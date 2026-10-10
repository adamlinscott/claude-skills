// Agent Office's discover module: turns the transcripts Claude Code already writes into an office
// snapshot for one git project — its live sessions and each session's agents.
//
// The transcript format is internal and undocumented, so every assumption about it lives in this
// one file (see docs/designs/agent-office-transcript-probe.md for where each field was found).
// A format change should be a one-file fix here, and the pane should show a one-line status
// rather than crash.
//
// No Node imports: a mod's hooks module has no Node APIs. Everything outside the process comes
// in through `io` (cli.mjs has the Node versions):
//   listDir(dir)              → [{ name, isDir }]   [] when the folder is missing
//   stat(path)                → { isDir, mtimeMs, size } | null
//   read(path, start?, end?)  → text of bytes [start, end), the whole file when both are omitted
//   run?(argv, { cwd })       → { code, stdout }     optional; git falls back to its pointer files
//   now()                     → milliseconds since the epoch
//   claudeDir                 → Claude Code's config folder (~/.claude, or CLAUDE_CONFIG_DIR)
// Any of them may be sync or async.
//
// Tunables (liveness windows, the quiet and stalled rules, touched-file window and tools, how much
// of a transcript to read on first sight) live in config.json, and agent placement in zones.json.
// A person overrides either per key in <claudeDir>/agent-office/.

import { createGit, join, normalize, pathKey, relativeTo } from "./git.mjs";

// A session whose own transcript has been quiet longer than this is not checked for busy
// subagents. A parent waiting on a long foreground agent writes nothing, so the window has to be
// far wider than the liveness one; a day keeps the listing cheap without missing a real case.
const SUBAGENT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

/**
 * The repo defaults in `defaultsDir`, overridden per key by <claudeDir>/agent-office/. A user value
 * that is missing, null or the wrong shape leaves that key (or that zone) at the repo default.
 */
export async function loadConfig(io, defaultsDir) {
  const userDir = join(io.claudeDir, "agent-office");
  const defaults = await readJson(io, join(defaultsDir, "config.json"));
  const user = await readJson(io, join(userDir, "config.json"), true);
  const config = {};
  for (const [key, fallback] of Object.entries(defaults)) config[key] = fits(key, user[key], fallback) ? user[key] : fallback;
  // No prototype: an agent type such as "constructor" or "__proto__" is only ever a plain key.
  const zones = Object.assign(Object.create(null), await readJson(io, join(defaultsDir, "zones.json")));
  for (const [type, zone] of Object.entries(await readJson(io, join(userDir, "zones.json"), true))) {
    if (typeof zone === "string" && zone) zones[type] = zone;
  }
  return { ...config, zones };
}

// Keys used as a byte count or a file offset, which must be whole numbers.
const BYTE_KEYS = new Set(["tailBytes"]);

// Every number in config.json is a window or a size, so it must be finite and above zero.
function fits(key, value, fallback) {
  if (typeof fallback === "number") {
    if (BYTE_KEYS.has(key)) return Number.isSafeInteger(value) && value > 0;
    return typeof value === "number" && Number.isFinite(value) && value > 0;
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
 * Returns { snapshot({ project, self? }) }. Keep the object for the life of the pane: it caches
 * each transcript's parsed state by size, so a refresh reads only the bytes written since the
 * last one, and caches git lookups per folder for `gitCacheSeconds`.
 */
export function createDiscover(io, { defaultsDir }) {
  const git = createGit(io);
  const transcripts = new Map();
  const metas = new Map();

  async function snapshot({ project, self = null }) {
    const now = await io.now();
    const config = await loadConfig(io, defaultsDir);
    // Every lookup in one snapshot passes the same `now`, so no folder is resolved twice in it.
    const gitOpts = { now, maxAgeMs: config.gitCacheSeconds * 1000 };
    const resolve = (dir) => git.resolve(dir, gitOpts);
    const errors = { count: 0, first: null };
    const fail = (err) => {
      errors.count++;
      if (errors.first === null) errors.first = String((err && err.message) || err);
    };
    const home = await resolve(project);
    if (!home) return emptySnapshot(null, self, now, `git could not place ${normalize(project)}`, errors);

    const candidates = await findSessions(join(io.claudeDir, "projects"), now, config);
    const sessions = [];
    let linesSeen = 0;
    let linesParsed = 0;
    let messagesParsed = 0;
    let cwdsSeen = 0;
    let sessionsFailed = 0;
    for (const c of candidates) {
      try {
        const main = await readTranscript(c.path, c.size, config.tailBytes);
        linesSeen += main.seen;
        linesParsed += main.parsed;
        messagesParsed += main.messages;
        if (!main.cwd) continue;
        cwdsSeen++;
        const where = await resolve(main.cwd);
        if (!where || pathKey(where.commonDir) !== pathKey(home.commonDir)) continue;
        sessions.push(await buildSession(c, main, where, now, config, resolve, fail));
      } catch (err) {
        // An unreadable transcript (deleted mid-scan, locked) costs one room, not the office,
        // but it is counted so a room never vanishes without a trace.
        sessionsFailed++;
        fail(err);
      }
    }

    if (candidates.length && sessionsFailed === candidates.length) {
      return emptySnapshot(home.commonDir, self, now, `could not read any of ${candidates.length} session transcripts: ${errors.first}`, errors);
    }
    // Lines that don't parse, or message lines that parse but never name a folder: the format has
    // moved on. A session that has written only bookkeeping lines (ai-title, mode…) is not drift.
    if (!sessions.length && linesSeen && (!linesParsed || (messagesParsed && !cwdsSeen))) {
      return emptySnapshot(home.commonDir, self, now, "transcript format not recognised", errors);
    }

    // Self: the id the caller knows, else the most recently written transcript started in this
    // folder. More than one such session makes that a guess, which the pane shows without the ★.
    let selfId = self;
    let selfAmbiguous = false;
    if (!selfId) {
      const here = sessions.filter((s) => pathKey(s.cwd) === pathKey(project)).sort((a, b) => b._ownMtime - a._ownMtime);
      selfId = here.length ? here[0].id : null;
      selfAmbiguous = here.length > 1;
    }
    sessions.sort((a, b) => (b.id === selfId) - (a.id === selfId) || b._lastActiveMs - a._lastActiveMs);
    for (const s of sessions) {
      delete s._ownMtime;
      delete s._lastActiveMs;
    }

    return { project: home.commonDir, self: selfId, selfAmbiguous, status: null, errors, generatedAt: new Date(now).toISOString(), sessions };
  }

  // Every session transcript whose newest write (its own, or any subagent's) is inside the idle
  // window. Filtering on mtime first means a quiet transcript is never opened.
  async function findSessions(projectsDir, now, config) {
    const idleMs = config.idleMinutes * 60000;
    const agentWindowMs = Math.max(idleMs, config.touchedWindowMinutes * 60000);
    const out = [];
    for (const slug of await io.listDir(projectsDir)) {
      if (!slug.isDir) continue;
      const slugDir = join(projectsDir, slug.name);
      for (const entry of await io.listDir(slugDir)) {
        if (entry.isDir || !entry.name.endsWith(".jsonl")) continue;
        const path = join(slugDir, entry.name);
        const st = await io.stat(path);
        if (!st || now - st.mtimeMs > SUBAGENT_LOOKBACK_MS) continue;
        const id = entry.name.slice(0, -".jsonl".length);
        const agents = [];
        const subDir = join(slugDir, `${id}/subagents`);
        for (const f of await io.listDir(subDir)) {
          const m = /^agent-(.+)\.jsonl$/.exec(f.name);
          if (f.isDir || !m) continue;
          const ast = await io.stat(join(subDir, f.name));
          if (ast && now - ast.mtimeMs <= agentWindowMs) {
            agents.push({ id: m[1], path: join(subDir, f.name), metaPath: join(subDir, `agent-${m[1]}.meta.json`), ...ast });
          }
        }
        const lastActive = Math.max(st.mtimeMs, ...agents.map((a) => a.mtimeMs));
        if (now - lastActive <= idleMs) out.push({ id, path, size: st.size, ownMtime: st.mtimeMs, lastActive, agents });
      }
    }
    return out;
  }

  async function buildSession(c, main, where, now, config, resolve, fail) {
    const idleMs = config.idleMinutes * 60000;
    const agentFiles = [];
    for (const a of c.agents) {
      try {
        agentFiles.push({ ...a, t: await readTranscript(a.path, a.size, config.tailBytes), meta: await readMeta(a.metaPath) });
      } catch (err) {
        // Same rule as a session: skip what can't be read, and count it.
        fail(err);
      }
    }

    // Done signals can sit in the session's own transcript or, for an agent's own agents, in
    // that agent's transcript, so look in all of them.
    const results = new Map(main.results);
    const notes = new Map(main.notes);
    const spawns = new Set(main.spawns);
    for (const a of agentFiles) {
      for (const [k, v] of a.t.results) results.set(k, v);
      for (const [k, v] of a.t.notes) notes.set(k, v);
      for (const id of a.t.spawns) spawns.add(id);
    }

    const agents = [];
    for (const a of agentFiles) {
      if (now - a.mtimeMs > idleMs) continue;
      const type = typeof a.meta.agentType === "string" && a.meta.agentType ? a.meta.agentType : "?";
      const at = a.t.cwd ? await resolve(a.t.cwd) : null;
      // The worktree trap: a worktree-isolated agent's lines carry the PARENT's gitBranch, so the
      // agent's branch comes from meta.json, or from git at the agent's own folder — never its lines.
      let worktree = typeof a.meta.worktreePath === "string" ? normalize(a.meta.worktreePath) : null;
      if (!worktree && at && pathKey(at.toplevel) !== pathKey(where.toplevel)) worktree = at.toplevel;
      const branch = worktree ? a.meta.worktreeBranch || (at && pathKey(at.toplevel) === pathKey(worktree) ? at.branch : null) : null;
      const status = agentStatus(a, results, notes, spawns, now, c.ownMtime, config);
      agents.push({
        id: a.id,
        type,
        zone: config.zones[type] ?? config.zones["*"] ?? null,
        description: a.meta.description ?? null,
        status,
        lastTool: a.t.lastTool ? a.t.lastTool.name : null,
        lastFile: a.t.lastTool && a.t.lastTool.file ? showPath((at || where).toplevel, a.t.lastTool.file) : null,
        age_s: Math.max(0, Math.round((now - a.mtimeMs) / 1000)),
        worktree,
        branch,
        finalMessage: status === "running" || status === "stalled" ? null : a.t.lastText,
      });
    }
    agents.sort((x, y) => x.age_s - y.age_s);

    const branch = main.branch || where.branch;
    return {
      id: c.id,
      cwd: normalize(main.cwd),
      worktree: where.toplevel,
      branch,
      title: main.title || branch,
      status: now - c.lastActive <= config.activeMinutes * 60000 ? "active" : "idle",
      lastActive: new Date(c.lastActive).toISOString(),
      agents,
      filesTouched: await touchedFiles([main, ...agentFiles.map((a) => a.t)], now, config, resolve),
      _ownMtime: c.ownMtime,
      _lastActiveMs: c.lastActive,
    };
  }

  // Edit/Write/NotebookEdit targets from the session and all its agents inside the window, each
  // made relative to the worktree of the folder that made the call. Outside the worktree: dropped.
  async function touchedFiles(states, now, config, resolve) {
    const since = now - config.touchedWindowMinutes * 60000;
    const tools = new Set(config.touchedTools);
    const files = new Set();
    for (const st of states) {
      st.touches = st.touches.filter((t) => t.at >= since);
      for (const t of st.touches) {
        if (!tools.has(t.name) || !t.cwd) continue;
        const where = await resolve(t.cwd);
        const rel = where && relativeTo(where.toplevel, t.path);
        if (rel) files.add(rel);
      }
    }
    return [...files].sort();
  }

  async function readMeta(p) {
    const st = await io.stat(p);
    if (!st) return {};
    const cached = metas.get(p);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.meta;
    let meta = {};
    try {
      meta = JSON.parse(await io.read(p)) || {};
    } catch {
      // An unreadable meta.json leaves the agent typeless; it sits on the open floor as "?".
    }
    metas.set(p, { mtimeMs: st.mtimeMs, meta });
    return meta;
  }

  // Parse a transcript incrementally. On first sight only the last `tailBytes` are read (a busy
  // session's file runs to megabytes); after that, only what was appended since. A file that
  // shrank was rewritten, so it starts again.
  async function readTranscript(path, size, tailBytes) {
    let st = transcripts.get(path);
    if (!st || size < st.offset) {
      st = newTranscriptState();
      st.offset = Math.max(0, size - tailBytes);
      st.skipPartial = st.offset > 0;
      transcripts.set(path, st);
    }
    if (size <= st.offset) return st;
    const text = await io.read(path, st.offset, size);
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return st; // a line still being written; take it next time
    // Advance only past complete lines, so a half-written last line is read whole next time.
    st.offset = size - encoder.encode(text.slice(lastNl + 1)).length;
    const lines = text.slice(0, lastNl).split("\n");
    if (st.skipPartial) {
      lines.shift(); // a tail read starts mid-line
      st.skipPartial = false;
    }
    for (const line of lines) if (line.trim()) foldLine(st, line);
    return st;
  }

  return { snapshot };
}

function emptySnapshot(project, self, now, status, errors) {
  return { project, self, selfAmbiguous: false, status, errors, generatedAt: new Date(now).toISOString(), sessions: [] };
}

function newTranscriptState() {
  return {
    offset: 0,
    skipPartial: false,
    seen: 0,
    parsed: 0,
    messages: 0, // parsed user/assistant/attachment/system lines, the ones that carry a cwd
    cwd: null,
    branch: null,
    title: null,
    lastAt: NaN,
    lastTool: null,
    lastText: null,
    lastRole: null, // "user" | "assistant": the newest message line
    waiting: false, // the newest assistant line asked for a tool
    results: new Map(), // tool_use_id → { launched } | { status }
    spawns: new Set(), // ids of the Agent tool_uses this file made
    notes: new Map(), // agent id → { status, at } from <task-notification>
    touches: [], // { at, cwd, name, path } for tool uses that name a file
  };
}

const MESSAGE_TYPES = new Set(["user", "assistant", "attachment", "system"]);

// Fold one transcript line into the file's running state. Lines that don't parse, or parse to
// something without a `type`, are skipped: the transcript is internal and lines come and go.
function foldLine(st, line) {
  st.seen++;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (!ev || typeof ev !== "object" || typeof ev.type !== "string") return;
  st.parsed++;
  if (MESSAGE_TYPES.has(ev.type)) st.messages++;

  const at = Date.parse(ev.timestamp);
  if (Number.isFinite(at)) st.lastAt = at;
  // Bookkeeping lines (ai-title, queue-operation, mode…) carry no cwd; keep the newest that does.
  if (typeof ev.cwd === "string" && ev.cwd) st.cwd = ev.cwd;
  if (typeof ev.gitBranch === "string" && ev.gitBranch) st.branch = ev.gitBranch;
  if (ev.type === "ai-title" && typeof ev.aiTitle === "string" && ev.aiTitle) st.title = ev.aiTitle;
  if (ev.type === "queue-operation" && typeof ev.content === "string") readNotifications(st, ev.content, at);

  const content = ev.message && ev.message.content;
  if (ev.type === "assistant" && Array.isArray(content)) {
    st.lastRole = "assistant";
    st.waiting = false;
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "text" && typeof c.text === "string" && c.text.trim()) st.lastText = c.text;
      if (c.type !== "tool_use") continue;
      st.waiting = true;
      if (c.name === "Agent" && typeof c.id === "string") st.spawns.add(c.id);
      const input = c.input || {};
      const file = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : typeof input.path === "string" ? input.path : null;
      st.lastTool = { name: c.name, file };
      // Edit paths are absolute; they are resolved against this line's cwd at snapshot time.
      const target = input.file_path || input.notebook_path;
      if (typeof target === "string" && Number.isFinite(at)) st.touches.push({ at, cwd: ev.cwd || st.cwd, name: c.name, path: target });
    }
  } else if (ev.type === "user" && content != null) {
    st.lastRole = "user";
    if (typeof content === "string") readNotifications(st, content, at);
    else if (Array.isArray(content)) {
      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "text" && typeof c.text === "string") readNotifications(st, c.text, at);
        if (c.type === "tool_result" && typeof c.tool_use_id === "string") st.results.set(c.tool_use_id, toolResult(ev.toolUseResult, c.is_error));
      }
    }
  }
}

// A background Agent call answers at once with a launch acknowledgement. That is not "done".
function toolResult(r, isError) {
  if (r && typeof r === "object") {
    if (r.isAsync || r.status === "async_launched") return { launched: true };
    if (typeof r.status === "string") return { status: r.status };
  }
  return { status: isError ? "failed" : "completed" };
}

function readNotifications(st, text, at) {
  if (!text.includes("<task-notification>")) return;
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(m[1]);
    const status = /<status>\s*([^<\s]+)\s*<\/status>/.exec(m[1]);
    if (id && status && status[1] !== "running") st.notes.set(id[1], { status: status[1], at });
  }
}

// running | stalled | done | failed | killed | stopped (or whatever other end state a notification names).
function agentStatus(a, results, notes, spawns, now, parentMtimeMs, config) {
  // Foreground: the parent's tool_result for the Agent call. A launch acknowledgement doesn't count.
  const r = a.meta.toolUseId && results.get(a.meta.toolUseId);
  if (r && !r.launched) return r.status === "completed" ? "done" : "failed";
  // Background: the completion notification, unless the agent was resumed and has written since.
  const n = notes.get(a.id);
  if (n && !(a.t.lastAt > n.at)) return n.status === "completed" ? "done" : n.status;
  // The parent's Agent call is in view with neither signal: running while the agent or its session
  // has written within `stalledMinutes`. Both quiet longer than that is stalled: most often an
  // orphan whose parent session crashed or exited, though a foreground agent stuck in one long
  // tool call while its parent waits looks the same.
  if (a.meta.toolUseId && spawns.has(a.meta.toolUseId)) {
    const stalledMs = config.stalledMinutes * 60000;
    return now - a.mtimeMs > stalledMs && now - parentMtimeMs > stalledMs ? "stalled" : "running";
  }
  // The spawn isn't in view (perhaps before the part of the parent we read): the quiet-file rule.
  if (now - a.mtimeMs >= config.quietSeconds * 1000 && a.t.lastRole === "assistant" && !a.t.waiting) return "done";
  return "running";
}

// A file the agent last touched, relative to its worktree when it is inside one.
function showPath(toplevel, file) {
  return relativeTo(toplevel, file) ?? normalize(file);
}
