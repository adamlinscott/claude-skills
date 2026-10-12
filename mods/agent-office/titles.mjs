// Agent Office's room titles: a short title written by a small model for a session whose title is
// only its branch (Claude Code hasn't written one yet, or never does, as in the Claude app). The
// host makes the call; this file decides what to ask, when, and what to keep from the reply.
//
// The prompt is built only from the office model: the branch, the session's edited files, and its
// subagents' types and task names. Never anything a person typed.
//
// Pure: no Node imports and no `$`. The mod and any later app share this file.

const ASK_EVERY_MS = 10 * 60000; // at most one call per session in this long
const MAX_FILES = 15;
const MAX_TASKS = 10;
const MAX_TITLE = 60;

export const TITLE_SYSTEM =
  "You name coding sessions for a floor plan of a team's work. From the facts given, write a title of 3 to 6 words saying what the session is working on. Reply with the title alone: no quotes and no full stop.";

/** What a session's title is written from: { branch, files, types, tasks }, each list sorted. */
export function titleInputs(model, sessionId) {
  const session = model.sessions.find((s) => s.id === sessionId);
  const agents = model.agents.filter((a) => a.session === sessionId);
  const ids = new Set(agents.map((a) => a.id));
  const subs = agents.filter((a) => a.startedBy !== null);
  // The newest edits and tasks, when there are more than a prompt needs.
  const files = new Map();
  for (const e of model.edits) if (ids.has(e.agent) && !(files.get(e.file) >= e.at)) files.set(e.file, e.at);
  const tasks = subs.filter((a) => a.task).sort((a, b) => cmp(b.lastActive, a.lastActive));
  return {
    branch: (session && session.branch) || null,
    files: [...files].sort((a, b) => cmp(b[1], a[1])).slice(0, MAX_FILES).map(([f]) => f).sort(),
    types: [...new Set(subs.map((a) => a.agentType).filter(Boolean))].sort(),
    tasks: [...new Set(tasks.map((a) => a.task))].slice(0, MAX_TASKS).sort(),
  };
}

/** The cache key for a session's inputs: a new call goes out only when this changes. */
export const titleKey = (inputs) => JSON.stringify(inputs);

/** The prompt for one session's inputs. */
export function titlePrompt({ branch, files, types, tasks }) {
  const out = [`Branch: ${branch || "(none)"}`];
  if (files.length) out.push("Files edited:", ...files.map((f) => "- " + f));
  if (types.length) out.push(`Agent types: ${types.join(", ")}`);
  if (tasks.length) out.push("Subagent tasks:", ...tasks.map((t) => "- " + t));
  return out.join("\n");
}

// The reply's text. The types promise a string, but the Claude app's build has answered with an
// object; read text from the usual shapes ({ text }, { content: string | [{ type: "text", text }] })
// and never print an object as a title.
function replyText(reply) {
  if (typeof reply === "string") return reply;
  if (!reply || typeof reply !== "object") return "";
  if (typeof reply.text === "string") return reply.text;
  if (typeof reply.content === "string") return reply.content;
  if (Array.isArray(reply.content)) return reply.content.filter((b) => b && typeof b.text === "string").map((b) => b.text).join("\n");
  return "";
}

/** The title from a reply: its first line, unquoted, clipped; null when nothing is left. */
export function cleanTitle(reply) {
  const first = replyText(reply).split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
  const title = first.replace(/^["'`*]+|["'`*.]+$/g, "").trim();
  if (!title) return null;
  return title.length <= MAX_TITLE ? title : title.slice(0, MAX_TITLE - 1).trimEnd() + "…";
}

/**
 * The next title to ask for, or null: the first session (in the model's order, newest first)
 * titled by its branch whose inputs changed since its last written title, and whose last ask was
 * at least ASK_EVERY_MS ago. cache: session id → { key, title, at }, the host's, kept in memory.
 * → { session, key, prompt }
 */
export function nextTitle(model, cache, now) {
  for (const s of model.sessions) {
    if (s.titleFrom !== "branch") continue;
    const inputs = titleInputs(model, s.id);
    if (!inputs.branch && !inputs.files.length && !inputs.tasks.length) continue; // nothing to go on
    const key = titleKey(inputs);
    const hit = cache.get(s.id);
    if (hit && (hit.key === key || now - hit.at < ASK_EVERY_MS)) continue;
    return { session: s.id, key, prompt: titlePrompt(inputs) };
  }
  return null;
}

/** session id → title, for the layout's `titles` option. */
export function writtenTitles(cache) {
  const out = {};
  for (const [id, hit] of cache) if (hit.title) out[id] = hit.title;
  return out;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
