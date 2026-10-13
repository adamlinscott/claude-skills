// Agent Office's Desktop drawing: a laid-out scene (layout.mjs) as one SVG for an image-mode `Svg`,
// ported from the agreed prototype's renderSvg (#46), plus a keyed `Box` over each seat holding a
// hover card with that person's detail (#43: interactive Svg reloads on every redraw, Box hover
// cards survive them) and a plain Button that picks the person for the details panel under the
// plan (#58).
//
// The SVG is drawn on the scene's cell grid at the Desktop's rough cell size, so a Box placed in
// cells lands over the figure it belongs to. Motion is CSS inside the SVG: the dots on a waiting
// line travel from the agent waiting toward the agent working, at the app's own frame rate.
//
// Pure: no Node imports and no `$`. The host hands in the surface's element constructors.

/** One layout cell in Desktop pixels (measured roughly on #43). */
export const CELL = { w: 7.9, h: 19 };

const FONT = "ui-monospace,Consolas,Menlo,monospace";
const SANS = "system-ui,'Segoe UI',Arial,sans-serif";

// The prototype's colours, light and dark.
const STYLE = `
:root{--ground:#e7eae5;--sheet:#f5f6f2;--ink:#1a2528;--ink-2:#4d5c5f;--rule:#bcc6c1;--wall:#2b3a3e;--table:#d6dcd6;
--lamp:#e2a91f;--ok:#2f8a55;--you:#2c6d71;--you-wash:rgba(44,109,113,.10);--stall:#9a5ab8;--clash:#c4462e;--info:#2e64c8;--bubble-ink:#1a1a12}
@media (prefers-color-scheme:dark){:root{--ground:#0f1618;--sheet:#152024;--ink:#e3eae6;--ink-2:#9db0ac;--rule:#30444a;--wall:#c9d6d2;
--table:#22323a;--lamp:#f3c24f;--ok:#6cc28a;--you:#71bdb9;--you-wash:rgba(113,189,185,.12);--stall:#c79be0;--clash:#f07d61;--info:#7aa7f5}}
.wall{fill:none;stroke:var(--wall);stroke-width:2}
.room-you{fill:var(--you-wash)}.room-dim{fill:var(--ground);opacity:.6}
.table{fill:var(--table);stroke:var(--rule)}
.t{font-family:${FONT};font-size:10.5px;fill:var(--ink-2)}
.title{font:700 13px ${SANS};fill:var(--ink)}.youc{fill:var(--you)}
.lab{font-size:10px;fill:var(--ink)}
.flow{fill:none;stroke:var(--ink-2);stroke-width:2.2;stroke-linecap:round;stroke-dasharray:.1 7;animation:flow 1s linear infinite}
@keyframes flow{to{stroke-dashoffset:-7.1}}
.flow-head{fill:var(--ink-2)}
@media (prefers-reduced-motion:reduce){.flow{animation:none}}
.glow{fill:var(--lamp);opacity:.18}
.av{color:var(--ink-2)}.av.work{color:var(--lamp)}.av.ok{color:var(--ok)}.av.you{color:var(--you)}
.av.idle,.av.stop{color:var(--ink-2);opacity:.5}.av.stall,.av.fail{color:var(--stall)}
.body{fill:currentColor}
.acc{fill:var(--ink)}.acc-line{fill:none;stroke:var(--ink);stroke-width:1.2;stroke-linecap:round}
.acc-ring{fill:var(--sheet);fill-opacity:.55;stroke:var(--ink);stroke-width:1.4}
.acc-star{fill:var(--lamp);stroke:var(--ink);stroke-width:.6}
.badge{fill:var(--sheet);stroke:var(--ink);stroke-width:.8}.badge-t{font:700 9px ${SANS};fill:var(--ink)}
.stop-sq{fill:var(--ink-2)}
.bub{stroke:var(--wall);stroke-width:.8}.bub.w{fill:var(--lamp)}.bub.c{fill:var(--clash)}
.bub-t{font:700 10px ${FONT};fill:var(--bubble-ink)}
.info-c{fill:var(--info)}.info-t{font:700 10px Georgia,serif;fill:var(--sheet)}
.off{opacity:.45;filter:saturate(.15)}`;

// The profile silhouettes: one body, one accessory per role (#46).
const BODY = `<g class="body"><circle cx="12" cy="8.6" r="4.6"/><path d="M2.6 23.4c0-5.6 4.2-9 9.4-9s9.4 3.4 9.4 9z"/></g>`;
const ACCESSORY = {
  worker: `<path class="acc" d="M6.6 7.9a5.4 5.4 0 0 1 10.8 0z"/><rect class="acc" x="5" y="7.6" width="14" height="1.7" rx=".8"/>`,
  scout: `<path class="acc" d="M7.4 7.6a4.6 4.6 0 0 1 9.2 0z"/><path class="acc" d="M12 6.6h7.6a1 1 0 0 1 0 1.9H12z"/>`,
  researcher: `<circle class="acc-line" cx="9.8" cy="9" r="1.9"/><circle class="acc-line" cx="14.2" cy="9" r="1.9"/><path class="acc-line" d="M11.7 9h.6"/>`,
  reviewer: `<circle class="acc-ring" cx="17.6" cy="15.8" r="3.3"/><path class="acc-line" style="stroke-width:2" d="M20 18.2l2.6 2.6"/>`,
  lead: `<path class="acc" d="M12 15.1l-1.3 1.5 1.3 5.4 1.3-5.4z"/><path class="acc" d="M10.6 14.6h2.8l-1.4 1.4z"/>`,
  you: `<path class="acc-star" d="M18.4 12.6l.9 1.9 2.1.3-1.5 1.5.4 2.1-1.9-1-1.9 1 .4-2.1-1.5-1.5 2.1-.3z"/>`,
  other: "",
};
const SYMBOLS = Object.entries(ACCESSORY)
  .map(([role, acc]) => `<symbol id="av-${role}" viewBox="0 0 24 24">${BODY}${acc}</symbol>`)
  .join("");

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (t, n) => ([...t].length > n ? [...t].slice(0, Math.max(0, n - 1)).join("") + "…" : t);
const px = (n) => Math.round(n * 10) / 10;
const base = (file) => file.split(/[\\/]/).pop();

// A person's figure is two cells wide (the terminal's dot and letter); its centre in pixels.
const centre = (p) => [px((p.x + 1) * CELL.w), px((p.y + 0.5) * CELL.h)];

// Each redraw loads a fresh SVG and so restarts its animation. Started at the wall clock's place in
// the one-second cycle, the dots carry on from where they were instead of jumping back.
const phase = (now) => (now === undefined ? "" : ` style="animation-delay:-${Math.round(now % 1000)}ms"`);

/**
 * scene → the SVG document for an image-mode Svg, `width` × `height` pixels. now: the wall clock
 * in ms, to keep the waiting lines' motion continuous across redraws; left out, the SVG is the same
 * every time.
 */
export function renderSvg(scene, { now } = {}) {
  const width = px(scene.w * CELL.w);
  const height = px(Math.max(1, scene.h) * CELL.h);
  // Lights-off rooms go in one faded group: every colour, text and figure in them, as they were.
  const lit = [];
  const dark = [];
  const into = (item) => (item.off ? dark : lit);
  for (const r of scene.rooms) {
    const out = into(r);
    const [x, y, w, h] = [px(r.x * CELL.w), px(r.y * CELL.h), px(r.w * CELL.w), px(r.h * CELL.h)];
    const wash = r.you ? "room-you" : r.idle ? "room-dim" : null;
    if (wash) out.push(`<rect class="${wash}" x="${x}" y="${y}" width="${w}" height="${h}"/>`);
    out.push(`<rect class="wall" x="${x}" y="${y}" width="${w}" height="${h}" rx="2"/>`);
    // A folded strip has its status on the right, so its title gets only the room left of that.
    const room = r.folded ? w - 30 - r.sub.length * 6.4 : w - 20;
    const title = esc(clip((r.you ? "★ " : "") + r.title, Math.max(4, Math.floor(room / 7.4))));
    if (r.folded) {
      const mid = px(y + h / 2 + 4);
      out.push(`<text class="title${r.you ? " youc" : ""}" x="${x + 10}" y="${mid}">${title}</text>`);
      out.push(`<text class="t" x="${px(x + w - 10)}" y="${mid}" text-anchor="end">${esc(r.sub)}</text>`);
    } else {
      out.push(`<text class="title${r.you ? " youc" : ""}" x="${x + 10}" y="${px(y + CELL.h * 0.85)}">${title}</text>`);
      out.push(`<text class="t" x="${x + 10}" y="${px(y + CELL.h * 1.75)}">${esc(clip(r.sub, Math.floor((w - 20) / 6.4)))}</text>`);
    }
  }
  for (const t of scene.tables) into(t).push(`<rect class="table" x="${px(t.x * CELL.w)}" y="${px(t.y * CELL.h + 4)}" width="${px(t.w * CELL.w)}" height="${px(2 * CELL.h - 8)}" rx="4"/>`);
  const at = new Map(scene.people.map((p) => [p.id, p]));
  for (const l of scene.lines) {
    const [ax, ay] = centre(at.get(l.from));
    const [bx, by] = centre(at.get(l.to));
    // From beside the waiter, curving into the agent it waits on, ending short of the figure.
    into(at.get(l.from)).push(`<path class="flow"${phase(now)} marker-end="url(#flow-head)" d="M${px(ax + 14)} ${ay}C${px((ax + bx) / 2)} ${ay} ${bx} ${px((ay + by) / 2)} ${bx} ${px(by + (by < ay ? 16 : -18))}"/>`);
  }
  for (const p of scene.people) {
    const out = into(p);
    const [cx, cy] = centre(p);
    if (p.look === "work") out.push(`<circle class="glow" cx="${cx}" cy="${px(cy - 3)}" r="15"/>`);
    out.push(`<use href="#av-${ACCESSORY[p.role] === undefined ? "other" : p.role}" class="av ${p.look}" x="${px(cx - 13)}" y="${px(cy - 17)}" width="26" height="26"/>`);
    if (p.look === "stall" || p.look === "fail") {
      out.push(`<circle class="badge" cx="${px(cx + 11)}" cy="${px(cy - 15)}" r="5.5"/><text class="badge-t" x="${px(cx + 11)}" y="${px(cy - 11.8)}" text-anchor="middle">${p.look === "fail" ? "×" : "!"}</text>`);
    }
    if (p.look === "stop") out.push(`<rect class="stop-sq" x="${px(cx + 7)}" y="${px(cy - 19)}" width="8" height="8" rx="1"/>`);
    // The info icon sits where a status mark would, and beside it when there is one.
    if (p.info) {
      const ix = cx + (["stall", "fail", "stop"].includes(p.look) ? 24 : 12);
      out.push(`<circle class="info-c" cx="${px(ix)}" cy="${px(cy - 15)}" r="6.5"/><text class="info-t" x="${px(ix)}" y="${px(cy - 11.5)}" text-anchor="middle">i</text>`);
    }
    if (p.bubble && p.bubble.dot) {
      // A conflict past its first seconds: a red light above the figure until it is checked.
      out.push(`<circle class="bub c" cx="${px(cx + 9)}" cy="${px((p.y - 1) * CELL.h + 9)}" r="4"/>`);
    } else if (p.bubble) {
      // In the row above the figure, its tail on the figure; kept within the seat's own columns so
      // neighbouring bubbles and the room's wall stay clear. Nine letters, as on the terminal.
      const t = "✎ " + clip(base(p.bubble.file), 9);
      const bw = [...t].length * 6.4 + 12;
      const bx = Math.max(cx - bw / 2, (p.x - 3) * CELL.w);
      const by = (p.y - 1) * CELL.h - 1;
      out.push(`<path class="bub ${p.bubble.clash ? "c" : "w"}" d="M${px(bx + 3)} ${px(by)}h${px(bw - 6)}a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H${px(cx + 3)}l-3 3-3-3H${px(bx + 3)}a3 3 0 0 1-3-3v-8a3 3 0 0 1 3-3z"/><text class="bub-t" x="${px(bx + bw / 2)}" y="${px(by + 10.5)}" text-anchor="middle">${esc(t)}</text>`);
    }
    // A name is drawn here only in a lights-off room: elsewhere the seat's button is the name, and
    // drawing both put two names, in two fonts, over each other.
    if (p.off) out.push(`<text class="t lab${p.role === "you" ? " youc" : ""}" x="${cx}" y="${px((p.y + 1) * CELL.h + 13)}" text-anchor="middle">${esc(clip(p.label, 12))}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><style>${STYLE}</style><defs>${SYMBOLS}<marker id="flow-head" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse" orient="auto"><path class="flow-head" d="M0 0L6 3L0 6z"/></marker></defs>${lit.join("")}${dark.length ? `<g class="off">${dark.join("")}</g>` : ""}</svg>`;
}

/**
 * The pane's plan on the Desktop: the Svg, with a keyed Box over each seat whose card appears
 * while the pointer is over it and a Button that presses onSelect(id); none in a lights-off room.
 * Under the plan, the scene's details in a bordered panel.
 * el: the surface's elements ({ Box, Text, Svg, Button }).
 */
export function drawDesktop(scene, el, { now, source, onSelect = () => {} } = {}) {
  const { Box, Text, Svg, Button } = el;
  const svg = Svg({ source: source ?? renderSvg(scene, { now }), alt: describe(scene), width: px(scene.w * CELL.w), height: px(Math.max(1, scene.h) * CELL.h) });
  const seats = scene.people.filter((p) => !p.off).map((p) => {
    // A whole seat (the room above the figure, the figure, its label) is the hover spot: the cell
    // size is only roughly known, so the spot is generous rather than exact.
    const seat = { top: p.y - 1, left: p.x - 3, w: 9, h: 3 };
    // The card is sized to its text and kept inside the plan: anything past the plan's edge makes
    // the pane scroll and clips the card.
    let lines = [p.card.title, ...p.card.lines];
    const cardW = Math.min(Math.max(...lines.map((l) => l.length)) + 4, Math.max(12, Math.min(48, scene.w)));
    // Border and padding take four columns; a long line (a description) wraps inside the rest.
    const rowsOf = (l) => Math.max(1, Math.ceil(l.length / (cardW - 4)));
    // A card taller than the plan (a report on a short plan) is cut to it, ending in "…".
    let kept = 0;
    for (let n = 0; kept < lines.length && n + rowsOf(lines[kept]) <= Math.max(1, scene.h) - 2; kept++) n += rowsOf(lines[kept]);
    if (kept < lines.length) lines = [...lines.slice(0, Math.max(1, kept - 1)), "…"];
    const cardH = lines.reduce((n, l) => n + rowsOf(l), 0) + 2;
    // Beside the seat, right or else left, never over it: a card over the seat covers the name,
    // which is the button that opens the details, so a click there would land on the card. With no
    // room either side it goes above the seat or below it.
    const H = Math.max(1, scene.h);
    let left = seat.w;
    let top = Math.max(-seat.top, Math.min(0, H - cardH - seat.top));
    if (seat.left + seat.w + cardW > scene.w) {
      if (seat.left - cardW >= 0) left = -cardW;
      else {
        left = Math.max(-seat.left, Math.min(0, scene.w - cardW - seat.left));
        top = seat.top - cardH >= 0 ? -cardH : Math.min(seat.h, H - cardH - seat.top);
      }
    }
    return Box({
      key: "seat:" + p.id,
      position: "absolute",
      top: seat.top,
      left: seat.left,
      width: seat.w,
      height: seat.h,
      children: [
        // The name under the figure is the button that opens the details: a blank label drew nothing
        // to click in the Claude app, so the name itself is the visible, pressable control.
        Box({ position: "absolute", top: 2, left: 0, width: seat.w, justifyContent: "center", children: [Button({ key: pickKey(p.id), label: clip(p.label, seat.w), plain: true, dimColor: true, onPress: () => onSelect(p.id) })] }),
        Box({
          position: "absolute",
          top,
          left,
          width: cardW,
          display: "none",
          hover: { display: "flex" },
          flexDirection: "column",
          borderStyle: "round",
          paddingX: 1,
          backgroundColor: "#152024",
          children: [
            Text({ bold: true, color: "#e3eae6", children: [lines[0]] }),
            ...lines.slice(1).map((line) => Text({ color: "#e3eae6", children: [line] })),
          ],
        }),
      ],
    });
  });
  const plan = Box({ key: "plan", position: "relative", children: [svg, ...seats] });
  return Box({ flexDirection: "column", children: scene.details ? [plan, panel(scene, el)] : [plan] });
}

/** The Button key for a person's seat on the Desktop; apart from the terminal's, so a focus there never moves the terminal's selection. */
export const pickKey = (id) => "pick:" + id;

// The selected person's details, in a bordered box as wide as its longest line, inside the plan's
// width; a longer line wraps.
function panel(scene, el) {
  const { Box, Text } = el;
  const { lines } = scene.details;
  return Box({
    key: "details",
    width: Math.min(Math.max(12, ...lines.map((l) => l.length + 4)), Math.max(12, scene.w)),
    flexDirection: "column",
    borderStyle: "round",
    paddingX: 1,
    children: lines.map((line, i) => Text({ bold: i === 0, children: [line] })),
  });
}

// What the plan says for a reader that cannot see it: each room and who is in it.
function describe(scene) {
  if (!scene.rooms.length) return "Agent Office floor plan: no sessions in this project yet.";
  const rooms = scene.rooms.map((r) => {
    const people = scene.people.filter((p) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h);
    return `${r.you ? "your room, " : ""}${r.title}${r.off || r.folded ? " (" + r.sub + ")" : ""}${people.length ? ": " + people.map((p) => `${p.label} ${p.card.lines[1]}`).join(", ") : ""}`;
  });
  return "Agent Office floor plan. " + rooms.join(". ") + ".";
}
