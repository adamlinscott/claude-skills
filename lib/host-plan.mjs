// The decision half of the VPS host tooling: every choice, none of the consequences.
//
// Nothing in this file touches the disk, the network, or a subprocess. It takes strings and
// objects in and returns strings and objects out, so all of it runs on the maintainer's Windows
// machine even though the thing it configures only ever runs on Linux. That split is the reason
// the security rules below can be tested at all: `validateUrl` is where a malicious clone URL is
// stopped, and a test can prove it without a network or a git binary anywhere in sight.
//
// The acting half lives in ./host-steps.mjs and puts every subprocess behind one injected
// executor. Keep the line between them: a decision that reaches for `fs` belongs over there.

// POSIX rules, always. Every path this file reasons about names a location on the Linux box being
// configured, never on the machine running the code — so Windows separators must not leak in when
// the maintainer runs the tests locally.
import { posix as path } from "node:path";

// ── Names ───────────────────────────────────────────────────────────────────────────────────────
// A repo name becomes four things at once: a directory under the workspace root, a systemd unit
// instance, a process to look for, and the label shown in the Claude app. Validated once, here,
// and every caller uses the result rather than the raw input.

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}$/;

// Rejected outright rather than merely failing the pattern, because each would "work" and then
// mean something else: `default` collides with systemd's own vocabulary, and the dot names are
// path segments that survive a naive join.
const RESERVED_NAMES = new Set(["default", "system", "user", "all", "none", "new", "config"]);

/**
 * Returns { ok: true, name } or { ok: false, reason }. The reason is written for a person, since
 * it is printed straight back to whoever typed the name.
 */
export function validateName(raw) {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "a name is required" };
  const name = raw.trim();
  if (name !== name.toLowerCase()) return { ok: false, reason: "names are lower case" };
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      reason: "names use a-z, 0-9 and hyphens, start with a letter or digit, and stop at 39 characters",
    };
  }
  if (RESERVED_NAMES.has(name)) return { ok: false, reason: `"${name}" is reserved — pick another` };
  return { ok: true, name };
}

/**
 * The name for a repo the caller did not name. Derived from the URL, and then put through exactly
 * the same validation as a name someone typed — the derived value is attacker-controlled too, so
 * trusting it because "we made it ourselves" is how traversal gets in.
 */
export function deriveName(url) {
  const cleaned = String(url).trim().replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  // Drop the scheme and host, then insist on both an owner and a repo. Without that check a URL
  // ending in a bare `.git` derives the OWNER as the repo name, which would register the wrong
  // thing under a plausible-looking name.
  const segments = cleaned.replace(/^[a-z0-9+.-]+:\/\//i, "").split(/[/:]/).filter(Boolean);
  if (segments.length < 3) return { ok: false, reason: "the URL needs a host, an owner and a repository" };
  return validateName(segments[segments.length - 1].toLowerCase());
}

/**
 * Join a repo name onto the workspace root, and refuse anything that escapes it.
 *
 * The name pattern already forbids slashes and dots, so this is belt-and-braces — but it is the
 * check that runs on every route, including the delete route, where the name arrives from a URL
 * path and has been through decodeURIComponent.
 */
export function resolveRepoPath(root, name) {
  const checked = validateName(name);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const base = path.resolve(root);
  const full = path.resolve(base, checked.name);
  if (full !== path.join(base, checked.name) || !full.startsWith(base + path.sep)) {
    return { ok: false, reason: "that name resolves outside the workspace" };
  }
  return { ok: true, path: full, name: checked.name };
}

// ── Clone URLs ──────────────────────────────────────────────────────────────────────────────────
// Cloning is the one place this tool takes a string from outside and hands it to another program.
// An argv array stops the shell getting involved; it does nothing about git's own surface, which is
// large. Three separate things are wrong with an unchecked URL and all three are checked here.

// Only these two shapes. Everything else — including transports that exist purely to run commands
// — is refused before git ever sees it.
const HTTPS_URL = /^https:\/\/([a-z0-9.-]+)(?::\d+)?\/(.+)$/i;
const SCP_URL = /^([a-z0-9._-]+)@([a-z0-9.-]+):(.+)$/i;
const SSH_URL = /^ssh:\/\/(?:([a-z0-9._-]+)@)?([a-z0-9.-]+)(?::\d+)?\/(.+)$/i;

/**
 * Returns { ok: true, host, owner, repo, normalised } or { ok: false, reason }.
 *
 * The order matters. Scheme is decided first, because a host allowlist cannot help with a URL that
 * has no host: `ext::sh -c '…'` names a command, not a server, and would sail past any check that
 * starts by reading a hostname.
 */
export function validateUrl(raw, allowedHosts = []) {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "a repository URL is required" };
  const url = raw.trim();

  // A URL that begins with a dash is read by git as an option, not an address. `--upload-pack=…`
  // runs a command of the caller's choosing; `--template=…` installs hooks into the new clone.
  if (url.startsWith("-")) return { ok: false, reason: "a URL cannot start with '-'" };

  // git's transport-helper syntax. `ext::` and `fd::` execute; none of them are ever wanted here.
  if (url.includes("::")) return { ok: false, reason: "transport helpers (the '::' form) are not allowed" };

  if (/[\s\x00-\x1f\x7f]/.test(url)) return { ok: false, reason: "a URL cannot contain spaces or control characters" };

  let host, tail, user = null;
  let m;
  if ((m = HTTPS_URL.exec(url))) {
    [, host, tail] = m;
  } else if ((m = SSH_URL.exec(url))) {
    [, user, host, tail] = m;
  } else if ((m = SCP_URL.exec(url))) {
    [, user, host, tail] = m;
  } else {
    // Named explicitly so the message is useful rather than "invalid URL".
    if (/^(file|git|http|ftp|ftps|rsync):/i.test(url)) {
      const scheme = url.split(":")[0].toLowerCase();
      return { ok: false, reason: `${scheme}:// is not allowed — use https:// or ssh` };
    }
    return { ok: false, reason: "use https://host/owner/repo or git@host:owner/repo" };
  }

  const segments = tail.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (segments.length < 2) return { ok: false, reason: "the URL needs an owner and a repository" };
  if (segments.some((s) => s === "." || s === "..")) return { ok: false, reason: "the URL contains path segments that are not allowed" };

  const lowerHost = host.toLowerCase();
  if (allowedHosts.length && !allowedHosts.map((h) => h.toLowerCase()).includes(lowerHost)) {
    return { ok: false, reason: `${lowerHost} is not in the allowed hosts list — add it in vps/config.json` };
  }

  return {
    ok: true,
    host: lowerHost,
    user,
    owner: segments[0],
    repo: segments[segments.length - 1],
    normalised: url,
  };
}

// The git configuration that goes with every clone. Kept next to validateUrl because the two are
// one defence in two places: the regex above decides what we accept, and these switches make git
// refuse the rest even if the regex is ever wrong.
export const GIT_SAFETY_ARGS = [
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "protocol.ssh.allow=always",
  "-c", "protocol.file.allow=never",
  "-c", "protocol.ext.allow=never",
];

// Non-interactive, always. Without these a private repo or an unknown host key does not fail — it
// waits forever for input that is never coming, and the caller hangs with it.
export const GIT_SAFETY_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes",
};

/** The full argv for a clone. One function so no caller can assemble it slightly differently. */
export function cloneArgs(url, dest) {
  return [...GIT_SAFETY_ARGS, "clone", "--no-recurse-submodules", "--", url, dest];
}

// ── Trust ───────────────────────────────────────────────────────────────────────────────────────
// Registering a repo means code from that repo runs on this box, unattended, as this user — the
// bootstrap hook is read from the repo itself. So something has to decide whether that is allowed,
// and it cannot be a prompt: the whole point of the box is that nobody is sitting at it.
//
// The rule is ownership. A repo owned by the account you are logged in as, or by an organisation
// you belong to, is code you already have. Anything else is not, and stops for a deliberate step.

/**
 * @param {object} a
 * @param {string} a.owner      owner segment from the clone URL
 * @param {string|null} a.login authenticated git account, or null if unknown
 * @param {string[]} a.orgs     organisations that account belongs to
 * @returns {{trusted: boolean, basis: string, reason: string}}
 */
export function trustDecision({ owner, login, orgs = [] }) {
  const o = String(owner || "").toLowerCase();
  if (!o) return { trusted: false, basis: "none", reason: "no owner could be read from the URL" };

  if (login && o === String(login).toLowerCase()) {
    return { trusted: true, basis: "owner", reason: `owned by you (${login})` };
  }
  const match = orgs.find((org) => String(org).toLowerCase() === o);
  if (match) {
    return { trusted: true, basis: "org", reason: `owned by ${match}, an organisation you belong to` };
  }
  if (!login) {
    return {
      trusted: false,
      basis: "unknown-identity",
      // Worth separating from a plain refusal: the repo may well be fine, we just cannot tell.
      reason: "no signed-in git account, so ownership could not be checked",
    };
  }
  return { trusted: false, basis: "foreign", reason: `owned by ${owner}, which is not you or one of your organisations` };
}

// ── Capacity ────────────────────────────────────────────────────────────────────────────────────

/**
 * How many Claude sessions this box may run at once.
 *
 * A Claude session is a large Node process plus its children, so the honest limit on a small box is
 * memory, not preference. 800 MB per session is a working estimate; 60% of total leaves room for
 * everything that is not a session. Deliberately never returns 0 — a repo that can run nothing is
 * worse than a repo that can run one thing and queue.
 */
export function capacityFor(memTotalMb, _unused = 1, perSessionMb = 800) {
  const usable = Math.floor((Number(memTotalMb) || 0) * 0.6);
  return Math.max(1, Math.min(8, Math.floor(usable / perSessionMb) || 1));
}

/** Memory ceiling for the slice that holds every server, so one busy repo cannot take the box. */
export function sliceMemoryMax(memTotalMb) {
  return `${Math.max(512, Math.floor((Number(memTotalMb) || 1024) * 0.75))}M`;
}

// ── systemd ─────────────────────────────────────────────────────────────────────────────────────

/** Quote a token for a systemd ExecStart line, but only when it actually needs it. */
function execToken(value) {
  const s = String(value);
  return /[\s'"\\]/.test(s) ? `"${s.replace(/(["\\])/g, "\\$1")}"` : s;
}


// ── Session ids ─────────────────────────────────────────────────────────────────────────────────
// A session id becomes a systemd instance, a directory under the workspace, and a git branch. Same
// rule as a repo name, with more room, because it carries the repo and the task as well as a
// disambiguator.

export const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Trim anything that is not a-z0-9 down to hyphens, collapse runs, and cap the length. */
export function slugify(raw, max = 24) {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/**
 * `<repo>-<task>-<suffix>`, so a glance at the Claude app tells you which repo and which job.
 *
 * The suffix is what makes two sessions on the same task distinct — without it the second one would
 * collide with the first's worktree and branch. It comes from the caller so tests are deterministic.
 */
export function makeSessionId({ repo, task, suffix }) {
  const repoPart = slugify(repo, 20);
  const taskPart = slugify(task, 24);
  if (!repoPart) return { ok: false, reason: "a repo is required" };
  const parts = [repoPart, taskPart, slugify(suffix, 8)].filter(Boolean);
  return validateSessionId(parts.join("-"));
}

export function validateSessionId(raw) {
  const id = String(raw ?? "").trim();
  if (!SESSION_ID_PATTERN.test(id)) {
    return { ok: false, reason: "session ids use a-z, 0-9 and hyphens, and stop at 63 characters" };
  }
  return { ok: true, id };
}

/**
 * The per-session unit, rendered once as a template and instanced per session.
 *
 * The shape changed after the first real test on a VPS. It used to be one long-lived
 * `claude remote-control --spawn worktree` server per repo, with sessions started from the Claude
 * app. Two things were wrong with that, and both only showed up on the box:
 *
 *   - Sessions started from the app's + button skip the bootstrap entirely unless a Claude
 *     `SessionStart` hook runs it, and hooks can be abandoned mid-flight — the binary carries
 *     "hook timed out (per-hook abort)". A session that quietly starts on a stale tree is worse
 *     than one that does not start.
 *   - One server holding N registrations means killing it orphans all N at once, and the app goes
 *     on offering a session that has nothing behind it.
 *
 * `ExecStartPre` fixes the first outright, and it is the reason this shape is better rather than
 * merely different: systemd runs it to completion before Claude exists, with its own timeout, into
 * the journal, and a non-zero exit fails the unit. The bootstrap cannot silently not happen.
 *
 * `Restart=on-failure`, not `always`: a session that finished is finished. Respawning it would put
 * a fresh Claude in a worktree whose work is already done.
 *
 * Two things carried over from the server version, both of which the systemd container proved:
 *
 *  • `script -qfec … /dev/null` for the PTY. Remote Control starts an interactive session, and with
 *    tmux instead, shutdown raced (clean 3 times in 5) and nothing was ever logged. This form was
 *    clean 10 times in 10 with Claude's output in the journal.
 *
 *  • `claudeBin` resolved by the caller and written absolute, because the systemd user manager
 *    inherits no PATH and Claude Code installs to ~/.local/bin, not /usr/local/bin.
 */
export function renderSessionUnit({
  stem = "skillhost",
  sessionRoot,
  claudeBin,
  scriptBin = "/usr/bin/script",
  bootstrapRunner,
  permissionMode = "auto",
  pathEnv = "%h/.local/bin:/usr/local/bin:/usr/bin:/bin",
  bootstrapTimeoutSec = 600,
  slice = "skillhost.slice",
  memoryMax = null,
}) {
  const inner = [claudeBin, "--remote-control", "%i", "--permission-mode", permissionMode].join(" ");

  const lines = [
    "# Managed by claude-skills — written by host-setup.mjs / skillhost.",
    "# One instance per Claude session. Edits here are replaced when you re-run the setup.",
    "[Unit]",
    "Description=Claude session %i",
    "Documentation=https://github.com/adamlinscott/claude-skills",
    // These two belong in [Unit], not [Service]. systemd ignores them in [Service] with only a log
    // line nobody reads, so a broken session would retry for ever instead of landing in `failed`
    // where `skillhost doctor` can see it. Caught by docker/systemd-tests.sh, not by review.
    "StartLimitIntervalSec=120",
    // One retry, not three. A bootstrap that failed on a transient `git fetch` deserves a second
    // go; one that failed because the script is wrong will fail identically every time, and three
    // attempts at ten seconds each leaves a broken session sitting in `activating` for forty
    // seconds, reported as "starting" when it is really already beaten.
    "StartLimitBurst=2",
    "",
    "[Service]",
    "Type=exec",
    // Derived from the instance name, so one template covers every session.
    `WorkingDirectory=${sessionRoot}/%i`,
    `Environment=PATH=${pathEnv}`,
    "Environment=CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX=%i",
    `Environment=SKILLHOST_SESSION=%i`,
    // The whole point of this shape. Runs to completion, in the worktree, before Claude exists.
    // Non-zero here means the unit fails and no session is ever registered.
    `ExecStartPre=${execToken(bootstrapRunner)} %i`,
    `TimeoutStartSec=${bootstrapTimeoutSec}`,
    `ExecStart=${execToken(scriptBin)} -qfec ${execToken(inner)} /dev/null`,
    "KillMode=control-group",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=20",
    // A crash is worth retrying; a finished session is not. `always` would respawn Claude into a
    // worktree whose job is already done.
    "Restart=on-failure",
    "RestartSec=5",
    "LimitNOFILE=65536",
    `Slice=${slice}`,
  ];
  if (memoryMax) lines.push(`MemoryMax=${memoryMax}`);
  lines.push("", "[Install]", "WantedBy=default.target", "");
  return lines.join("\n");
}

/**
 * The script `ExecStartPre` runs. One file, dispatching on the session's own metadata, so the unit
 * template stays fixed while every session can have a different repo and a different bootstrap.
 *
 * A repo that commits its own `.claude/bootstrap.sh` wins over the hook named at registration —
 * the repo knows what it needs better than a line in a config file does.
 */
export function renderBootstrapRunner({ stateDir, hooksDir, workspaceRoot }) {
  return `#!/usr/bin/env bash
# Managed by claude-skills. Run by ExecStartPre before each Claude session starts.
#
# It runs in the session's fresh worktree and must finish. If it exits non-zero, systemd fails the
# unit and no session is registered — which is the entire reason the bootstrap lives here rather
# than in a Claude SessionStart hook, where a slow script can be abandoned and the session starts
# anyway on a tree that was never prepared.

set -uo pipefail

SESSION="\${1:?no session id}"
META="${stateDir}/sessions/\$SESSION.json"
WORKTREE="${workspaceRoot}/.sessions/\$SESSION"

if [ ! -d "\$WORKTREE" ]; then
  echo "skillhost: no worktree at \$WORKTREE" >&2
  exit 1
fi
cd "\$WORKTREE" || exit 1

REPO=""
HOOK=""
if [ -r "\$META" ]; then
  REPO=\$(sed -n 's/.*"repo"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "\$META" | head -1)
  HOOK=\$(sed -n 's/.*"hook"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "\$META" | head -1)
fi

export CLAUDE_PROJECT_DIR="\$WORKTREE"
export SKILLHOST_SESSION="\$SESSION"
export SKILLHOST_REPO="\$REPO"
export SKILLHOST_ROOT="${workspaceRoot}"
# Never wait for input. There is no terminal here and nobody to type at one; a git command that
# prompts would hold the session in "starting" until TimeoutStartSec kills it.
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=yes"

# The repo's own script wins, if it ships one.
if [ -x "\$WORKTREE/.claude/bootstrap.sh" ]; then
  echo "skillhost: running the repo's own .claude/bootstrap.sh"
  exec "\$WORKTREE/.claude/bootstrap.sh"
fi

if [ -n "\$HOOK" ] && [ -x "${hooksDir}/\$HOOK" ]; then
  echo "skillhost: running \$HOOK"
  exec "${hooksDir}/\$HOOK"
fi

echo "skillhost: no bootstrap for \${REPO:-this session} — starting as-is"
exit 0
`;
}

/**
 * The shared slice.
 *
 * It matters more now than it did with one server per repo: sessions are started on demand, so
 * nothing bounds how many exist except this. Without a ceiling, the OOM killer arrives and does not
 * politely pick a Claude session — it may take sshd, and then the box is gone.
 */
export function renderSlice({ memoryMax, tasksMax = 4096 }) {
  return [
    "# Managed by claude-skills. Holds every Claude session on this box, with one shared ceiling.",
    "[Unit]",
    "Description=Claude sessions",
    "",
    "[Slice]",
    `MemoryMax=${memoryMax}`,
    `MemoryHigh=${memoryMax}`,
    `TasksMax=${tasksMax}`,
    "",
  ].join("\n");
}

export const sessionUnitName = (stem, id) => `${stem}-session@${id}.service`;

// ── Settings merge ──────────────────────────────────────────────────────────────────────────────
// install.mjs writes into the user's CLAUDE.md between HTML comment markers, so removing a block is
// exact. JSON has no comments, so the same precision has to come from the manifest instead: record
// every rule added, and remove exactly those on the way out. Anything the user added by hand stays.

/**
 * Merge permission rules into an existing settings object without clobbering anything.
 * Returns { merged, added } where `added` is what the manifest records.
 */
export function mergeSettings(existing, additions) {
  const merged = structuredClone(existing ?? {});
  const added = { allow: [], deny: [], ask: [] };
  merged.permissions = merged.permissions ?? {};

  for (const band of ["allow", "deny", "ask"]) {
    const incoming = additions?.permissions?.[band];
    if (!Array.isArray(incoming) || incoming.length === 0) continue;
    const current = Array.isArray(merged.permissions[band]) ? merged.permissions[band] : [];
    const seen = new Set(current);
    for (const rule of incoming) {
      if (seen.has(rule)) continue;
      seen.add(rule);
      current.push(rule);
      added[band].push(rule);
    }
    merged.permissions[band] = current;
  }

  // Scalars are only ever filled in, never overwritten: a value the user chose beats our default.
  for (const [key, value] of Object.entries(additions ?? {})) {
    if (key === "permissions") continue;
    if (merged[key] === undefined) merged[key] = value;
  }
  return { merged, added };
}

/** Undo exactly what mergeSettings added, per the manifest. Rules added by hand are left alone. */
export function unmergeSettings(existing, added) {
  const merged = structuredClone(existing ?? {});
  if (!merged.permissions) return merged;
  for (const band of ["allow", "deny", "ask"]) {
    const remove = new Set(added?.[band] ?? []);
    if (!remove.size || !Array.isArray(merged.permissions[band])) continue;
    merged.permissions[band] = merged.permissions[band].filter((r) => !remove.has(r));
    if (merged.permissions[band].length === 0) delete merged.permissions[band];
  }
  if (Object.keys(merged.permissions).length === 0) delete merged.permissions;
  return merged;
}

// ── Config and repo list ────────────────────────────────────────────────────────────────────────
// Read at run time from vps/, never baked in, so tuning the setup means editing an obvious file
// rather than editing this script.

export const DEFAULT_CONFIG = {
  workspaceRoot: "~/workspace",
  stem: "skillhost",
  permissionMode: "auto",
  capacity: "auto",
  perSessionMb: 800,
  allowedHosts: ["github.com", "gitlab.com"],
  bind: "127.0.0.1",
  port: 7717,
  autoTrust: { owner: true, org: true },
  retentionDays: 14,
};

export function loadConfig(raw) {
  let parsed = {};
  if (typeof raw === "string" && raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // A broken config must stop the run and name the parse error. Silently falling back to
      // defaults would apply a policy the user did not write and cannot see.
      return { ok: false, reason: `vps/config.json is not valid JSON — ${err.message}` };
    }
  }
  const config = { ...DEFAULT_CONFIG, ...parsed };
  config.autoTrust = { ...DEFAULT_CONFIG.autoTrust, ...(parsed.autoTrust ?? {}) };
  if (!Array.isArray(config.allowedHosts) || config.allowedHosts.length === 0) {
    return { ok: false, reason: "allowedHosts must list at least one host" };
  }
  if (config.bind !== "127.0.0.1" && config.bind !== "localhost" && config.bind !== "::1") {
    // Deliberately not configurable to a public address. Exposure is Tailscale's job or an SSH
    // tunnel's; a bind address that reaches the internet turns a convenience into an open door.
    return { ok: false, reason: "bind must stay on loopback — expose it with Tailscale or an SSH tunnel instead" };
  }
  return { ok: true, config };
}

/**
 * One line per repo: `<name> | <git url> | <bootstrap hook, or ->`.
 * Same shape as skills.txt, for the same reason: a person edits this, not a program.
 */
export function parseRepos(text) {
  const rows = [];
  const problems = [];
  for (const [index, line] of String(text ?? "").split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [name = "", url = "", hook = ""] = trimmed.split("|").map((p) => p.trim());
    const checked = validateName(name);
    if (!checked.ok) {
      problems.push(`line ${index + 1}: ${checked.reason}`);
      continue;
    }
    if (!url) {
      problems.push(`line ${index + 1}: no URL for "${name}"`);
      continue;
    }
    if (rows.some((r) => r.name === checked.name)) {
      problems.push(`line ${index + 1}: "${checked.name}" appears more than once`);
      continue;
    }
    rows.push({ name: checked.name, url, hook: hook && hook !== "-" ? hook : null });
  }
  return { rows, problems };
}

/** A hook name must be a bare filename inside vps/hooks, never a path that can climb out of it. */
export function validateHookName(raw, available = []) {
  if (raw === null || raw === undefined || raw === "" || raw === "-") return { ok: true, hook: null };
  const hook = String(raw).trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(hook) || hook.includes("..")) {
    return { ok: false, reason: "a hook name is a plain file name, with no directories in it" };
  }
  if (available.length && !available.includes(hook)) {
    return { ok: false, reason: `no hook called "${hook}" in vps/hooks` };
  }
  return { ok: true, hook };
}

// ── Logging ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Strip anything that could forge a log line or drive the reader's terminal.
 *
 * Logs get read with `cat` by someone trying to work out what went wrong, and a URL carrying ANSI
 * escapes can rewrite what they see at exactly that moment.
 */
export function sanitiseLogValue(value) {
  return String(value).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 512);
}

export function logLine(event, fields = {}) {
  const safe = {};
  for (const [k, v] of Object.entries(fields)) safe[k] = typeof v === "string" ? sanitiseLogValue(v) : v;
  return JSON.stringify({ event: sanitiseLogValue(event), ...safe });
}

// ── Manifest ────────────────────────────────────────────────────────────────────────────────────
// What --uninstall reverses. Without it, removal either leaves the riskiest thing installed (the
// user-scope permission rules) or deletes something the user added themselves.

export const MANIFEST_SCHEMA = 1;

export function emptyManifest() {
  return {
    schema: MANIFEST_SCHEMA,
    writtenAt: null,
    claudeVersion: null,
    stem: DEFAULT_CONFIG.stem,
    units: [],
    files: [],
    repos: [],
    sessions: [],
    settingsAdded: { allow: [], deny: [], ask: [] },
    lingerEnabled: false,
    gitignoreLines: [],
  };
}

export function readManifest(raw) {
  if (!raw) return emptyManifest();
  try {
    const parsed = JSON.parse(raw);
    if (parsed.schema !== MANIFEST_SCHEMA) return { ...emptyManifest(), ...parsed, schema: MANIFEST_SCHEMA };
    return { ...emptyManifest(), ...parsed };
  } catch {
    // A corrupt manifest must not stop an uninstall — it just means we know less about what to
    // take away, and the caller says so rather than pretending.
    return { ...emptyManifest(), corrupt: true };
  }
}

/** What --uninstall would do, as a list a person can read before agreeing to it. */
export function uninstallPlan(manifest, { purge = false } = {}) {
  const steps = [];
  for (const session of manifest.sessions ?? []) {
    steps.push({ kind: "session", detail: session.id, description: `end session ${session.id} and reclaim its worktree` });
  }
  for (const unit of manifest.units ?? []) steps.push({ kind: "unit", detail: unit, description: `stop and remove ${unit}` });
  for (const file of manifest.files ?? []) steps.push({ kind: "file", detail: file, description: `delete ${file}` });
  const rules = ["allow", "deny", "ask"].flatMap((b) => (manifest.settingsAdded?.[b] ?? []).map((r) => `${b}: ${r}`));
  if (rules.length) steps.push({ kind: "settings", detail: rules, description: `remove ${rules.length} permission rule(s) from ~/.claude/settings.json` });
  for (const repo of manifest.repos ?? []) {
    steps.push({ kind: "trust", detail: repo.name, description: `withdraw trust for ${repo.name}` });
    if (purge) steps.push({ kind: "clone", detail: repo.path, description: `DELETE the clone and worktrees at ${repo.path}` });
  }
  if (manifest.lingerEnabled) steps.push({ kind: "linger", detail: null, description: "turn linger back off (services stop at logout again)" });
  if (!purge && (manifest.repos ?? []).length) {
    steps.push({ kind: "note", detail: null, description: "your clones are left alone — pass --purge to delete them too" });
  }
  return steps;
}
