import { test } from "node:test";
import assert from "node:assert/strict";
import { getPatterns, answerOpenQuestion, getThemes, groupTheme } from "../src/mcp/handlers.ts";
import { resolveOrCreateCluster, createTheme } from "../src/corpus/identity.ts";
import { computeRelational } from "../src/corpus/identity.ts";
import {
  emptyCorpus,
  emptyEvidenceStore,
  type Corpus,
  type EvidenceStore,
} from "../src/corpus/types.ts";
import type { ReturnInstructions } from "../src/mcp/prompts.ts";

const now = "2026-06-25T00:00:00.000Z";
const ABS_PATH_A = "C:/Users/adamr/Projects/alpha";
const ABS_PATH_B = "C:/Users/adamr/Projects/beta";

const INSTRUCTIONS: ReturnInstructions = {
  depthInstruction: "DEPTH",
  classifyIntent: "CLASSIFY",
};

/** A cluster with two distinct-repo, distinct-session evidence items + computed relational facts. */
function clusterFixture(): { corpus: Corpus; evidence: EvidenceStore; clusterId: string } {
  const corpus = emptyCorpus(now);
  const evidence = emptyEvidenceStore();
  const c = resolveOrCreateCluster(corpus, "after-error", "rgb value", "renamed acronyms", now);
  evidence.items["e1"] = { id: "e1", sessionId: "s1", cwd: ABS_PATH_A, gitBranch: "main", ts: "2026-01-01T00:00:00Z", snippet: "a" };
  evidence.items["e2"] = { id: "e2", sessionId: "s2", cwd: ABS_PATH_B, gitBranch: "dev", ts: "2026-03-01T00:00:00Z", snippet: "b" };
  c.evidenceIds = ["e1", "e2"];
  c.count = 2;
  c.sessionCount = 2;
  c.relational = computeRelational(c.evidenceIds, evidence);
  return { corpus, evidence, clusterId: c.clusterId };
}

// ── get_patterns surfaces the stored relational rollup (evidence-free) ──────────────────────────

test("get_patterns includes the cluster's relational rollup (counts only, no raw paths)", () => {
  const { corpus } = clusterFixture();
  const res = getPatterns(corpus);
  const p = res.patterns[0];
  assert.ok(p.relational, "relational rollup present on the summary");
  assert.equal(p.relational!.distinctSessions, 2);
  assert.equal(p.relational!.distinctRepos, 2);
  assert.equal(p.relational!.distinctBranches, 2);
  assert.equal(p.relational!.occurrences, 2);
  // Privacy: no raw path leaks via get_patterns.
  const serialized = JSON.stringify(res);
  assert.equal(serialized.includes(ABS_PATH_A), false);
  assert.equal(serialized.includes(ABS_PATH_B), false);
});

// ── answer_open_question (cluster) exposes relationalFacts incl. timeline ───────────────────────

test("answer_open_question(cluster) returns relationalFacts with rollup + sorted timeline (no verdict)", () => {
  const { corpus, evidence, clusterId } = clusterFixture();
  const res = answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId })!;
  assert.ok(res.relationalFacts, "relationalFacts present");
  assert.equal(res.relationalFacts.distinctSessions, 2);
  assert.equal(res.relationalFacts.distinctRepos, 2);
  assert.equal(res.relationalFacts.distinctBranches, 2);
  assert.equal(res.relationalFacts.occurrences, 2);
  assert.equal(res.relationalFacts.firstTs, "2026-01-01T00:00:00Z");
  assert.equal(res.relationalFacts.lastTs, "2026-03-01T00:00:00Z");
  assert.deepEqual(res.relationalFacts.timeline, ["2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"]);
  // No raw path / verdict text leaks via the facts.
  const serialized = JSON.stringify(res.relationalFacts);
  assert.equal(serialized.includes(ABS_PATH_A), false);
  assert.equal(/trust|earned|cross-domain/i.test(serialized), false, "facts carry no verdict label");
});

test("answer_open_question(cluster) relationalFacts is freshly computed from the sidecar (not stale stored facts)", () => {
  const { corpus, evidence, clusterId } = clusterFixture();
  // Add a THIRD evidence item to the sidecar + cluster WITHOUT recomputing cluster.relational (stale).
  evidence.items["e3"] = { id: "e3", sessionId: "s3", cwd: "C:/Users/adamr/Projects/gamma", gitBranch: "main", ts: "2026-05-01T00:00:00Z", snippet: "c" };
  const c = corpus.clusters[0];
  c.evidenceIds.push("e3");
  // c.relational still says 2 sessions; answer_open_question must reflect the live sidecar (3).
  const res = answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId })!;
  assert.equal(res.relationalFacts.distinctSessions, 3, "freshly computed from the sidecar");
  assert.equal(res.relationalFacts.occurrences, 3);
  assert.equal(res.relationalFacts.lastTs, "2026-05-01T00:00:00Z");
});

// ── answer_open_question (theme) exposes the EXACT union rollup + timeline ───────────────────────

test("answer_open_question(theme) returns the EXACT union relationalFacts across member clusters", () => {
  const corpus = emptyCorpus(now);
  const evidence = emptyEvidenceStore();
  const a = resolveOrCreateCluster(corpus, "after-error", "a", "a", now);
  const b = resolveOrCreateCluster(corpus, "after-error", "b", "b", now);
  // Members share session s1 -> union distinctSessions must be 2, not 3.
  evidence.items["e1"] = { id: "e1", sessionId: "s1", cwd: ABS_PATH_A, gitBranch: "main", ts: "2026-01-01T00:00:00Z", snippet: "a" };
  evidence.items["e2"] = { id: "e2", sessionId: "s1", cwd: ABS_PATH_A, gitBranch: "main", ts: "2026-02-01T00:00:00Z", snippet: "b" };
  evidence.items["e3"] = { id: "e3", sessionId: "s2", cwd: ABS_PATH_B, gitBranch: "dev", ts: "2026-03-01T00:00:00Z", snippet: "c" };
  a.evidenceIds = ["e1"];
  b.evidenceIds = ["e2", "e3"];
  const theme = createTheme(corpus, "T", [a.clusterId, b.clusterId], now);

  const res = answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { themeId: theme.themeId })!;
  assert.equal(res.target, "theme");
  assert.equal(res.relationalFacts.distinctSessions, 2, "exact union (s1 shared)");
  assert.equal(res.relationalFacts.distinctRepos, 2);
  assert.equal(res.relationalFacts.occurrences, 3);
  assert.deepEqual(res.relationalFacts.timeline, [
    "2026-01-01T00:00:00Z",
    "2026-02-01T00:00:00Z",
    "2026-03-01T00:00:00Z",
  ]);
});

// ── get_themes surfaces the corpus-only (approximate) theme rollup ──────────────────────────────

test("get_themes includes a theme relational rollup (MAX-over-members distinct*, sum occurrences)", () => {
  const corpus = emptyCorpus(now);
  const evidence = emptyEvidenceStore();
  const a = resolveOrCreateCluster(corpus, "after-error", "a", "a", now);
  const b = resolveOrCreateCluster(corpus, "after-error", "b", "b", now);
  evidence.items["e1"] = { id: "e1", sessionId: "s1", cwd: ABS_PATH_A, gitBranch: "main", ts: "2026-01-01T00:00:00Z", snippet: "a" };
  evidence.items["e2"] = { id: "e2", sessionId: "s2", cwd: ABS_PATH_B, gitBranch: "dev", ts: "2026-03-01T00:00:00Z", snippet: "b" };
  a.evidenceIds = ["e1"];
  a.relational = computeRelational(a.evidenceIds, evidence);
  b.evidenceIds = ["e2"];
  b.relational = computeRelational(b.evidenceIds, evidence);
  groupTheme(corpus, { name: "T", clusterIds: [a.clusterId, b.clusterId] });

  const res = getThemes(corpus);
  const t = res.themes[0];
  assert.ok(t.relational, "theme summary carries a relational rollup");
  assert.equal(t.relationalApprox, true, "in-band marker: theme distinct* are a MAX-over-members floor");
  assert.equal(t.relational!.occurrences, 2, "sum of members");
  assert.equal(t.relational!.distinctSessions, 1, "max-over-members (each member has 1)");
  assert.equal(t.relational!.firstTs, "2026-01-01T00:00:00Z");
  assert.equal(t.relational!.lastTs, "2026-03-01T00:00:00Z");
  // Privacy: no raw path leaks via get_themes.
  assert.equal(JSON.stringify(res).includes(ABS_PATH_A), false);
});
