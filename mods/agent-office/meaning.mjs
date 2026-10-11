// Agent Office's meaning rules: the judgements drawn from the sources' facts — each agent's role,
// possible conflicts and findings worth reading. A source may supply any item itself, and what it
// supplies wins; the rules work out the rest. Every item says who produced it.
//
// Pure: no Node imports and no io. The engine, the mod and any later app share this file.
//
// facts:  { agents, edits, reports, meaning: { roles?, conflicts?, findings? } } in the model's
//         shape, where a source's own meaning items carry no `by` (they are stamped "source")
// config: { roles: agent type → role with "*" for the rest, touchedWindowMinutes, findingsFrom }

/** → { roles: [{ agent, role, by }], conflicts: [{ file, agents, by }], findings: [{ report, by }] } */
export function workOutMeaning(facts, config, now) {
  const given = facts.meaning || {};
  return {
    roles: roles(facts.agents, given.roles || [], config.roles),
    conflicts: conflicts(facts.edits, given.conflicts || [], now - config.touchedWindowMinutes * 60000),
    findings: findings(facts.agents, facts.reports, given.findings || [], new Set(config.findingsFrom)),
  };
}

// A lead is a lead. Anyone else gets the catalogue's role for their agent type, or its "*" entry
// when the type has none (or the source gave no type).
function roles(agents, given, catalogue) {
  const fromSource = new Map(given.map((r) => [r.agent, r.role]));
  return agents.map((a) => {
    if (fromSource.has(a.id)) return { agent: a.id, role: fromSource.get(a.id), by: "source" };
    const role = a.startedBy === null ? "lead" : (a.agentType != null ? catalogue[a.agentType] : undefined) ?? catalogue["*"] ?? "other";
    return { agent: a.id, role, by: "rules" };
  });
}

// A file that two or more agents edited inside the touched window, whatever each one's status
// now. One item per file, naming everyone who edited it. Git history later shows whether it is a
// real conflict; that is not decided here.
function conflicts(edits, given, since) {
  const out = given.map((c) => ({ file: c.file, agents: c.agents, by: "source" }));
  const covered = new Set(out.map((c) => c.file));
  const editors = new Map();
  for (const e of edits) {
    if (covered.has(e.file) || Date.parse(e.at) < since) continue;
    if (!editors.has(e.file)) editors.set(e.file, new Set());
    editors.get(e.file).add(e.agent);
  }
  for (const [file, people] of editors) {
    if (people.size > 1) out.push({ file, agents: [...people].sort(), by: "rules" });
  }
  return out;
}

// Reports from the agent types the config names (reviewers by default).
function findings(agents, reports, given, from) {
  const out = given.map((f) => ({ report: f.report, by: "source" }));
  const covered = new Set(out.map((f) => f.report));
  const type = new Map(agents.map((a) => [a.id, a.agentType]));
  for (const r of reports) {
    if (!covered.has(r.agent) && from.has(type.get(r.agent))) out.push({ report: r.agent, by: "rules" });
  }
  return out;
}
