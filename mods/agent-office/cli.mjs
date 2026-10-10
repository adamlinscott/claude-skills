#!/usr/bin/env node
// Agent Office from a terminal: prints the office snapshot for one git project as JSON.
//
//   node mods/agent-office/cli.mjs --json [--self <session id>] [--project <dir>]
//
// --project defaults to the current folder; any folder inside any worktree of the project will do.
// Without --self, the session is guessed from the transcripts (see discover.mjs).
//
// discover.mjs takes no Node APIs, so the mod can load it too. This file supplies the Node
// versions of what it needs: file access, the clock and a git runner.

import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDiscover } from "./discover.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// Claude Code keeps projects/ (and the user's agent-office/ overrides) under CLAUDE_CONFIG_DIR when
// it is set, else ~/.claude.
const defaultClaudeDir = () => (process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), ".claude"));

export function nodeIo({ claudeDir = defaultClaudeDir(), now = () => Date.now(), run = runCommand } = {}) {
  return {
    claudeDir,
    now,
    run,
    async listDir(dir) {
      try {
        return (await fs.readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
      } catch {
        return [];
      }
    },
    async stat(p) {
      try {
        const s = await fs.stat(p);
        return { isDir: s.isDirectory(), mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    },
    async read(p, start, end) {
      if (start === undefined) return fs.readFile(p, "utf8");
      const fh = await fs.open(p, "r");
      try {
        const buf = Buffer.alloc(Math.max(0, end - start));
        const { bytesRead } = await fh.read(buf, 0, buf.length, start);
        return buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await fh.close();
      }
    },
  };
}

function runCommand([cmd, ...args], { cwd }) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, encoding: "utf8", timeout: 10000, windowsHide: true }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: stdout || "" });
    });
  });
}

async function main(argv) {
  const value = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };
  if (!argv.includes("--json")) {
    process.stderr.write("usage: node cli.mjs --json [--self <session id>] [--project <dir>]\n");
    return 2;
  }
  const project = path.resolve(value("--project") || process.cwd());
  const discover = createDiscover(nodeIo(), { defaultsDir: here });
  const snap = await discover.snapshot({ project, self: value("--self") });
  process.stdout.write(JSON.stringify(snap, null, 2) + "\n");
  return 0;
}

// Run only when started as a script, not when imported. Node gives import.meta.url the real path
// but leaves argv[1] as typed, so a symlink, a junction or a differently cased Windows path would
// otherwise fail the comparison: compare real paths, case-folded on Windows.
function isEntry() {
  if (!process.argv[1]) return false;
  const key = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  try {
    return key(realpathSync(fileURLToPath(import.meta.url))) === key(realpathSync(process.argv[1]));
  } catch {
    return false;
  }
}

if (isEntry()) {
  process.exitCode = await main(process.argv.slice(2));
}
