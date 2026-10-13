// Agent Office's claude-code source: turns the transcripts Claude Code already writes into the
// facts of the office model for one git project — its live sessions, each session's lead and
// subagents, who started whom, their edits, reads, waits and reports, and what each one is doing now.
// Roles, conflicts and findings are not decided here: meaning.mjs works them out from these facts.
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
//   run?(argv, { cwd })       → { code, stdout }     optional; without it the owner is unknown
//   claudeDir                 → Claude Code's config folder (~/.claude, or CLAUDE_CONFIG_DIR)
// Any of them may be sync or async.
//
// Ids are source-scoped: a session is claude-code:<session id>, its lead claude-code:<session
// id>:lead, and a subagent claude-code:<agent id>.

import { join, normalize, pathKey, relativeTo } from "../git.mjs";
import { shellFiles } from "../shell-writes.mjs";

const SOURCE = "claude-code";

// A session whose own transcript has been quiet longer than this is not checked for busy
// subagents. A parent waiting on a long foreground agent writes nothing, so the window has to be
// far wider than the liveness one; a day keeps the listing cheap without missing a real case.
const SUBAGENT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

// What an agent is doing, read from the last tool it called. Any other tool shows as nothing, and a
// shell tool (`shellTools`) whose command writes a file shows as "write".
const DOING = {
  Edit: "write",
  Write: "write",
  NotebookEdit: "write",
  Read: "read",
  Bash: "run",
  PowerShell: "run",
  Grep: "search",
  Glob: "search",
  WebSearch: "search",
  WebFetch: "search",
  Agent: "talk",
  SendMessage: "talk",
};

// The tools whose file path counts as a read. A shell tool (`shellTools`) counts the files its
// command reads.
const READ_TOOLS = ["Read"];

// End states that mean someone ended the agent early. It never answers, so it leaves no report.
const STOPPED = new Set(["killed", "stopped"]);

const encoder = new TextEncoder();

/**
 * Returns { id, read({ home, now, config, resolve }) }. `home` is the project's git placement and
 * `resolve(dir)` places any folder (the engine caches it). Keep the object for the life of the
 * engine: it caches each transcript's parsed state by size, so a pass reads only the bytes
 * written since the last one, and caches each checkout's owner for `gitCacheSeconds`. A cache entry
 * the latest finished pass didn't use is dropped, so a long stream holds only what is in view.
 *
 * read → { status, errors, humans, sessions, agents, edits, reads, waits, reports, meaning }, the fact
 * lists in the office model's shape. Agents carry no role: the meaning rules give it.
 */
export function createClaudeCode(io) {
  const transcripts = new Map();
  const metas = new Map();
  const owners = new Map();
  let used = new Set(); // the cache keys this pass has used

  async function read({ home, now, config, resolve }) {
    used = new Set();
    const errors = { count: 0, first: null };
    const fail = (err) => {
      errors.count++;
      if (errors.first === null) errors.first = String((err && err.message) || err);
    };
    const facts = { ...newFacts(), errors };

    const candidates = await findSessions(join(io.claudeDir, "projects"), now, config);
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
        // A session's facts join the office only once all of them are read.
        const one = newFacts();
        await addSession(one, c, main, where, now, config, resolve, fail);
        for (const key of FACT_LISTS) facts[key].push(...one[key]);
      } catch (err) {
        // An unreadable transcript (deleted mid-scan, locked) costs one room, not the office,
        // but it is counted so a room never vanishes without a trace.
        sessionsFailed++;
        fail(err);
      }
    }

    for (const cache of [transcripts, metas, owners]) {
      for (const key of cache.keys()) if (!used.has(key)) cache.delete(key);
    }

    if (candidates.length && sessionsFailed === candidates.length) {
      return { ...facts, status: `could not read any of ${candidates.length} session transcripts: ${errors.first}` };
    }
    // Lines that don't parse, or message lines that parse but never name a folder: the format has
    // moved on. A session that has written only bookkeeping lines (ai-title, mode…) is not drift.
    if (!facts.sessions.length && linesSeen && (!linesParsed || (messagesParsed && !cwdsSeen))) {
      return { ...facts, status: "transcript format not recognised" };
    }
    const humans = new Map(facts.humans.map((h) => [h.id, h]));
    return { ...facts, humans: [...humans.values()] };
  }

  // Every session transcript whose newest write (its own, or any subagent's) is inside the idle
  // window, lights on, or inside `lightsOffHours`, lights off. Filtering on mtime first means a
  // quiet transcript is never opened. A subagent is kept while it is inside the idle window or the
  // touched-file window, whichever is wider, so its edits still count towards a possible conflict.
  // With the lights off that window ends at the session's last activity, not now: the room keeps
  // whoever was there when it went quiet.
  async function findSessions(projectsDir, now, config) {
    const idleMs = config.idleMinutes * 60000;
    const keepMs = Math.max(idleMs, config.lightsOffHours * 3600000);
    const agentWindowMs = Math.max(idleMs, config.touchedWindowMinutes * 60000);
    const out = [];
    for (const slug of await io.listDir(projectsDir)) {
      if (!slug.isDir) continue;
      const slugDir = join(projectsDir, slug.name);
      for (const entry of await io.listDir(slugDir)) {
        if (entry.isDir || !entry.name.endsWith(".jsonl")) continue;
        const path = join(slugDir, entry.name);
        const st = await io.stat(path);
        if (!st || now - st.mtimeMs > Math.max(SUBAGENT_LOOKBACK_MS, keepMs)) continue;
        const id = entry.name.slice(0, -".jsonl".length);
        const all = [];
        // Subagents of subagents sit in the same folder; meta.json says who started them.
        const subDir = join(slugDir, `${id}/subagents`);
        for (const f of await io.listDir(subDir)) {
          const m = /^agent-(.+)\.jsonl$/.exec(f.name);
          if (f.isDir || !m) continue;
          const ast = await io.stat(join(subDir, f.name));
          if (ast) all.push({ id: m[1], path: join(subDir, f.name), metaPath: join(subDir, `agent-${m[1]}.meta.json`), ...ast });
        }
        const lastActive = Math.max(st.mtimeMs, ...all.map((a) => a.mtimeMs));
        if (now - lastActive > keepMs) continue;
        const lit = now - lastActive <= idleMs;
        const from = lit ? now : lastActive;
        const agents = all.filter((a) => from - a.mtimeMs <= agentWindowMs);
        out.push({ id, path, size: st.size, ownMtime: st.mtimeMs, lastActive, lights: lit ? "on" : "off", agents });
      }
    }
    return out;
  }

  async function addSession(facts, c, main, where, now, config, resolve, fail) {
    const session = `${SOURCE}:${c.id}`;
    const lead = `${session}:lead`;
    const agentFiles = [];
    for (const a of c.agents) {
      try {
        agentFiles.push({ ...a, t: await readTranscript(a.path, a.size, config.tailBytes), meta: await readMeta(a.metaPath) });
      } catch (err) {
        // Same rule as a session: skip what can't be read, and count it.
        fail(err);
      }
    }

    // Done signals and spawns can sit in the session's own transcript or, for an agent's own
    // agents, in that agent's transcript, so look in all of them. A spawn keeps which file made it.
    const results = new Map(main.results);
    const notes = new Map(main.notes);
    const spawns = new Map();
    for (const [toolUseId, at] of main.spawns) spawns.set(toolUseId, { at, by: lead });
    for (const a of agentFiles) {
      for (const [k, v] of a.t.results) results.set(k, v);
      for (const [k, v] of a.t.notes) notes.set(k, v);
      for (const [toolUseId, at] of a.t.spawns) spawns.set(toolUseId, { at, by: agentId(a.id) });
    }
    // Each transcript's newest write, by the agent that writes it.
    const mtimes = new Map([[lead, c.ownMtime], ...agentFiles.map((a) => [agentId(a.id), a.mtimeMs])]);

    const owner = await ownerOf(where.toplevel, now, config);
    const branch = main.branch || where.branch;
    facts.humans.push(owner);
    facts.sessions.push({
      id: session,
      source: SOURCE,
      owner: owner.id,
      lead,
      title: main.title || branch,
      // The host writes a title for a branch stand-in; Claude Code's own title stays as it is.
      titleFrom: main.title ? "source" : "branch",
      branch,
      checkout: where.toplevel,
      lastActive: iso(c.lastActive),
      status: now - c.lastActive <= config.activeMinutes * 60000 ? "active" : "idle",
      lights: c.lights,
    });

    // The lead works while its turn is open: from a prompt (or a notification it takes up) until
    // it answers without asking for a tool. A lead never stalls: an open turn quiet past
    // `stalledMinutes` is idle, even while it waits on a foreground agent, and it keeps its waits.
    // Idle runs from its last message line, so a later bookkeeping line doesn't move it.
    const leadWorking = main.turnOpen && now - c.ownMtime <= config.stalledMinutes * 60000;
    facts.agents.push({
      id: lead,
      source: SOURCE,
      session,
      startedBy: null,
      agentType: null,
      task: null,
      status: leadWorking ? "working" : "idle",
      statusSince: iso(leadWorking ? main.turnAt : main.lastMessageAt, c.ownMtime),
      lastActive: iso(c.ownMtime),
      doing: leadWorking ? await doingOf(main, resolve, c.ownMtime, config) : null,
      usage: usageOf(main, c.ownMtime),
    });
    await addEdits(facts, lead, main, now, config, resolve);
    await addReads(facts, lead, main, now, config, resolve);

    for (const a of agentFiles) {
      const id = agentId(a.id);
      const type = typeof a.meta.agentType === "string" && a.meta.agentType ? a.meta.agentType : null;
      const at = a.t.cwd ? await resolve(a.t.cwd) : null;
      // The worktree trap: a worktree-isolated agent's lines carry the PARENT's gitBranch, so the
      // agent's branch comes from meta.json, or from git at the agent's own folder — never its lines.
      let worktree = typeof a.meta.worktreePath === "string" ? normalize(a.meta.worktreePath) : null;
      if (!worktree && at && pathKey(at.toplevel) !== pathKey(where.toplevel)) worktree = at.toplevel;
      const agentBranch = worktree ? a.meta.worktreeBranch || (at && pathKey(at.toplevel) === pathKey(worktree) ? at.branch : null) : null;

      // Started by whichever transcript made the Agent call, else the parent meta.json names, else
      // the lead. One not in view (aged out, or never seen) falls back to the lead too.
      const spawn = a.meta.toolUseId ? spawns.get(a.meta.toolUseId) : undefined;
      let startedBy = spawn ? spawn.by : typeof a.meta.parentAgentId === "string" ? agentId(a.meta.parentAgentId) : lead;
      if (!mtimes.has(startedBy)) startedBy = lead;

      const s = agentStatus(a, results, notes, spawn, now, mtimes.get(startedBy), config);
      const working = s.status === "working";
      // A stalled agent keeps its last action, to show where it stopped.
      const live = working || s.status === "stalled";
      facts.agents.push({
        id,
        source: SOURCE,
        session,
        startedBy,
        agentType: type,
        task: typeof a.meta.description === "string" && a.meta.description ? a.meta.description : null,
        status: s.status,
        statusSince: iso(s.since, a.mtimeMs),
        lastActive: iso(a.mtimeMs),
        doing: live ? await doingOf(a.t, resolve, a.mtimeMs, config) : null,
        usage: usageOf(a.t, a.mtimeMs),
        ...(worktree ? { checkout: worktree, branch: agentBranch } : {}),
        extra: { description: a.meta.description ?? null, ...(s.endState ? { endState: s.endState } : {}) },
      });
      if (live) {
        facts.waits.push({ waiter: startedBy, on: id, since: iso(spawn ? spawn.at : a.t.firstAt, a.mtimeMs) });
      }
      if ((s.status === "done" || s.status === "failed") && a.t.lastText !== null) {
        facts.reports.push({ agent: id, at: iso(a.t.lastTextAt, a.mtimeMs), text: a.t.lastText });
      }
      await addEdits(facts, id, a.t, now, config, resolve);
      await addReads(facts, id, a.t, now, config, resolve);
    }
  }

  // Edit/Write/NotebookEdit targets, and the files a shell command wrote, inside the window, each
  // made relative to the worktree of the folder that made the call, newest time per file. Outside
  // the worktree: dropped.
  async function addEdits(facts, agent, st, now, config, resolve) {
    st.touches = await addFiles(facts.edits, agent, st.touches, [...config.touchedTools, ...config.shellTools], now, config, resolve);
  }

  // Read targets and the files a shell command read, the same way.
  async function addReads(facts, agent, st, now, config, resolve) {
    st.reads = await addFiles(facts.reads, agent, st.reads, [...READ_TOOLS, ...config.shellTools], now, config, resolve);
  }

  // Pushes { agent, file, at } to `list` for each file `touches` names by one of `tools`, and
  // returns the touches still inside the window.
  async function addFiles(list, agent, touches, tools, now, config, resolve) {
    const since = now - config.touchedWindowMinutes * 60000;
    const kept = touches.filter((t) => t.at >= since);
    const newest = new Map();
    for (const t of kept) {
      if (!tools.includes(t.name) || !t.cwd) continue;
      const where = await resolve(t.cwd);
      const file = where && relativeTo(where.toplevel, t.path);
      if (file && !(newest.get(file) >= t.at)) newest.set(file, t.at);
    }
    for (const [file, at] of newest) list.push({ agent, file, at: iso(at) });
    return kept;
  }

  // The human a session belongs to, from git's user.name in its checkout. The email stays here.
  async function ownerOf(dir, now, config) {
    const key = pathKey(dir);
    used.add(key);
    const hit = owners.get(key);
    if (hit && now - hit.at <= config.gitCacheSeconds * 1000) return hit.owner;
    let name = null;
    if (io.run) {
      const r = await Promise.resolve()
        .then(() => io.run(["git", "config", "user.name"], { cwd: dir }))
        .catch(() => null);
      if (r && r.code === 0 && r.stdout.trim()) name = r.stdout.trim();
    }
    const owner = { id: `git:${name ?? "unknown"}`, name };
    owners.set(key, { at: now, owner });
    return owner;
  }

  async function readMeta(p) {
    used.add(p);
    const st = await io.stat(p);
    if (!st) return {};
    const cached = metas.get(p);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.meta;
    let meta = {};
    try {
      meta = JSON.parse(await io.read(p)) || {};
    } catch {
      // An unreadable meta.json leaves the agent typeless; its role is the catalogue's "*".
    }
    metas.set(p, { mtimeMs: st.mtimeMs, meta });
    return meta;
  }

  // Parse a transcript incrementally. On first sight only the last `tailBytes` are read (a busy
  // session's file runs to megabytes); after that, only what was appended since. A file that
  // shrank was rewritten, so it starts again.
  async function readTranscript(path, size, tailBytes) {
    used.add(path);
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

  return { id: SOURCE, read };
}

const FACT_LISTS = ["humans", "sessions", "agents", "edits", "reads", "waits", "reports"];

function newFacts() {
  return { status: null, errors: null, humans: [], sessions: [], agents: [], edits: [], reads: [], waits: [], reports: [], meaning: {} };
}

const agentId = (id) => `${SOURCE}:${id}`;

// An ISO time from milliseconds, or from `fallback` when the transcript gave no usable time.
function iso(ms, fallback) {
  return new Date(Number.isFinite(ms) ? ms : fallback).toISOString();
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
    firstAt: NaN, // the first timestamp seen (the start of the tail on a long file)
    lastAt: NaN,
    lastMessageAt: NaN, // the newest user/assistant/attachment/system line's time
    lastTool: null, // { name, file, cwd, at, wrote }: wrote when a shell command writes `file`
    lastText: null,
    lastTextAt: NaN,
    lastRole: null, // "user" | "assistant": the newest message line
    waiting: false, // the newest assistant line asked for a tool
    turnOpen: false, // a lead's turn is in progress
    turnAt: NaN, // when it opened
    results: new Map(), // tool_use_id → { launched } | { status, at }
    spawns: new Map(), // id of each Agent tool_use this file made → its time
    notes: new Map(), // agent id → { status, at } from <task-notification>
    touches: [], // { at, cwd, name, path } for tool uses that name a file
    reads: [], // the same, for the files a tool use read
    usage: null, // { model, context, at } from the newest reply
    output: 0, // output tokens over the replies read
    replyId: null, // the newest reply's message id, and its output tokens as counted
    replyOut: 0,
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
  if (Number.isFinite(at)) {
    st.lastAt = at;
    if (!Number.isFinite(st.firstAt)) st.firstAt = at;
    if (MESSAGE_TYPES.has(ev.type)) st.lastMessageAt = at;
  }
  // Bookkeeping lines (ai-title, queue-operation, mode…) carry no cwd; keep the newest that does.
  if (typeof ev.cwd === "string" && ev.cwd) st.cwd = ev.cwd;
  if (typeof ev.gitBranch === "string" && ev.gitBranch) st.branch = ev.gitBranch;
  if (ev.type === "ai-title" && typeof ev.aiTitle === "string" && ev.aiTitle) st.title = ev.aiTitle;
  if (ev.type === "queue-operation" && typeof ev.content === "string") readNotifications(st, ev.content, at);

  const content = ev.message && ev.message.content;
  if (ev.type === "assistant" && Array.isArray(content)) {
    st.lastRole = "assistant";
    st.waiting = false;
    readUsage(st, ev.message, at);
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
        st.lastText = c.text;
        st.lastTextAt = at;
      }
      if (c.type !== "tool_use") continue;
      st.waiting = true;
      if (c.name === "Agent" && typeof c.id === "string") st.spawns.set(c.id, at);
      const input = c.input || {};
      const cwd = ev.cwd || st.cwd;
      // Any tool with a command is read as a shell: read time keeps only the `shellTools`.
      const shell = typeof input.command === "string" ? shellFiles(input.command, cwd, { powershell: c.name === "PowerShell" }) : { writes: [], reads: [] };
      const writes = shell.writes;
      const file = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : typeof input.path === "string" ? input.path : null;
      st.lastTool = writes.length ? { name: c.name, file: writes[writes.length - 1], cwd, at, wrote: true } : { name: c.name, file, cwd, at };
      // Edit and Read paths and shell writes and reads are absolute; they are resolved against this
      // line's cwd at read time, which also keeps only the tools that count.
      const target = input.file_path || input.notebook_path;
      const targets = typeof target === "string" ? [target] : writes;
      const reads = typeof target === "string" ? [target] : shell.reads;
      if (Number.isFinite(at)) {
        for (const path of targets) st.touches.push({ at, cwd, name: c.name, path });
        for (const path of reads) st.reads.push({ at, cwd, name: c.name, path });
      }
    }
    // Each content block is its own line, so a text or thinking line inside a turn that goes on to
    // call a tool carries stop_reason "tool_use" while the tool_use line itself is still to come.
    setTurn(st, st.waiting || ev.message.stop_reason === "tool_use", at);
  } else if (ev.type === "user" && content != null) {
    st.lastRole = "user";
    let toolResults = false;
    if (typeof content === "string") readNotifications(st, content, at);
    else if (Array.isArray(content)) {
      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "text" && typeof c.text === "string") readNotifications(st, c.text, at);
        if (c.type === "tool_result" && typeof c.tool_use_id === "string") {
          toolResults = true;
          st.results.set(c.tool_use_id, { ...toolResult(ev.toolUseResult, c.is_error), at });
        }
      }
    }
    const turn = userTurn(ev, content);
    if (turn !== null) setTurn(st, turn, at);
    // A prompt (not a tool result) starts a new turn: the last turn's tool is not what it is doing.
    if (turn === true && !toolResults) st.lastTool = null;
  }
}

// The newest reply's model and context size (its input plus both cache counts), and the output
// summed over the replies read. Each content block of a reply is its own line carrying the same
// usage, so a reply counts once. A line the client made up (model "<synthetic>") is no reply.
function readUsage(st, message, at) {
  const u = message.usage;
  if (!u || typeof u !== "object" || typeof message.model !== "string" || !message.model || message.model.startsWith("<")) return;
  const n = (key) => (Number.isFinite(u[key]) ? u[key] : 0);
  const out = n("output_tokens");
  const same = typeof message.id === "string" && message.id === st.replyId;
  st.output += out - (same ? st.replyOut : 0);
  st.replyId = typeof message.id === "string" ? message.id : null;
  st.replyOut = out;
  st.usage = { model: message.model, context: n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens"), at };
}

// An agent's usage for the model: null until a reply with usage has been read.
function usageOf(st, fallbackMs) {
  return st.usage && { model: st.usage.model, context: st.usage.context, output: st.output, at: iso(st.usage.at, fallbackMs) };
}

function setTurn(st, open, at) {
  if (open && !st.turnOpen) st.turnAt = at;
  st.turnOpen = open;
}

// How a user line moves the lead's turn: a prompt, a tool result or a notification opens it (true),
// an interruption ends it (false), and meta lines, slash-command echoes and compaction summaries
// leave it as it was (null).
function userTurn(ev, content) {
  if (ev.isMeta || ev.isCompactSummary) return null;
  const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text) : [];
  if (texts.some((t) => t.startsWith("[Request interrupted by user"))) return false;
  if (texts.length && texts.every((t) => /^\s*<(command-|local-command-)/.test(t))) return null;
  return true;
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

/**
 * A subagent's { status, since, endState? }: working | stalled | done | stopped | failed, with
 * the raw end state Claude Code gave (completed, killed, stopped, failed…) when it has ended.
 */
function agentStatus(a, results, notes, spawn, now, starterMtimeMs, config) {
  // Foreground: the parent's tool_result for the Agent call. A launch acknowledgement doesn't count.
  const r = a.meta.toolUseId && results.get(a.meta.toolUseId);
  if (r && !r.launched) return ended(r.status, r.at);
  // Background: the completion notification, unless the agent was resumed and has written since.
  const n = notes.get(a.id);
  if (n && !(a.t.lastAt > n.at)) return ended(n.status, n.at);
  // The parent's Agent call is in view with neither signal: working while the agent or whoever
  // started it (the lead, or the parent subagent) has written within `stalledMinutes`. Both quiet
  // longer than that is stalled: most often an orphan whose parent crashed or exited, though a
  // foreground agent stuck in one long tool call while its parent waits looks the same.
  if (spawn) {
    const stalledMs = config.stalledMinutes * 60000;
    const quietSince = Math.max(a.mtimeMs, starterMtimeMs);
    if (now - quietSince > stalledMs) return { status: "stalled", since: quietSince + stalledMs };
    return { status: "working", since: spawn.at };
  }
  // The spawn isn't in view (perhaps before the part of the parent we read): the quiet-file rule.
  if (now - a.mtimeMs >= config.quietSeconds * 1000 && a.t.lastRole === "assistant" && !a.t.waiting) return ended("completed", a.t.lastAt);
  return { status: "working", since: a.t.firstAt };
}

function ended(state, at) {
  return { status: state === "completed" ? "done" : STOPPED.has(state) ? "stopped" : "failed", since: at, endState: state };
}

// The agent's last tool call as { kind, file?, since }, the file relative to the worktree it was
// called from. Outside the worktree the file is dropped, as for edits. A tool with no kind in
// DOING shows as nothing; a shell tool's write shows as "write".
async function doingOf(st, resolve, fallbackMs, config) {
  const t = st.lastTool;
  const kind = t && (t.wrote && config.shellTools.includes(t.name) ? "write" : DOING[t.name]);
  if (!kind) return null;
  const doing = { kind };
  if (t.file && t.cwd) {
    const where = await resolve(t.cwd);
    const file = where && relativeTo(where.toplevel, t.file);
    if (file) doing.file = file;
  }
  doing.since = iso(t.at, fallbackMs);
  return doing;
}
