import { test } from "node:test";
import assert from "node:assert/strict";
import { workOutMeaning } from "../meaning.mjs";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();
const config = { roles: Object.assign(Object.create(null), { worker: "worker", reviewer: "reviewer", "*": "other" }), touchedWindowMinutes: 30, findingsFrom: ["reviewer"] };

const lead = { id: "lead", startedBy: null, agentType: null, doing: null };
const person = (id, agentType, doing = null) => ({ id, startedBy: "lead", agentType, doing });
const writing = (file) => ({ kind: "write", file, since: ago(0) });
const facts = (more) => ({ agents: [], edits: [], reports: [], meaning: {}, ...more });

test("roles: a lead is a lead; others take the catalogue's role for their type, else its \"*\" entry", () => {
  const m = workOutMeaning(facts({ agents: [lead, person("w", "worker"), person("x", "mystery"), person("n", null)] }), config, NOW);
  assert.deepEqual(m.roles, [
    { agent: "lead", role: "lead", by: "rules" },
    { agent: "w", role: "worker", by: "rules" },
    { agent: "x", role: "other", by: "rules" },
    { agent: "n", role: "other", by: "rules" },
  ]);
});

test("conflicts: a file two or more agents edited inside the touched window, whatever they are doing now", () => {
  // Nobody is writing anything now; the edits alone decide.
  const agents = [lead, person("a", "worker"), person("b", "worker"), person("c", "worker"), person("d", "worker")];
  const edits = [
    { agent: "a", file: "x.md", at: ago(10) },
    { agent: "b", file: "x.md", at: ago(25) }, // two editors in the window: a conflict
    { agent: "a", file: "z.md", at: ago(1) },
    { agent: "c", file: "z.md", at: ago(2) },
    { agent: "lead", file: "z.md", at: ago(3) }, // every editor is listed
    { agent: "c", file: "own.md", at: ago(1) }, // one editor: none
    { agent: "d", file: "old.md", at: ago(45) },
    { agent: "a", file: "old.md", at: ago(5) }, // the other edit is outside the window: none
  ];
  assert.deepEqual(workOutMeaning(facts({ agents, edits }), config, NOW).conflicts, [
    { file: "x.md", agents: ["a", "b"], by: "rules" },
    { file: "z.md", agents: ["a", "c", "lead"], by: "rules" },
  ]);
});

test("conflicts: files match case-insensitively, named by the first spelling seen", () => {
  const agents = [lead, person("a", "worker"), person("b", "worker")];
  const edits = [
    { agent: "a", file: "README.md", at: ago(5) },
    { agent: "b", file: "readme.md", at: ago(2) },
  ];
  assert.deepEqual(workOutMeaning(facts({ agents, edits }), config, NOW).conflicts, [{ file: "README.md", agents: ["a", "b"], by: "rules" }]);
});

test("findings: reports from the agent types the config names, reviewer by default", () => {
  const agents = [lead, person("r", "reviewer"), person("w", "worker")];
  const reports = [{ agent: "r", at: ago(1), text: "Two bugs." }, { agent: "w", at: ago(1), text: "Built it." }];
  assert.deepEqual(workOutMeaning(facts({ agents, reports }), config, NOW).findings, [{ report: "r", by: "rules" }]);
  assert.deepEqual(workOutMeaning(facts({ agents, reports }), { ...config, findingsFrom: ["worker"] }, NOW).findings, [{ report: "w", by: "rules" }]);
});

test("source meaning wins: what a source supplies is kept as its own, and the rules fill only the rest", () => {
  const agents = [lead, person("r", "reviewer", writing("x.md")), person("w", "worker", writing("x.md"))];
  const reports = [{ agent: "r", at: ago(1), text: "Two bugs." }];
  const given = { roles: [{ agent: "w", role: "accountant" }], conflicts: [{ file: "x.md", agents: ["w"] }], findings: [{ report: "r" }] };
  const m = workOutMeaning(facts({ agents, reports, meaning: given }), config, NOW);
  assert.deepEqual(m.roles.find((r) => r.agent === "w"), { agent: "w", role: "accountant", by: "source" });
  assert.deepEqual(m.roles.find((r) => r.agent === "r"), { agent: "r", role: "reviewer", by: "rules" });
  assert.deepEqual(m.conflicts, [{ file: "x.md", agents: ["w"], by: "source" }]);
  assert.deepEqual(m.findings, [{ report: "r", by: "source" }]);
});
