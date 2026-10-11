// A small office model v1 for the layout and renderer tests, built from a list of rooms.

export const NOW = Date.parse("2026-10-11T15:00:00Z");
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();

/**
 * rooms: [{ id, sessions: [{ id, status?, idle?, lead?, team?: [{ id, type, status, waited? }] }] }].
 * Sessions are listed newest first, as the model sorts them. A teammate with `waited` is owed an
 * answer by its lead.
 */
export function office(rooms) {
  const m = {
    schemaVersion: 1,
    seq: 1,
    generatedAt: new Date(NOW).toISOString(),
    project: { id: "C:/repo/.git", name: "repo" },
    sources: [{ id: "claude-code", status: null, errors: { count: 0, first: null } }],
    humans: [{ id: "git:Adam", name: "Adam" }],
    sessions: [],
    rooms: [],
    agents: [],
    edits: [],
    waits: [],
    reports: [],
    meaning: { roles: [], conflicts: [], findings: [] },
  };
  for (const r of rooms) {
    m.rooms.push({ id: "room:" + r.id, sessions: r.sessions.map((s) => s.id), title: r.title ?? `Room ${r.id}` });
    for (const s of r.sessions) {
      const lead = `${s.id}:lead`;
      const idle = s.idle ?? (s.status === "idle" ? 10 : 0);
      m.sessions.push({ id: s.id, source: "claude-code", owner: "git:Adam", lead, title: `Room ${r.id}`, branch: `b-${s.id}`, checkout: `C:/w/${s.id}`, lastActive: ago(idle), status: s.status ?? "active" });
      m.agents.push({ id: lead, source: "claude-code", session: s.id, startedBy: null, agentType: null, role: "lead", status: s.lead ?? "working", statusSince: ago(2), lastActive: ago(idle), doing: null });
      for (const a of s.team || []) {
        m.agents.push({ id: a.id, source: "claude-code", session: s.id, startedBy: lead, agentType: a.type ?? "worker", role: a.role ?? "worker", status: a.status ?? "working", statusSince: ago(5), lastActive: ago(1), doing: null, ...(a.extra ? { extra: a.extra } : {}) });
        if (a.waited) m.waits.push({ waiter: lead, on: a.id, since: ago(5) });
      }
    }
  }
  return m;
}
