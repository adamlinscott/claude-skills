// Agent Office's pane: the hooks module Claude Code loads for this mod. It is the host
// (docs/designs/agent-office-model.md, layers): it runs the office engine while the pane is open,
// keeps the latest office model, and draws it through the shared layout and the two renderers.
//
//   /agent-office opens the pane, and closes it when it is open. autoOpen in config.json (or the
//   person's ~/.claude/agent-office/config.json) opens it at session start.
//
// The engine is `node cli.mjs --stream`, one model per line. A stream that ends is started again;
// one that keeps failing gives way to `--json` on a timer. Closing the pane lets the stream go,
// which ends the process (at its next line); Claude Code also ends it with the session.
//
// Relative imports resolve from this hooks/ folder, so the shared modules are one level up.

import { loadConfig } from "../engine.mjs";
import { layout, statusLine, viewerFor, drawable } from "../layout.mjs";
import { drawDesktop } from "../draw-desktop.mjs";
import { drawTerminal, renderCells, seatOf } from "../draw-terminal.mjs";

const PANE = "agent-office";
const RESTARTS = 3; // streams in a row that end without a model before falling back to --json
const FALLBACK_MS = 5000;
const ANIMATE_MS = 450; // the terminal's waiting arrows step at this pace
const REFRESH_MS = 30000; // idle times and cards are in whole minutes; re-lay the scene this often
const UNDER_PLAN_ROWS = 6; // the terminal rows kept for the status line and the selected person

let model = null;
let engine = "stopped"; // starting | running | restarting | fallback | stopped
let run = 0; // the current engine run; an older run's loop sees the change and stops
let letGo = null; // lets the current stream go, which ends its process
let timers = [];
let viewer = null; // the model's id for this session
let order = []; // room ids in the order this pane first saw them
let selected = null; // the person the terminal's focus ring is on
let tick = 0;
const shown = {}; // surface → what it last drew: { columns, rows, key, scene }

export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "agent-office", description: "Open or close the Agent Office floor plan of this project" });
    if ((await readConfig($)).autoOpen === true) {
      start($)
        .then(() => $.ui.open({ id: PANE, title: "Agent Office" }))
        .catch((err) => $.ui.log("agent-office: could not open the pane: " + message(err), { to: "debug" }));
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

  // Every close comes through here, the person's and this module's own.
  on("ui.close", ($, e, next) => {
    if (e.id === PANE) stop();
    return next(e);
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
    const view = frame(columns, rows);
    shown[e.surface] = { columns, rows, key: JSON.stringify(view), scene: view.scene };

    const out = [];
    if (view.status) out.push(el.Text({ dimColor: true, wrap: "truncate-end", children: [view.status] }));
    if (view.scene && terminal) out.push(drawTerminal(view.scene, el, { tick, selected, onSelect: (id) => select($, id) }));
    else if (view.scene) out.push(drawDesktop(view.scene, el));
    else if (!view.status) out.push(el.Text({ dimColor: true, children: ["Waiting for the office…"] }));
    return el.Box({ flexDirection: "column", children: out });
  });
}

// What a surface of this size draws now: the status line and the scene (none for a model this
// pane can't read). Keeps the room order the scene settled on.
function frame(columns, rows) {
  const status = statusLine(model, engine);
  if (!drawable(model)) return { status, scene: null };
  const scene = layout(model, viewerFor(model, viewer), { columns, rows, order, now: Date.now() });
  order = scene.order;
  return { status, scene };
}

// Redraw only when something a surface draws has changed.
function changed($) {
  const surfaces = Object.values(shown);
  if (!surfaces.length || surfaces.some((s) => JSON.stringify(frame(s.columns, s.rows)) !== s.key)) $.ui.invalidate("ui.render");
}

function select($, id) {
  selected = id;
  $.ui.invalidate("ui.render");
}

async function start($) {
  if (engine !== "stopped") return;
  const me = ++run;
  engine = "starting";
  viewer = "claude-code:" + (await $.session.id());
  const cwd = await $.session.cwd();
  const cli = $.plugin.root.replace(/\\/g, "/") + "/cli.mjs";

  timers = [
    $.clock.every(REFRESH_MS, () => changed($)),
    // The terminal's arrows move by repainting the plan's cells: no pane redraw.
    $.clock.every(ANIMATE_MS, () => {
      const t = shown.terminal;
      if (!t || !t.scene || !t.scene.lines.length) return;
      tick += 1;
      const { columns, rows, cells } = renderCells(t.scene, tick);
      $.ui.blit({ requestId: PANE, key: "plan", columns, rows, cells }).catch(() => {});
    }),
  ];
  stream($, me, cli, cwd).catch((err) => $.ui.log("agent-office: the engine loop failed: " + message(err), { to: "debug" }));
}

function stop() {
  run += 1;
  engine = "stopped";
  if (letGo) letGo();
  letGo = null;
  for (const t of timers) t.cancel();
  timers = [];
  model = null;
  order = [];
  selected = null;
  for (const k of Object.keys(shown)) delete shown[k];
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
  return true;
}

async function stream($, me, cli, cwd) {
  let failures = 0;
  while (me === run && failures < RESTARTS) {
    let got = false;
    const it = $.process.spawn({ argv: ["node", cli, "--stream", "--project", cwd], cwd })[Symbol.asyncIterator]();
    letGo = () => it.return && it.return().catch(() => {});
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
