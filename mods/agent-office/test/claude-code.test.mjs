import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { normalize, pathKey } from "../git.mjs";
import { nodeIo } from "../cli.mjs";
import { createEngine, loadConfig } from "../engine.mjs";
import { NOW, defaultsDir, tempRoot, gitRepo, gitWorktree, line, session, agent, engineIn, byId, cc, touch, at } from "./fixture.mjs";

// One project (a main checkout plus a linked worktree elsewhere on disk) and an unrelated repo.
function office() {
  const root = tempRoot();
  const home = path.join(root, "home");
  const main = gitRepo(path.join(root, "projects", "repo"), "main");
  const wt = gitWorktree(main, path.join(root, "orca", "wt"), "wt", "feature/a");
  const other = gitRepo(path.join(root, "other"), "main");
  return { root, home, main, wt, other };
}

const modelOf = (home, project, opts) => engineIn(home, project, opts).model();
const sessionsOf = async (home, project, opts) => byId((await modelOf(home, project, opts)).sessions);
const agentsOf = async (home, project, opts) => byId((await modelOf(home, project, opts)).agents);
// Windows paths are case-folded by shape; the temp folder decides which shape these tests get.
const fold = (p) => (path.sep === "\\" ? p.toLowerCase() : p);

test("groups sessions by git common dir across worktrees; skips bad lines; title falls back to branch", async () => {
  const { home, main, wt, other } = office();
  session(home, "s-main", ["not json {", line.title("Old title"), line.user(main, "hi", 60, { gitBranch: "main" }), line.title("Room label"), "{}"]);
  session(home, "s-wt", [line.user(wt, "hi")], { slug: "wt" });
  session(home, "s-other", [line.user(other, "hi")], { slug: "other" });

  const m = await modelOf(home, main);
  const s = byId(m.sessions);
  assert.equal(m.sources[0].status, null);
  assert.equal(pathKey(m.project.id), pathKey(path.join(main, ".git")));
  assert.equal(m.project.name, "repo");
  assert.deepEqual(Object.keys(s).sort(), ["s-main", "s-wt"]);
  assert.equal(s["s-main"].title, "Room label");
  assert.equal(s["s-main"].branch, "main");
  assert.equal(s["s-main"].lead, cc("s-main:lead"));
  // No ai-title and no gitBranch on its lines: the branch comes from git, and the title from that.
  assert.equal(s["s-wt"].branch, "feature/a");
  assert.equal(s["s-wt"].title, "feature/a");
  assert.equal(s["s-wt"].checkout, normalize(wt));
});

test("liveness: active, idle, lights off — and a busy subagent keeps a quiet session live", async () => {
  const { home, main } = office();
  session(home, "active", [line.user(main, "x")], { age: 30 });
  session(home, "idle", [line.user(main, "x")], { age: 10 * 60 });
  session(home, "gone", [line.user(main, "x")], { age: 40 * 60 });
  session(home, "waiting", [line.user(main, "x")], { age: 50 * 60 });
  agent(home, "waiting", "a1", { agentType: "scout" }, [line.tool(main, "Grep", { pattern: "x" })], { age: 20 });

  const s = await sessionsOf(home, main);
  assert.equal(s.active.status, "active");
  assert.equal(s.idle.status, "idle");
  assert.deepEqual([s.active.lights, s.idle.lights, s.waiting.lights], ["on", "on", "on"]);
  assert.deepEqual([s.gone.status, s.gone.lights], ["idle", "off"]);
  assert.equal(s.waiting.status, "active");
  assert.equal(s.waiting.lastActive, at(20));
});

test("lights off: kept until lightsOffHours, with the subagents in view when the session went quiet", async () => {
  const { home, main } = office();
  const hours = (h) => h * 3600;
  fs.mkdirSync(path.join(home, ".claude", "agent-office"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "agent-office", "config.json"), JSON.stringify({ lightsOffHours: 5 }));
  session(home, "last-night", [line.user(main, "x", hours(3))], { age: hours(3) });
  // Ten minutes before the lead's last line, inside the window back from it; an hour before, not.
  agent(home, "last-night", "late", { agentType: "reviewer" }, [line.text(main, "Looks fine.", hours(3) + 600)], { age: hours(3) + 600 });
  agent(home, "last-night", "early", { agentType: "worker" }, [line.text(main, "Done.", hours(4))], { age: hours(4) });
  session(home, "too-old", [line.user(main, "x", hours(6))], { age: hours(6) });
  const m = await modelOf(home, main);
  const s = byId(m.sessions);
  assert.deepEqual([s["last-night"].lights, s["last-night"].status], ["off", "idle"]);
  assert.equal(s["too-old"], undefined);
  assert.deepEqual(m.agents.map((a) => a.id), [cc("last-night:lead"), cc("late")]);
  assert.equal(byId(m.agents).late.status, "done"); // worked out at now, by the usual rules
});

test("lights off: lightsOffHours 0 drops a session once it has been quiet for idleMinutes", async () => {
  const { root, home, main } = office();
  const defaults = path.join(root, "defaults");
  fs.mkdirSync(defaults);
  const config = JSON.parse(fs.readFileSync(path.join(defaultsDir, "config.json"), "utf8"));
  fs.writeFileSync(path.join(defaults, "config.json"), JSON.stringify({ ...config, lightsOffHours: 0 }));
  fs.copyFileSync(path.join(defaultsDir, "roles.json"), path.join(defaults, "roles.json"));
  session(home, "idle", [line.user(main, "x")], { age: 10 * 60 });
  session(home, "gone", [line.user(main, "x")], { age: 40 * 60 });
  const io = nodeIo({ claudeDir: path.join(home, ".claude"), now: () => NOW, run: null });
  const m = await createEngine(io, { defaultsDir: defaults, project: main }).model();
  assert.deepEqual(m.sessions.map((x) => [x.id, x.lights]), [[cc("idle"), "on"]]);
});

test("no self: the model is viewer-neutral, the same from any folder of the project", async () => {
  const { home, main, wt } = office();
  session(home, "older", [line.user(main, "x")], { age: 50 });
  session(home, "in-wt", [line.user(wt, "x")], { age: 5, slug: "wt" });
  const fromMain = await modelOf(home, main);
  const fromWt = await modelOf(home, wt);
  assert.equal("self" in fromMain, false);
  assert.equal("selfAmbiguous" in fromMain, false);
  assert.deepEqual(fromWt, fromMain);
  assert.deepEqual(fromMain.sessions.map((s) => s.id), [cc("in-wt"), cc("older")]); // newest first
});

test("lead: an agent with startedBy null, working while its turn is open and idle once it answers", async () => {
  const { home, main } = office();
  const prompt = line.user(main, "fix the bug", 40);
  const thinking = line.text(main, "Let me look.", 35, { message: { role: "assistant", content: [{ type: "text", text: "Let me look." }], stop_reason: "tool_use" } });
  const read = line.tool(main, "Read", { file_path: path.join(main, "a.md") }, 30);
  const lead = async () => (await agentsOf(home, main))["s:lead"];

  session(home, "s", [prompt, thinking]);
  let l = await lead();
  assert.deepEqual([l.startedBy, l.agentType, l.role, l.status, l.statusSince], [null, null, "lead", "working", at(40)]);

  session(home, "s", [prompt, thinking, read]);
  assert.deepEqual((await lead()).doing, { kind: "read", file: "a.md", since: at(30) });

  session(home, "s", [prompt, thinking, read, line.result(main, "t1", null, 25), line.text(main, "Fixed.", 20)]);
  l = await lead();
  assert.deepEqual([l.status, l.statusSince, l.doing], ["idle", at(20), null]);

  // A slash-command echo is no prompt; an interruption ends the turn.
  session(home, "s", [prompt, thinking, read, line.result(main, "t1", null, 25), line.text(main, "Fixed.", 20), line.user(main, "<command-name>/model</command-name>", 15)]);
  assert.equal((await lead()).status, "idle");
  session(home, "s", [prompt, read, line.user(main, [{ type: "text", text: "[Request interrupted by user for tool use]" }], 10)]);
  assert.equal((await lead()).status, "idle");
});

test("lead: a new prompt opens a turn doing nothing until its first tool call", async () => {
  const { home, main } = office();
  const lead = async () => (await agentsOf(home, main))["s:lead"];
  const lastTurn = [line.user(main, "fix the bug", 60), line.tool(main, "Edit", { file_path: path.join(main, "a.md") }, 50), line.result(main, "t1", null, 45), line.text(main, "Fixed.", 40)];
  session(home, "s", [...lastTurn, line.user(main, "now the docs", 20)]);
  const l = await lead();
  assert.deepEqual([l.status, l.doing], ["working", null]);
  session(home, "s", [...lastTurn, line.user(main, "now the docs", 20), line.tool(main, "Read", { file_path: path.join(main, "b.md") }, 10)]);
  assert.deepEqual((await lead()).doing, { kind: "read", file: "b.md", since: at(10) });
});

test("lead: never stalls — an open turn quiet past stalledMinutes is idle since its last message line", async () => {
  const { home, main } = office();
  const lead = async () => (await agentsOf(home, main))["s:lead"];
  // Mid-turn, then nothing for ten minutes; a bookkeeping line after the last message doesn't count.
  session(home, "s", [line.user(main, "fix the bug", 700), line.tool(main, "Read", { file_path: path.join(main, "a.md") }, 650), { ...line.title("Bug fix"), timestamp: at(600) }], { age: 600 });
  const l = await lead();
  assert.deepEqual([l.status, l.statusSince, l.doing], ["idle", at(650), null]);
});

test("foreground agent: working until the parent's tool_result says completed, then done with a report", async () => {
  const { home, main } = office();
  const lines = [line.spawn(main, "tu-fg1", { subagent_type: "researcher" }, 100)];
  session(home, "s", lines);
  agent(home, "s", "fg1", { agentType: "researcher", toolUseId: "tu-fg1" }, [line.tool(main, "WebFetch", { url: "u" }, 5)], { age: 5 });
  let m = await modelOf(home, main);
  let a = byId(m.agents).fg1;
  assert.deepEqual([a.status, a.statusSince, a.role, a.agentType], ["working", at(100), "researcher", "researcher"]);
  assert.deepEqual(a.doing, { kind: "search", since: at(5) });
  assert.deepEqual(m.reports, []);
  // The lead waits on its foreground agent inside its own turn: working, talking.
  assert.equal(byId(m.agents)["s:lead"].status, "working");
  assert.equal(byId(m.agents)["s:lead"].doing.kind, "talk");

  session(home, "s", [...lines, line.result(main, "tu-fg1", { status: "completed", agentType: "researcher", totalDurationMs: 9 }, 2)]);
  agent(home, "s", "fg1", { agentType: "researcher", toolUseId: "tu-fg1" }, [line.tool(main, "WebFetch", { url: "u" }, 5), line.text(main, "Found it.", 3)], { age: 3 });
  m = await modelOf(home, main);
  a = byId(m.agents).fg1;
  assert.deepEqual([a.status, a.statusSince, a.doing, a.extra.endState], ["done", at(2), null, "completed"]);
  assert.deepEqual(m.reports, [{ agent: cc("fg1"), at: at(3), text: "Found it." }]);
});

test("background agent: the launch acknowledgement is not done; the task-notification is", async () => {
  const { home, main } = office();
  const launch = [line.spawn(main, "tu-bg", { run_in_background: true }, 100), line.result(main, "tu-bg", { isAsync: true, status: "async_launched", agentId: "bg1" }, 99)];
  const work = [line.tool(main, "Grep", { pattern: "x", path: path.join(main, "agents") + path.sep }, 20), line.text(main, "Report.", 8)];
  session(home, "s", launch);
  agent(home, "s", "bg1", { agentType: "scout", toolUseId: "tu-bg", requestShape: "background" }, work, { age: 8 });
  let a = (await agentsOf(home, main)).bg1;
  assert.equal(a.status, "working"); // quiet for 8s only, and no notification yet
  assert.equal(a.role, "scout");
  assert.deepEqual(a.doing, { kind: "search", file: "agents", since: at(20) });

  session(home, "s", [...launch, line.notify("bg1", "completed", 5)]);
  a = (await agentsOf(home, main)).bg1;
  assert.deepEqual([a.status, a.statusSince], ["done", at(5)]);

  // Resumed after the notification: it has written since, so it is working again.
  agent(home, "s", "bg1", { agentType: "scout", toolUseId: "tu-bg" }, [...work, line.user(main, "one more thing", 2)], { age: 2 });
  assert.equal((await agentsOf(home, main)).bg1.status, "working");
});

test("stopped: a killed or stopped agent is stopped, keeps its end state, and leaves no report", async () => {
  const { home, main } = office();
  const launch = (id) => [line.spawn(main, "tu-" + id, { run_in_background: true }, 100), line.result(main, "tu-" + id, { isAsync: true, status: "async_launched" }, 99)];
  session(home, "s", [...launch("k"), ...launch("st"), ...launch("f"), line.notify("k", "killed", 6), line.notify("st", "stopped", 5), line.notify("f", "failed", 4)]);
  for (const id of ["k", "st", "f"]) agent(home, "s", id, { agentType: "worker", toolUseId: "tu-" + id }, [line.text(main, "Partial work.", 30)], { age: 30 });
  const m = await modelOf(home, main);
  const a = byId(m.agents);
  assert.deepEqual([a.k.status, a.k.extra.endState, a.k.statusSince], ["stopped", "killed", at(6)]);
  assert.deepEqual([a.st.status, a.st.extra.endState], ["stopped", "stopped"]);
  assert.deepEqual([a.f.status, a.f.extra.endState], ["failed", "failed"]);
  assert.deepEqual(m.reports.map((r) => r.agent), [cc("f")]);
  assert.deepEqual(m.waits, []);
});

test("quiet rule: no signal found, quiet past the window and not waiting on a tool → done", async () => {
  const { home, main } = office();
  session(home, "s", [line.user(main, "x")]);
  agent(home, "s", "q1", { agentType: "worker", toolUseId: "unseen" }, [line.text(main, "All done.", 120)], { age: 120 });
  agent(home, "s", "q2", { agentType: "worker", toolUseId: "unseen2" }, [line.tool(main, "Bash", { command: "npm test" }, 120)], { age: 120 });
  const a = await agentsOf(home, main);
  assert.equal(a.q1.status, "done");
  assert.equal(a.q2.status, "working");
  assert.deepEqual(a.q2.doing, { kind: "run", since: at(120) });
});

test("spawn in view: a long-quiet agent stays working until its tool_result or notification arrives", async () => {
  const { home, main } = office();
  session(home, "s", [
    line.spawn(main, "tu-fg", { subagent_type: "worker" }, 600),
    line.spawn(main, "tu-bg", { run_in_background: true }, 600),
    line.result(main, "tu-bg", { isAsync: true, status: "async_launched", agentId: "bg" }, 599),
  ]);
  // Both quiet for five minutes after a plain text line: the quiet rule alone would call them done.
  agent(home, "s", "fg", { agentType: "worker", toolUseId: "tu-fg" }, [line.text(main, "Thinking it over.", 300)], { age: 300 });
  agent(home, "s", "bg", { agentType: "worker", toolUseId: "tu-bg" }, [line.text(main, "Thinking it over.", 300)], { age: 300 });
  const a = await agentsOf(home, main);
  assert.deepEqual([a.fg.status, a.bg.status], ["working", "working"]);
  // A text line is not a tool call: working, doing nothing anyone can draw.
  assert.equal(a.fg.doing, null);
});

test("stalled: spawn in view, no signal, and both the agent and its session quiet past stalledMinutes", async () => {
  const { home, main } = office();
  const spawns = [line.spawn(main, "tu-orphan", { subagent_type: "worker" }, 900), line.spawn(main, "tu-busy", { subagent_type: "worker" }, 900)];
  // The session crashed ten minutes ago; one agent has been quiet as long, the other wrote just now.
  session(home, "s", spawns, { age: 600 });
  agent(home, "s", "orphan", { agentType: "worker", toolUseId: "tu-orphan" }, [line.tool(main, "Bash", { command: "npm test" }, 600)], { age: 600 });
  agent(home, "s", "busy", { agentType: "worker", toolUseId: "tu-busy" }, [line.text(main, "Still going.", 10)], { age: 10 });
  let m = await modelOf(home, main);
  let a = byId(m.agents);
  assert.deepEqual([a.orphan.status, a.orphan.statusSince], ["stalled", at(300)]); // quiet since 600s ago, plus 5 minutes
  assert.deepEqual(a.orphan.doing, { kind: "run", since: at(600) }); // where it stopped
  assert.equal(a.busy.status, "working");
  assert.deepEqual(m.reports, []);

  // The session writes again: the same quiet agent is working, not stalled.
  session(home, "s", spawns, { age: 10 });
  a = await agentsOf(home, main);
  assert.equal(a.orphan.status, "working");
});

test("stalled: a nested agent's quiet is measured against the subagent that started it, not the lead", async () => {
  const { home, main } = office();
  session(home, "s", [line.spawn(main, "tu-a", {}, 900)], { age: 10 }); // the lead wrote just now
  agent(home, "s", "A", { agentType: "worker", toolUseId: "tu-a" }, [line.spawn(main, "tu-b", {}, 600)], { age: 600 });
  agent(home, "s", "B", { agentType: "scout", toolUseId: "tu-b" }, [line.tool(main, "Bash", { command: "npm test" }, 600)], { age: 600 });
  const a = await agentsOf(home, main);
  assert.equal(a.A.status, "working"); // its starter, the lead, is live
  assert.deepEqual([a.B.status, a.B.statusSince], ["stalled", at(300)]); // B and A both quiet for ten minutes
});

test("startedBy: every agent names who started it, subagents of subagents included", async () => {
  const { home, main } = office();
  session(home, "s", [line.spawn(main, "tu-a", { subagent_type: "worker" }, 100)]);
  // A spawns B in its own transcript; C's spawn is out of view but meta.json names A as its parent;
  // D's named parent is not in view, so it falls back to the lead.
  agent(home, "s", "A", { agentType: "worker", toolUseId: "tu-a" }, [line.spawn(main, "tu-b", { subagent_type: "scout" }, 80)], { age: 5 });
  agent(home, "s", "B", { agentType: "scout", toolUseId: "tu-b" }, [line.tool(main, "Grep", { pattern: "x" }, 5)], { age: 5 });
  agent(home, "s", "C", { agentType: "scout", toolUseId: "tu-c", parentAgentId: "A" }, [line.tool(main, "Grep", { pattern: "x" }, 5)], { age: 5 });
  agent(home, "s", "D", { agentType: "scout", toolUseId: "tu-d", parentAgentId: "gone" }, [line.tool(main, "Grep", { pattern: "x" }, 5)], { age: 5 });
  const a = await agentsOf(home, main);
  assert.deepEqual(
    Object.fromEntries(Object.entries(a).map(([id, x]) => [id, x.startedBy])),
    { "s:lead": null, A: cc("s:lead"), B: cc("A"), C: cc("A"), D: cc("s:lead") },
  );
  assert.ok(Object.values(a).every((x) => x.session === cc("s")));
});

test("waits: a working or stalled agent owes its starter an answer, since its spawn or its first line seen", async () => {
  const { home, main } = office();
  session(home, "s", [line.spawn(main, "tu-a", {}, 100), line.spawn(main, "tu-done", {}, 100), line.result(main, "tu-done", { status: "completed" }, 50)], { age: 400 });
  agent(home, "s", "A", { agentType: "worker", toolUseId: "tu-a" }, [line.spawn(main, "tu-b", {}, 70), line.text(main, "Waiting on B.", 60)], { age: 360 });
  agent(home, "s", "B", { agentType: "scout", toolUseId: "tu-b" }, [line.tool(main, "Read", { file_path: "x" }, 5)], { age: 5 });
  agent(home, "s", "loose", { agentType: "scout", toolUseId: "unseen" }, [line.tool(main, "Read", { file_path: "x" }, 40), line.tool(main, "Read", { file_path: "y" }, 5)], { age: 5 });
  agent(home, "s", "done", { agentType: "scout", toolUseId: "tu-done" }, [line.text(main, "Done.", 55)], { age: 55 });
  const m = await modelOf(home, main);
  const a = byId(m.agents);
  assert.equal(a.A.status, "stalled"); // A and the session both quiet for six minutes
  assert.deepEqual(m.waits, [
    { waiter: cc("s:lead"), on: cc("A"), since: at(100) },
    { waiter: cc("s:lead"), on: cc("loose"), since: at(40) },
    { waiter: cc("A"), on: cc("B"), since: at(70) },
  ]);
});

test("doing: the last tool call's kind, shown while working or stalled; a file outside the checkout is dropped", async () => {
  const { home, main, other } = office();
  session(home, "s", [line.user(main, "x")]);
  const tools = { w: ["Write", { file_path: path.join(main, "w.md") }], r: ["Read", { file_path: path.join(other, "r.md") }], b: ["PowerShell", { command: "ls" }], g: ["Glob", { pattern: "*" }], t: ["SendMessage", {}], o: ["TodoWrite", {}] };
  for (const [id, [name, input]] of Object.entries(tools)) agent(home, "s", id, { agentType: "worker" }, [line.tool(main, name, input, 5)], { age: 5 });
  const a = await agentsOf(home, main);
  assert.deepEqual(
    Object.fromEntries(Object.keys(tools).map((id) => [id, a[id].doing && a[id].doing.kind])),
    { w: "write", r: "read", b: "run", g: "search", t: "talk", o: null },
  );
  assert.equal(a.w.doing.file, "w.md");
  assert.deepEqual(a.r.doing, { kind: "read", since: at(5) });
});

test("owner: git user.name names the human; without a git runner the owner is unknown", async () => {
  const { home, main } = office();
  session(home, "s", [line.user(main, "x")]);
  const run = ([, cmd]) => (cmd === "config" ? { code: 0, stdout: "Ada Lovelace\n" } : { code: 1, stdout: "" });
  const named = await modelOf(home, main, { run });
  assert.deepEqual(named.humans, [{ id: "git:Ada Lovelace", name: "Ada Lovelace" }]);
  assert.equal(named.sessions[0].owner, "git:Ada Lovelace");
  const unknown = await modelOf(home, main);
  assert.deepEqual(unknown.humans, [{ id: "git:unknown", name: null }]);
});

test("errors: an unreadable transcript is counted, not silently dropped; all failing says so", async () => {
  const { home, main } = office();
  const bad = session(home, "bad", [line.user(main, "x")]);
  const ok = session(home, "ok", [line.user(main, "x")]);
  const badAgent = agent(home, "ok", "a1", { agentType: "worker" }, [line.text(main, "x", 5)], { age: 5 });
  const broken = new Set([pathKey(bad), pathKey(badAgent)]);
  const engineBroken = () => {
    const io = nodeIo({ claudeDir: path.join(home, ".claude"), now: () => NOW, run: null });
    const read = io.read;
    io.read = (file, start, end) => {
      if (broken.has(pathKey(file))) throw new Error(`EBUSY: ${path.basename(file)}`);
      return read(file, start, end);
    };
    return createEngine(io, { defaultsDir, project: main });
  };

  const some = await engineBroken().model();
  assert.equal(some.sources[0].status, null);
  assert.deepEqual(some.sessions.map((s) => s.id), [cc("ok")]);
  assert.deepEqual(some.agents.map((a) => a.id), [cc("ok:lead")]);
  assert.equal(some.sources[0].errors.count, 2);
  assert.match(some.sources[0].errors.first, /^EBUSY: /);

  broken.add(pathKey(ok));
  const none = await engineBroken().model();
  assert.deepEqual(none.sessions, []);
  assert.match(none.sources[0].status, /^could not read any of 2 session transcripts: EBUSY: /);
});

test("format drift: lines that parse but never name a cwd report the format, not an empty office", async () => {
  const { home, main } = office();
  session(home, "drift", [{ type: "user", workingDir: main, timestamp: at(30), message: { role: "user", content: "x" } }, line.title("A title")]);
  const m = await modelOf(home, main);
  assert.equal(m.sources[0].status, "transcript format not recognised");
  assert.deepEqual(m.sessions, []);
});

test("format drift: a session that has written only bookkeeping lines is skipped quietly", async () => {
  const { home, main } = office();
  session(home, "fresh", [
    line.title("A title"),
    { type: "mode", mode: "default" },
    { type: "last-prompt", lastPrompt: "x" },
    { type: "queue-operation", operation: "enqueue", timestamp: at(10), content: "hello" },
  ]);
  const m = await modelOf(home, main);
  assert.equal(m.sources[0].status, null);
  assert.deepEqual(m.sessions, []);
});

test("config: a missing, null or wrong-typed user value falls back to the repo default, roles per entry", async () => {
  const claudeDir = path.join(tempRoot(), ".claude");
  const userDir = path.join(claudeDir, "agent-office");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDir, "config.json"),
    '{"activeMinutes": null, "idleMinutes": "30", "quietSeconds": -1, "tailBytes": 1e999, "touchedTools": "Edit", "findingsFrom": "worker", "touchedWindowMinutes": 45}',
  );
  fs.writeFileSync(path.join(userDir, "roles.json"), JSON.stringify({ scout: null, researcher: 7, worker: "builder", "*": "" }));
  const defaults = JSON.parse(fs.readFileSync(path.join(defaultsDir, "config.json"), "utf8"));
  const config = await loadConfig(nodeIo({ claudeDir }), defaultsDir);
  assert.deepEqual({ ...config, roles: { ...config.roles } }, {
    ...defaults,
    touchedWindowMinutes: 45,
    roles: { ...JSON.parse(fs.readFileSync(path.join(defaultsDir, "roles.json"), "utf8")), worker: "builder" },
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

test("config: streamSeconds below its floor falls back to the repo default", async () => {
  const claudeDir = path.join(tempRoot(), ".claude");
  fs.mkdirSync(path.join(claudeDir, "agent-office"), { recursive: true });
  const defaults = JSON.parse(fs.readFileSync(path.join(defaultsDir, "config.json"), "utf8"));
  const streamSeconds = async (value) => {
    fs.writeFileSync(path.join(claudeDir, "agent-office", "config.json"), JSON.stringify({ streamSeconds: value }));
    return (await loadConfig(nodeIo({ claudeDir }), defaultsDir)).streamSeconds;
  };
  assert.equal(await streamSeconds(0.01), defaults.streamSeconds);
  assert.equal(await streamSeconds(0.25), 0.25);
});

test("config: a person's own lightsOffHours 0 turns lights-off rooms off", async () => {
  const claudeDir = path.join(tempRoot(), ".claude");
  fs.mkdirSync(path.join(claudeDir, "agent-office"), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "agent-office", "config.json"), JSON.stringify({ lightsOffHours: 0 }));
  assert.equal((await loadConfig(nodeIo({ claudeDir }), defaultsDir)).lightsOffHours, 0);
});

test("roles: agent types and user keys named like Object.prototype members are plain strings", async () => {
  const { home, main } = office();
  session(home, "s", [line.user(main, "x")]);
  for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    agent(home, "s", type.replace(/_/g, ""), { agentType: type }, [line.text(main, "x", 5)], { age: 5 });
  }
  const roles = async () => Object.fromEntries((await modelOf(home, main)).agents.filter((a) => a.startedBy).map((a) => [a.agentType, a.role]));
  assert.deepEqual(await roles(), { constructor: "other", toString: "other", ["__proto__"]: "other", hasOwnProperty: "other" });

  // Raw text: an object literal would turn "__proto__" into a prototype, not a key.
  fs.mkdirSync(path.join(home, ".claude", "agent-office"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "agent-office", "roles.json"), '{"__proto__": "attic"}');
  const r = await roles();
  assert.equal(r.__proto__, "attic");
  assert.equal(r.constructor, "other");
  assert.equal(r.toString, "other");
});

test("CLAUDE_CONFIG_DIR: the CLI reads projects/ and agent-office/ from it instead of ~/.claude", async () => {
  const { home, main } = office();
  session(home, "s", [line.user(main, "x")]);
  agent(home, "s", "a1", { agentType: "mystery" }, [line.text(main, "x", 5)], { age: 5 });
  fs.mkdirSync(path.join(home, ".claude", "agent-office"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "agent-office", "roles.json"), JSON.stringify({ "*": "lobby" }));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  try {
    const io = nodeIo({ now: () => NOW, run: null });
    const a = byId((await createEngine(io, { defaultsDir, project: main }).model()).agents);
    assert.equal(a.a1.role, "lobby");
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test("git cache: a branch switch shows once gitCacheSeconds have passed", async () => {
  const { home, main, wt } = office();
  session(home, "s", [line.user(wt, "x")]);
  let clock = NOW;
  const engine = engineIn(home, wt, { now: () => clock });
  const branch = async () => (await engine.model()).sessions[0].branch;
  assert.equal(await branch(), "feature/a");
  fs.writeFileSync(path.join(main, ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/feature/b\n");
  clock = NOW + 30000;
  assert.equal(await branch(), "feature/a");
  clock = NOW + 61000;
  assert.equal(await branch(), "feature/b");
});

test("worktree trap: an isolated agent's branch comes from meta.json or git, never its lines' gitBranch", async () => {
  const { root, home, main } = office();
  const iso = gitWorktree(main, path.join(root, "projects", "repo", ".claude", "worktrees", "agent-w1"), "agent-w1", "worktree-agent-w1");
  const iso2 = gitWorktree(main, path.join(root, "iso2"), "iso2", "resolved-from-git");
  session(home, "s", [line.user(main, "x", 30, { gitBranch: "main" })]);
  agent(home, "s", "w1", { agentType: "general-purpose", worktreePath: iso, worktreeBranch: "worktree-agent-w1" }, [line.tool(iso, "Read", { file_path: path.join(iso, "a.md") }, 5, { gitBranch: "main" })], { age: 5 });
  agent(home, "s", "w2", { agentType: "general-purpose" }, [line.tool(iso2, "Read", { file_path: "x" }, 5, { gitBranch: "main" })], { age: 5 });
  agent(home, "s", "w3", { agentType: "general-purpose" }, [line.tool(main, "Read", { file_path: "x" }, 5, { gitBranch: "main" })], { age: 5 });

  const m = await modelOf(home, main);
  const a = byId(m.agents);
  assert.equal(m.sessions[0].branch, "main");
  assert.equal(a.w1.branch, "worktree-agent-w1");
  assert.equal(a.w1.checkout, normalize(iso));
  assert.equal(a.w1.doing.file, "a.md");
  assert.equal(a.w2.branch, "resolved-from-git");
  assert.equal(a.w2.checkout, normalize(iso2));
  assert.equal("checkout" in a.w3, false);
  assert.equal("branch" in a.w3, false);
  assert.equal(a.w1.role, "other"); // not in roles.json → the "*" role
});

test("edits: Edit/Write/NotebookEdit in the window, per agent with the newest time, relative to each worktree", async () => {
  const { home, main, wt, other } = office();
  session(home, "s", [
    line.tool(main, "Edit", { file_path: path.join(main, "Lib", "A.mjs") }, 90),
    line.tool(main, "Edit", { file_path: path.join(main, "Lib", "A.mjs") }, 60),
    line.tool(main, "Write", { file_path: path.join(main, "b.md") }, 60),
    line.tool(main, "NotebookEdit", { notebook_path: path.join(main, "n.ipynb") }, 60),
    line.tool(main, "Read", { file_path: path.join(main, "read-only.md") }, 60),
    line.tool(main, "Edit", { file_path: path.join(other, "outside.md") }, 60),
    line.tool(main, "Edit", { file_path: path.join(main, "stale.md") }, 40 * 60),
  ]);
  agent(home, "s", "w", { agentType: "worker" }, [line.tool(wt, "Edit", { file_path: path.join(wt, "src", "c.mjs") }, 30)], { age: 30 });
  const m = await modelOf(home, main);
  assert.deepEqual(m.edits, [
    ...[
      { agent: cc("s:lead"), file: fold("Lib/A.mjs"), at: at(60) },
      { agent: cc("s:lead"), file: "b.md", at: at(60) },
      { agent: cc("s:lead"), file: "n.ipynb", at: at(60) },
    ].sort((x, y) => (x.file < y.file ? -1 : 1)),
    { agent: cc("w"), file: "src/c.mjs", at: at(30) },
  ]);
});

test("config: user files override per key, roles merge per agent type", async () => {
  const { home, main } = office();
  fs.mkdirSync(path.join(home, ".claude", "agent-office"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "agent-office", "roles.json"), JSON.stringify({ scout: "basement", "*": "lobby" }));
  fs.writeFileSync(path.join(home, ".claude", "agent-office", "config.json"), JSON.stringify({ activeMinutes: 20 }));
  session(home, "s", [line.user(main, "x")], { age: 10 * 60 });
  agent(home, "s", "a1", { agentType: "scout" }, [line.text(main, "x", 5)], { age: 5 });
  agent(home, "s", "a2", { agentType: "researcher" }, [line.text(main, "x", 5)], { age: 5 });
  agent(home, "s", "a3", { agentType: "mystery" }, [line.text(main, "x", 5)], { age: 5 });
  agent(home, "s", "a4", {}, [line.text(main, "x", 5)], { age: 5 });
  const m = await modelOf(home, main);
  const role = Object.fromEntries(m.agents.filter((a) => a.startedBy).map((a) => [a.id, [a.agentType, a.role]]));
  assert.equal(m.sessions[0].status, "active"); // 10 minutes old, inside the overridden 20-minute window
  assert.deepEqual(role, { [cc("a1")]: ["scout", "basement"], [cc("a2")]: ["researcher", "researcher"], [cc("a3")]: ["mystery", "lobby"], [cc("a4")]: [null, "lobby"] });
});

test("degraded: no git project, unrecognised transcripts, and cwds git can't place", async () => {
  const { root, home, main } = office();
  const loose = path.join(root, "loose");
  fs.mkdirSync(loose);
  const noGit = await modelOf(home, loose);
  // A temp folder inside some repository would resolve; only assert when it really is outside.
  if (noGit.project.id === null) {
    assert.match(noGit.sources[0].status, /^git could not place /);
    assert.deepEqual(noGit.sessions, []);
  }

  session(home, "junk", ["<<<", "also not json", '{"no":"type"}']);
  const junk = await modelOf(home, main);
  assert.equal(junk.sources[0].status, "transcript format not recognised");
  assert.deepEqual(junk.sessions, []);

  session(home, "removed-worktree", [line.user(path.join(root, "deleted", "wt"), "x")], { slug: "gone" });
  session(home, "ok", [line.user(main, "x")]);
  const mixed = await modelOf(home, main);
  assert.equal(mixed.sources[0].status, null);
  assert.deepEqual(mixed.sessions.map((s) => s.id), [cc("ok")]);
});

test("incremental reads: first sight reads only the tail; later passes read only appended bytes", async () => {
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
  const engine = createEngine(io, { defaultsDir, project: main });
  const title = async () => (await engine.model()).sessions[0].title;

  const size1 = fs.statSync(p).size;
  assert.equal(await title(), "Recent title");
  assert.deepEqual(reads, [[size1 - 400, size1]]);

  fs.appendFileSync(p, JSON.stringify(line.title("Newest title")) + "\n" + '{"type":"user","cwd":"half-writ');
  touch(p, 1);
  const size2 = fs.statSync(p).size;
  assert.equal(await title(), "Newest title");
  assert.deepEqual(reads[1], [size1, size2]);

  // The half-written line is re-read once it is finished.
  fs.appendFileSync(p, 'ten"}\n');
  touch(p, 1);
  await engine.model();
  assert.equal(reads[2][0], size2 - '{"type":"user","cwd":"half-writ'.length);
});

test("cache pruning: a transcript a pass didn't use is forgotten, and read afresh if it comes back", async () => {
  const { home, main } = office();
  const p = session(home, "s", [line.user(main, "x")]);
  const reads = [];
  const io = nodeIo({ claudeDir: path.join(home, ".claude"), now: () => NOW, run: null });
  const read = io.read;
  io.read = (file, start, end) => {
    if (pathKey(file) === pathKey(p)) reads.push(start);
    return read(file, start, end);
  };
  const engine = createEngine(io, { defaultsDir, project: main });
  await engine.model();
  touch(p, 2 * 24 * 60 * 60); // out of view: not even listed
  assert.deepEqual((await engine.model()).sessions, []);
  touch(p, 10);
  assert.equal((await engine.model()).sessions.length, 1);
  // Kept in the cache, the unchanged file would not have been read again.
  assert.deepEqual(reads, [0, 0]);
});
