// Temp fixture trees for the tests: a fake home with ~/.claude/projects transcripts, and fake git
// repositories and worktrees made of plain files (no git binary involved).

import fs from "node:fs";
import { after } from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeIo } from "../cli.mjs";
import { createDiscover } from "../discover.mjs";

export const defaultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const NOW = Date.parse("2026-10-09T12:00:00Z");

// Every temp root made in a test file is removed when that file's tests are done.
const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

export function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-office-"));
  roots.push(root);
  return root;
}

function write(p, text, ageSeconds) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  if (ageSeconds !== undefined) touch(p, ageSeconds);
}

export function touch(p, ageSeconds) {
  const t = new Date(NOW - ageSeconds * 1000);
  fs.utimesSync(p, t, t);
}

/** A main checkout: <dir>/.git as a directory, on `branch`. */
export function gitRepo(dir, branch = "main") {
  write(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  return dir;
}

/** A linked worktree of `mainDir` at `dir`: a .git file pointing at .git/worktrees/<name>. */
export function gitWorktree(mainDir, dir, name, branch, { absoluteCommondir = false } = {}) {
  const gitDir = path.join(mainDir, ".git", "worktrees", name);
  write(path.join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
  write(path.join(gitDir, "commondir"), absoluteCommondir ? path.join(mainDir, ".git") + "\n" : "../..\n");
  write(path.join(dir, ".git"), `gitdir: ${gitDir}\n`);
  return dir;
}

export const at = (ageSeconds) => new Date(NOW - ageSeconds * 1000).toISOString();

// Transcript lines, shaped as the probe found them.
export const line = {
  user: (cwd, text, age = 30, extra = {}) => ({ type: "user", cwd, timestamp: at(age), message: { role: "user", content: text }, ...extra }),
  text: (cwd, text, age = 30, extra = {}) => ({ type: "assistant", cwd, timestamp: at(age), message: { role: "assistant", content: [{ type: "text", text }] }, ...extra }),
  tool: (cwd, name, input, age = 30, extra = {}) => ({ type: "assistant", cwd, timestamp: at(age), message: { role: "assistant", content: [{ type: "tool_use", id: "t" + Math.random(), name, input }] }, ...extra }),
  spawn: (cwd, toolUseId, input = {}, age = 30) => ({ type: "assistant", cwd, timestamp: at(age), message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "Agent", input }] } }),
  result: (cwd, toolUseId, toolUseResult, age = 30, isError = false) => ({ type: "user", cwd, timestamp: at(age), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "…", is_error: isError }] }, toolUseResult }),
  title: (aiTitle) => ({ type: "ai-title", aiTitle }),
  notify: (agentId, status, age = 10) => ({
    type: "queue-operation",
    operation: "enqueue",
    timestamp: at(age),
    content: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>${status}</status>\n<result>finished</result>\n</task-notification>`,
  }),
};

const jsonl = (lines) => lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";

/** A session transcript under <home>/.claude/projects/<slug>/<id>.jsonl, last written `age` seconds ago. */
export function session(home, id, lines, { slug = "proj", age = 10 } = {}) {
  const p = path.join(home, ".claude", "projects", slug, `${id}.jsonl`);
  write(p, jsonl(lines), age);
  return p;
}

/** A subagent transcript plus its meta.json, inside that session's subagents/ folder. */
export function agent(home, sessionId, agentId, meta, lines, { slug = "proj", age = 10 } = {}) {
  const dir = path.join(home, ".claude", "projects", slug, sessionId, "subagents");
  write(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta), age);
  const p = path.join(dir, `agent-${agentId}.jsonl`);
  write(p, jsonl(lines), age);
  return p;
}

export function discoverIn(home, opts = {}) {
  const io = nodeIo({ claudeDir: path.join(home, ".claude"), now: () => NOW, run: null, ...opts });
  return createDiscover(io, { defaultsDir });
}
