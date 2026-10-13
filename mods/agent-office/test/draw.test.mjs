import { test } from "node:test";
import assert from "node:assert/strict";
import { layout, viewerFor } from "../layout.mjs";
import { renderSvg, drawDesktop, pickKey } from "../draw-desktop.mjs";
import { renderCells, drawTerminal, seatKey, seatOf } from "../draw-terminal.mjs";
import { office } from "./office.mjs";

const m = office([
  { id: "a", sessions: [{ id: "s-a", team: [{ id: "w1", waited: true }, { id: "v1", type: "reviewer", role: "reviewer", status: "stopped" }] }] },
  { id: "b", sessions: [{ id: "s-b", lead: "idle", team: [{ id: "r1", type: "researcher", role: "researcher", status: "failed" }] }] },
]);
const scene = layout(m, viewerFor(m, "s-a"), { columns: 90 });
// Two agents in two rooms writing the same file, one writing a file of its own, and two reviewers
// with findings, one of them failed.
const report = Array.from({ length: 12 }, (_, i) => `${i + 1}. The wizard writes the config twice when the folder already exists.`).join("\n");
const busy = office([
  { id: "a", sessions: [{ id: "s-a", team: [{ id: "w1", writing: "lib/wizard.mjs" }, { id: "w2", writing: "README.md" }, { id: "v1", type: "reviewer", role: "reviewer", status: "done", report }] }] },
  { id: "b", sessions: [{ id: "s-b", team: [{ id: "w9", writing: "lib/wizard.mjs" }, { id: "v9", type: "reviewer", role: "reviewer", status: "failed", report: "Ran out of time." }] }] },
]);
busy.meaning.conflicts = [{ file: "lib/wizard.mjs", agents: ["w1", "w9"], by: "rules" }];
const busyScene = layout(busy, viewerFor(busy, "s-a"), { columns: 90 });
// Element constructors that record what they were given.
const el = new Proxy({}, { get: (_, type) => (props) => ({ type, props }) });
// The Desktop's seats: the plan Box's children after the Svg.
const seatsOf = (tree) => tree.props.children[0].props.children.slice(1);
// The seat's details Button: the person's name, under the figure.
const pickOf = (seat) => seat.props.children[0].props.children[0];

// The cells back as text rows.
function text({ columns, rows, cells }) {
  const words = new Uint32Array(Uint8Array.from(atob(cells), (c) => c.charCodeAt(0)).buffer);
  assert.equal(words.length, columns * rows * 3);
  return Array.from({ length: rows }, (_, y) => Array.from({ length: columns }, (_, x) => String.fromCodePoint(words[(y * columns + x) * 3])).join(""));
}

test("desktop: every person, room and waiting line is in the SVG, the same every time", () => {
  const svg = renderSvg(scene);
  assert.equal(svg, renderSvg(scene));
  assert.ok(svg.startsWith("<svg") && svg.length < 131072);
  for (const r of scene.rooms) assert.ok(svg.includes(r.title.replace(/&/g, "&amp;")));
  assert.equal((svg.match(/<use href="#av-/g) || []).length, scene.people.length);
  for (const look of ["you", "work", "stop", "fail"]) assert.ok(svg.includes(`class="av ${look}"`), look);
  assert.equal((svg.match(/class="flow"/g) || []).length, scene.lines.length);
  assert.equal(scene.lines.length, 1);
  // A redraw restarts the animation, so the line starts where the wall clock has it: no jump back.
  assert.ok(renderSvg(scene, { now: 12345 }).includes('class="flow" style="animation-delay:-345ms" marker-end="url(#flow-head)"'));
});

test("desktop: a keyed hover box over every seat, holding that person's card", () => {
  const [svg, ...seats] = drawDesktop(scene, el).props.children[0].props.children;
  assert.equal(svg.type, "Svg");
  assert.deepEqual(seats.map((s) => s.props.key), scene.people.map((p) => "seat:" + p.id));
  const card = seats[1].props.children.find((c) => c.props.hover);
  assert.deepEqual(card.props.hover, { display: "flex" });
  assert.equal(card.props.display, "none");
  assert.equal(card.props.children[0].props.children[0], scene.people[1].card.title);
});

test("desktop: a plain Button over every seat picks that person; the picked person's details sit in a panel under the plan", () => {
  const picks = [];
  const tree = drawDesktop(scene, el, { onSelect: (id) => picks.push(id) });
  assert.equal(tree.props.children.length, 1);
  const buttons = seatsOf(tree).map(pickOf);
  assert.deepEqual(buttons.map((b) => b.props.key), scene.people.map((p) => pickKey(p.id)));
  assert.ok(buttons.every((b) => b.props.plain && b.props.label.trim()), "a visible name to click, not a blank");
  buttons[1].props.onPress();
  assert.deepEqual(picks, [scene.people[1].id]);

  const picked = layout(m, viewerFor(m, "s-a"), { columns: 90, selected: "w1" });
  const [plan, panel] = drawDesktop(picked, el).props.children;
  assert.equal(plan.props.key, "plan");
  assert.equal(panel.props.key, "details");
  assert.equal(panel.props.borderStyle, "round");
  assert.deepEqual(panel.props.children.map((t) => t.props.children[0]), picked.details.lines);
  assert.ok(panel.props.width <= picked.w);
});

test("desktop: write bubbles, red for a possible conflict, and info icons are in the SVG", () => {
  const svg = renderSvg(busyScene);
  assert.equal((svg.match(/class="bub c"/g) || []).length, 2);
  assert.equal((svg.match(/class="bub w"/g) || []).length, 1);
  assert.equal((svg.match(/class="info-c"/g) || []).length, 2);
  assert.ok(svg.includes(">✎ wizard.m…<") && svg.includes(">✎ README.md<"));
});

test("terminal: every person is a dot and a role letter, a waiting arrow shifts with the tick, the same every time", () => {
  const a = renderCells(scene, 0);
  assert.deepEqual(a, renderCells(scene, 0));
  assert.equal(a.columns, scene.w);
  assert.equal(a.rows, scene.h);
  const rows = text(a);
  const at = (p, n) => rows[p.y].slice(p.x, p.x + n);
  const by = Object.fromEntries(scene.people.map((p) => [p.id, p]));
  assert.equal(at(by["s-a:lead"], 2), "●★");
  assert.equal(at(by["s-b:lead"], 2), "●L");
  assert.equal(at(by.w1, 2), "●W");
  assert.equal(at(by.v1, 3), "●V■");
  assert.equal(at(by.r1, 3), "●R×");
  const arrow = (cells) => text(cells)[by.w1.y].slice(by.w1.x - 3, by.w1.x);
  assert.deepEqual([arrow(a), arrow(renderCells(scene, 1)), arrow(renderCells(scene, 2))], ["›··", "·›·", "··›"]);
});

test("terminal: ✎ and the file's name above a writer, coloured by clash, and i beside a reviewer with findings", () => {
  const cells = renderCells(busyScene);
  const rows = text(cells);
  const by = Object.fromEntries(busyScene.people.map((p) => [p.id, p]));
  const above = (p) => rows[p.y - 1].slice(p.x - 3, p.x + 7);
  assert.equal(above(by.w1), "✎wizard.m…");
  assert.equal(above(by.w2), "✎README.md");
  assert.equal(rows[by.v1.y].slice(by.v1.x, by.v1.x + 3), "●Vi");
  assert.equal(rows[by.v9.y].slice(by.v9.x, by.v9.x + 4), "●V×i");
  const words = new Uint32Array(Uint8Array.from(atob(cells.cells), (c) => c.charCodeAt(0)).buffer);
  const ink = (p) => words[((p.y - 1) * cells.columns + p.x - 3) * 3 + 1];
  assert.deepEqual([ink(by.w1), ink(by.w9), ink(by.w2)], [0xf07d61, 0xf07d61, 0xf3c24f]);
});

test("terminal: the selected person's detail is cut to the rows kept for it", () => {
  const picked = layout(busy, viewerFor(busy, "s-a"), { columns: 90, selected: "w1" });
  const detail = (rows) => drawTerminal(picked, el, { detailRows: rows }).props.children.slice(1);
  assert.equal(detail(Infinity).length, picked.details.lines.length + picked.details.more.length);
  assert.equal(detail(3).length, 3);
});

test("terminal: a focusable label per person, and the selected person's detail under the plan", () => {
  const tree = drawTerminal(layout(m, viewerFor(m, "s-a"), { columns: 90, selected: "w1" }), el);
  const [plan, ...detail] = tree.props.children;
  const [raster, ...seats] = plan.props.children;
  assert.equal(raster.type, "Raster");
  assert.equal(raster.props.key, "plan");
  const buttons = seats.map((s) => s.props.children[0]);
  assert.deepEqual(buttons.map((b) => seatOf(b.props.key)), scene.people.map((p) => p.id));
  assert.equal(buttons.find((b) => b.props.key === seatKey("s-a:lead")).props.autoFocus, true);
  assert.equal(detail[0].props.children[0], "worker · role worker · type worker");
  assert.equal(detail[1].props.children[0], "working for 5m");
});

test("desktop: every hover card is wide enough for its text and stays inside the plan", () => {
  const small = layout(m, viewerFor(m, "s-a"), { columns: 40 });
  const busySmall = layout(busy, viewerFor(busy, "s-a"), { columns: 40 });
  for (const s of [scene, small, busyScene, busySmall]) {
    for (const seat of seatsOf(drawDesktop(s, el))) {
      const card = seat.props.children.find((c) => c.props.hover).props;
      const x = seat.props.left + card.left;
      const y = seat.props.top + card.top;
      assert.ok(card.width >= 12, "wide enough to read");
      assert.ok(x >= 0 && x + card.width <= s.w, `inside the plan's width: ${x}..${x + card.width} of ${s.w}`);
      assert.ok(y >= 0, "not above the plan");
      // Its rows as drawDesktop counts them: each line wrapped inside the border and padding.
      const texts = card.children.map((t) => t.props.children[0]);
      const h = texts.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / (card.width - 4))), 0) + 2;
      assert.ok(y + h <= s.h, `inside the plan's height: ${y}..${y + h} of ${s.h}`);
    }
  }
});

test("lights off: faded in the SVG and dim in the cells, with no hover box or seat button for its people", () => {
  const night = office([
    { id: "a", sessions: [{ id: "s-a" }] },
    { id: "z", sessions: [{ id: "s-z", status: "idle", idle: 180, lights: "off", lead: "idle", team: [{ id: "v9", type: "reviewer", role: "reviewer", status: "done", report: "Looks fine." }] }] },
  ]);
  const s = layout(night, viewerFor(night, "s-a"), { columns: 90 });
  const svg = renderSvg(s);
  const faded = svg.slice(svg.indexOf('<g class="off">'));
  assert.ok(faded.includes("Room z") && faded.includes('class="info-c"') && !faded.includes("Room a"));
  assert.deepEqual(seatsOf(drawDesktop(s, el)).map((b) => b.props.key), ["seat:s-a:lead"]);
  assert.equal(pickOf(seatsOf(drawDesktop(s, el))[0]).props.key, pickKey("s-a:lead"));
  const [, ...seats] = drawTerminal(s, el).props.children[0].props.children;
  assert.deepEqual(seats.map((b) => seatOf(b.props.children[0].props.key)), ["s-a:lead"]);
  assert.equal(seats[0].props.children[0].props.autoFocus, true);
  const cells = renderCells(s);
  const words = new Uint32Array(Uint8Array.from(atob(cells.cells), (c) => c.charCodeAt(0)).buffer);
  const v9 = s.people.find((p) => p.id === "v9");
  assert.equal(text(cells)[v9.y].slice(v9.x, v9.x + 3), "●Vi");
  assert.equal(words[(v9.y * cells.columns + v9.x) * 3 + 1], 0x56625f);
});

test("desktop: a report card taller than the plan is cut to it, ending in …", () => {
  const one = office([{ id: "a", sessions: [{ id: "s-a", team: [{ id: "v1", type: "reviewer", role: "reviewer", status: "done", report }] }] }]);
  const short = layout(one, viewerFor(one, "s-a"));
  const seat = seatsOf(drawDesktop(short, el)).find((c) => c.props.key === "seat:v1");
  const card = seat.props.children.find((c) => c.props.hover).props;
  const texts = card.children.map((t) => t.props.children[0]);
  assert.equal(texts.length, short.h - 2);
  assert.ok(texts.length < 1 + short.people.find((p) => p.id === "v1").card.lines.length);
  assert.equal(texts.at(-1), "…");
});

test("a red bubble past its seconds is drawn as a red dot on both panes", () => {
  const m = office([
    { id: "a", sessions: [{ id: "s-a", team: [{ id: "w1", writing: "lib/wizard.mjs" }] }] },
    { id: "b", sessions: [{ id: "s-b", team: [{ id: "w9", writing: "lib/wizard.mjs" }] }] },
  ]);
  m.meaning.conflicts = [{ file: "lib/wizard.mjs", agents: ["w1", "w9"], by: "rules" }];
  const scene = layout(m, viewerFor(m, "s-a"), { now: Date.parse(m.generatedAt) + 60000 });
  const w1 = scene.people.find((p) => p.id === "w1");
  assert.equal(w1.bubble.dot, true);
  const svg = renderSvg(scene);
  assert.ok(svg.includes('<circle class="bub c"') && !svg.includes("✎"));
  const { columns, cells } = renderCells(scene);
  const bytes = Buffer.from(cells, "base64");
  const ch = (x, y) => String.fromCodePoint(bytes.readUInt32LE((y * columns + x) * 12));
  assert.equal(ch(w1.x + 1, w1.y - 1), "●");
});
