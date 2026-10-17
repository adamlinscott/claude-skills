import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { layout, viewerFor, statusLine, drawable, contextWindow, cost } from "../layout.mjs";
import { office, NOW } from "./office.mjs";

const prices = JSON.parse(fs.readFileSync(new URL("../prices.json", import.meta.url), "utf8")).models;
const tally = () => ({ input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 });

const viewer = (m, session) => viewerFor(m, session);
const roomIds = (scene) => scene.rooms.map((r) => r.id);
const who = (scene, id) => scene.people.find((p) => p.id === id);

test("your room comes first, and the star goes on your own lead; other leads get the tie", () => {
  const m = office([{ id: "a", sessions: [{ id: "s-a" }] }, { id: "b", sessions: [{ id: "s-b" }] }]);
  const scene = layout(m, viewer(m, "s-b"));
  assert.deepEqual(roomIds(scene), ["room:b", "room:a"]);
  assert.equal(scene.rooms[0].you, true);
  assert.equal(scene.rooms[1].you, false);
  assert.deepEqual([who(scene, "s-b:lead").role, who(scene, "s-b:lead").look, who(scene, "s-b:lead").label], ["you", "you", "lead (you)"]);
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

test("no idle folding: an idle room with nobody working stays open, in its place, dimmed", () => {
  const m = office([
    { id: "mine", sessions: [{ id: "s-m" }] },
    { id: "quiet", sessions: [{ id: "s-q", status: "idle", lead: "idle", team: [{ id: "q1", status: "done" }] }] },
    { id: "busy", sessions: [{ id: "s-b" }] },
  ]);
  const scene = layout(m, viewer(m, "s-m"));
  const quiet = scene.rooms.find((r) => r.id === "room:quiet");
  assert.deepEqual(roomIds(scene), ["room:mine", "room:quiet", "room:busy"]);
  assert.deepEqual([quiet.folded, quiet.idle, quiet.off], [false, true, false]);
  assert.equal(who(scene, "q1").off, false);
});

test("lights off: in the room's own place, full size with its people, all marked off and still; never your room", () => {
  const night = { status: "idle", idle: 180, lights: "off", lead: "idle" };
  const m = office([
    { id: "dark", sessions: [{ id: "s-d", ...night, team: [{ id: "d1", status: "stalled", waited: true }] }] },
    { id: "mine", sessions: [{ id: "s-m", ...night }] },
    { id: "lit", sessions: [{ id: "s-l" }] },
  ]);
  const scene = layout(m, viewer(m, "s-m"));
  const room = (id) => scene.rooms.find((r) => r.id === id);
  assert.deepEqual(roomIds(scene), ["room:mine", "room:dark", "room:lit"]);
  assert.deepEqual([room("room:dark").off, room("room:dark").folded, room("room:dark").sub], [true, false, "b-s-d · s-d  ·  lights off · idle 3h"]);
  assert.deepEqual(scene.lines, [], "a lights-off room's waits draw no moving line");
  assert.equal(room("room:mine").off, false);
  assert.equal(room("room:lit").off, false);
  assert.deepEqual([who(scene, "s-d:lead").off, who(scene, "d1").off, who(scene, "d1").look], [true, true, "stall"]);
  assert.equal(who(scene, "s-m:lead").off, false);
  assert.deepEqual(scene.tables.map((t) => t.off), [false, true, false]);
});

test("small print: now: the newest working subagent's task, else last: the one active last; nothing without a task", () => {
  const m = office([
    { id: "busy", sessions: [{ id: "s-b", team: [{ id: "b1", task: "Old task" }, { id: "b2", task: "New task" }, { id: "b3" }, { id: "b4", status: "done", task: "Done task" }] }] },
    { id: "dark", sessions: [{ id: "s-d", status: "idle", idle: 180, lights: "off", lead: "idle", team: [{ id: "d1", status: "done", task: "Earlier" }, { id: "d2", status: "stopped", task: "Latest" }] }] },
    { id: "bare", sessions: [{ id: "s-n", team: [{ id: "n1" }] }] },
  ]);
  const set = (id, fields) => Object.assign(m.agents.find((a) => a.id === id), fields);
  set("b1", { statusSince: "2026-10-11T14:40:00.000Z" });
  set("b2", { statusSince: "2026-10-11T14:50:00.000Z" });
  set("b4", { statusSince: "2026-10-11T14:59:00.000Z" }); // started later, but not working
  set("d1", { lastActive: "2026-10-11T11:00:00.000Z" });
  set("d2", { lastActive: "2026-10-11T11:30:00.000Z" });
  const sub = (scene, id) => scene.rooms.find((r) => r.id === id).sub;
  const scene = layout(m, viewer(m, "s-b"));
  assert.equal(sub(scene, "room:busy"), "b-s-b · s-b  ·  now: New task");
  assert.equal(sub(scene, "room:dark"), "b-s-d · s-d  ·  lights off · idle 3h  ·  last: Latest");
  assert.equal(sub(scene, "room:bare"), "b-s-n · s-n");
});

test("titles: a written title replaces a branch stand-in, in the room and in a card's conflict line, never Claude Code's own", () => {
  const m = office([
    { id: "a", sessions: [{ id: "s-a", titleFrom: "branch", team: [{ id: "w1", writing: "lib/a.mjs" }] }] },
    { id: "b", sessions: [{ id: "s-b", team: [{ id: "w2", writing: "lib/a.mjs" }] }] },
  ]);
  m.meaning.conflicts = [{ file: "lib/a.mjs", agents: ["w1", "w2"], by: "rules" }];
  const titles = { "s-a": "Fixing the setup wizard", "s-b": "Never shown" };
  const scene = layout(m, viewer(m, "s-b"), { titles });
  assert.deepEqual(scene.rooms.map((r) => r.title), ["Room b", "Fixing the setup wizard"]);
  assert.match(who(scene, "w2").card.lines.find((l) => l.startsWith("possible conflict")), / in Fixing the setup wizard$/);
  assert.equal(layout(m, viewer(m, "s-b")).rooms[1].title, "Room a", "the branch stand-in until a title is written");
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
  // Stacked, with the second room folded to fit: its people aren't drawn.
  const scene = layout(m, viewer(m, "s-a"), { columns: 40, rows: 18 });
  assert.equal(scene.rooms[1].folded, true);
  assert.deepEqual(scene.lines, [{ from: "s-a:lead", to: "w1" }]);
});

test("statuses: stopped is its own faded look, apart from failed and stalled", () => {
  const team = ["working", "done", "idle", "stalled", "stopped", "failed"].map((status, i) => ({ id: "x" + i, status }));
  const m = office([{ id: "a", sessions: [{ id: "s-a", team }] }]);
  const scene = layout(m, viewer(m, "nobody"));
  assert.deepEqual(team.map((t) => who(scene, t.id).look), ["work", "ok", "idle", "stall", "stop", "fail"]);
  assert.equal(who(scene, "s-a:lead").look, "work");
});

test("the card: role and agent type, status and for how long, what it is doing, its task", () => {
  const m = office([{ id: "a", sessions: [{ id: "s-a", team: [{ id: "w1", type: "worker-light", task: "Fix the wizard" }] }] }]);
  m.agents[1].doing = { kind: "write", file: "lib/wizard.mjs", since: m.generatedAt };
  Object.assign(m.agents[1], { checkout: "C:/w/.claude/worktrees/x", branch: "x" });
  assert.deepEqual(who(layout(m, viewer(m, "s-a")), "w1").card, {
    title: "worker-light",
    lines: ["role worker · type worker-light", "working for 5m", "writing lib/wizard.mjs", "Fix the wizard", "own worktree: x · C:/w/.claude/worktrees/x"],
  });
});

test("details: who and on what model, short status, last acted, waits, context, tokens, cost; no report or task; only for someone drawn", () => {
  const usage = (model, context, input, cacheWrite, cacheWrite1h, cacheRead, output, over100k = tally()) => ({ model, context, input, cacheWrite, cacheWrite1h, cacheRead, output, over100k, at: new Date(NOW).toISOString() });
  const m = office([
    {
      id: "a",
      sessions: [
        {
          id: "s-a",
          usage: usage("claude-opus-5-5", 100000, 0, 0, 0, 0, 200),
          team: [
            { id: "w1", task: "Fix the wizard", waited: true, usage: usage("claude-opus-5-5", 294000, 2000, 400000, 100000, 800000, 41000) },
            { id: "v1", type: "reviewer", role: "reviewer", status: "done", task: "Review it", report: "\nAll clear.\nMore.", usage: usage("claude-haiku-5-5-20261001", 8400, 11000, 0, 0, 189000, 7000, { ...tally(), input: 10000, cacheRead: 140000, output: 5000 }) },
            { id: "x1", usage: usage("claude-opus-9", 500, 500, 0, 0, 0, 10) },
          ],
        },
      ],
    },
  ]);
  const details = (selected, opts) => layout(m, viewer(m, "s-a"), { selected, prices, ...opts }).details;
  const windows = { "claude-opus-5-5": { window: 1000000, compactAt: 920000 } };
  // 2k × $4 + 300k × $5 + 100k × $8 + 800k × $0.20 + 41k × $20 per million = $3.288.
  assert.deepEqual(details("w1", { contextWindows: windows }).lines, [
    "worker · claude-opus-5-5",
    "working 5m",
    "last acted 1m ago",
    "waited on by: lead (you)",
    "context: 294k of 1M (29%) · compacts at 92%",
    "tokens: 1.2M in (800k cached) · 41k out",
    "cost: ~$3.29 at API prices",
  ]);
  // Haiku 5.5 by each reply's prompt: 1k × $0.10 + 49k × $0.01 + 2k × $0.50, plus the replies over
  // 100k at 10k × $0.50 + 140k × $0.05 + 5k × $2.50 per million = $0.02609.
  const v1 = details("v1", { contextWindows: windows });
  assert.deepEqual(v1.lines, [
    "reviewer · claude-haiku-5-5-20261001",
    "done 5m ago",
    "last acted 1m ago",
    "context: 8.4k · window unknown for claude-haiku-5-5-20261001",
    "tokens: 200k in (189k cached) · 7k out",
    "cost: ~$0.03 at API prices",
  ]);
  assert.ok(![...v1.lines, ...v1.more].some((l) => /All clear|Review it/.test(l)), "no report or task in the panel");
  assert.ok(!details("w1").more.includes("Fix the wizard"));
  // The viewer's own lead: its context live from the session, the window from the session too.
  const own = { model: "claude-opus-5-5", window: 1000000, compactAt: null, tokens: 120000 };
  assert.deepEqual(details("s-a:lead", { own }).lines, ["lead (you) · lead · claude-opus-5-5", "working 2m", "last acted <1m ago", "waiting on: worker", "context: 120k of 1M (12%)", "tokens: 0 in (0 cached) · 200 out", "cost: under $0.01 at API prices"]);
  // A model with no price, or a broken price, says so; a family's newer model never takes its price.
  assert.equal(details("x1").lines.at(-1), "cost: no price for claude-opus-9");
  assert.equal(details("w1", { prices: { "claude-opus-5-5": { input: "4" } } }).lines.at(-1), "cost: no price for claude-opus-5-5");
  assert.equal(details(null), null);
  assert.equal(details("nobody"), null);
});

test("details: the billing line only when it is known", () => {
  const m = office([{ id: "a", sessions: [{ id: "s-a" }] }]);
  const last = (billing) => layout(m, viewer(m, "s-a"), { selected: "s-a:lead", billing }).details.lines.at(-1);
  assert.equal(last("subscription"), "billing: Claude subscription");
  assert.equal(last("api"), "billing: API key");
  assert.equal(last(null), "last acted <1m ago");
});

test("cost: the longest price key the model id starts with, a dated or [1m] id included; cache writes split 1h and 5m", () => {
  const u = (model) => ({ model, input: 1e6, cacheWrite: 3e6, cacheWrite1h: 1e6, cacheRead: 1e6, output: 1e6, over100k: tally() });
  assert.equal(cost(u("claude-opus-5-5-20260901[1m]"), prices), 4 + 2 * 5 + 8 + 0.2 + 20);
  assert.equal(cost(u("claude-opus-5"), prices), 5 + 2 * 6.25 + 10 + 0.5 + 25);
  assert.equal(cost(u("claude-sonnet-4-20250514"), prices), 3 + 2 * 3.75 + 6 + 0.3 + 15);
  assert.equal(cost(u("claude-opus-5x"), prices), null);
});

test("context window: config's entry for the model, then the viewer's own session on that model, then config's *", () => {
  const own = { model: "opus", window: 200000, compactAt: 180000, tokens: 5000 };
  assert.deepEqual(contextWindow("opus", { opus: { window: 1e6 }, "*": { window: 5e5 } }, own), { window: 1e6, compactAt: null });
  assert.deepEqual(contextWindow("opus", { "*": { window: 5e5 } }, own), { window: 200000, compactAt: 180000 });
  assert.deepEqual(contextWindow("haiku", { "*": { window: 5e5, compactAt: 4e5 } }, own), { window: 5e5, compactAt: 4e5 });
  assert.equal(contextWindow("haiku", {}, own), null);
  // A malformed entry or table is passed over, never shown.
  assert.deepEqual(contextWindow("opus", { opus: { window: "big" } }, own), { window: 200000, compactAt: 180000 });
  assert.equal(contextWindow("opus", [], null), null);
});

test("write bubbles: amber while writing a file, never red for the agent's own edits, none without a file", () => {
  const m = office([{ id: "a", sessions: [{ id: "s-a", team: [{ id: "w1", writing: "lib/a.mjs" }, { id: "w2", writing: "lib/b.mjs" }, { id: "w3" }] }] }]);
  m.agents.find((a) => a.id === "w3").doing = { kind: "write", since: m.generatedAt };
  m.meaning.conflicts = [{ file: "lib/b.mjs", agents: ["w2"], by: "source" }];
  const scene = layout(m, viewer(m, "s-a"));
  assert.deepEqual(who(scene, "w1").bubble, { file: "lib/a.mjs", clash: false, dot: false });
  assert.deepEqual(who(scene, "w2").bubble, { file: "lib/b.mjs", clash: false, dot: false });
  assert.equal(who(scene, "w3").bubble, null);
  assert.equal(who(scene, "s-a:lead").bubble, null);
  assert.ok(!who(scene, "w2").card.lines.some((l) => l.startsWith("possible conflict")));
});

test("write bubbles: red when someone in another room edited the file lately, and the card says who and where", () => {
  const m = office([
    { id: "a", sessions: [{ id: "s-a", team: [{ id: "w1", writing: "lib/wizard.mjs" }] }] },
    { id: "b", sessions: [{ id: "s-b", status: "idle", lead: "idle", team: [{ id: "w9", status: "done" }] }] },
  ]);
  m.meaning.conflicts = [{ file: "lib/wizard.mjs", agents: ["w1", "w9"], by: "rules" }];
  const scene = layout(m, viewer(m, "s-a"), { touchedWindowMinutes: 45 });
  assert.deepEqual(who(scene, "w1").bubble, { file: "lib/wizard.mjs", clash: true, dot: false });
  assert.deepEqual(who(scene, "w1").card.lines.slice(2, 4), ["writing lib/wizard.mjs", "possible conflict: also edited in the last 45m by worker in Room b"]);
});

test("write bubbles: amber for bubbleSeconds after the agent's newest edit, then gone, whatever it is doing now", () => {
  const m = office([{ id: "a", sessions: [{ id: "s-a", team: [{ id: "w1", writing: "lib/a.mjs" }] }] }]);
  m.agents.find((a) => a.id === "w1").doing = { kind: "read", file: "lib/b.mjs", since: m.generatedAt };
  const at = (seconds, opts) => who(layout(m, viewer(m, "s-a"), { now: NOW + seconds * 1000, ...opts }), "w1").bubble;
  assert.deepEqual(at(10), { file: "lib/a.mjs", clash: false, dot: false });
  assert.equal(at(11), null);
  assert.deepEqual(at(25, { bubbleSeconds: 30 }), { file: "lib/a.mjs", clash: false, dot: false });
});

test("write bubbles: red stays past the amber time, for a done agent too, the conflict's file matched case-insensitively", () => {
  const m = office([
    { id: "a", sessions: [{ id: "s-a", team: [{ id: "w1", status: "done", writing: "lib/wizard.mjs" }] }] },
    { id: "b", sessions: [{ id: "s-b", team: [{ id: "w9" }] }] },
  ]);
  m.edits.push({ agent: "w9", file: "Lib/Wizard.mjs", at: new Date(NOW - 60000).toISOString() });
  m.meaning.conflicts = [{ file: "Lib/Wizard.mjs", agents: ["w1", "w9"], by: "rules" }];
  const scene = layout(m, viewer(m, "s-a"), { now: NOW + 5 * 60000 });
  // Past the bubble's seconds a red bubble is a dot, a notification light, until it is checked.
  assert.deepEqual(who(scene, "w1").bubble, { file: "lib/wizard.mjs", clash: true, dot: true });
  assert.deepEqual(who(scene, "w9").bubble, { file: "Lib/Wizard.mjs", clash: true, dot: true });
});

test("write bubbles: red clears once the agent reads the file after its newest edit, or writes another file", () => {
  const conflicted = () => {
    const m = office([
      { id: "a", sessions: [{ id: "s-a", team: [{ id: "w1", writing: "lib/wizard.mjs" }] }] },
      { id: "b", sessions: [{ id: "s-b", team: [{ id: "w9", writing: "lib/wizard.mjs" }] }] },
    ]);
    m.meaning.conflicts = [{ file: "lib/wizard.mjs", agents: ["w1", "w9"], by: "rules" }];
    return m;
  };
  const bubble = (m) => who(layout(m, viewer(m, "s-a"), { now: NOW + 60000 }), "w1").bubble;
  const later = (seconds) => new Date(NOW + seconds * 1000).toISOString();

  const readBefore = conflicted();
  readBefore.reads.push({ agent: "w1", file: "lib/wizard.mjs", at: new Date(NOW - 5000).toISOString() });
  assert.deepEqual(bubble(readBefore), { file: "lib/wizard.mjs", clash: true, dot: true });

  const readAfter = conflicted();
  readAfter.reads.push({ agent: "w1", file: "Lib/Wizard.mjs", at: later(20) });
  assert.equal(bubble(readAfter), null);
  assert.equal(who(layout(readAfter, viewer(readAfter, "s-a"), { now: NOW + 60000 }), "w9").bubble.clash, true);

  const movedOn = conflicted();
  movedOn.edits.push({ agent: "w1", file: "README.md", at: later(55) });
  assert.deepEqual(bubble(movedOn), { file: "README.md", clash: false, dot: false });
});

test("info icon: an agent with findings shows it, and its card holds the report's first lines, cut with …", () => {
  const report = ["Findings:", "", "1. The wizard writes the config twice when the folder already exists.", ...Array.from({ length: 9 }, (_, i) => `${i + 2}. Another thing.`)].join("\n");
  const m = office([{ id: "a", sessions: [{ id: "s-a", team: [{ id: "v1", type: "reviewer", role: "reviewer", status: "done", report }, { id: "w1" }] }] }]);
  const scene = layout(m, viewer(m, "s-a"));
  assert.equal(who(scene, "v1").info, true);
  assert.equal(who(scene, "w1").info, false);
  assert.deepEqual(who(scene, "v1").card.lines.slice(2), [
    "Findings:",
    "1. The wizard writes the config twice when",
    "the folder already exists.",
    "2. Another thing.",
    "3. Another thing.",
    "4. Another thing.",
    "5. Another thing.",
    "6. Another thing.…",
  ]);
  assert.ok(who(scene, "v1").card.lines.every((l) => l.length <= 44));
});

test("folding: an idle room whose reviewer still has findings stays open, dimmed", () => {
  const m = office([
    { id: "mine", sessions: [{ id: "s-m" }] },
    { id: "read", sessions: [{ id: "s-r", status: "idle", lead: "idle", team: [{ id: "v1", type: "reviewer", role: "reviewer", status: "done", report: "Looks fine." }] }] },
  ]);
  const room = layout(m, viewer(m, "s-m")).rooms.find((r) => r.id === "room:read");
  assert.equal(room.folded, false);
  assert.equal(room.idle, true);
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

  // Rooms fold where they stand; with b's lights off, b folds first.
  assert.deepEqual(squeezed.rooms.map((r) => [r.id, r.folded]), [["room:a", false], ["room:b", false], ["room:c", true], ["room:d", true]]);
  const night = office(rooms.map((r) => (r.id === "b" ? { ...r, sessions: [{ ...r.sessions[0], status: "idle", lights: "off" }] } : r)));
  const dark = layout(night, viewer(night, "s-a"), { columns: 84, rows: 20 });
  assert.deepEqual(dark.rooms.map((r) => [r.id, r.folded]), [["room:a", false], ["room:b", true], ["room:c", true], ["room:d", true]]);

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
