#!/usr/bin/env node
// Is the installed copy of this collection behind its remote?
//
// Everything deterministic about that question lives here: which clone to look at, whether we are
// due to ask, what git says, and — with --update — the pull and the refresh. The skill that calls
// this owns only the manners: when it is polite to mention an update, and how to word it.
//
// Prints ONE line of JSON on stdout and nothing else, so the caller never has to parse prose.
//
//   node check.mjs            decide whether to speak, honouring the rate limit
//   node check.mjs --force    ignore the rate limit (the user asked directly)
//   node check.mjs --update   pull, then re-link what is installed
//   node check.mjs --decline  remember that this exact version was turned down
//
// Verdicts: "fresh" | "behind" | "unsafe" | "offline" | "not-installed" | "too-soon" | "updated"
// Only "behind" is worth interrupting anyone for.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ASK_EVERY_MS = 24 * 60 * 60 * 1000;
const statePath = path.join(os.homedir(), ".claude", ".claude-skills-freshness.json");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

function git(repo, args, timeout = 20000) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

// State lives beside CLAUDE.md, NEVER inside the clone. A timestamp written into the repo would
// leave it permanently dirty, which would in turn make the pull this script recommends unsafe —
// the check would break the thing it exists to enable.
function writeState(patch) {
  const next = { ...readState(), ...patch };
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(next, null, 2));
  } catch {
    // A state file we cannot write costs us the rate limit, not the answer. Carry on.
  }
  return next;
}

function say(verdict, extra = {}) {
  process.stdout.write(JSON.stringify({ verdict, ...extra }) + "\n");
}

/**
 * The installed clone — resolved from where this script actually lives, not from the working
 * directory. Called from inside a session the cwd is whatever the user happens to be working in,
 * which on a feature branch or a git worktree would answer a completely different question.
 */
function resolveRepo() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = fs.realpathSync(path.resolve(here, "..", ".."));
  return fs.existsSync(path.join(root, ".git")) ? root : null;
}

const repo = resolveRepo();
if (!repo) {
  say("not-installed", { detail: "could not resolve the clone this script lives in" });
} else if (has("--decline")) {
  let head = null;
  try {
    head = git(repo, ["rev-parse", "origin/HEAD"]);
  } catch {
    /* nothing to pin the refusal to; the timestamp alone will do */
  }
  writeState({ lastCheck: Date.now(), declined: head });
  say("fresh", { detail: "declined; will not ask again for this version" });
} else {
  const state = readState();
  const due = has("--force") || has("--update") || !state.lastCheck || Date.now() - state.lastCheck > ASK_EVERY_MS;
  if (!due) {
    say("too-soon", { lastCheck: state.lastCheck });
  } else {
    let branch, dirty, base;
    try {
      branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
      dirty = git(repo, ["status", "--porcelain"]).length > 0;
      base = git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, "");
    } catch {
      base = "main";
    }

    // A dirty or branched clone is not a place to run `git pull` unattended, and telling someone
    // to do it there is worse than saying nothing. Stay quiet and say why.
    if (dirty || (branch && branch !== base)) {
      writeState({ lastCheck: Date.now() });
      say("unsafe", { branch, dirty, base, repo });
    } else {
      try {
        git(repo, ["fetch", "--quiet", "origin", base], 30000);
      } catch {
        writeState({ lastCheck: Date.now() });
        say("offline", { repo });
        process.exitCode = 0;
      }
      if (process.exitCode === undefined || process.exitCode === 0) {
        let behind = "0";
        let head = null;
        try {
          behind = git(repo, ["rev-list", "--count", `HEAD..origin/${base}`]);
          head = git(repo, ["rev-parse", `origin/${base}`]);
        } catch {
          /* fall through as fresh; a count we cannot take is not evidence of staleness */
        }
        const count = Number(behind) || 0;

        if (has("--update")) {
          try {
            git(repo, ["pull", "--ff-only", "origin", base], 60000);
          } catch (err) {
            writeState({ lastCheck: Date.now() });
            say("unsafe", { repo, detail: `pull failed: ${String(err.message || err).split("\n")[0]}` });
            process.exit(0);
          }
          // Skills are links, so the pull alone already updated their content. This re-links
          // anything dangling and rewrites the instruction blocks, which ARE copies.
          // Only after the pull, and only if the pulled installer actually understands --refresh:
          // an older one prints its help and exits 0, which would look like success.
          let refreshed = true;
          const installer = path.join(repo, "install.mjs");
          const supportsRefresh = (() => {
            try {
              return fs.readFileSync(installer, "utf8").includes('"--refresh"');
            } catch {
              return false;
            }
          })();
          try {
            if (!supportsRefresh) throw new Error("installer has no --refresh");
            execFileSync(process.execPath, [installer, "--refresh"], {
              encoding: "utf8",
              timeout: 60000,
              stdio: ["ignore", "pipe", "pipe"],
            });
          } catch {
            refreshed = false;
          }
          writeState({ lastCheck: Date.now(), declined: null });
          say("updated", { repo, applied: count, refreshed });
        } else if (count > 0 && head && head === state.declined) {
          // Already turned this exact version down. The clock running out is not new information.
          say("fresh", { detail: "declined earlier and unchanged since" });
        } else {
          writeState({ lastCheck: Date.now() });
          if (count > 0) {
            let titles = [];
            try {
              titles = git(repo, ["log", "--no-merges", "--format=%s", "-5", `HEAD..origin/${base}`]).split("\n").filter(Boolean);
            } catch {
              /* the count is the load-bearing part; titles are a courtesy */
            }
            say("behind", { count, head, repo, base, titles });
          } else {
            say("fresh", { repo });
          }
        }
      }
    }
  }
}
