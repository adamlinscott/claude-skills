// Agent Office's layout: turns the office model and the viewer into a scene, the rooms, tables,
// people and waiting lines placed on a grid of terminal cells. Both renderers draw the one scene:
// the terminal as cells, the Desktop pane as an SVG with each cell scaled to pixels.
//
// Grid layout A, as agreed on #46: the viewer's room first, then every other room in a fixed
// place, idle rooms with nothing to show folded into a one-line strip. Placing rooms (layout) is a
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
 *     rooms:  [{ id, x, y, w, h, title, sub, you, idle, folded }],
 *     tables: [{ x, y, w }],                       two rows tall
 *     people: [{ id, x, y, role, look, label, card: { title, lines } }],
 *     lines:  [{ from: waiter id, to: agent id }]  only between people drawn }
 *
 * columns: the width to fill. rows: the height to fit (the terminal's pane); rooms past it fold,
 *          then drop, counted in `hidden`. order: the room ids in the order the host first saw
 *          them; the scene's `order` adds new rooms at the end, for the host to pass next time.
 * now:     ms since the epoch, for the idle times and the cards; the model's own time by default.
 */
export function layout(model, viewer, { columns = 124, rows = Infinity, order = [], now = Date.parse(model.generatedAt) } = {}) {
  const office = index(model, viewer, now);
  const seen = [...order, ...model.rooms.map((r) => r.id).filter((id) => !order.includes(id))];
  const rank = new Map(seen.map((id, i) => [id, i]));
  const rooms = [...model.rooms].sort((a, b) => rank.get(a.id) - rank.get(b.id));
  const width = Math.max(columns, ROOM_MIN_W);

  const yours = rooms.find((r) => r.sessions.includes(viewer.session));
  const open = rooms.filter((r) => r !== yours && !restful(office, r));
  const folded = rooms.filter((r) => r !== yours && restful(office, r));
  // Squeezed into `rows`: open rooms fold from the last, then rooms drop from the end.
  let plan = [...(yours ? [{ room: yours, fold: false }] : []), ...open.map((room) => ({ room, fold: false })), ...folded.map((room) => ({ room, fold: true }))];
  let hidden = 0;
  const tall = () => place(office, plan, width).h + (hidden ? 1 : 0) > rows;
  while (tall()) {
    const last = plan.findLast((p) => !p.fold && p.room !== yours);
    if (!last) break;
    // It joins the folded strips, ahead of the rooms that were folded already.
    last.fold = true;
    plan = [...plan.filter((p) => !p.fold), last, ...plan.filter((p) => p.fold && p !== last)];
  }
  while (tall() && plan.length > 1) {
    plan = plan.slice(0, -1);
    hidden += 1;
  }

  const scene = { w: width, h: 0, order: seen, hidden, rooms: [], tables: [], people: [], lines: [] };
  const placed = place(office, plan, width);
  for (const { p, x, y } of placed.at) drawRoom(scene, office, p.room, p.fold, x, y, width);
  scene.h = placed.h + (hidden ? 1 : 0);
  const drawn = new Set(scene.people.map((q) => q.id));
  scene.lines = model.waits.filter((w) => drawn.has(w.waiter) && drawn.has(w.on)).map((w) => ({ from: w.waiter, to: w.on }));
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
function index(model, viewer, now) {
  const sessions = new Map(model.sessions.map((s) => [s.id, s]));
  const agents = new Map(model.agents.map((a) => [a.id, a]));
  const team = new Map(); // session id → its subagents, in the model's order
  for (const a of model.agents) {
    if (a.startedBy === null) continue;
    if (!team.has(a.session)) team.set(a.session, []);
    team.get(a.session).push(a);
  }
  return { sessions, agents, team, viewer, now };
}

// A room folds when its sessions are idle and none of its agents is working or stalled.
function restful(office, room) {
  return room.sessions.every((id) => {
    const s = office.sessions.get(id);
    if (s.status !== "idle") return false;
    const people = [office.agents.get(s.lead), ...(office.team.get(id) || [])].filter(Boolean);
    return !people.some((a) => a.status === "working" || a.status === "stalled");
  });
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
  const since = Math.max(...sessions.map((s) => Date.parse(s.lastActive)));
  const title = room.title || sessions.map((s) => s.title).filter(Boolean).join(" + ") || "Untitled session";
  let sub;
  if (fold) sub = idle ? `idle ${duration(office.now - since)} · lights off` : "folded to fit";
  else sub = sessions.map((s) => [s.branch, folderName(s.checkout)].filter(Boolean).join(" · ")).join("  |  ") + (idle ? `  ·  idle ${duration(office.now - since)}` : "");
  scene.rooms.push({ id: room.id, x, y, w, h, title, sub, you, idle, folded: fold });
  if (fold) return;

  let cy = y + HEAD_H;
  for (const s of sessions) {
    const subs = office.team.get(s.id) || [];
    const per = seatsPerRow(subs.length, width);
    const tx = x + 2 + LEAD_W;
    const lead = office.agents.get(s.lead);
    if (lead) scene.people.push(person(office, lead, s, x + 4, cy + 4));
    scene.tables.push({ x: tx, y: cy + 4, w: per * SEAT - 1 });
    subs.forEach((a, i) => {
      const row = Math.floor(i / per);
      const col = i % per;
      // Row 0 sits above the table, the rest below it.
      const fy = row === 0 ? cy + 1 : cy + 7 + 3 * (row - 1);
      scene.people.push(person(office, a, s, tx + col * SEAT + 4, fy));
    });
    cy += blockH(Math.ceil(subs.length / per));
  }
}

function person(office, a, session, x, y) {
  const you = a.startedBy === null && a.session === office.viewer.session;
  const role = you ? "you" : a.role || "other";
  const label = you ? "you" : a.startedBy === null ? "lead" : a.agentType || role;
  return { id: a.id, x, y, role, look: you ? "you" : LOOK[a.status] || "idle", label, card: card(office, a, session, label) };
}

// The hover card (the terminal's detail lines): role and agent type, status and for how long,
// what it is doing, its description, and its own worktree when it has one.
function card(office, a, session, label) {
  const lines = [];
  lines.push(`role ${a.role || "other"}${a.agentType ? ` · type ${a.agentType}` : ""}`);
  lines.push(`${a.status} for ${duration(office.now - Date.parse(a.statusSince))}`);
  if (a.doing) lines.push(`${DOING[a.doing.kind] || a.doing.kind}${a.doing.file ? " " + a.doing.file : ""}`);
  const description = a.extra && typeof a.extra.description === "string" ? a.extra.description : null;
  if (description) lines.push(description);
  if (a.checkout && a.checkout !== session.checkout) lines.push(`own worktree: ${[a.branch, a.checkout].filter(Boolean).join(" · ")}`);
  return { title: label, lines };
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
