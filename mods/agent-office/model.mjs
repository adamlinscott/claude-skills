// Agent Office's office model, version 1 (docs/designs/agent-office-model.md): puts the sources'
// facts and the meaning rules' judgements together into one model, in a fixed order, and tells
// whether two models differ.
//
// Pure: no Node imports and no io. The engine, the mod and any later app share this file.

export const SCHEMA_VERSION = 1;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// An id's place in `order`; one the model doesn't hold sorts after every known one.
const rank = (order, id) => order.get(id) ?? order.size;

/**
 * { seq, now, project: { id, name }, sources: [{ id, status, errors }], facts, meaning } → model.
 * Rooms are one per session in v1, titled from it. Everything is sorted so the same office always
 * gives the same text: sessions newest first, then agents by session with the lead first.
 */
export function assembleModel({ seq, now, project, sources, facts, meaning }) {
  const sessions = [...facts.sessions].sort((a, b) => cmp(b.lastActive, a.lastActive) || cmp(a.id, b.id));
  const sessionOrder = new Map(sessions.map((s, i) => [s.id, i]));
  const role = new Map(meaning.roles.map((r) => [r.agent, r.role]));
  const agents = facts.agents
    .map(({ id, source, session, startedBy, agentType, ...rest }) => ({ id, source, session, startedBy, agentType, role: role.get(id) ?? null, ...rest }))
    .sort((a, b) => rank(sessionOrder, a.session) - rank(sessionOrder, b.session) || (a.startedBy !== null) - (b.startedBy !== null) || cmp(a.id, b.id));
  const agentOrder = new Map(agents.map((a, i) => [a.id, i]));
  const byAgent = (key) => (a, b) => rank(agentOrder, a[key]) - rank(agentOrder, b[key]) || cmp(a[key], b[key]);

  return {
    schemaVersion: SCHEMA_VERSION,
    seq,
    generatedAt: new Date(now).toISOString(),
    project,
    sources,
    humans: [...facts.humans].sort((a, b) => cmp(a.id, b.id)),
    sessions,
    rooms: sessions.map((s) => ({ id: `room:${s.id}`, sessions: [s.id], title: s.title })),
    agents,
    edits: [...facts.edits].sort((a, b) => byAgent("agent")(a, b) || cmp(a.file, b.file)),
    reads: [...facts.reads].sort((a, b) => byAgent("agent")(a, b) || cmp(a.file, b.file)),
    waits: [...facts.waits].sort((a, b) => byAgent("waiter")(a, b) || byAgent("on")(a, b)),
    reports: [...facts.reports].sort(byAgent("agent")),
    meaning: {
      roles: [...meaning.roles].sort(byAgent("agent")),
      conflicts: [...meaning.conflicts].sort((a, b) => cmp(a.file, b.file)),
      findings: [...meaning.findings].sort(byAgent("report")),
    },
  };
}

/** True when the two models describe the same office: everything but `seq` and `generatedAt`. */
export function sameModel(a, b) {
  if (!a || !b) return a === b;
  const strip = ({ seq, generatedAt, ...rest }) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}
