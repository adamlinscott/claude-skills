import { test } from "node:test";
import assert from "node:assert/strict";
import { layout, viewerFor } from "../layout.mjs";
import { renderSvg, drawDesktop } from "../draw-desktop.mjs";
import { renderCells, drawTerminal, seatKey, seatOf } from "../draw-terminal.mjs";
import { office } from "./office.mjs";

const m = office([
  { id: "a", sessions: [{ id: "s-a", team: [{ id: "w1", waited: true }, { id: "v1", type: "reviewer", role: "reviewer", status: "stopped" }] }] },
  { id: "b", sessions: [{ id: "s-b", lead: "idle", team: [{ id: "r1", type: "researcher", role: "researcher", status: "failed" }] }] },
]);
const scene = layout(m, viewerFor(m, "s-a"), { columns: 90 });
// Element constructors that record what they were given.
const el = new Proxy({}, { get: (_, type) => (props) => ({ type, props }) });

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
});

test("desktop: a keyed hover box over every seat, holding that person's card", () => {
  const tree = drawDesktop(scene, el);
  const [svg, ...seats] = tree.props.children;
  assert.equal(svg.type, "Svg");
  assert.deepEqual(seats.map((s) => s.props.key), scene.people.map((p) => "seat:" + p.id));
  const card = seats[1].props.children.find((c) => c.props.hover);
  assert.deepEqual(card.props.hover, { display: "flex" });
  assert.equal(card.props.display, "none");
  assert.equal(card.props.children[0].props.children[0], scene.people[1].card.title);
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

test("terminal: a focusable label per person, and the selected person's detail under the plan", () => {
  const tree = drawTerminal(scene, el, { selected: "w1" });
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
  for (const s of [scene, small]) {
    for (const seat of drawDesktop(s, el).props.children.slice(1)) {
      const card = seat.props.children.find((c) => c.props.hover).props;
      const x = seat.props.left + card.left;
      const y = seat.props.top + card.top;
      assert.ok(card.width >= 12, "wide enough to read");
      assert.ok(x >= 0 && x + card.width <= s.w, `inside the plan's width: ${x}..${x + card.width} of ${s.w}`);
      assert.ok(y >= 0, "not above the plan");
    }
  }
});
