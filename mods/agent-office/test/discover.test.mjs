import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { normalize, pathKey } from "../git.mjs";
import { nodeIo } from "../cli.mjs";
import { createDiscover, loadConfig } from "../discover.mjs";
import { NOW, defaultsDir, tempRoot, gitRepo, gitWorktree, line, session, agent, discoverIn, touch, at } from "./fixture.mjs";

// One project (a main checkout plus a linked worktree elsewhere on disk) and an unrelated repo.
function office() {
  const root = tempRoot();
  const home = path.join(root, "home");
  const main = gitRepo(path.join(root, "projects", "repo"), "main");
  const wt = gitWorktree(main, path.join(root, "orca", "wt"), "wt", "feature/a");
  const other = gitRepo(path.join(root, "other"), "main");
  return { root, home, main, wt, other };
}

const byId = (snap) => Object.fromEntries(snap.sessions.map((s) => [s.id, s]));
// Windows paths are case-folded by shape; the temp folder decides which shape these tests get.
const fold = (p) => (path.sep === "\\" ? p.toLowerCase() : p);

test("groups sessions by git common dir across worktrees; skips bad lines; title falls back to branch", async () => {
  const { home, main, wt, other } = office();
  session(home, "s-main", ["not json {", line.title("Old title"), line.user(main, "hi", 60, { gitBranch: "main" }), line.title("Room label"), "{}"]);
  session(home, "s-wt", [line.user(wt, "hi")], { slug: "wt" });
  session(home, "s-other", [line.user(other, "hi")], { slug: "other" });

  const snap = await discoverIn(home).snapshot({ project: main });
  const s = byId(snap);
  assert.equal(snap.status, null);
  assert.equal(pathKey(snap.project), pathKey(path.join(main, ".git")));
  assert.deepEqual(Object.keys(s).sort(), ["s-main", "s-wt"]);
  assert.equal(s["s-main"].title, "Room label");
  assert.equal(s["s-main"].branch, "main");
  // No ai-title and no gitBranch on its lines: the branch comes from git, and the title from that.
  assert.equal(s["s-wt"].branch, "feature/a");
  assert.equal(s["s-wt"].title, "feature/a");
  assert.equal(s["s-wt"].worktree, normalize(wt));
  assert.equal(s["s-wt"].cwd, normalize(wt));
});

test("liveness: active, idle, hidden — and a busy subagent keeps a quiet session live", async () => {
  const { home, main } = office();
  session(home, "active", [line.user(main, "x")], { age: 30 });
  session(home, "idle", [line.user(main, "x")], { age: 10 * 60 });
  session(home, "gone", [line.user(main, "x")], { age: 40 * 60 });
  session(home, "waiting", [line.user(main, "x")], { age: 50 * 60 });
  agent(home, "waiting", "a1", { agentType: "scout" }, [line.tool(main, "Grep", { pattern: "x" })], { age: 20 });

  const s = byId(await discoverIn(home).snapshot({ project: main }));
  assert.equal(s.active.status, "active");
  assert.equal(s.idle.status, "idle");
  assert.equal(s.gone, undefined);
  assert.equal(s.waiting.status, "active");
  assert.equal(s.waiting.lastActive, new Date(NOW - 20000).toISOString());
});

test("self: an explicit id comes first; otherwise the newest transcript in this folder, flagged when ambiguous", async () => {
  const { home, main, wt } = office();
  session(home, "older", [line.user(main, "x")], { age: 50 });
  session(home, "newer", [line.user(main, "x")], { age: 20 });
  session(home, "in-wt", [line.user(wt, "x")], { age: 5, slug: "wt" });

  const explicit = await discoverIn(home).snapshot({ project: main, self: "older" });
  assert.equal(explicit.self, "older");
  assert.equal(explicit.sessions[0].id, "older");
  assert.equal(explicit.selfAmbiguous, false);

  const guessed = await discoverIn(home).snapshot({ project: main });
  assert.equal(guessed.self, "newer");
  assert.equal(guessed.selfAmbiguous, true);
  assert.equal(guessed.sessions[0].id, "newer");

  const single = await discoverIn(home).snapshot({ project: wt });
  assert.equal(single.self, "in-wt");
  assert.equal(single.selfAmbiguous, false);
});

test("foreground agent: running until the parent's tool_result says completed", async () => {
  const { home, main } = office();
  const lines = [line.tool(main, "Agent", { subagent_type: "researcher" }, 100)];
  session(home, "s", lines);
  agent(home, "s", "fg1", { agentType: "researcher", toolUseId: "tu-fg1" }, [line.tool(main, "WebFetch", { url: "u" }, 5)], { age: 5 });
  let a = byId(await discoverIn(home).snapshot({ project: main })).s.agents[0];
  assert.equal(a.status, "running");
  assert.equal(a.zone, "library");
  assert.equal(a.lastTool, "WebFetch");
  assert.equal(a.finalMessage, null);

  session(home, "s", [...lines, line.result(main, "tu-fg1", { status: "completed", agentType: "researcher", totalDurationMs: 9 }, 2)]);
  agent(home, "s", "fg1", { agentType: "researcher", toolUseId: "tu-fg1" }, [line.tool(main, "WebFetch", { url: "u" }, 5), line.text(main, "Found it.", 3)], { age: 3 });
  a = byId(await discoverIn(home).snapshot({ project: main })).s.agents[0];
  assert.equal(a.status, "done");
  assert.equal(a.finalMessage, "Found it.");
});

test("background agent: the launch acknowledgement is not done; the task-notification is", async () => {
  const { home, main } = office();
  const launch = [line.tool(main, "Agent", { run_in_background: true }, 100), line.result(main, "tu-bg", { isAsync: true, status: "async_launched", agentId: "bg1" }, 99)];
  const work = [line.tool(main, "Grep", { pattern: "x", path: "agents/" }, 20), line.text(main, "Report.", 8)];
  session(home, "s", launch);
  agent(home, "s", "bg1", { agentType: "scout", toolUseId: "tu-bg", requestShape: "background" }, work, { age: 8 });
  let a = byId(await discoverIn(home).snapshot({ project: main })).s.agents[0];
  assert.equal(a.status, "running"); // quiet for 8s only, and no notification yet
  assert.equal(a.zone, "archive");
  assert.equal(a.lastFile, "agents");

  session(home, "s", [...launch, line.notify("bg1", "completed", 5)]);
  a = byId(await discoverIn(home).snapshot({ project: main })).s.agents[0];
  assert.equal(a.status, "done");
  assert.equal(a.finalMessage, "Report.");

  session(home, "s", [...launch, line.notify("bg1", "killed", 5)]);
  assert.equal(byId(await discoverIn(home).snapshot({ project: main })).s.agents[0].status, "killed");

  // Resumed after the notification: it has written since, so it is running again.
  session(home, "s", [...launch, line.notify("bg1", "completed", 5)]);
  agent(home, "s", "bg1", { agentType: "scout", toolUseId: "tu-bg" }, [...work, line.user(main, "one more thing", 2)], { age: 2 });
  assert.equal(byId(await discoverIn(home).snapshot({ project: main })).s.agents[0].status, "running");
});

test("quiet rule: no signal found, quiet past the window and not waiting on a tool → done", async () => {
  const { home, main } = office();
  session(home, "s", [line.user(main, "x")]);
  agent(home, "s", "q1", { agentType: "worker", toolUseId: "unseen" }, [line.text(main, "All done.", 120)], { age: 120 });
  agent(home, "s", "q2", { agentType: "worker", toolUseId: "unseen2" }, [line.tool(main, "Bash", { command: "npm test" }, 120)], { age: 120 });
  const agents = Object.fromEntries(byId(await discoverIn(home).snapshot({ project: main })).s.agents.map((a) => [a.id, a]));
  assert.equal(agents.q1.status, "done");
  assert.equal(agents.q2.status, "running");
});

test("spawn in view: a long-quiet agent stays running until its tool_result or notification arrives", async () => {
  const { home, main } = office();
  session(home, "s", [
    line.spawn(main, "tu-fg", { subagent_type: "worker" }, 600),
    line.spawn(main, "tu-bg", { run_in_background: true }, 600),
    line.result(main, "tu-bg", { isAsync: true, status: "async_launched", agentId: "bg" }, 599),
  ]);
  // Both quiet for five minutes after a plain text line: the quiet rule alone would call them done.
  agent(home, "s", "fg", { agentType: "worker", toolUseId: "tu-fg" }, [line.text(main, "Thinking it over.", 300)], { age: 300 });
  agent(home, "s", "bg", { agentType: "worker", toolUseId: "tu-bg" }, [line.text(main, "Thinking it over.", 300)], { age: 300 });
  const agents = Object.fromEntries(byId(await discoverIn(home).snapshot({ project: main })).s.agents.map((a) => [a.id, a.status]));
  assert.deepEqual(agents, { fg: "running", bg: "running" });
});

test("stalled: spawn in view, no signal, and both the agent and its session quiet past stalledMinutes", async () => {
  const { home, main } = office();
  const spawns = [line.spawn(main, "tu-orphan", { subagent_type: "worker" }, 900), line.spawn(main, "tu-busy", { subagent_type: "worker" }, 900)];
  // The session crashed ten minutes ago; one agent has been quiet as long, the other wrote just now.
  session(home, "s", spawns, { age: 600 });
  agent(home, "s", "orphan", { agentType: "worker", toolUseId: "tu-orphan" }, [line.text(main, "Halfway.", 600)], { age: 600 });
  agent(home, "s", "busy", { agentType: "worker", toolUseId: "tu-busy" }, [line.text(main, "Still going.", 10)], { age: 10 });
  let agents = Object.fromEntries(byId(await discoverIn(home).snapshot({ project: main })).s.agents.map((a) => [a.id, a]));
  assert.equal(agents.orphan.status, "stalled");
  assert.equal(agents.orphan.finalMessage, null);
  assert.equal(agents.busy.status, "running");

  // The session writes again: the same quiet agent is running, not stalled.
  session(home, "s", spawns, { age: 10 });
  agents = Object.fromEntries(byId(await discoverIn(home).snapshot({ project: main })).s.agents.map((a) => [a.id, a]));
  assert.equal(agents.orphan.status, "running");
});

test("errors: an unreadable transcript is counted, not silently dropped; all failing says so", async () => {
  const { home, main } = office();
  const bad = session(home, "bad", [line.user(main, "x")]);
  const ok = session(home, "ok", [line.user(main, "x")]);
  const badAgent = agent(home, "ok", "a1", { agentType: "worker" }, [line.text(main, "x", 5)], { age: 5 });
  const broken = new Set([pathKey(bad), pathKey(badAgent)]);
  const discoverBroken = () => {
    const io = nodeIo({ claudeDir: path.join(home, ".claude"), now: () => NOW, run: null });
    const read = io.read;
    io.read = (file, start, end) => {
      if (broken.has(pathKey(file))) throw new Error(`EBUSY: ${path.basename(file)}`);
      return read(file, start, end);
    };
    return createDiscover(io, { defaultsDir });
  };

  const some = await discoverBroken().snapshot({ project: main });
  assert.equal(some.status, null);
  assert.deepEqual(some.sessions.map((s) => s.id), ["ok"]);
  assert.deepEqual(some.sessions[0].agents, []);
  assert.equal(some.errors.count, 2);
  assert.match(some.errors.first, /^EBUSY: /);

  broken.add(pathKey(ok));
  const none = await discoverBroken().snapshot({ project: main });
  assert.deepEqual(none.sessions, []);
  assert.match(none.status, /^could not read any of 2 session transcripts: EBUSY: /);
});

test("format drift: lines that parse but never name a cwd report the format, not an empty office", async () => {
  const { home, main } = office();
  session(home, "drift", [{ type: "user", workingDir: main, timestamp: at(30), message: { role: "user", content: "x" } }, line.title("A title")]);
  const snap = await discoverIn(home).snapshot({ project: main });
  assert.equal(snap.status, "transcript format not recognised");
  assert.deepEqual(snap.sessions, []);
});

test("format drift: a session that has written only bookkeeping lines is skipped quietly", async () => {
  const { home, main } = office();
  session(home, "fresh", [
    line.title("A title"),
    { type: "mode", mode: "default" },
    { type: "last-prompt", lastPrompt: "x" },
    { type: "queue-operation", operation: "enqueue", timestamp: at(10), content: "hello" },
  ]);
  const snap = await discoverIn(home).snapshot({ project: main });
  assert.equal(snap.status, null);
  assert.deepEqual(snap.sessions, []);
});

test("config: a missing, null or wrong-typed user value falls back to the repo default, zones per entry", async () => {
  const claudeDir = path.join(tempRoot(), ".claude");
  const userDir = path.join(claudeDir, "agent-office");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDir, "config.json"),
    '{"activeMinutes": null, "idleMinutes": "30", "quietSeconds": -1, "tailBytes": 1e999, "touchedTools": "Edit", "touchedWindowMinutes": 45}',
  );
  fs.writeFileSync(path.join(userDir, "zones.json"), JSON.stringify({ scout: null, researcher: 7, worker: "garage", "*": "" }));
  const defaults = JSON.parse(fs.readFileSync(path.join(defaultsDir, "config.json"), "utf8"));
  const config = await loadConfig(nodeIo({ claudeDir }), defaultsDir);
  assert.deepEqual({ ...config, zones: { ...config.zones } }, {
    ...defaults,
    touchedWindowMinutes: 45,
    zones: { ...JSON.parse(fs.readFileSync(path.join(defaultsDir, "zones.json"), "utf8")), worker: "garage" },
  });
});

test("config: a byte count must be a whole number; a fractional tailBytes falls back to the repo default", async () => {
  const claudeDir = path.join(tempRoot(), ".claude");
  fs.mkdirSync(path.join(claudeDir, "agent-office"), { recursive: true });
  const defaults = JSON.parse(fs.readFileSync(path.join(defaultsDir, "config.json"), "utf8"));
  const tailBytes = async (value) => {
    fs.writeFileSync(path.join(claudeDir, "agent-office", "config.json"), JSON.stringify({ tailBytes: value }));
    return (await loadConfig(nodeIo({ claudeDir }), defaultsDir)).tailBytes;
  };
  assert.equal(await tailBytes(1000.5), defaults.tailBytes);
  assert.equal(await tailBytes(2048), 2048);
});

test("zones: agent types and user keys named like Object.prototype members are plain strings", async () => {
  const { home, main } = office();
  session(home, "s", [line.user(main, "x")]);
  for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    agent(home, "s", type.replace(/_/g, ""), { agentType: type }, [line.text(main, "x", 5)], { age: 5 });
  }
  const zones = async () => Object.fromEntries(byId(await discoverIn(home).snapshot({ project: main })).s.agents.map((a) => [a.type, a.zone]));
  assert.deepEqual(await zones(), { constructor: "open floor", toString: "open floor", ["__proto__"]: "open floor", hasOwnProperty: "open floor" });

  // Raw text: an object literal would turn "__proto__" into a prototype, not a key.
  fs.mkdirSync(path.join(home, ".claude", "agent-office"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "agent-office", "zones.json"), '{"__proto__": "attic"}');
  const z = await zones();
  assert.equal(z.__proto__, "attic");
  assert.equal(z.constructor, "open floor");
  assert.equal(z.toString, "open floor");
});

test("CLAUDE_CONFIG_DIR: the CLI reads projects/ and agent-office/ from it instead of ~/.claude", async () => {
  const { home, main } = office();
  session(home, "s", [line.user(main, "x")]);
  agent(home, "s", "a1", { agentType: "mystery" }, [line.text(main, "x", 5)], { age: 5 });
  fs.mkdirSync(path.join(home, ".claude", "agent-office"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "agent-office", "zones.json"), JSON.stringify({ "*": "lobby" }));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  try {
    const io = nodeIo({ now: () => NOW, run: null });
    const s = byId(await createDiscover(io, { defaultsDir }).snapshot({ project: main })).s;
    assert.equal(s.agents[0].zone, "lobby");
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test("git cache: a branch switch shows once gitCacheSeconds have passed", async () => {
  const { home, main, wt } = office();
  session(home, "s", [line.user(wt, "x")]);
  let clock = NOW;
  const discover = discoverIn(home, { now: () => clock });
  assert.equal(byId(await discover.snapshot({ project: wt })).s.branch, "feature/a");
  fs.writeFileSync(path.join(main, ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/feature/b\n");
  clock = NOW + 30000;
  assert.equal(byId(await discover.snapshot({ project: wt })).s.branch, "feature/a");
  clock = NOW + 61000;
  assert.equal(byId(await discover.snapshot({ project: wt })).s.branch, "feature/b");
});

test("worktree trap: an isolated agent's branch comes from meta.json or git, never its lines' gitBranch", async () => {
  const { root, home, main } = office();
  const iso = gitWorktree(main, path.join(root, "projects", "repo", ".claude", "worktrees", "agent-w1"), "agent-w1", "worktree-agent-w1");
  const iso2 = gitWorktree(main, path.join(root, "iso2"), "iso2", "resolved-from-git");
  session(home, "s", [line.user(main, "x", 30, { gitBranch: "main" })]);
  agent(home, "s", "w1", { agentType: "general-purpose", worktreePath: iso, worktreeBranch: "worktree-agent-w1" }, [line.tool(iso, "Read", { file_path: path.join(iso, "a.md") }, 5, { gitBranch: "main" })], { age: 5 });
  agent(home, "s", "w2", { agentType: "general-purpose" }, [line.tool(iso2, "Read", { file_path: "x" }, 5, { gitBranch: "main" })], { age: 5 });
  agent(home, "s", "w3", { agentType: "general-purpose" }, [line.tool(main, "Read", { file_path: "x" }, 5, { gitBranch: "main" })], { age: 5 });

  const s = byId(await discoverIn(home).snapshot({ project: main })).s;
  const agents = Object.fromEntries(s.agents.map((a) => [a.id, a]));
  assert.equal(s.branch, "main");
  assert.equal(agents.w1.branch, "worktree-agent-w1");
  assert.equal(agents.w1.worktree, normalize(iso));
  assert.equal(agents.w1.lastFile, "a.md");
  assert.equal(agents.w2.branch, "resolved-from-git");
  assert.equal(agents.w2.worktree, normalize(iso2));
  assert.equal(agents.w3.worktree, null);
  assert.equal(agents.w3.branch, null);
  assert.equal(agents.w1.zone, "open floor"); // not in zones.json → the "*" zone
});

test("touched files: Edit/Write/NotebookEdit in the window, from the session and its agents, relative to each worktree", async () => {
  const { home, main, wt, other } = office();
  session(home, "s", [
    line.tool(main, "Edit", { file_path: path.join(main, "Lib", "A.mjs") }, 60),
    line.tool(main, "Write", { file_path: path.join(main, "b.md") }, 60),
    line.tool(main, "NotebookEdit", { notebook_path: path.join(main, "n.ipynb") }, 60),
    line.tool(main, "Read", { file_path: path.join(main, "read-only.md") }, 60),
    line.tool(main, "Edit", { file_path: path.join(other, "outside.md") }, 60),
    line.tool(main, "Edit", { file_path: path.join(main, "stale.md") }, 40 * 60),
  ]);
  agent(home, "s", "w", { agentType: "worker" }, [line.tool(wt, "Edit", { file_path: path.join(wt, "src", "c.mjs") }, 30)], { age: 30 });
  const s = byId(await discoverIn(home).snapshot({ project: main })).s;
  assert.deepEqual(s.filesTouched, [fold("Lib/A.mjs"), "b.md", "n.ipynb", "src/c.mjs"].sort());
});

test("config: user files override per key, zones merge per agent type", async () => {
  const { home, main } = office();
  fs.mkdirSync(path.join(home, ".claude", "agent-office"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "agent-office", "zones.json"), JSON.stringify({ scout: "basement", "*": "lobby" }));
  fs.writeFileSync(path.join(home, ".claude", "agent-office", "config.json"), JSON.stringify({ activeMinutes: 20 }));
  session(home, "s", [line.user(main, "x")], { age: 10 * 60 });
  agent(home, "s", "a1", { agentType: "scout" }, [line.text(main, "x", 5)], { age: 5 });
  agent(home, "s", "a2", { agentType: "researcher" }, [line.text(main, "x", 5)], { age: 5 });
  agent(home, "s", "a3", { agentType: "mystery" }, [line.text(main, "x", 5)], { age: 5 });
  agent(home, "s", "a4", {}, [line.text(main, "x", 5)], { age: 5 });
  const s = byId(await discoverIn(home).snapshot({ project: main })).s;
  const zone = Object.fromEntries(s.agents.map((a) => [a.id, [a.type, a.zone]]));
  assert.equal(s.status, "active"); // 10 minutes old, inside the overridden 20-minute window
  assert.deepEqual(zone, { a1: ["scout", "basement"], a2: ["researcher", "library"], a3: ["mystery", "lobby"], a4: ["?", "lobby"] });
});

test("degraded: no git project, unrecognised transcripts, and cwds git can't place", async () => {
  const { root, home, main } = office();
  const loose = path.join(root, "loose");
  fs.mkdirSync(loose);
  const noGit = await discoverIn(home).snapshot({ project: loose });
  // A temp folder inside some repository would resolve; only assert when it really is outside.
  if (noGit.project === null) {
    assert.match(noGit.status, /^git could not place /);
    assert.deepEqual(noGit.sessions, []);
  }

  session(home, "junk", ["<<<", "also not json", '{"no":"type"}']);
  const junk = await discoverIn(home).snapshot({ project: main });
  assert.equal(junk.status, "transcript format not recognised");
  assert.deepEqual(junk.sessions, []);

  session(home, "removed-worktree", [line.user(path.join(root, "deleted", "wt"), "x")], { slug: "gone" });
  session(home, "ok", [line.user(main, "x")]);
  const mixed = await discoverIn(home).snapshot({ project: main });
  assert.equal(mixed.status, null);
  assert.deepEqual(mixed.sessions.map((s) => s.id), ["ok"]);
});

test("incremental reads: first sight reads only the tail; later refreshes read only appended bytes", async () => {
  const { home, main } = office();
  fs.mkdirSync(path.join(home, ".claude", "agent-office"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "agent-office", "config.json"), JSON.stringify({ tailBytes: 400 }));
  const filler = Array.from({ length: 40 }, (_, i) => line.user(main, "padding line " + i, 100));
  const p = session(home, "s", [line.title("Too early to see"), ...filler, line.title("Recent title")]);
  const reads = [];
  const io = nodeIo({ claudeDir: path.join(home, ".claude"), now: () => NOW, run: null });
  const read = io.read;
  io.read = (file, start, end) => {
    if (pathKey(file) === pathKey(p)) reads.push([start, end]);
    return read(file, start, end);
  };
  const discover = createDiscover(io, { defaultsDir });

  const size1 = fs.statSync(p).size;
  assert.equal(byId(await discover.snapshot({ project: main })).s.title, "Recent title");
  assert.deepEqual(reads, [[size1 - 400, size1]]);

  fs.appendFileSync(p, JSON.stringify(line.title("Newest title")) + "\n" + '{"type":"user","cwd":"half-writ');
  touch(p, 1);
  const size2 = fs.statSync(p).size;
  assert.equal(byId(await discover.snapshot({ project: main })).s.title, "Newest title");
  assert.deepEqual(reads[1], [size1, size2]);

  // The half-written line is re-read once it is finished.
  fs.appendFileSync(p, 'ten"}\n');
  touch(p, 1);
  await discover.snapshot({ project: main });
  assert.equal(reads[2][0], size2 - '{"type":"user","cwd":"half-writ'.length);
});
