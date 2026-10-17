#!/usr/bin/env node
// Agent Office's engine from a terminal: the office model for one git project as JSON.
//
//   node mods/agent-office/cli.mjs --json   [--project <dir>]   one model, then exit
//   node mods/agent-office/cli.mjs --stream [--project <dir>]   one model per line whenever the
//                                                                office changes, until stopped
//
// --project defaults to the current folder; any folder inside any worktree of the project will do.
// A pane runs --stream as its child. Claude Code ends a mod's spawned process with its session, and
// closes the child's stdin at once, so stdin says nothing about the pane. As a backstop for other
// hosts the stream also stops when stdout breaks or its parent process has gone.
//
// engine.mjs takes no Node APIs, so the mod can load it too. This file supplies the Node
// versions of what it needs: file access, the clock, a git runner, output and the stream's timer.

import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createEngine } from "./engine.mjs";

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
  const streaming = argv.includes("--stream");
  if (!streaming && !argv.includes("--json")) {
    process.stderr.write("usage: node cli.mjs --json|--stream [--project <dir>]\n");
    return 2;
  }
  const project = path.resolve(value("--project") || process.cwd());
  if (!streaming) {
    const engine = createEngine(nodeIo(), { defaultsDir: here, project });
    process.stdout.write(JSON.stringify(await engine.model(), null, 2) + "\n");
    return 0;
  }
  // The stream ends when stdout can no longer be written, or the parent is gone (checked each pass,
  // since an office that doesn't change writes nothing and so never finds a broken stdout). On
  // POSIX an orphan is re-parented, so a changed ppid means gone even if the old pid is reused.
  const parent = process.ppid;
  const closed = new Promise((resolve) => process.stdout.on("error", resolve));
  let open = true;
  closed.then(() => (open = false));
  const wait = (ms) => {
    let timer;
    const timeUp = new Promise((resolve) => (timer = setTimeout(() => resolve(process.ppid === parent && alive(parent)), ms)));
    return Promise.race([timeUp, closed.then(() => false)]).finally(() => clearTimeout(timer));
  };
  const write = (text) => open && new Promise((resolve) => process.stdout.write(text, () => resolve()));
  await createEngine({ ...nodeIo(), write, wait }, { defaultsDir: here, project }).stream();
  return 0;
}

// Signal 0 tests for a process without touching it: ESRCH means it is gone, EPERM that it exists.
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
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
