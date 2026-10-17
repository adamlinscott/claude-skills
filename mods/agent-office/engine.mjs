// Agent Office's office engine (docs/adr/0001-agent-office-streaming-engine.md): asks each source
// for its facts about one git project, works out their meaning and puts together the office
// model. Run once it gives one model; run as a stream it writes a model per line whenever the
// office changes, keeping every source's read cache between passes.
//
// No Node imports. Everything outside the process comes in through `io`: what the sources need
// (see sources/claude-code.mjs), plus
//   now()      → milliseconds since the epoch
//   write(s)   → output text (the stream only)
//   wait(ms)   → true once `ms` have passed, false as soon as the stream should end (the stream only)
// Any of them may be sync or async.
//
// Tunables live in config.json and the role catalogue in roles.json. A person overrides either
// per key in <claudeDir>/agent-office/.

import { createGit, join, normalize } from "./git.mjs";
import { workOutMeaning } from "./meaning.mjs";
import { assembleModel, sameModel } from "./model.mjs";
import { createClaudeCode } from "./sources/claude-code.mjs";

/**
 * The repo defaults in `defaultsDir`, overridden per key by <claudeDir>/agent-office/. A user value
 * that is missing, null or the wrong shape leaves that key (or that role) at the repo default.
 */
export async function loadConfig(io, defaultsDir) {
  const userDir = join(io.claudeDir, "agent-office");
  const defaults = await readJson(io, join(defaultsDir, "config.json"));
  const user = await readJson(io, join(userDir, "config.json"), true);
  const config = {};
  for (const [key, fallback] of Object.entries(defaults)) config[key] = fits(key, user[key], fallback) ? user[key] : fallback;
  // No prototype: an agent type such as "constructor" or "__proto__" is only ever a plain key.
  const roles = Object.assign(Object.create(null), await readJson(io, join(defaultsDir, "roles.json")));
  for (const [type, role] of Object.entries(await readJson(io, join(userDir, "roles.json"), true))) {
    if (typeof role === "string" && role) roles[type] = role;
  }
  return { ...config, roles };
}

// The stream's pace before config.json has ever loaded (it is broken from the first pass).
const FALLBACK_STREAM_SECONDS = 1;

// Keys used as a byte count or a file offset, which must be whole numbers.
const BYTE_KEYS = new Set(["tailBytes"]);

// Keys with a floor above zero. The stream's pace is one: a pass every few milliseconds would
// spin the machine.
const FLOORS = new Map([["streamSeconds", 0.25]]);

// Every number in config.json is a window or a size, so it must be finite and above zero; a
// window in ZERO_OFF may also be 0, which turns its feature off.
const ZERO_OFF = new Set(["lightsOffHours"]);
function fits(key, value, fallback) {
  if (typeof fallback === "number") {
    if (BYTE_KEYS.has(key)) return Number.isSafeInteger(value) && value > 0;
    if (ZERO_OFF.has(key) && value === 0) return true;
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value >= (FLOORS.get(key) ?? 0);
  }
  if (Array.isArray(fallback)) return Array.isArray(value);
  return value != null && typeof value === typeof fallback;
}

async function readJson(io, p, optional = false) {
  if (optional && !(await io.stat(p))) return {};
  try {
    const value = JSON.parse(await io.read(p));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (err) {
    // A broken override must not take the office down; a broken repo default is a bug to see.
    if (optional) return {};
    throw err;
  }
}

/**
 * Returns { model(), stream() } for the project holding `project` (any folder inside any of its
 * worktrees). Keep the object for the life of the pane: the sources' read caches and the git
 * lookups (refreshed after `gitCacheSeconds`) live in it.
 *
 * model() gives the office now, numbered one past the last model the stream wrote. It never
 * throws: a pass that fails gives the last office that built, with the problem in every
 * sources[].status, or an empty office when none has built yet. A source that throws keeps its
 * facts from its last good read the same way.
 * stream() writes a model as one JSON line every `streamSeconds` when it differs from the last
 * one written, and returns when io.wait says to stop.
 */
export function createEngine(io, { defaultsDir, project }) {
  const git = createGit(io);
  const sources = [createClaudeCode(io)];
  let lastSeq = 0;
  let config = null;
  let lastGood = null; // the last model a pass built
  const lastRead = new Map(); // source id → its last good facts

  async function model() {
    const now = await io.now();
    try {
      lastGood = await pass(now);
      return lastGood;
    } catch (err) {
      // A broken repo default or a throw in the rules costs this pass, never the stream: the last
      // office that built stays up, every source reports the problem, and `config` stays the last
      // one that loaded.
      const message = errorText(err);
      if (lastGood) {
        return { ...lastGood, seq: lastSeq + 1, generatedAt: new Date(now).toISOString(), sources: lastGood.sources.map((s) => failed(s, message)) };
      }
      return assembleModel({
        seq: lastSeq + 1,
        now,
        project: { id: null, name: null },
        sources: sources.map((s) => failed({ id: s.id, errors: { count: 0, first: null } }, message)),
        facts: { humans: [], sessions: [], agents: [], edits: [], reads: [], waits: [], reports: [] },
        meaning: { roles: [], conflicts: [], findings: [] },
      });
    }
  }

  async function pass(now) {
    config = await loadConfig(io, defaultsDir);
    // Every lookup in one pass passes the same `now`, so no folder is resolved twice in it.
    const gitOpts = { now, maxAgeMs: config.gitCacheSeconds * 1000 };
    const resolve = (dir) => git.resolve(dir, gitOpts);
    const home = await resolve(project);

    const facts = { humans: [], sessions: [], agents: [], edits: [], reads: [], waits: [], reports: [], meaning: { roles: [], conflicts: [], findings: [] } };
    const add = (f) => {
      for (const key of ["humans", "sessions", "agents", "edits", "reads", "waits", "reports"]) facts[key].push(...f[key]);
      for (const key of ["roles", "conflicts", "findings"]) facts.meaning[key].push(...(f.meaning[key] || []));
    };
    const states = [];
    for (const source of sources) {
      if (!home) {
        states.push({ id: source.id, status: `git could not place ${normalize(project)}`, errors: { count: 0, first: null } });
        continue;
      }
      try {
        const f = await source.read({ home, now, config, resolve });
        lastRead.set(source.id, f);
        states.push({ id: source.id, status: oneLine(f.status), errors: { count: f.errors.count, first: oneLine(f.errors.first) } });
        add(f);
      } catch (err) {
        // A source that throws costs this pass, never the stream: its last good facts stay.
        const kept = lastRead.get(source.id);
        states.push(failed({ id: source.id, errors: kept ? kept.errors : { count: 0, first: null } }, errorText(err)));
        if (kept) add(kept);
      }
    }

    return assembleModel({
      seq: lastSeq + 1,
      now,
      project: { id: home ? home.commonDir : null, name: home ? projectName(home.commonDir) : null },
      sources: states,
      facts,
      meaning: workOutMeaning(facts, config, now),
    });
  }

  async function stream() {
    let last = null;
    do {
      const m = await model();
      if (!sameModel(m, last)) {
        await io.write(JSON.stringify(m) + "\n");
        lastSeq = m.seq;
        last = m;
      }
    } while (await io.wait((config ? config.streamSeconds : FALLBACK_STREAM_SECONDS) * 1000));
  }

  return { model, stream };
}

// A source's state after a failure: the problem as its status, counted among its errors.
function failed(state, message) {
  return { id: state.id, status: message, errors: { count: state.errors.count + 1, first: oneLine(state.errors.first) ?? message } };
}

const errorText = (err) => oneLine(String((err && err.message) || err));

// Statuses and error messages are one line each: a multi-line message has its breaks folded.
const oneLine = (text) => (text == null ? text : text.replace(/\s*[\r\n]+\s*/g, " ").trim());

// The folder that holds the common dir (…/repo/.git → repo), or a bare repository's own name.
function projectName(commonDir) {
  const parts = commonDir.split("/").filter(Boolean);
  const last = parts.pop() || null;
  return last === ".git" ? parts.pop() || null : last && last.replace(/\.git$/, "");
}
