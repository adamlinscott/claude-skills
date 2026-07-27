/**
 * seatbelt guard — a Claude Code PreToolUse hook.
 *
 * This file is COPIED into a target repo by the /seatbelt skill. It is never
 * generated per-run: it is security-relevant code, so it is version-controlled
 * and tested (see guard.test.mjs) rather than improvised.
 *
 * Scope. Claude Code's permission engine already splits compound commands on
 * `&&`, `||`, `;`, `|`, `|&`, `&` and newlines and requires each subcommand to
 * match independently, and it handles `$(...)`/backtick substitution. This guard
 * does NOT re-implement that. It covers only what declarative rules provably
 * cannot express:
 *
 *   1. `bash -c` / `sh -c` / `eval` wrappers, whose payload is one opaque token
 *      to a rule but a whole command to a shell.
 *   2. Script indirection: `npm run deploy` where the script body is
 *      `vercel --prod`.
 *   3. Branch-sensitive decisions. `git push`, `git push origin HEAD` and
 *      `git push -u origin $(git branch --show-current)` do not contain the
 *      branch name, so no string rule can tell a feature push from a main push.
 *   4. `git config`, which can relocate hooks or alias a denied verb.
 *   5. Protecting this guard's own mechanism files.
 *
 * Exit contract. Only exit code 2 blocks a tool call; every other exit code is
 * a NON-BLOCKING error and Claude Code proceeds. So this guard fails CLOSED:
 * any internal error exits 2. A guard that cannot decide must not wave the call
 * through, because the user has been told it is protecting them.
 *
 *   exit 0, no stdout   -> fall through to normal permission checks
 *   exit 0, deny JSON   -> blocked, with an audience-appropriate reason
 *   exit 0, ask JSON    -> prompt the human
 *   exit 2              -> internal failure, blocked, reason on stderr
 *
 * No dependencies, no shebang, LF endings. Invoked in exec form so no shell is
 * involved on any platform.
 */

import { readSync, writeSync, readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_STDIN = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 60_000;
const MAX_DEPTH = 6;

// ---------------------------------------------------------------- decisions

const RANK = { allow: 0, ask: 1, deny: 2 };

/**
 * Write synchronously. process.stdout.write() is ASYNC on a pipe, and Claude Code
 * always gives a hook a pipe — so `write(); process.exit(0)` silently truncates the
 * payload. A deny that emits nothing is an exit-0-with-no-output, which Claude Code
 * reads as "fall through", i.e. ALLOW. That is a fail-open in the single most
 * important path in this file. writeSync is the fix; do not revert it.
 */
function writeAllSync(fd, text) {
  const buf = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    } catch (err) {
      if (err.code === "EAGAIN") continue;
      throw err;
    }
  }
}

function emit(decision, reason) {
  if (decision === "allow") process.exit(0); // silence = fall through
  writeAllSync(
    1,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

function failClosed(message) {
  writeAllSync(
    2,
    `seatbelt could not evaluate this call, so it was blocked.\n` +
      `Cause: ${message}\n` +
      `Fix: run /seatbelt --uninstall if the guard is broken, or report the command that triggered this.\n`,
  );
  process.exit(2);
}

const worst = (list) =>
  list.filter(Boolean).reduce((a, b) => (RANK[b.decision] > RANK[a.decision] ? b : a), {
    decision: "allow",
    reason: "",
  });

// ------------------------------------------------------------------- input

function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  let total = 0;
  for (;;) {
    let n;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      if (err.code === "EAGAIN") continue;
      if (err.code === "EOF") break;
      throw err;
    }
    if (n === 0) break;
    total += n;
    if (total > MAX_STDIN) throw new Error("hook input exceeded 4MB");
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ------------------------------------------------------------------ policy

const DEFAULT_POLICY = {
  version: 1,
  mode: "vibe",
  protectedPaths: [],
  protectedGlobs: [],
  defaultBranchFallbacks: ["main", "master", "trunk", "develop"],
  allowPushToDefaultBranch: false,
  allowHistoryRewrite: false,
  allowForcePush: false,
  denyCommands: [],
  askCommands: [],
  mcpDeny: [],
  mcpAsk: [],
  unknownMcp: "allow",
  unresolvedScript: "ask",
  logPath: ".claude/seatbelt-log.jsonl",
};

function loadJson(file) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Policy is DATA and lives in two files. seatbelt.policy.json is self-protected;
 * seatbelt.local.json is deliberately NOT, because it is the escape hatch. If
 * both were protected, `--uninstall` and `--allow` would be blocked by the very
 * guard they are meant to change.
 */
function loadPolicy(root) {
  const basePath = path.join(root, ".claude", "seatbelt.policy.json");
  // A registered guard with no policy is a broken install, not an empty policy.
  // Falling back to defaults here would allow everything while the user believes
  // they are protected — the exact silent failure this guard exists to prevent.
  if (!existsSync(basePath)) {
    throw new Error(
      `no policy at ${basePath}. The guard is registered but unconfigured — ` +
        `re-run /seatbelt, or /seatbelt --uninstall to remove it.`,
    );
  }
  const base = loadJson(basePath) ?? {};
  const local = loadJson(path.join(root, ".claude", "seatbelt.local.json")) ?? {};
  const merged = { ...DEFAULT_POLICY, ...base, ...local };
  for (const key of ["protectedPaths", "protectedGlobs", "denyCommands", "askCommands", "mcpDeny", "mcpAsk"]) {
    merged[key] = [...(base[key] ?? []), ...(local[key] ?? [])];
  }
  // `allowCommands` in the LOCAL file only — an override must never be grantable
  // by the committed policy, or a repo could widen its own permissions.
  merged.allowCommands = local.allowCommands ?? [];
  return merged;
}

// -------------------------------------------------------------- shell parse

/** Tokenize a command, honouring quotes. Quotes are stripped: `bash -c "a && b"`
 *  yields ["bash", "-c", "a && b"], which is exactly the payload we need to recurse into. */
export function tokenize(cmd) {
  const out = [];
  let cur = "";
  let quote = null;
  let escaped = false;
  let started = false;
  for (const ch of cmd) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || cur) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur) out.push(cur);
  return out;
}

/** Split on shell separators at depth 0, leaving quoted and substituted text intact. */
export function splitSegments(cmd) {
  const segs = [];
  let cur = "";
  let quote = null;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      cur += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      cur += ch;
      quote = ch;
      continue;
    }
    if (ch === "$" && next === "(") {
      depth++;
      cur += ch;
      continue;
    }
    if (ch === ")" && depth > 0) {
      depth--;
      cur += ch;
      continue;
    }
    if (depth === 0) {
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
        segs.push(cur);
        cur = "";
        i++;
        continue;
      }
      if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
        segs.push(cur);
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

/** Pull the bodies out of $(...) and `...` so they get evaluated too. */
export function extractSubstitutions(cmd) {
  const found = [];
  const re = /\$\(((?:[^()]|\([^()]*\))*)\)|`([^`]*)`/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    const body = m[1] ?? m[2];
    if (body && body.trim()) found.push(body.trim());
  }
  return found;
}

const WRAPPERS = new Set([
  "timeout", "time", "nice", "nohup", "stdbuf", "command", "builtin",
  "noglob", "env", "xargs", "sudo", "doas", "setsid",
]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash", "busybox"]);
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

const bare = (tok) => path.basename(String(tok ?? "")).replace(/\.(exe|cmd|bat)$/i, "");

/** Strip leading VAR=x assignments and benign wrappers so `timeout 60 env X=1 git push` reads as `git push`. */
export function unwrap(tokens) {
  const t = [...tokens];
  for (;;) {
    while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t.shift();
    if (!t.length || !WRAPPERS.has(bare(t[0]))) break;
    t.shift();
    while (t.length && (t[0].startsWith("-") || /^\d+(\.\d+)?[smhd]?$/.test(t[0]))) t.shift();
  }
  return t;
}

// --------------------------------------------------------------- git facts

/** Cached because the guard runs on every matching tool call and shelling out is the hot path. */
function gitFacts(root) {
  const cacheFile = path.join(tmpdir(), `seatbelt-git-${Buffer.from(root).toString("hex").slice(0, 32)}.json`);
  try {
    const cached = loadJson(cacheFile);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.facts;
  } catch {
    /* corrupt cache is not fatal — recompute */
  }
  const git = (args, fallback = "") => {
    try {
      return execFileSync("git", args, {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return fallback;
    }
  };
  const facts = {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    defaultBranch: git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, ""),
    commonDir: git(["rev-parse", "--git-common-dir"]),
    hooksPath: git(["config", "--get", "core.hooksPath"]),
  };
  try {
    writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), facts }));
  } catch {
    /* unwritable tmp is not fatal */
  }
  return facts;
}

/**
 * Which branch would this push land on? Usually not stated in the command, which
 * is precisely why a declarative rule cannot answer it.
 */
export function resolvePushTarget(argsAfterSubcommand, facts) {
  const positional = argsAfterSubcommand.filter((a) => !a.startsWith("-"));
  const refspec = positional[1]; // [remote, refspec]
  if (!refspec) return facts.branch || null;
  const src = refspec.includes(":") ? refspec.split(":").pop() : refspec;
  const name = src.replace(/^refs\/heads\//, "");
  if (name === "HEAD" || name === "") return facts.branch || null;
  return name;
}

const isDefaultBranch = (branch, facts, policy) => {
  if (!branch) return true; // unknown target: treat as protected
  const known = facts.defaultBranch;
  if (known) return branch === known;
  return policy.defaultBranchFallbacks.includes(branch);
};

// -------------------------------------------------------- script resolution

function resolveNodeScript(root, name) {
  const pkg = loadJson(path.join(root, "package.json"));
  return pkg?.scripts?.[name] ?? null;
}

function resolveMakeTarget(root, name) {
  const file = ["Makefile", "makefile", "GNUmakefile"].map((f) => path.join(root, f)).find(existsSync);
  if (!file) return null;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).test(l));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length && /^\t/.test(lines[i]); i++) {
    body.push(lines[i].replace(/^\t[-@+]*/, ""));
  }
  return body.join("\n") || null;
}

function resolveJustRecipe(root, name) {
  const file = ["justfile", "Justfile", ".justfile"].map((f) => path.join(root, f)).find(existsSync);
  if (!file) return null;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) =>
    new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(\\w|\\+|\\*)*\\s*:`).test(l),
  );
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) {
    body.push(lines[i].trim().replace(/^[-@]+/, ""));
  }
  return body.join("\n") || null;
}

// --------------------------------------------------------------- matching

export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const normalize = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * Rule matching deliberately does NOT default to regex.
 *
 * A regex in a JSON policy file has to be double-escaped (`"\\bvercel\\b"`), and
 * getting that wrong yields a rule that silently never matches — the policy looks
 * populated, the report claims protection, and nothing is enforced. That is the
 * same silent-no-op failure as a `Write(path)` permission rule, and it is the one
 * failure mode this whole skill exists to avoid.
 *
 * Supported shapes, in precedence order:
 *   "vercel --prod"                     literal substring, case-insensitive
 *   { contains: ["vercel", "--prod"] }  every fragment present, order-free
 *   { startsWith: "terraform apply" }   command begins with this
 *   { regex: "^vercel\\b.*--prod" }     explicit opt-in, still escape-checked
 * Any other shape is malformed and reported by validatePolicy() rather than
 * quietly skipped.
 */
export function ruleMatches(rule, text) {
  const haystack = String(text).toLowerCase();
  if (typeof rule === "string") return haystack.includes(rule.toLowerCase());
  if (!rule || typeof rule !== "object") return false;
  if (Array.isArray(rule.contains)) {
    return rule.contains.length > 0 && rule.contains.every((f) => haystack.includes(String(f).toLowerCase()));
  }
  if (typeof rule.startsWith === "string") {
    return haystack.trimStart().startsWith(rule.startsWith.toLowerCase());
  }
  if (typeof rule.regex === "string") {
    try {
      return new RegExp(rule.regex, "i").test(text);
    } catch {
      return false; // reported by validatePolicy, never fatal at decision time
    }
  }
  return false;
}

/** Returns a list of human-readable problems. The skill runs this before writing a policy. */
export function validatePolicy(policy) {
  const problems = [];
  for (const key of ["denyCommands", "askCommands", "allowCommands", "mcpDeny", "mcpAsk"]) {
    for (const [i, rule] of (policy[key] ?? []).entries()) {
      if (typeof rule === "string") {
        if (!rule.trim()) problems.push(`${key}[${i}]: empty pattern`);
        continue;
      }
      if (!rule || typeof rule !== "object") {
        problems.push(`${key}[${i}]: not a string or object`);
        continue;
      }
      const shapes = ["contains", "startsWith", "regex"].filter((k) => k in rule);
      if (shapes.length === 0) {
        problems.push(`${key}[${i}]: no contains/startsWith/regex — this rule can never match`);
      }
      if (typeof rule.regex === "string") {
        try {
          new RegExp(rule.regex, "i");
        } catch (err) {
          problems.push(`${key}[${i}]: invalid regex (${err.message})`);
        }
      }
      if (Array.isArray(rule.contains) && rule.contains.length === 0) {
        problems.push(`${key}[${i}]: empty contains array — this rule can never match`);
      }
    }
  }
  return problems;
}

function matchRules(rules, text) {
  for (const rule of rules) {
    if (ruleMatches(rule, text)) return typeof rule === "string" ? "" : (rule.reason ?? "");
  }
  return null;
}

// ------------------------------------------------------------ git intents

function evaluateGit(tokens, ctx) {
  const { policy, facts } = ctx;
  const args = tokens.slice(1).filter((a) => a !== "--");
  // `git -c core.hooksPath=x push` — config injection before the subcommand.
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" || args[i] === "--config-env") {
      return { decision: "deny", reason: reason(policy, "git-config-inline") };
    }
  }
  const sub = args.find((a) => !a.startsWith("-"));
  const flags = args.filter((a) => a.startsWith("-"));
  const has = (...names) => flags.some((f) => names.some((n) => f === n || f.startsWith(`${n}=`)));

  if (sub === "config") return { decision: "deny", reason: reason(policy, "git-config") };

  if (sub === "push") {
    const forced = has("-f", "--force", "--force-with-lease", "--force-if-includes");
    const deleting = has("-d", "--delete") || args.some((a) => /^:(?!$)/.test(a));
    // Drop the subcommand so positional[0] is the remote, not "push".
    const target = resolvePushTarget(args.slice(args.indexOf(sub) + 1), facts);
    const onDefault = isDefaultBranch(target, facts, policy);
    if (forced && (onDefault || !policy.allowForcePush)) {
      return { decision: "deny", reason: reason(policy, "force-push", { target }) };
    }
    if (deleting && onDefault) return { decision: "deny", reason: reason(policy, "delete-branch", { target }) };
    if (onDefault && !policy.allowPushToDefaultBranch) {
      return { decision: "deny", reason: reason(policy, "push-default", { target }) };
    }
    return { decision: "allow", reason: "" };
  }

  if (!policy.allowHistoryRewrite) {
    if (sub === "reset" && has("--hard")) return { decision: "deny", reason: reason(policy, "reset-hard") };
    if (sub === "clean" && has("-f", "-fd", "-fdx", "--force")) {
      return { decision: "deny", reason: reason(policy, "clean") };
    }
    if (sub === "commit" && has("--amend")) return { decision: "deny", reason: reason(policy, "amend") };
    if (sub === "rebase" && !has("--abort", "--quit")) return { decision: "deny", reason: reason(policy, "rebase") };
    if (sub === "filter-branch" || sub === "filter-repo") {
      return { decision: "deny", reason: reason(policy, "rewrite") };
    }
    if (sub === "branch" && has("-D")) return { decision: "deny", reason: reason(policy, "delete-branch") };
    if (sub === "checkout" && has("-f", "--force")) return { decision: "deny", reason: reason(policy, "reset-hard") };
  }
  return { decision: "allow", reason: "" };
}

// ---------------------------------------------------------------- messages

const MESSAGES = {
  vibe: {
    "push-default": (c) =>
      `I can't push straight to "${c.target}" — that's your live branch and this can't be undone.\n` +
      `What I'll do instead: put this on its own branch and open a pull request for you.\n` +
      `What you do: open the link I give you, read the summary, click "Merge pull request".`,
    "force-push": (c) =>
      `I can't force-push to "${c.target}". Force-pushing overwrites history, and work can disappear for good.\n` +
      `What I'll do instead: make a normal commit on a branch.\n` +
      `What you do: nothing — I'll show you the pull request when it's ready.`,
    "delete-branch": () =>
      `I can't delete that branch. Deleting is permanent and I might be wrong about what's safe to remove.\n` +
      `What you do: if you're sure, delete it yourself on GitHub, where you can see what's in it.`,
    "reset-hard": () =>
      `I can't run that — it throws away uncommitted work with no way back.\n` +
      `What I'll do instead: commit what's there first, so nothing is lost.`,
    clean: () =>
      `I can't run that — it deletes files that aren't saved in git yet, permanently.\n` +
      `What you do: check the files yourself and delete the ones you don't want.`,
    amend: () => `I can't rewrite an existing commit. I'll add a new one instead, so your history stays honest.`,
    rebase: () => `I can't rebase — it rewrites history and is hard to undo. I'll merge or add a commit instead.`,
    rewrite: () => `I can't rewrite repository history. That's a one-way door and needs a person who knows git.`,
    "git-config": () =>
      `I can't change git's configuration. Some settings there would switch off the checks that protect you.`,
    "git-config-inline": () => `I can't run git with inline config overrides — that can bypass your safety settings.`,
    protected: (c) => `I can't edit ${c.file}. That file is what keeps these protections working.`,
    deploy: (c) =>
      `I can't deploy. "${c.what}" pushes to your live site, and if it's broken your users see it immediately.\n` +
      `What you do: deploy yourself when you've checked it, or ask a developer to.`,
    merge: () =>
      `I can't merge this myself — merging is permanent and puts the change into your live project.\n` +
      `What I'll do instead: leave the pull request open with everything ready.\n` +
      `What you do: open the pull request, read the summary, click "Merge pull request".`,
    publish: (c) =>
      `I can't publish. "${c.what}" sends this out to other people and you can't take it back.\n` +
      `What you do: publish it yourself once you're happy with it.`,
    spend: (c) => `I can't run "${c.what}" — it spends real money.`,
    destructive: (c) => `I can't run "${c.what ?? "that"}" — it deletes data that can't be recovered.`,
    confirm: (c) => `"${c.what}" changes more than just your code, so I'd like you to confirm it first.`,
    unresolved: (c) => `I can't tell what "${c.what}" actually runs, so I've stopped rather than guess.`,
    mcp: (c) => `I can't use ${c.tool} — that action is permanent and I can't undo it for you.`,
  },
  developer: {
    "push-default": (c) => `DENY  push to default branch (${c.target}) — seatbelt:push-default`,
    "force-push": (c) => `DENY  force-push to ${c.target} — seatbelt:force-push`,
    "delete-branch": (c) => `DENY  branch deletion${c.target ? ` (${c.target})` : ""} — seatbelt:delete-branch`,
    "reset-hard": () => `DENY  destructive worktree reset — seatbelt:reset-hard`,
    clean: () => `DENY  git clean --force — seatbelt:clean`,
    amend: () => `DENY  history rewrite — seatbelt:amend`,
    rebase: () => `DENY  history rewrite — seatbelt:rebase`,
    rewrite: () => `DENY  history rewrite — seatbelt:rewrite`,
    "git-config": () => `DENY  git config write — seatbelt:git-config (can relocate hooks / alias denied verbs)`,
    "git-config-inline": () => `DENY  git -c inline config — seatbelt:git-config-inline`,
    protected: (c) => `DENY  write to guard mechanism ${c.file} — seatbelt:protected`,
    deploy: (c) => `DENY  production deploy (${c.what}) — seatbelt:deploy`,
    merge: () => `DENY  merge — seatbelt:merge`,
    publish: (c) => `DENY  publish (${c.what}) — seatbelt:publish`,
    spend: (c) => `DENY  spend (${c.what}) — seatbelt:spend`,
    destructive: (c) => `DENY  irreversible data loss (${c.what ?? "command"}) — seatbelt:destructive`,
    confirm: (c) => `ASK   ${c.what} — seatbelt:confirm`,
    unresolved: (c) => `DENY  unresolvable indirection (${c.what}) — seatbelt:unresolved`,
    mcp: (c) => `DENY  ${c.tool} — seatbelt:mcp`,
  },
};

const OVERRIDE = {
  vibe: `\nIf you want me to be able to do this, run: /seatbelt --allow "<the command>"`,
  developer: `\nOverride: /seatbelt --allow "<cmd>"  ·  or edit .claude/seatbelt.local.json`,
};

/**
 * `key` is either a known message key (templated below) or literal prose supplied
 * by the policy author in a rule's `reason` field. Both get the override footer,
 * because a denial without a next action is the failure mode that strands a user.
 */
function reason(policy, key, ctx = {}) {
  const mode = policy.mode === "developer" ? "developer" : "vibe";
  const fn = MESSAGES[mode][key];
  if (fn) return fn(ctx) + OVERRIDE[mode];
  return (String(key ?? "").trim() || MESSAGES[mode].destructive(ctx)) + OVERRIDE[mode];
}

// -------------------------------------------------------------- evaluation

function evaluateSegment(segment, ctx, depth) {
  const { policy } = ctx;
  if (matchRules(policy.allowCommands, segment) !== null) return { decision: "allow", reason: "" };

  const tokens = unwrap(tokenize(segment));
  if (!tokens.length) return { decision: "allow", reason: "" };

  // The command NAME itself is computed: `$(echo git) push -f`, `${GIT} push`.
  // No static analysis can say what will run, so fail closed rather than guess.
  if (/[$`]/.test(tokens[0])) {
    return { decision: "deny", reason: reason(policy, "unresolved", { what: tokens[0] }) };
  }

  const cmd = bare(tokens[0]);

  // 1. Shell wrappers — the payload a rule sees as one opaque token.
  if (SHELLS.has(cmd)) {
    const idx = tokens.findIndex((t) => t === "-c" || t === "-lc" || t === "-cl");
    if (idx !== -1 && tokens[idx + 1]) return evaluateCommand(tokens[idx + 1], ctx, depth + 1);
  }
  if (cmd === "eval" && tokens.length > 1) return evaluateCommand(tokens.slice(1).join(" "), ctx, depth + 1);

  // 2. Script indirection — `npm run deploy` is `vercel --prod` wearing a hat.
  if (RUNNERS.has(cmd)) {
    const rest = tokens.slice(1).filter((t) => !t.startsWith("-"));
    const isRun = rest[0] === "run" || rest[0] === "run-script" || (cmd === "bun" && rest[0] === "run");
    const name = isRun ? rest[1] : cmd === "npm" || cmd === "pnpm" ? null : rest[0];
    if (name) {
      const body = resolveNodeScript(ctx.root, name);
      if (body) return evaluateCommand(body, ctx, depth + 1);
      if (isRun && policy.unresolvedScript !== "allow") {
        return { decision: policy.unresolvedScript, reason: reason(policy, "unresolved", { what: segment }) };
      }
    }
  }
  if (cmd === "make" || cmd === "just") {
    const name = tokens.slice(1).find((t) => !t.startsWith("-"));
    if (name) {
      const body = cmd === "make" ? resolveMakeTarget(ctx.root, name) : resolveJustRecipe(ctx.root, name);
      if (body) return evaluateCommand(body, ctx, depth + 1);
    }
  }

  // 3. Branch-sensitive git.
  if (cmd === "git") return evaluateGit(tokens, ctx);

  // 4. Everything else is policy data.
  const denied = matchRules(policy.denyCommands, segment);
  if (denied !== null) return { decision: "deny", reason: reason(policy, denied || "destructive", { what: cmd }) };
  const asked = matchRules(policy.askCommands, segment);
  if (asked !== null) return { decision: "ask", reason: reason(policy, asked || "confirm", { what: cmd }) };

  return { decision: "allow", reason: "" };
}

function evaluateCommand(command, ctx, depth = 0) {
  if (depth > MAX_DEPTH) {
    return { decision: "deny", reason: reason(ctx.policy, "unresolved", { what: "deeply nested command" }) };
  }
  const results = [];
  for (const segment of splitSegments(command)) {
    for (const sub of extractSubstitutions(segment)) results.push(evaluateCommand(sub, ctx, depth + 1));
    results.push(evaluateSegment(segment, ctx, depth));
  }
  return worst(results);
}

function evaluateFileWrite(filePath, ctx) {
  const { policy, root, facts } = ctx;
  const abs = path.resolve(root, String(filePath ?? ""));
  const rel = normalize(path.relative(root, abs));
  const outside = rel.startsWith("..");
  const candidates = [normalize(filePath), rel];

  // Worktrees: .git is a FILE, so a literal `.git/hooks/**` rule matches nothing.
  // Resolve the real hooks directory instead.
  const hookDirs = [facts.hooksPath, facts.commonDir && path.join(facts.commonDir, "hooks")].filter(Boolean);
  for (const dir of hookDirs) {
    if (!path.relative(path.resolve(root, dir), abs).startsWith("..")) {
      return { decision: "deny", reason: reason(policy, "protected", { file: "the git hooks directory" }) };
    }
  }

  for (const p of policy.protectedPaths) {
    if (candidates.includes(normalize(p))) {
      return { decision: "deny", reason: reason(policy, "protected", { file: normalize(p) }) };
    }
  }
  for (const g of policy.protectedGlobs) {
    const re = globToRegExp(normalize(g));
    if (candidates.some((c) => !outside && re.test(c))) {
      return { decision: "deny", reason: reason(policy, "protected", { file: normalize(g) }) };
    }
  }
  return { decision: "allow", reason: "" };
}

function evaluateMcp(toolName, ctx) {
  const { policy } = ctx;
  if (matchRules(policy.mcpDeny, toolName) !== null) {
    return { decision: "deny", reason: reason(policy, "mcp", { tool: toolName }) };
  }
  if (matchRules(policy.mcpAsk, toolName) !== null) {
    return { decision: "ask", reason: `seatbelt: ${toolName} can make changes outside this repo. Confirm?` };
  }
  if (policy.unknownMcp === "ask") {
    return { decision: "ask", reason: `seatbelt: ${toolName} is a tool I don't have a rule for. Confirm?` };
  }
  return { decision: "allow", reason: "" };
}

// ------------------------------------------------------------------- audit

function log(ctx, record) {
  if (!ctx.policy.logPath) return;
  try {
    const file = path.resolve(ctx.root, ctx.policy.logPath);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  } catch {
    /* logging must never change the decision */
  }
}

// -------------------------------------------------------------------- main

export function decide(input, ctx) {
  const tool = input.tool_name;
  const args = input.tool_input ?? {};
  if (typeof tool !== "string" || !tool) throw new Error("missing tool_name");

  if (tool.startsWith("mcp__")) return evaluateMcp(tool, ctx);
  if (tool === "Bash" || tool === "PowerShell") {
    const command = args.command;
    if (typeof command !== "string") throw new Error(`${tool} call had no command string`);
    return evaluateCommand(command, ctx);
  }
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    // Note: `Write(path)` PERMISSION RULES never match — but the hook sees the
    // real tool name, so this is where write-protection actually has to live.
    const file = args.file_path ?? args.notebook_path;
    if (!file) return { decision: "allow", reason: "" };
    return evaluateFileWrite(file, ctx);
  }
  return { decision: "allow", reason: "" };
}

/**
 * `--selftest` is wired to SessionStart. A guard that has been renamed, deleted, or
 * left without a policy would otherwise fail silently and the user would keep
 * believing they are protected. This makes that state loud, once per session.
 */
function selftest() {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    const policy = loadPolicy(root);
    const problems = validatePolicy(policy);
    if (problems.length) {
      writeAllSync(2, `seatbelt: policy has ${problems.length} rule(s) that can never match:\n  ${problems.join("\n  ")}\n`);
      process.exit(1);
    }
    const probe = decide(
      { tool_name: "Bash", tool_input: { command: "git push --force origin HEAD:refs/heads/main" } },
      { root, policy, facts: { branch: "main", defaultBranch: "main", commonDir: "", hooksPath: "" } },
    );
    if (probe.decision !== "deny") {
      writeAllSync(2, `seatbelt: ALIVE BUT NOT ENFORCING — a force-push to main was not denied. Re-run /seatbelt.\n`);
      process.exit(1);
    }
    if (policy.denyCommands.length === 0) {
      writeAllSync(2, `seatbelt: active but the policy has NO command rules — that is almost certainly wrong. Re-run /seatbelt.\n`);
      process.exit(1);
    }
    writeAllSync(1, `seatbelt: active (${policy.mode} mode, ${policy.denyCommands.length} deny rules).\n`);
    process.exit(0);
  } catch (err) {
    writeAllSync(2, `seatbelt: NOT PROTECTING THIS SESSION — ${err.message}\n`);
    process.exit(1);
  }
}

function main() {
  if (process.argv.includes("--selftest")) return selftest();
  let input;
  try {
    const raw = readStdin();
    if (!raw.trim()) throw new Error("empty hook input");
    input = JSON.parse(raw);
  } catch (err) {
    failClosed(`could not read hook input (${err.message})`);
    return;
  }

  let ctx;
  try {
    const root = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const policy = loadPolicy(root);
    ctx = { root, policy, facts: gitFacts(root) };
  } catch (err) {
    failClosed(`could not load policy (${err.message})`);
    return;
  }

  let result;
  try {
    result = decide(input, ctx);
  } catch (err) {
    failClosed(err.message);
    return;
  }

  if (result.decision !== "allow") {
    log(ctx, { decision: result.decision, tool: input.tool_name, session: input.session_id ?? null });
  }
  emit(result.decision, result.reason);
}

// Only run when invoked as the hook, so the test file can import the internals.
if (process.argv[1] && path.basename(process.argv[1]) === "guard.mjs") main();
