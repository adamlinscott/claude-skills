import { test } from "node:test";
import assert from "node:assert/strict";
import { layout, viewerFor, statusLine, drawable } from "../layout.mjs";
import { office } from "./office.mjs";

const viewer = (m, session) => viewerFor(m, session);
const roomIds = (scene) => scene.rooms.map((r) => r.id);
const who = (scene, id) => scene.people.find((p) => p.id === id);

test("your room comes first, and the star goes on your own lead; other leads get the tie", () => {
  const m = office([{ id: "a", sessions: [{ id: "s-a" }] }, { id: "b", sessions: [{ id: "s-b" }] }]);
  const scene = layout(m, viewer(m, "s-b"));
  assert.deepEqual(roomIds(scene), ["room:b", "room:a"]);
  assert.equal(scene.rooms[0].you, true);
  assert.equal(scene.rooms[1].you, false);
  assert.deepEqual([who(scene, "s-b:lead").role, who(scene, "s-b:lead").look, who(scene, "s-b:lead").label], ["you", "you", "you"]);
  assert.deepEqual([who(scene, "s-a:lead").role, who(scene, "s-a:lead").label], ["lead", "lead"]);
  assert.deepEqual(viewer(m, "s-b"), { human: "git:Adam", session: "s-b" });
});

test("fixed places: rooms keep the order the pane first saw them in, and a new room goes at the end", () => {
  const first = office([{ id: "a", sessions: [{ id: "s-a" }] }, { id: "b", sessions: [{ id: "s-b" }] }]);
  const scene = layout(first, viewer(first, "nobody"));
  assert.deepEqual(scene.order, ["room:a", "room:b"]);
  // The model now lists b first (newest first) and has a new room c at its head.
  const later = office([{ id: "c", sessions: [{ id: "s-c" }] }, { id: "b", sessions: [{ id: "s-b" }] }, { id: "a", sessions: [{ id: "s-a" }] }]);
  const next = layout(later, viewer(later, "nobody"), { order: scene.order });
  assert.deepEqual(roomIds(next), ["room:a", "room:b", "room:c"]);
  assert.deepEqual(next.order, ["room:a", "room:b", "room:c"]);
});

test("folding: an idle room with nobody working or stalled folds into a strip; yours never does", () => {
  const m = office([
    { id: "mine", sessions: [{ id: "s-m", status: "idle", lead: "idle" }] },
    { id: "quiet", sessions: [{ id: "s-q", status: "idle", lead: "idle", team: [{ id: "q1", status: "done" }] }] },
    { id: "stuck", sessions: [{ id: "s-s", status: "idle", lead: "idle", team: [{ id: "s1", status: "stalled" }] }] },
    { id: "busy", sessions: [{ id: "s-b" }] },
  ]);
  const scene = layout(m, viewer(m, "s-m"));
  const room = (id) => scene.rooms.find((r) => r.id === id);
  assert.deepEqual(roomIds(scene), ["room:mine", "room:stuck", "room:busy", "room:quiet"]);
  assert.equal(room("room:quiet").folded, true);
  assert.equal(room("room:quiet").h, 3);
  assert.match(room("room:quiet").sub, /^idle 10m · lights off$/);
  assert.equal(room("room:stuck").folded, false);
  assert.equal(room("room:mine").folded, false);
  assert.equal(who(scene, "q1"), undefined, "a folded room draws nobody");
});

test("a room is drawn from its list of sessions: each session gets its lead and its own table", () => {
  const m = office([{ id: "pair", sessions: [{ id: "s1", team: [{ id: "w1" }, { id: "w2" }] }, { id: "s2", team: [{ id: "w3" }] }] }]);
  const scene = layout(m, viewer(m, "s1"));
  assert.equal(scene.rooms.length, 1);
  assert.equal(scene.tables.length, 2);
  assert.deepEqual(scene.people.map((p) => p.id), ["s1:lead", "w1", "w2", "s2:lead", "w3"]);
  // The second session's block sits below the first, inside the same room.
  const [room] = scene.rooms;
  assert.ok(who(scene, "s2:lead").y > who(scene, "w2").y);
  assert.ok(scene.people.every((p) => p.y > room.y && p.y < room.y + room.h - 1 && p.x > room.x && p.x < room.x + room.w));
});

test("waits give lines, from the agent waiting to the agent it waits on, only between people drawn", () => {
  const m = office([
    { id: "a", sessions: [{ id: "s-a", team: [{ id: "w1", waited: true }, { id: "w2", status: "done" }] }] },
    { id: "z", sessions: [{ id: "s-z", status: "idle", lead: "idle", team: [{ id: "w9", status: "idle", waited: true }] }] },
  ]);
  const scene = layout(m, viewer(m, "s-a"));
  assert.deepEqual(scene.lines, [{ from: "s-a:lead", to: "w1" }]);
});

test("statuses: stopped is its own faded look, apart from failed and stalled", () => {
  const team = ["working", "done", "idle", "stalled", "stopped", "failed"].map((status, i) => ({ id: "x" + i, status }));
  const m = office([{ id: "a", sessions: [{ id: "s-a", team }] }]);
  const scene = layout(m, viewer(m, "nobody"));
  assert.deepEqual(team.map((t) => who(scene, t.id).look), ["work", "ok", "idle", "stall", "stop", "fail"]);
  assert.equal(who(scene, "s-a:lead").look, "work");
});

test("the card: role and agent type, status and for how long, what it is doing, its description", () => {
  const m = office([{ id: "a", sessions: [{ id: "s-a", team: [{ id: "w1", type: "worker-light", extra: { description: "Fix the wizard" } }] }] }]);
  m.agents[1].doing = { kind: "write", file: "lib/wizard.mjs", since: m.generatedAt };
  Object.assign(m.agents[1], { checkout: "C:/w/.claude/worktrees/x", branch: "x" });
  assert.deepEqual(who(layout(m, viewer(m, "s-a")), "w1").card, {
    title: "worker-light",
    lines: ["role worker · type worker-light", "working for 5m", "writing lib/wizard.mjs", "Fix the wizard", "own worktree: x · C:/w/.claude/worktrees/x"],
  });
});

test("fitting rows: open rooms fold from the last, then rooms past the bottom are counted, not drawn", () => {
  const rooms = ["a", "b", "c", "d"].map((id) => ({ id, sessions: [{ id: "s-" + id, team: [{ id: "w-" + id }] }] }));
  const m = office(rooms);
  // Two open rooms a row at 84 columns, eleven rows each: everything open is 23 rows.
  const roomy = layout(m, viewer(m, "s-a"), { columns: 84 });
  assert.equal(roomy.rooms.filter((r) => r.folded).length, 0);

  const squeezed = layout(m, viewer(m, "s-a"), { columns: 84, rows: 20 });
  assert.ok(squeezed.h <= 20);
  assert.equal(squeezed.rooms[0].id, "room:a");
  assert.equal(squeezed.rooms[0].folded, false, "your room stays open");
  assert.equal(squeezed.rooms.find((r) => r.id === "room:d").folded, true);
  assert.equal(squeezed.rooms.find((r) => r.id === "room:d").sub, "folded to fit");

  const tiny = layout(m, viewer(m, "s-a"), { columns: 40, rows: 12 });
  assert.ok(tiny.hidden > 0);
  assert.deepEqual(roomIds(tiny), ["room:a"]);
});

test("status line: quiet when all is well; the engine, a source's problem and a newer model each say so", () => {
  const m = office([{ id: "a", sessions: [{ id: "s-a" }] }]);
  assert.equal(statusLine(m, "running"), null);
  assert.match(statusLine(null, "fallback"), /isn't running/);
  assert.match(statusLine({ ...m, sources: [{ id: "claude-code", status: "git could not place C:/x" }] }, "running"), /^claude-code: git could not place/);
  const newer = { ...m, schemaVersion: 2 };
  assert.match(statusLine(newer, "running"), /version 2.*version 1/);
  assert.equal(drawable(newer), false);
  assert.equal(drawable(m), true);
});
