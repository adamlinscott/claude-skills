// A fake box: an in-memory filesystem and a recording executor.
//
// This is what makes the security rules testable from Windows. Every command host-steps.mjs would
// run is captured as (command, argv) rather than executed, so a test can assert that a clone really
// does carry `--` before the URL, and that deleting a repo called `../../etc` never reaches `rm`.

import { posix as path } from "node:path";

/** Minimal node:fs shape, enough for host-steps.mjs, backed by a Map. */
export function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set(["/"]);

  const addDirs = (file) => {
    let dir = path.dirname(file);
    while (dir && dir !== "/" && !dirs.has(dir)) {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  };
  for (const file of files.keys()) addDirs(file);

  return {
    files,
    dirs,
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return files.get(p);
    },
    writeFileSync: (p, data, opts = {}) => {
      addDirs(p);
      files.set(p, opts.flag === "a" ? (files.get(p) ?? "") + data : data);
    },
    mkdirSync: (p, opts = {}) => {
      if (dirs.has(p) && opts.recursive === false) {
        throw Object.assign(new Error(`EEXIST: ${p}`), { code: "EEXIST" });
      }
      if (!opts.recursive && dirs.has(p)) {
        throw Object.assign(new Error(`EEXIST: ${p}`), { code: "EEXIST" });
      }
      dirs.add(p);
      addDirs(`${p}/x`);
    },
    rmSync: (p) => {
      for (const key of [...files.keys()]) if (key === p || key.startsWith(`${p}/`)) files.delete(key);
      for (const key of [...dirs]) if (key === p || key.startsWith(`${p}/`)) dirs.delete(key);
    },
    renameSync: (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
      addDirs(to);
    },
    readdirSync: (p) => {
      const out = new Set();
      for (const key of files.keys()) if (key.startsWith(`${p}/`)) out.add(key.slice(p.length + 1).split("/")[0]);
      return [...out];
    },
    statSync: (p) => {
      if (!files.has(p) && !dirs.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return { mtimeMs: Date.now() };
    },
  };
}

/**
 * A recording executor.
 *
 * `responses` maps a prefix of the rendered command line to a canned result, so a test can say what
 * `git remote get-url origin` returns without caring how it was assembled. Anything unmatched
 * succeeds silently, which keeps a test focused on the one call it is about.
 */
export function fakeRun(responses = {}) {
  const calls = [];
  const run = (command, argv = [], opts = {}) => {
    calls.push({ command, argv, opts, line: `${command} ${argv.join(" ")}` });
    for (const [prefix, response] of Object.entries(responses)) {
      if (`${command} ${argv.join(" ")}`.startsWith(prefix)) {
        return { ok: true, code: 0, stdout: "", stderr: "", ...response };
      }
    }
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  run.calls = calls;
  run.find = (prefix) => calls.filter((c) => c.line.startsWith(prefix));
  run.ran = (prefix) => calls.some((c) => c.line.startsWith(prefix));
  return run;
}

export const HOME = "/home/dev";

/** The default responses that make a box look healthy, so each test only overrides what it cares about. */
export function healthyResponses(extra = {}) {
  return {
    "which claude": { stdout: `${HOME}/.local/bin/claude\n` },
    // `script` from util-linux is what gives Claude a PTY under systemd. tmux is not used.
    "which script": { stdout: "/usr/bin/script\n" },
    "which git": { stdout: "/usr/bin/git\n" },
    "which gh": { stdout: "/usr/bin/gh\n" },
    [`${HOME}/.local/bin/claude remote-control --help`]: { stdout: "--spawn worktree --capacity" },
    [`${HOME}/.local/bin/claude auth status`]: { stdout: "Logged in as dev" },
    "loginctl show-user": { stdout: "Linger=yes\n" },
    "systemctl --user is-system-running": { stdout: "running\n" },
    "/usr/bin/gh api user --jq .login": { stdout: "adamlinscott\n" },
    "/usr/bin/gh api user/orgs": { stdout: "lorveil\nsomeother\n" },
    ...extra,
  };
}
