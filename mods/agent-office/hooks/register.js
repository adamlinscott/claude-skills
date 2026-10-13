// Agent Office's pane: the hooks module Claude Code loads for this mod. It is the host
// (docs/designs/agent-office-model.md, layers): it runs the office engine for the life of the
// session, keeps the latest office model, and draws it through the shared layout and the two
// renderers. The model also flags a possible conflict to an agent as it edits (flags.mjs), so the
// engine runs whether or not anyone opens the pane.
//
//   /agent-office opens the pane, and closes it when it is open. autoOpen in config.json (or the
//   person's ~/.claude/agent-office/config.json) opens it at session start.
//
// The engine is `node cli.mjs --stream`, one model per line. A stream that ends is started again;
// one that keeps failing gives way to `--json` on a timer. Closing the pane leaves it running;
// Claude Code ends it with the session.
//
// Relative imports resolve from this hooks/ folder, so the shared modules are one level up.

import { loadConfig } from "../engine.mjs";
import { layout, statusLine, viewerFor, drawable } from "../layout.mjs";
import { drawDesktop, renderSvg } from "../draw-desktop.mjs";
import { drawTerminal, renderCells, seatOf } from "../draw-terminal.mjs";
import { nextTitle, writtenTitles, cleanTitle, TITLE_SYSTEM } from "../titles.mjs";
import { conflictNote, writtenPaths } from "../flags.mjs";

const PANE = "agent-office";
const RESTARTS = 3; // streams in a row that end without a model before falling back to --json
const FALLBACK_MS = 5000;
const ANIMATE_MS = 450; // the terminal's waiting arrows step at this pace
// Re-lay the scene this often: an amber write bubble goes bubbleSeconds after the write with no new
// model to say so. The scene is compared, so a pane redraws only when something it draws changed.
const REFRESH_MS = 2000;
const UNDER_PLAN_ROWS = 6; // the terminal rows kept for the status line and the selected person
const MEASURE_MS = 5000; // read this session's own context window at most this often

let model = null;
let engine = "stopped"; // starting | running | restarting | fallback | stopped
let run = 0; // the current engine run; an older run's loop sees the change and stops
let config = { touchedTools: ["Edit", "Write", "NotebookEdit"], shellTools: ["Bash", "PowerShell"], touchedWindowMinutes: 30, bubbleSeconds: 10, contextWindows: {} }; // until session start reads it
let viewer = null; // the model's id for this session
let order = []; // room ids in the order this pane first saw them
let selected = null; // the person the terminal's focus ring is on
let picked = null; // the person whose details the Claude app's panel shows: a press picks, a second lets go
// This session's own context window, for its lead's model: { model, window, compactAt, tokens,
// counted: whether the breakdown came back }. Read in the background, never on a render.
let own = null;
let measuring = false;
let measuredAt = 0;
let tick = 0;
const shown = {}; // surface → what it last drew: { columns, rows, key, scene }
// Titles written for rooms named only by their branch: session id → { key, title, at }. Kept for
// the life of the module, so reopening the pane doesn't ask again.
const titles = new Map();
let asking = false; // one title call in flight at a time

export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "agent-office", description: "Open or close the Agent Office floor plan of this project" });
    config = { ...config, ...(await readConfig($)) };
    start($).catch((err) => $.ui.log("agent-office: could not start the engine: " + message(err), { to: "debug" }));
    if (config.autoOpen === true) {
      $.ui.open({ id: PANE, title: "Agent Office" }).catch((err) => $.ui.log("agent-office: could not open the pane: " + message(err), { to: "debug" }));
    }
    return next(e);
  });

  on("command.run", { command: "agent-office" }, async ($) => {
    if ((await $.ui.panes()).some((p) => p.id === PANE)) {
      await $.ui.close({ id: PANE });
      return {};
    }
    await start($);
    await $.ui.open({ id: PANE, title: "Agent Office", focus: true });
    return {};
  });

  // Every close comes through here, the person's and this module's own. The engine keeps running
  // for the flags; only what the pane drew is let go, so nothing redraws a closed pane.
  on("ui.close", ($, e, next) => {
    if (e.id === PANE) {
      for (const k of Object.keys(shown)) delete shown[k];
      selected = null;
      picked = null;
    }
    return next(e);
  });

  // After an edit by any agent in this session, or a shell command that writes a file, a note per
  // file someone else in the office edited lately. The tool's result is kept as it is (with its
  // ref); a failed or refused call gets none. Filtered here rather than by matcher so the person's
  // touchedTools and shellTools apply. The event carries no working folder, so a shell command's
  // relative paths read against the caller's own worktree when the model holds one, else the
  // session's folder.
  on("tool.call", async ($, e, next) => {
    const r = await next(e);
    if (r.deny || r.isError || !drawable(model) || !viewer) return r;
    if (!config.touchedTools.includes(e.tool) && !config.shellTools.includes(e.tool)) return r;
    const agent = e.agentId ? "claude-code:" + e.agentId : viewer + ":lead";
    const caller = model.agents.find((a) => a.id === agent);
    const cwd = config.shellTools.includes(e.tool) ? (caller && caller.checkout) || (await $.session.cwd()) : null;
    const opts = { now: Date.now(), window: config.touchedWindowMinutes, titles: writtenTitles(titles) };
    const notes = writtenPaths(e, cwd, config).map((path) => conflictNote(model, { agent, session: viewer, path }, opts)).filter(Boolean);
    return notes.length ? { ...r, context: [...(r.context || []), ...notes] } : r;
  });

  // The terminal's selection is wherever the pane's focus ring is: Tab and the arrows walk it
  // between the people's labels once the pane has the keys.
  on("ui.focus", ($, e, next) => {
    if (e.requestId === PANE) {
      const id = seatOf(e.element);
      if (id && id !== selected) {
        selected = id;
        $.ui.invalidate("ui.render");
      }
    }
    return next(e);
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    // A pane still open after the module reloaded has no engine yet.
    if (engine === "stopped") start($).catch(() => {});
    const el = $.ui.resolve(e);
    const terminal = e.surface === "terminal";
    const columns = e.props.bodyColumns || (e.viewport && e.viewport.columns) || 100;
    const rows = terminal && e.props.scroll ? Math.max(4, e.props.scroll.bodyRows - UNDER_PLAN_ROWS) : Infinity;
    const view = frame(columns, rows, e.surface);
    shown[e.surface] = { columns, rows, key: JSON.stringify(view), scene: view.scene };

    const out = [];
    if (view.status) out.push(el.Text({ dimColor: true, wrap: "truncate-end", children: [view.status] }));
    if (view.scene && terminal) out.push(drawTerminal(view.scene, el, { tick, onSelect: (id) => select($, id), detailRows: UNDER_PLAN_ROWS - (view.status ? 1 : 0) }));
    else if (view.scene) out.push(drawDesktop(view.scene, el, { source: planSource(view.scene), onSelect: (id) => pick($, id) }));
    else if (!view.status) out.push(el.Text({ dimColor: true, children: ["Waiting for the office…"] }));
    return el.Box({ flexDirection: "column", children: out });
  });
}

// The plan's SVG, the same string as last time unless the drawing itself changed. A new string
// reloads the image (a blink, and the dots restarting), so a change that only touches the cards,
// the details or the status line keeps the picture as it is. A new drawing starts its dots at the
// wall clock's place in their cycle, so they carry on rather than jump back.
let plan = { base: null, source: null };
function planSource(scene) {
  const base = renderSvg(scene);
  if (base !== plan.base) plan = { base, source: renderSvg(scene, { now: Date.now() }) };
  return plan.source;
}

// What a surface of this size draws now: the status line and the scene (none for a model this
// pane can't read), with that surface's selection's details. Keeps the room order the scene settled on.
function frame(columns, rows, surface) {
  const status = statusLine(model, engine);
  if (!drawable(model)) return { status, scene: null };
  const scene = layout(model, viewerFor(model, viewer), {
    columns,
    rows,
    order,
    now: Date.now(),
    touchedWindowMinutes: config.touchedWindowMinutes,
    bubbleSeconds: config.bubbleSeconds,
    titles: writtenTitles(titles),
    selected: surface === "terminal" ? selected : picked,
    contextWindows: config.contextWindows,
    own,
  });
  order = scene.order;
  return { status, scene };
}

// Redraw only when something a surface draws has changed. No surface drawn is a closed pane (or
// one about to draw for the first time, which needs no nudge).
function changed($) {
  const surfaces = Object.entries(shown);
  if (surfaces.some(([surface, s]) => JSON.stringify(frame(s.columns, s.rows, surface)) !== s.key)) $.ui.invalidate("ui.render");
}

function select($, id) {
  selected = id;
  $.ui.invalidate("ui.render");
}

function pick($, id) {
  picked = picked === id ? null : id;
  $.ui.invalidate("ui.render");
}

// Reads this session's own context window in the background while the pane is drawn, for the
// model its lead's newest reply used: the plain call (free) at most every MEASURE_MS, and the
// breakdown, estimated locally, until one has come back for that model. Whatever comes back is
// read defensively: only positive numbers count.
function measure($) {
  if (measuring || !drawable(model) || !Object.keys(shown).length) return;
  const lead = model.agents.find((a) => a.id === viewer + ":lead");
  const id = lead && lead.usage && lead.usage.model;
  const now = Date.now();
  // A new model is read at once; the same one at most every MEASURE_MS.
  if (!id || (own && own.model === id && now - measuredAt < MEASURE_MS)) return;
  const before = own && own.model === id ? own : null;
  measuring = true;
  measuredAt = now;
  $.session
    .usage(before && before.counted ? undefined : { breakdown: "summary" })
    .then((u) => {
      const context = (u && u.context) || {};
      const b = context.breakdown && typeof context.breakdown === "object" ? context.breakdown : null;
      own = {
        model: id,
        window: (b && positive(b.rawMaxTokens)) || (before && before.window) || positive(context.window),
        compactAt: b ? positive(b.autoCompactThreshold) : before && before.compactAt,
        tokens: positive(context.tokens),
        counted: !!b || !!(before && before.counted),
      };
      changed($);
    })
    .catch((err) => $.ui.log("agent-office: could not read the context window: " + message(err), { to: "debug" }))
    .finally(() => {
      measuring = false;
    });
}

const positive = (n) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null);

async function start($) {
  if (engine !== "stopped") return;
  const me = ++run;
  engine = "starting";
  viewer = "claude-code:" + (await $.session.id());
  const cwd = await $.session.cwd();
  const cli = $.plugin.root.replace(/\\/g, "/") + "/cli.mjs";

  // The engine runs for the session, so these do too; with the pane closed they find nothing drawn.
  $.clock.every(REFRESH_MS, () => {
    changed($);
    askTitle($);
    measure($);
  });
  // The terminal's arrows move by repainting the plan's cells: no pane redraw.
  $.clock.every(ANIMATE_MS, () => {
    const t = shown.terminal;
    if (!t || !t.scene || !t.scene.lines.length) return;
    tick += 1;
    const { columns, rows, cells } = renderCells(t.scene, tick);
    $.ui.blit({ requestId: PANE, key: "plan", columns, rows, cells }).catch(() => {});
  });
  stream($, me, cli, cwd).catch((err) => $.ui.log("agent-office: the engine loop failed: " + message(err), { to: "debug" }));
}

function accept($, me, text) {
  if (me !== run) return false;
  let next;
  try {
    next = JSON.parse(text);
  } catch {
    return false;
  }
  model = next;
  if (engine !== "fallback") engine = "running";
  changed($);
  askTitle($);
  return true;
}

// Asks the small model for the next room title that is due, in the background: drawing never
// waits on it. The branch shows until a title comes back; a failed call or an empty reply leaves
// it, and is tried again once the rate limit allows. Only while the pane is drawn: the engine runs
// all session, and nobody needs a title written for a pane that isn't open.
function askTitle($) {
  if (asking || !drawable(model) || !Object.keys(shown).length) return;
  const now = Date.now();
  const ask = nextTitle(model, titles, now);
  if (!ask) return;
  const before = titles.get(ask.session);
  titles.set(ask.session, { key: before ? before.key : null, title: before ? before.title : null, at: now });
  asking = true;
  $.model
    .complete({ model: "haiku", system: TITLE_SYSTEM, prompt: ask.prompt, maxTokens: 40 })
    .then((reply) => {
      const title = cleanTitle(reply);
      if (!title) {
        if (reply && typeof reply === "object") $.ui.log("agent-office: a title reply had no text; its keys: " + Object.keys(reply).join(", "), { to: "debug" });
        return;
      }
      titles.set(ask.session, { key: ask.key, title, at: now });
      changed($);
    })
    .catch((err) => $.ui.log("agent-office: could not write a room title: " + message(err), { to: "debug" }))
    .finally(() => {
      asking = false;
      askTitle($); // the next room due, so a morning start doesn't wait on the refresh timer
    });
}

async function stream($, me, cli, cwd) {
  let failures = 0;
  while (me === run && failures < RESTARTS) {
    let got = false;
    const it = $.process.spawn({ argv: ["node", cli, "--stream", "--project", cwd], cwd })[Symbol.asyncIterator]();
    try {
      let buffer = "";
      for (;;) {
        const { value, done } = await it.next();
        if (done || me !== run) break;
        if (value.stream !== "stdout") continue;
        buffer += value.text;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line && accept($, me, line)) got = true;
        }
      }
    } catch (err) {
      $.ui.log("agent-office: the engine stream failed: " + message(err), { to: "debug" });
    }
    if (me !== run) return;
    // A stream that gave models and then ended starts the count again.
    failures = got ? 1 : failures + 1;
    engine = "restarting";
    changed($);
    await $.clock.sleep(1000 * failures);
  }
  if (me !== run) return;
  engine = "fallback";
  changed($);
  while (me === run) {
    try {
      const r = await $.process.run(["node", cli, "--json", "--project", cwd], { cwd, timeoutMs: 60000 });
      if (r.exitCode === 0) accept($, me, r.stdout);
      else $.ui.log("agent-office: the engine exited " + r.exitCode + ": " + String(r.stderr).trim().slice(0, 300), { to: "debug" });
    } catch (err) {
      $.ui.log("agent-office: could not run the engine: " + message(err), { to: "debug" });
    }
    await $.clock.sleep(FALLBACK_MS);
  }
}

// The mod's config.json, overridden per key by <claude dir>/agent-office/config.json.
async function readConfig($) {
  const home = String((await $.env.get("CLAUDE_CONFIG_DIR")) || ((await $.env.get("USERPROFILE")) || (await $.env.get("HOME")) || "") + "/.claude");
  const io = {
    claudeDir: home.replace(/\\/g, "/"),
    stat: async (p) => ((await $.fs.exists(p)) ? {} : null),
    read: (p) => $.fs.read(p),
  };
  try {
    return await loadConfig(io, $.plugin.root.replace(/\\/g, "/"));
  } catch {
    return {};
  }
}

const message = (err) => String((err && err.message) || err);
