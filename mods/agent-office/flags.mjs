// Agent Office's flags: a note for an agent that has just edited a file someone else in the office
// edited lately, which it reads after the tool's result. A flag never blocks or undoes anything:
// it names a possible conflict, as the meaning rules do, and leaves the agent to check.
//
// Pure: no Node imports and no `$`. The mod and any later app share this file.

import { relativeTo } from "./git.mjs";

/**
 * The file a call edited as the model names it: relative to the caller's checkout (its own
 * worktree when it has one, else its session's), or null when the path is outside it.
 * call: { agent, session, path }, the model ids of the caller and its session, and the absolute
 *       path the tool was given. A caller the model doesn't hold yet uses its session's checkout.
 */
export function editedFile(model, { agent, session, path }) {
  const a = model.agents.find((x) => x.id === agent);
  const s = model.sessions.find((x) => x.id === (a ? a.session : session));
  const checkout = (a && a.checkout) || (s && s.checkout);
  return checkout && path ? relativeTo(checkout, path) : null;
}

/**
 * The note for one finished edit, or null: one line per other agent, in any room, that edited the
 * file inside the touched window (newest first), then what to do about it. The caller's own edits
 * never count.
 * window: touchedWindowMinutes. titles: session id → a title the host wrote for a branch stand-in.
 */
export function conflictNote(model, call, { now, window, titles = {} }) {
  const file = editedFile(model, call);
  if (!file) return null;
  const since = now - window * 60000;
  const others = model.edits.filter((e) => e.file === file && e.agent !== call.agent && Date.parse(e.at) >= since).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (!others.length) return null;
  const lines = others.map((e) => {
    const a = model.agents.find((x) => x.id === e.agent);
    const minutes = Math.max(0, Math.floor((now - Date.parse(e.at)) / 60000));
    return `Possible conflict: ${file} was also edited ${minutes}m ago by ${a ? labelOf(a) : e.agent} in "${a ? roomTitle(model, a.session, titles) : "another room"}"`;
  });
  return [...lines, "Check that your change and theirs fit together before going on."].join("\n");
}

// Named as the pane names people and rooms (layout.mjs), so the note matches what a person sees.
const labelOf = (a) => (a.startedBy === null ? "lead" : a.agentType || a.role || "other");

function roomTitle(model, sessionId, titles) {
  const room = model.rooms.find((r) => r.sessions.includes(sessionId));
  const sessions = room ? room.sessions.map((id) => model.sessions.find((s) => s.id === id)).filter(Boolean) : [];
  if (sessions.some((s) => s.titleFrom === "branch" && titles[s.id])) {
    return sessions.map((s) => (s.titleFrom === "branch" && titles[s.id]) || s.title).filter(Boolean).join(" + ");
  }
  return (room && room.title) || sessions.map((s) => s.title).filter(Boolean).join(" + ") || "Untitled session";
}
