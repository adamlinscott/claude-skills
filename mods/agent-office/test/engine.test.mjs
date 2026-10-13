import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathKey } from "../git.mjs";
import { nodeIo } from "../cli.mjs";
import { createEngine } from "../engine.mjs";
import { assembleModel, sameModel } from "../model.mjs";
import { NOW, defaultsDir, tempRoot, gitRepo, line, session, agent, engineIn, cc, touch } from "./fixture.mjs";

function office() {
  const root = tempRoot();
  const home = path.join(root, "home");
  const main = gitRepo(path.join(root, "repo"), "main");
  session(home, "s1", [line.title("First room"), line.user(main, "x", 60)], { age: 60 });
  session(home, "s2", [line.user(main, "x", 20)], { age: 20 });
  return { home, main };
}

// A stream whose wait runs `steps[i]` before pass i + 2 and ends after the last one.
async function streamIn(home, main, steps, ioPatch = {}) {
  const lines = [];
  let clock = NOW;
  let i = 0;
  const io = {
    ...nodeIo({ claudeDir: path.join(home, ".claude"), now: () => clock, run: null }),
    write: (text) => lines.push(text),
    wait: async (ms) => {
      clock += ms;
      if (i >= steps.length) return false;
      await steps[i++]();
      return true;
    },
    ...ioPatch,
  };
  await createEngine(io, { defaultsDir, project: main }).stream();
  return lines;
}

test("rooms: one per session, room:<session id>, titled from the session", async () => {
  const { home, main } = office();
  const m = await engineIn(home, main).model();
  assert.deepEqual(m.rooms, [
    { id: `room:${cc("s2")}`, sessions: [cc("s2")], title: "main" },
    { id: `room:${cc("s1")}`, sessions: [cc("s1")], title: "First room" },
  ]);
});

test("stream: one JSON line per change, numbered by seq; an unchanged office writes nothing", async () => {
  const { home, main } = office();
  const p = session(home, "s1", [line.title("First room"), line.user(main, "x", 60)], { age: 60 });
  const reads = [];
  const read = nodeIo().read;
  const lines = await streamIn(
    home,
    main,
    [
      () => {}, // nothing changes: no line
      () => {
        fs.appendFileSync(p, JSON.stringify(line.title("Renamed room")) + "\n");
        touch(p, 1);
      },
      () => {},
    ],
    {
      read: (file, start, end) => {
        if (pathKey(file) === pathKey(p)) reads.push(start);
        return read(file, start, end);
      },
    },
  );
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.endsWith("\n") && !l.slice(0, -1).includes("\n")));
  const [first, second] = lines.map((l) => JSON.parse(l));
  assert.deepEqual([first.seq, second.seq], [1, 2]);
  assert.equal(second.rooms.find((r) => r.id === `room:${cc("s1")}`).title, "Renamed room");
  // The read cache lives across passes: the transcript is read whole once, then from where it ended.
  assert.equal(reads.length, 2);
  assert.ok(reads[1] > 0);
});

test("one-shot: --json's model equals the stream's first model apart from seq and generatedAt", async () => {
  const { home, main } = office();
  agent(home, "s2", "a1", { agentType: "reviewer" }, [line.text(main, "Looks fine.", 120)], { age: 120 });
  const once = await engineIn(home, main).model();
  const [first] = await streamIn(home, main, []);
  assert.ok(sameModel(once, JSON.parse(first)));
  assert.equal(once.meaning.findings.length, 1);
});

test("a source that throws keeps its last good facts, reports a one-line status, and the stream goes on", async () => {
  const { home, main } = office();
  let broken = false;
  const listDir = nodeIo().listDir;
  const lines = await streamIn(home, main, [() => (broken = true), () => (broken = false)], {
    listDir: (dir) => {
      if (broken) throw new Error("EACCES: projects\r\n    at listDir");
      return listDir(dir);
    },
  });
  const [good, failed, recovered] = lines.map((l) => JSON.parse(l));
  assert.equal(failed.sources[0].status, "EACCES: projects at listDir");
  assert.deepEqual(failed.sources[0].errors, { count: 1, first: "EACCES: projects at listDir" });
  assert.deepEqual([failed.sessions, failed.agents], [good.sessions, good.agents]);
  assert.equal(recovered.sources[0].status, null);
  assert.ok(sameModel(recovered, good));
});

test("a broken repo default keeps the last good office, reports in sources[].status, goes on at the last good pace, and recovers", async () => {
  const { home, main } = office();
  const configFile = pathKey(path.join(defaultsDir, "config.json"));
  const read = nodeIo().read;
  fs.mkdirSync(path.join(home, ".claude", "agent-office"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "agent-office", "config.json"), JSON.stringify({ streamSeconds: 5 }));
  let broken = true;
  const lines = await streamIn(home, main, [() => (broken = false), () => (broken = true), () => (broken = false)], {
    read: (file, start, end) => (broken && pathKey(file) === configFile ? "{ half-saved" : read(file, start, end)),
  });
  const models = lines.map((l) => JSON.parse(l));
  // No office has built before the first pass, so it is empty; the third keeps the second's.
  assert.deepEqual(models.map((m) => m.sessions.length), [0, 2, 2, 2]);
  assert.match(models[0].sources[0].status, /JSON/);
  assert.equal(models[0].sources[0].errors.count, 1);
  assert.equal(models[1].sources[0].status, null);
  assert.match(models[2].sources[0].status, /JSON/);
  assert.equal(models[2].sources[0].errors.count, 1);
  assert.deepEqual(models[2].agents, models[1].agents);
  // No config has loaded before the first pass, so it waits the fallback second; after that, the last good 5.
  assert.deepEqual(models.map((m) => Date.parse(m.generatedAt) - NOW), [0, 1000, 6000, 11000]);
});

test("model order: facts naming an agent or session the model doesn't hold sort after the known ones, then by id", () => {
  const facts = {
    humans: [],
    sessions: [{ id: "s", lastActive: "2026-10-09T12:00:00.000Z" }],
    agents: [{ id: "z", session: "gone", startedBy: "x" }, { id: "b", session: "s", startedBy: "a" }, { id: "y", session: "gone", startedBy: "x" }, { id: "a", session: "s", startedBy: null }],
    edits: [{ agent: "q", file: "f" }, { agent: "b", file: "f" }, { agent: "p", file: "f" }],
    reads: [],
    waits: [],
    reports: [],
  };
  const m = assembleModel({ seq: 1, now: 0, project: {}, sources: [], facts, meaning: { roles: [], conflicts: [], findings: [] } });
  assert.deepEqual(m.agents.map((a) => a.id), ["a", "b", "y", "z"]);
  assert.deepEqual(m.edits.map((e) => e.agent), ["b", "p", "q"]);
});
