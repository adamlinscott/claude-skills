// A small office model v1 for the layout and renderer tests, built from a list of rooms.

export const NOW = Date.parse("2026-10-11T15:00:00Z");
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();

/**
 * rooms: [{ id, sessions: [{ id, status?, idle?, lights?, titleFrom?, lead?, team?: [{ id, type, status, task?, waited?, writing?, report? }] }] }].
 * Sessions are listed newest first, as the model sorts them. A teammate with `waited` is owed an
 * answer by its lead; one `writing` a file is doing that, an edit made now; one with a `report` has
 * it as a finding.
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
    reads: [],
    waits: [],
    reports: [],
    meaning: { roles: [], conflicts: [], findings: [] },
  };
  for (const r of rooms) {
    m.rooms.push({ id: "room:" + r.id, sessions: r.sessions.map((s) => s.id), title: r.title ?? `Room ${r.id}` });
    for (const s of r.sessions) {
      const lead = `${s.id}:lead`;
      const idle = s.idle ?? (s.status === "idle" ? 10 : 0);
      m.sessions.push({ id: s.id, source: "claude-code", owner: "git:Adam", lead, title: `Room ${r.id}`, titleFrom: s.titleFrom ?? "source", branch: `b-${s.id}`, checkout: `C:/w/${s.id}`, lastActive: ago(idle), status: s.status ?? "active", lights: s.lights ?? "on" });
      m.agents.push({ id: lead, source: "claude-code", session: s.id, startedBy: null, agentType: null, task: null, role: "lead", status: s.lead ?? "working", statusSince: ago(2), lastActive: ago(idle), doing: null });
      for (const a of s.team || []) {
        m.agents.push({ id: a.id, source: "claude-code", session: s.id, startedBy: lead, agentType: a.type ?? "worker", task: a.task ?? null, role: a.role ?? "worker", status: a.status ?? "working", statusSince: ago(5), lastActive: ago(1), doing: a.writing ? { kind: "write", file: a.writing, since: ago(1) } : null });
        if (a.writing) m.edits.push({ agent: a.id, file: a.writing, at: ago(0) });
        if (a.report) {
          m.reports.push({ agent: a.id, at: ago(1), text: a.report });
          m.meaning.findings.push({ report: a.id, by: "rules" });
        }
        if (a.waited) m.waits.push({ waiter: lead, on: a.id, since: ago(5) });
      }
    }
  }
  return m;
}
