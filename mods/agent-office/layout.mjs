// Agent Office's layout: turns the office model and the viewer into a scene, the rooms, tables,
// people and waiting lines placed on a grid of terminal cells. Both renderers draw the one scene:
// the terminal as cells, the Desktop pane as an SVG with each cell scaled to pixels.
//
// Grid layout A, as agreed on #46: the viewer's room first, then every other room in a fixed
// place, whether its lights are on or off: the office changes gradually, so a room dims where it
// stands rather than moving. Placing rooms (layout) is a
// separate step from drawing one (drawRoom), and a room is drawn from its list of sessions, so a
// later layout or a room of several sessions changes neither.
//
// Pure: no Node imports and no `$`. The mod and any later app share this file.

import { SCHEMA_VERSION } from "./model.mjs";

const SEAT = 12; // columns per seat at the table
const LEAD_W = 12; // columns the lead's place takes, left of the table
const ROOM_MIN_W = 40;
const HEAD_H = 3; // a room's title row, its small print and a blank row
const FOLD_W = 34;
const FOLD_H = 3; // a folded room: its frame round one line
const CARD_TEXT = 44; // a card's text width: the Desktop card is at most 48 columns, less its border and padding
const REPORT_LINES = 8; // a report's lines on the card; the full text is /office's (#52)

// How each status is drawn. The viewer's own lead is drawn as "you" whatever its status.
const LOOK = { working: "work", done: "ok", idle: "idle", stalled: "stall", failed: "fail", stopped: "stop" };

/** The viewer: the session the pane is drawn in (its id in the model) and the human who owns it. */
export function viewerFor(model, sessionId) {
  const session = model && model.sessions.find((s) => s.id === sessionId);
  return { human: session ? session.owner : null, session: sessionId };
}

/**
 * model, viewer → scene, in terminal cells:
 *   { w, h, order, hidden,
 *     rooms:  [{ id, x, y, w, h, title, sub, you, idle, folded, off }],
 *     tables: [{ x, y, w, off }],                  two rows tall
 *     people: [{ id, x, y, role, look, label, bubble: { file, clash } | null, info, off, card: { title, lines } }],
 *     lines:  [{ from: waiter id, to: agent id }]  only between people drawn
 *     details: { id, lines, more } | null }        the selected person's, when drawn: the panel's
 *                                                  lines, and the card's lines the panel doesn't say
 *
 * columns: the width to fill. rows: the height to fit (the terminal's pane); rooms past it fold,
 *          then drop, counted in `hidden`. order: the room ids in the order the host first saw
 *          them; the scene's `order` adds new rooms at the end, for the host to pass next time.
 * now:     ms since the epoch, for the idle times and the cards; the model's own time by default.
 * touchedWindowMinutes: the engine's window for a possible conflict, for the card's wording. The
 *          model doesn't carry it, so it is config.json's default unless the host passes it.
 * bubbleSeconds: how long a write bubble stays amber after the write (config.json's default).
 * titles:  session id → a title the host had written for it, used in place of a branch stand-in.
 * selected: the agent id whose details to give, or null.
 * contextWindows: config.json's table, model id → { window, compactAt } in tokens, "*" the default.
 * own:     the viewer's own session's reading, { model, window, compactAt, tokens }, or null.
 */
export function layout(model, viewer, { columns = 124, rows = Infinity, order = [], now = Date.parse(model.generatedAt), touchedWindowMinutes = 30, bubbleSeconds = 10, titles = {}, selected = null, contextWindows = {}, own = null } = {}) {
  const office = { ...index(model, viewer, now, touchedWindowMinutes, bubbleSeconds, titles), contextWindows, own };
  const seen = [...order, ...model.rooms.map((r) => r.id).filter((id) => !order.includes(id))];
  const rank = new Map(seen.map((id, i) => [id, i]));
  const rooms = [...model.rooms].sort((a, b) => rank.get(a.id) - rank.get(b.id));
  const width = Math.max(columns, ROOM_MIN_W);

  const yours = rooms.find((r) => r.sessions.includes(viewer.session));
  // Squeezed into `rows`: rooms fold where they stand, lights-off rooms from the last first, then
  // lit ones from the last; then rooms drop from the end.
  let plan = [yours, ...rooms.filter((r) => r !== yours)].filter(Boolean).map((room) => ({ room, fold: false }));
  let hidden = 0;
  const tall = () => place(office, plan, width).h + (hidden ? 1 : 0) > rows;
  while (tall()) {
    const last = plan.findLast((p) => !p.fold && p.room !== yours && lightsOff(office, p.room)) || plan.findLast((p) => !p.fold && p.room !== yours);
    if (!last) break;
    last.fold = true;
  }
  while (tall() && plan.length > 1) {
    plan = plan.slice(0, -1);
    hidden += 1;
  }

  const scene = { w: width, h: 0, order: seen, hidden, rooms: [], tables: [], people: [], lines: [], details: null };
  const placed = place(office, plan, width);
  for (const { p, x, y } of placed.at) drawRoom(scene, office, p.room, p.fold, x, y, width);
  scene.h = placed.h + (hidden ? 1 : 0);
  // A lights-off room is still: its waits draw no lines.
  const drawn = new Set(scene.people.filter((q) => !q.off).map((q) => q.id));
  scene.lines = model.waits.filter((w) => drawn.has(w.waiter) && drawn.has(w.on)).map((w) => ({ from: w.waiter, to: w.on }));
  if (scene.people.some((p) => p.id === selected)) scene.details = details(office, office.agents.get(selected));
  return scene;
}

// Rooms left to right, wrapping to a new row when the next one would pass `width`.
function place(office, plan, width) {
  const at = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const p of plan) {
    const m = measure(office, p.room, p.fold, width);
    if (x && x + m.w > width) {
      x = 0;
      y += rowH + 1;
      rowH = 0;
    }
    at.push({ p, x, y });
    x += m.w + 1;
    rowH = Math.max(rowH, m.h);
  }
  return { at, h: y + rowH };
}

// The model looked up by id once, for the room drawing.
function index(model, viewer, now, window, bubbleSeconds, titles) {
  const sessions = new Map(model.sessions.map((s) => [s.id, s]));
  const rooms = new Map(model.rooms.flatMap((r) => r.sessions.map((id) => [id, r]))); // session id → its room
  const agents = new Map(model.agents.map((a) => [a.id, a]));
  const team = new Map(); // session id → its subagents, in the model's order
  for (const a of model.agents) {
    if (a.startedBy === null) continue;
    if (!team.has(a.session)) team.set(a.session, []);
    team.get(a.session).push(a);
  }
  // Files match case-insensitively, as in the meaning rules.
  const conflicts = new Map(); // lower-cased file → everyone who edited it inside the touched window
  for (const c of model.meaning.conflicts) {
    const key = c.file.toLowerCase();
    conflicts.set(key, [...(conflicts.get(key) || []), ...c.agents]);
  }
  const lastEdit = new Map(); // agent id → its newest edit
  const edited = new Map(); // lower-cased file → its newest edit's time, by anyone
  for (const e of model.edits) {
    if (!lastEdit.has(e.agent) || e.at > lastEdit.get(e.agent).at) lastEdit.set(e.agent, e);
    const key = e.file.toLowerCase();
    if (!(edited.get(key) >= e.at)) edited.set(key, e.at);
  }
  const reads = new Map(); // agent id and lower-cased file → its newest read's time
  for (const r of model.reads) {
    const key = r.agent + "\n" + r.file.toLowerCase();
    if (!(reads.get(key) >= r.at)) reads.set(key, r.at);
  }
  const findings = new Set(model.meaning.findings.map((f) => f.report));
  const reports = new Map(); // agent id → its latest report
  for (const r of model.reports) if (!reports.has(r.agent) || r.at >= reports.get(r.agent).at) reports.set(r.agent, r);
  return { sessions, rooms, agents, team, conflicts, lastEdit, edited, reads, findings, reports, waits: model.waits, viewer, now, window, bubbleMs: bubbleSeconds * 1000, titles };
}

// A room's lights are off once all its sessions have gone quiet past the engine's idle window. The
// viewer's own room never is: the pane is open in it.
function lightsOff(office, room) {
  return !room.sessions.includes(office.viewer.session) && room.sessions.every((id) => office.sessions.get(id).lights === "off");
}

// Seats per row at a table: half the team, at most what fits across `width`.
function seatsPerRow(n, width) {
  const most = Math.max(1, Math.floor((width - 4 - LEAD_W) / SEAT));
  return Math.max(1, Math.min(Math.ceil(n / 2), most));
}

// A session's block: a row of seats above the table, the table with the lead at its head, then a
// row of seats below for each further row. Every seat is three rows: room above the figure for a
// write bubble (#50), the figure, its label.
const blockH = (seatRows) => 8 + 3 * Math.max(0, seatRows - 1);

function measure(office, room, fold, width) {
  if (fold) return { w: FOLD_W, h: FOLD_H };
  let k = 1;
  let h = HEAD_H;
  for (const id of room.sessions) {
    const n = (office.team.get(id) || []).length;
    const per = seatsPerRow(n, width);
    k = Math.max(k, per);
    h += blockH(Math.ceil(n / per));
  }
  return { w: Math.max(4 + LEAD_W + k * SEAT, ROOM_MIN_W), h };
}

/** Draws one room, from its list of sessions, at (x, y) into the scene. */
function drawRoom(scene, office, room, fold, x, y, width) {
  const { w, h } = measure(office, room, fold, width);
  const sessions = room.sessions.map((id) => office.sessions.get(id));
  const you = room.sessions.includes(office.viewer.session);
  const idle = sessions.every((s) => s.status === "idle");
  const off = lightsOff(office, room);
  const since = Math.max(...sessions.map((s) => Date.parse(s.lastActive)));
  const title = roomTitle(office, room);
  let sub;
  const where = sessions.map((s) => [s.branch, folderName(s.checkout)].filter(Boolean).join(" · ")).join("  |  ");
  // The task goes last: the drawing clips small print from the end.
  const task = fold ? "" : nowLine(office, room);
  if (fold && !off) sub = "folded to fit";
  else if (off) sub = (fold ? "" : where + "  ·  ") + `lights off · idle ${duration(office.now - since)}` + task;
  else sub = where + (idle ? `  ·  idle ${duration(office.now - since)}` : "") + task;
  scene.rooms.push({ id: room.id, x, y, w, h, title, sub, you, idle, folded: fold, off });
  if (fold) return;

  let cy = y + HEAD_H;
  for (const s of sessions) {
    const subs = office.team.get(s.id) || [];
    const per = seatsPerRow(subs.length, width);
    const tx = x + 2 + LEAD_W;
    const lead = office.agents.get(s.lead);
    if (lead) scene.people.push(person(office, lead, s, x + 4, cy + 4, off));
    scene.tables.push({ x: tx, y: cy + 4, w: per * SEAT - 1, off });
    subs.forEach((a, i) => {
      const row = Math.floor(i / per);
      const col = i % per;
      // Row 0 sits above the table, the rest below it.
      const fy = row === 0 ? cy + 1 : cy + 7 + 3 * (row - 1);
      scene.people.push(person(office, a, s, tx + col * SEAT + 4, fy, off));
    });
    cy += blockH(Math.ceil(subs.length / per));
  }
}

function roomTitle(office, room) {
  const sessions = room.sessions.map((id) => office.sessions.get(id));
  // A v1 room's title is its session's, so a written title stands in for the room's too.
  if (sessions.some((s) => written(office, s))) return sessions.map((s) => written(office, s) || s.title).filter(Boolean).join(" + ");
  return room.title || sessions.map((s) => s.title).filter(Boolean).join(" + ") || "Untitled session";
}

const written = (office, s) => (s.titleFrom === "branch" && office.titles[s.id]) || null;

// What the room is doing: the task of its newest working subagent (by start, which is a working
// agent's statusSince), else the task of the one active last. Empty when no subagent has a task.
function nowLine(office, room) {
  const tasked = room.sessions.flatMap((id) => office.team.get(id) || []).filter((a) => a.task);
  const newest = (list, key) => list.reduce((best, a) => (!best || a[key] > best[key] ? a : best), null);
  const working = newest(tasked.filter((a) => a.status === "working"), "statusSince");
  if (working) return `  ·  now: ${working.task}`;
  const last = newest(tasked, "lastActive");
  return last ? `  ·  last: ${last.task}` : "";
}

function labelOf(office, a) {
  if (a.startedBy === null) return a.session === office.viewer.session ? "you" : "lead";
  return a.agentType || a.role || "other";
}

function person(office, a, session, x, y, off) {
  const you = a.startedBy === null && a.session === office.viewer.session;
  const label = labelOf(office, a);
  const { bubble, others } = writeBubble(office, a);
  return {
    id: a.id,
    x,
    y,
    role: you ? "you" : a.role || "other",
    look: you ? "you" : LOOK[a.status] || "idle",
    label,
    bubble,
    info: office.findings.has(a.id),
    off,
    card: card(office, a, session, label, others),
  };
}

// The write bubble, from the agent's newest edit, and who else edited that file when it is red.
// Amber for `bubbleSeconds` after the write. Red, whatever the agent's status, while anyone else
// in any room edited the file lately (never for the agent's own edits), until the agent reads the
// file at or after the file's newest edit; writing another file moves the bubble to that one.
function writeBubble(office, a) {
  const e = office.lastEdit.get(a.id);
  if (!e) return { bubble: null, others: [] };
  const key = e.file.toLowerCase();
  const others = (office.conflicts.get(key) || []).filter((id) => id !== a.id);
  const checked = office.reads.get(a.id + "\n" + key) >= office.edited.get(key);
  if (others.length && !checked) return { bubble: { file: e.file, clash: true }, others };
  if (office.now - Date.parse(e.at) <= office.bubbleMs) return { bubble: { file: e.file, clash: false }, others: [] };
  return { bubble: null, others: [] };
}

// The hover card (the terminal's detail lines): role and agent type, status and for how long,
// what it is doing and who else edited that file lately, its task, its own worktree when
// it has one, and the start of its report when that is a finding.
function card(office, a, session, label, others) {
  const lines = [roleLine(a), `${a.status} for ${duration(office.now - Date.parse(a.statusSince))}`, ...about(office, a, session, others)];
  if (office.findings.has(a.id) && office.reports.has(a.id)) lines.push(...reportLines(office.reports.get(a.id).text));
  return { title: label, lines };
}

const roleLine = (a) => `role ${a.role || "other"}${a.agentType ? ` · type ${a.agentType}` : ""}`;

// The card's lines between its status and its report: what it is doing, who else edited that
// file lately, its task and its own worktree.
function about(office, a, session, others) {
  const lines = [];
  if (a.doing) lines.push(`${DOING[a.doing.kind] || a.doing.kind}${a.doing.file ? " " + a.doing.file : ""}`);
  for (const id of others) {
    const b = office.agents.get(id);
    const where = b && office.rooms.get(b.session);
    lines.push(`possible conflict: also edited in the last ${office.window}m by ${b ? labelOf(office, b) : id}${where ? " in " + roomTitle(office, where) : ""}`);
  }
  if (a.task) lines.push(a.task);
  if (a.checkout && a.checkout !== session.checkout) lines.push(`own worktree: ${[a.branch, a.checkout].filter(Boolean).join(" · ")}`);
  return lines;
}

// How an ended or stuck status reads in the details: whether the agent finished its task.
const SPELLED = {
  done: (d) => `done ${d} ago: it finished its task`,
  stalled: (d) => `stalled for ${d}: gone quiet before finishing its task`,
  stopped: (d) => `stopped ${d} ago: ended early, so it leaves no report`,
  failed: (d) => `failed ${d} ago: it ended with an error`,
};

// The details panel (#58): who, its status, its report's first line, its waits, its tokens and
// context, and when it last acted. `more` is the card's lines the panel doesn't say.
function details(office, a) {
  const since = duration(office.now - Date.parse(a.statusSince));
  const lines = [`${labelOf(office, a)} · ${roleLine(a)}`, SPELLED[a.status] ? SPELLED[a.status](since) : `${a.status} for ${since}`];
  const report = office.reports.get(a.id);
  const first = report && String(report.text).split(/\r?\n/).find((l) => l.trim());
  if (first) lines.push(`report: ${first.trim()}`);
  const names = (ids) => ids.map((id) => (office.agents.has(id) ? labelOf(office, office.agents.get(id)) : id)).join(", ");
  const on = office.waits.filter((w) => w.waiter === a.id).map((w) => w.on);
  const by = office.waits.filter((w) => w.on === a.id).map((w) => w.waiter);
  if (on.length) lines.push(`waiting on: ${names(on)}`);
  if (by.length) lines.push(`waited on by: ${names(by)}`);
  if (a.usage) {
    // The viewer's own lead reads its context live from the session when the host has it.
    const mine = a.startedBy === null && a.session === office.viewer.session && office.own && positive(office.own.tokens);
    const used = mine ? office.own.tokens : a.usage.context;
    lines.push(`tokens: ${tokens(used)} context now · ${tokens(a.usage.output)} output so far`);
    const w = contextWindow(a.usage.model, office.contextWindows, office.own);
    if (!w) lines.push(`context: ${tokens(used)} · window unknown for ${a.usage.model}`);
    else lines.push(`context: ${tokens(used)} of ${tokens(w.window)} (${percent(used, w.window)}%)${w.compactAt ? ` · compacts at ${percent(w.compactAt, w.window)}%` : ""}`);
  }
  lines.push(`last acted ${duration(office.now - Date.parse(a.lastActive))} ago`);
  return { id: a.id, lines, more: about(office, a, office.sessions.get(a.session), writeBubble(office, a).others) };
}

/**
 * A model's context window, { window, compactAt } in tokens (compactAt null when unknown), or null
 * when nothing says. First match wins: config's entry for the model, the viewer's own session's
 * reading when it runs that model, then config's "*".
 */
export function contextWindow(model, contextWindows, own) {
  const table = contextWindows && typeof contextWindows === "object" ? contextWindows : {};
  const entry = (key) => (Object.hasOwn(table, key) ? fit(table[key]) : null);
  return (model && entry(model)) || (model && own && own.model === model && fit(own)) || entry("*");
}

const positive = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;
const fit = (w) => (w && typeof w === "object" && positive(w.window) ? { window: w.window, compactAt: positive(w.compactAt) ? w.compactAt : null } : null);
const percent = (part, whole) => Math.round((part / whole) * 100);

// Token counts as the status line writes them: 812, 8.4k, 294k, 1M, 1.2M.
function tokens(n) {
  const one = (x) => String(Math.round(x * 10) / 10);
  if (n < 1000) return String(n);
  if (n < 9950) return one(n / 1000) + "k";
  if (n < 999500) return Math.round(n / 1000) + "k";
  return one(n / 1e6) + "M";
}

// A report's first lines, wrapped to the card's text width at spaces, its blank lines left out,
// ending in "…" when there is more.
function reportLines(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    let rest = line.trimEnd();
    while (rest.trim() && out.length <= REPORT_LINES) {
      let cut = rest.length <= CARD_TEXT ? rest.length : rest.lastIndexOf(" ", CARD_TEXT);
      if (cut < 1 || !rest.slice(0, cut).trim()) cut = CARD_TEXT;
      out.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
  }
  if (out.length <= REPORT_LINES) return out;
  const last = out[REPORT_LINES - 1];
  return [...out.slice(0, REPORT_LINES - 1), (last.length < CARD_TEXT ? last : last.slice(0, CARD_TEXT - 1)) + "…"];
}

const DOING = { write: "writing", read: "reading", run: "running a command", search: "searching", talk: "talking" };

// A checkout's last folder: enough to tell worktrees apart in small print.
function folderName(checkout) {
  return checkout ? checkout.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : null;
}

// Whole minutes, then hours, then days: the scene changes at most once a minute while idle.
export function duration(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

/**
 * The one line the pane shows when things are degraded, or null when all is well. engine is the
 * host's word for its engine process: "running", "starting", "restarting" or "fallback".
 */
export function statusLine(model, engine) {
  const out = [];
  if (model && model.schemaVersion > SCHEMA_VERSION) {
    return `The office engine sends model version ${model.schemaVersion}; this pane knows version ${SCHEMA_VERSION}. Update the agent-office mod.`;
  }
  if (engine === "starting" && !model) out.push("Starting the office engine…");
  if (engine === "restarting") out.push("The office engine stopped; restarting it.");
  if (engine === "fallback") out.push("The office engine isn't running; reading the office every few seconds instead.");
  for (const s of (model && model.sources) || []) if (s.status) out.push(`${s.id}: ${s.status}`);
  return out.length ? out.join(" · ") : null;
}

/** True when this pane can draw the model: a version it knows. */
export const drawable = (model) => !!model && model.schemaVersion <= SCHEMA_VERSION;
