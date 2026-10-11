// Agent Office's terminal drawing: a laid-out scene (layout.mjs) as coloured cells for a `Raster`,
// ported from the agreed prototype's renderCells (#46). Each person is a coloured dot and a role
// letter; a waiting line is a `›··` arrow beside the agent being waited on, shifting toward it on
// each tick, so the host animates it by repainting the cells with `$.ui.blit`.
//
// Pure: no Node imports and no `$`. The host hands in the surface's element constructors.

const DEFAULT = 0x01000000; // the terminal's own colour
const INK = {
  wall: 0x7e9590,
  dim: 0x7d908c,
  you: 0x71bdb9,
  work: 0xf3c24f,
  ok: 0x6cc28a,
  idle: 0x7d908c,
  stall: 0xc79be0,
  fail: 0xc79be0,
  stop: 0x7d908c,
  youWash: 0x1b3033,
  table: 0x24343a,
};
const GLYPH = { you: "★", lead: "L", worker: "W", scout: "S", researcher: "R", reviewer: "V" };
// The mark after the figure: stalled !, failed ×, stopped ■ (ended early, never answers).
const MARK = { stall: "!", fail: "×", stop: "■" };
const PHASES = ["›··", "·›·", "··›"];

const clip = (t, n) => ([...t].length > n ? [...t].slice(0, Math.max(0, n - 1)).join("") + "…" : t);

/** scene, tick → { columns, rows, cells }: the Raster's props, cells as RasterProps' base64. */
export function renderCells(scene, tick = 0) {
  const W = Math.max(1, scene.w);
  const H = Math.max(1, scene.h);
  const fg = new Uint32Array(W * H).fill(DEFAULT);
  const bg = new Uint32Array(W * H).fill(DEFAULT);
  const ch = new Uint32Array(W * H).fill(32);
  const at = (x, y) => (x >= 0 && x < W && y >= 0 && y < H ? y * W + x : -1);
  const put = (x, y, text, colour) => {
    [...text].forEach((c, k) => {
      const i = at(x + k, y);
      if (i < 0) return;
      ch[i] = c.codePointAt(0);
      if (colour !== undefined) fg[i] = colour;
    });
  };
  const fill = (x, y, w, h, colour) => {
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) if (at(c, r) >= 0) bg[at(c, r)] = colour;
  };
  const frame = (x, y, w, h, colour) => {
    put(x, y, "┌" + "─".repeat(w - 2) + "┐", colour);
    put(x, y + h - 1, "└" + "─".repeat(w - 2) + "┘", colour);
    for (let r = y + 1; r < y + h - 1; r++) {
      put(x, r, "│", colour);
      put(x + w - 1, r, "│", colour);
    }
  };

  for (const r of scene.rooms) {
    if (r.you) fill(r.x + 1, r.y + 1, r.w - 2, r.h - 2, INK.youWash);
    frame(r.x, r.y, r.w, r.h, INK.wall);
    put(r.x + 2, r.y, " " + clip((r.you ? "★ " : "") + r.title, r.w - 6) + " ", r.you ? INK.you : r.idle ? INK.dim : DEFAULT);
    put(r.x + 2, r.y + 1, clip(r.sub, r.w - 4), INK.dim);
  }
  for (const t of scene.tables) fill(t.x, t.y, t.w, 2, INK.table);
  const awaited = new Set(scene.lines.map((l) => l.to));
  for (const p of scene.people) {
    put(p.x, p.y, "●" + (GLYPH[p.role] || "?"), INK[p.look]);
    if (MARK[p.look]) put(p.x + 2, p.y, MARK[p.look], INK[p.look === "stop" ? "dim" : "stall"]);
    if (awaited.has(p.id)) put(p.x - 3, p.y, PHASES[tick % PHASES.length], INK.dim);
    put(p.x - 3, p.y + 1, clip(p.label, 10), p.role === "you" ? INK.you : INK.dim);
  }
  if (scene.hidden) put(0, H - 1, `+${scene.hidden} more room${scene.hidden > 1 ? "s" : ""}: give the pane more rows to see ${scene.hidden > 1 ? "them" : "it"}`, INK.dim);

  const words = new Uint32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) words.set([ch[i], fg[i], bg[i]], i * 3);
  return { columns: W, rows: H, cells: base64(words) };
}

/**
 * The pane's tree on the terminal: the plan as a Raster keyed "plan", a plain Button over each
 * person's label so the pane's focus ring (Tab and the arrows, once the pane has the keys) walks
 * between people, then the selected person's detail under the plan.
 *
 * el: the surface's elements ({ Box, Text, Raster, Button }). selected: an agent id or null.
 * onSelect(id): what a press on a person runs.
 */
export function drawTerminal(scene, el, { tick = 0, selected = null, onSelect = () => {} } = {}) {
  const { Box, Text, Raster, Button } = el;
  const plan = renderCells(scene, tick);
  const seats = scene.people.map((p) =>
    Box({
      key: "at:" + p.id,
      position: "absolute",
      top: p.y + 1,
      left: p.x - 3,
      children: [
        Button({
          key: seatKey(p.id),
          label: clip(p.label, 10),
          plain: true,
          dimColor: true,
          ...(p.role === "you" ? { autoFocus: true } : {}),
          onPress: () => onSelect(p.id),
        }),
      ],
    }),
  );
  const rows = [Box({ position: "relative", children: [Raster({ key: "plan", ...plan }), ...seats] })];
  const who = scene.people.find((p) => p.id === selected);
  if (who) rows.push(...detailLines(who).map((line, i) => Text({ bold: i === 0, wrap: "truncate-end", children: [line] })));
  return Box({ flexDirection: "column", children: rows });
}

/** The selected person's detail, a line each: who, then the card's lines. */
export function detailLines(p) {
  return [`${p.card.title} · ${p.card.lines[0]}`, ...p.card.lines.slice(1)];
}

/** The Button key for a person, and back. */
export const seatKey = (id) => "seat:" + id;
export const seatOf = (key) => (typeof key === "string" && key.startsWith("seat:") ? key.slice(5) : null);

// Standard padded base64 of the words, little-endian as RasterProps asks.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(words) {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((w, i) => view.setUint32(i * 4, w, true));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : "=";
  }
  return out;
}
