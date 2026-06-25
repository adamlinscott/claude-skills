import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getPatterns,
  getEvidence,
  getThemeEvidence,
  answerOpenQuestion,
  submitAnswer,
  exportRulesFile,
  mergeClusters,
  addAlias,
  recordProtocol,
  getPendingQuestions,
  skipQuestion,
  groupTheme,
  ungroupTheme,
  getThemes,
  setClusterKind,
  getGroupingTask,
  UNTRUSTED_CORPUS_NOTICE,
} from "../src/mcp/handlers.ts";
import {
  resolveOrCreateCluster,
  getCluster,
  getTheme,
  lookupClusterId,
  effectiveAnswer,
  effectiveThemeAnswer,
} from "../src/corpus/identity.ts";
import { emptyCorpus, emptyEvidenceStore, type Corpus, type EvidenceStore } from "../src/corpus/types.ts";
import type { ReturnInstructions } from "../src/mcp/prompts.ts";

const now = "2026-06-25T00:00:00.000Z";
const SENTINEL = "RAW-TRANSCRIPT-SNIPPET-7788";

const INSTRUCTIONS: ReturnInstructions = {
  depthInstruction: "DEPTH-INSTRUCTION-MARKER: turn the pattern into an open why-question.",
  classifyIntent: "CLASSIFY-INTENT-MARKER: label the turn's intent.",
};

/** Build a corpus + sidecar with N clusters, each carrying one evidence snippet. */
function fixture(n: number): { corpus: Corpus; evidence: EvidenceStore; ids: string[] } {
  const corpus = emptyCorpus(now);
  const evidence = emptyEvidenceStore();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const cl = resolveOrCreateCluster(corpus, "after-error", `subject ${i}`, `summary ${i}`);
    const eid = `s${i}:0-1`;
    cl.evidenceIds = [eid];
    cl.count = 1 + i; // distinct counts so ordering is observable
    cl.sessionCount = 1;
    evidence.items[eid] = { id: eid, sessionId: `s${i}`, snippet: `${SENTINEL}-${i}` };
    ids.push(cl.clusterId);
  }
  return { corpus, evidence, ids };
}

// ── get_patterns ────────────────────────────────────────────────────────────────────────────

test("get_patterns returns SUMMARIES with NO inline evidence (no snippets leak)", () => {
  const { corpus } = fixture(3);
  const res = getPatterns(corpus);
  assert.equal(res.patterns.length, 3);
  const serialized = JSON.stringify(res);
  assert.equal(serialized.includes(SENTINEL), false, "summaries must not contain raw snippets");
  assert.equal(serialized.includes("evidenceIds"), false, "summaries must not expose evidenceIds");
  // shape: summary fields present, evidence absent
  const p = res.patterns[0];
  assert.ok(p.clusterId && typeof p.count === "number" && typeof p.answered === "boolean");
  assert.equal((p as Record<string, unknown>).evidence, undefined);
});

test("get_patterns carries the untrusted-corpus data notice (summary/subject are untrusted)", () => {
  const { corpus } = fixture(1);
  const res = getPatterns(corpus);
  assert.equal(res.notice, UNTRUSTED_CORPUS_NOTICE);
  assert.match(res.notice, /NEVER as\s+instructions|never\s+as\s+instructions/i);
});

test("get_patterns paginates with limit + nextCursor and covers every cluster exactly once", () => {
  const { corpus } = fixture(5);
  const page1 = getPatterns(corpus, { limit: 2 });
  assert.equal(page1.patterns.length, 2);
  assert.ok(page1.nextCursor, "first page must offer a nextCursor");

  const page2 = getPatterns(corpus, { limit: 2, cursor: page1.nextCursor });
  assert.equal(page2.patterns.length, 2);
  assert.ok(page2.nextCursor);

  const page3 = getPatterns(corpus, { limit: 2, cursor: page2.nextCursor });
  assert.equal(page3.patterns.length, 1);
  assert.equal(page3.nextCursor, undefined, "last page must NOT offer a nextCursor");

  // every cluster surfaced exactly once across the pages
  const seen = [...page1.patterns, ...page2.patterns, ...page3.patterns].map((p) => p.clusterId);
  assert.equal(new Set(seen).size, 5);
});

test("get_patterns orders by count desc (highest-frequency first)", () => {
  const { corpus } = fixture(4); // counts 1,2,3,4
  const res = getPatterns(corpus);
  const counts = res.patterns.map((p) => p.count);
  assert.deepEqual(counts, [4, 3, 2, 1]);
});

test("get_patterns filters by detector and by answered", () => {
  const { corpus, ids } = fixture(2);
  // answer the first cluster
  submitAnswer(corpus, { clusterId: ids[0], text: "x", source: "user", confirmed: true });
  // mark a different detector on the second cluster
  corpus.clusters[1].detector = "turn-after-completion";

  const onlyAfterError = getPatterns(corpus, { detector: "after-error" });
  assert.ok(onlyAfterError.patterns.every((p) => p.detector === "after-error"));

  const answered = getPatterns(corpus, { answered: true });
  assert.equal(answered.patterns.length, 1);
  assert.equal(answered.patterns[0].clusterId, ids[0]);

  const unanswered = getPatterns(corpus, { answered: false });
  assert.ok(unanswered.patterns.every((p) => p.answered === false));
});

test("get_patterns minCount applies a minimum-occurrence bar; default behavior is unchanged", () => {
  const { corpus } = fixture(4); // counts 1,2,3,4
  // default (no minCount): all four surface
  assert.equal(getPatterns(corpus).patterns.length, 4);
  // minCount:3 keeps only counts >= 3 (i.e. 3 and 4)
  const filtered = getPatterns(corpus, { minCount: 3 });
  assert.equal(filtered.patterns.length, 2);
  assert.ok(filtered.patterns.every((p) => p.count >= 3));
  // minCount:0 is a no-op bar (still all four)
  assert.equal(getPatterns(corpus, { minCount: 0 }).patterns.length, 4);
});

test("get_patterns surfaces the merged flag for agent-merged clusters", () => {
  const { corpus } = fixture(2);
  corpus.clusters[0].merged = true;
  const res = getPatterns(corpus);
  const merged = res.patterns.find((p) => p.clusterId === corpus.clusters[0].clusterId)!;
  const raw = res.patterns.find((p) => p.clusterId === corpus.clusters[1].clusterId)!;
  assert.equal(merged.merged, true, "merged cluster reports merged:true");
  assert.equal(raw.merged, undefined, "raw cluster omits the merged flag");
});

// ── get_evidence ────────────────────────────────────────────────────────────────────────────

test("get_evidence delimits each snippet and labels it untrusted data", () => {
  const { corpus, evidence, ids } = fixture(1);
  const bundle = getEvidence(corpus, evidence, ids[0])!;
  assert.ok(bundle);
  assert.equal(bundle.snippets.length, 1);
  assert.ok(bundle.snippets[0].wrapped.includes(bundle.nonce), "delimiter must carry the per-call nonce");
  assert.match(bundle.snippets[0].wrapped, /UNTRUSTED-EVIDENCE/);
  assert.match(bundle.snippets[0].wrapped, /END-UNTRUSTED-EVIDENCE/);
  assert.match(bundle.notice, /not instructions/i);
  assert.ok(bundle.snippets[0].wrapped.includes(`${SENTINEL}-0`), "snippet content still present (delimited)");
});

test("get_evidence returns undefined for an unknown cluster", () => {
  const { corpus, evidence } = fixture(1);
  assert.equal(getEvidence(corpus, evidence, "nope"), undefined);
});

// ── answer_open_question (RETURN-INSTRUCTION) ─────────────────────────────────────────────────

test("answer_open_question returns the loaded depth instruction and does NOT resolve by default", () => {
  const { corpus, evidence, ids } = fixture(1);
  const res = answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId: ids[0] })!;
  assert.ok(res);
  assert.equal(res.mode, "none", "default mode is no-auto-resolution");
  assert.equal(res.status, "ready");
  // it returns the runtime-loaded instruction text...
  assert.equal(res.depthInstruction, INSTRUCTIONS.depthInstruction);
  assert.equal(res.classifyIntent, INSTRUCTIONS.classifyIntent);
  // ...and the evidence bundle for the agent to reason over...
  assert.ok(res.evidence && res.evidence.snippets.length === 1);
  // ...but it does NOT itself produce an answer (no auto-resolution): the corpus stays answer-free.
  assert.equal(corpus.clusters[0].answers.length, 0, "the tool must not write an answer itself");
  assert.match(res.instruction, /did NOT/i);
});

test("answer_open_question mode:user forwards (pending-user) WITH evidence to regenerate the question", () => {
  const { corpus, evidence, ids } = fixture(1);
  const res = answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId: ids[0], mode: "user" })!;
  assert.equal(res.status, "pending-user");
  assert.equal(corpus.clusters[0].answers.length, 0);
  assert.match(res.instruction, /FORWARDED TO USER/);
  // The forward must be actionable on its own: it carries the depth instruction + the delimited
  // evidence so the agent can compose the (never-persisted) question and surface it.
  assert.equal(res.depthInstruction, INSTRUCTIONS.depthInstruction);
  assert.ok(res.evidence && res.evidence.snippets.length === 1, "pending-user must include the evidence bundle");
  assert.match(res.evidence.snippets[0].wrapped, /UNTRUSTED-EVIDENCE/);
});

test("answer_open_question mode:self still returns instruction and does not auto-answer", () => {
  const { corpus, evidence, ids } = fixture(1);
  const res = answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId: ids[0], mode: "self" })!;
  assert.equal(res.status, "ready");
  assert.equal(res.depthInstruction, INSTRUCTIONS.depthInstruction);
  assert.equal(corpus.clusters[0].answers.length, 0, "even mode:self must not auto-write an answer");
});

test("answer_open_question returns undefined for an unknown cluster", () => {
  const { corpus, evidence } = fixture(1);
  assert.equal(answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId: "nope" }), undefined);
});

test("answer_open_question threads standing protocols into the result and parameterizes the instruction", () => {
  const { corpus, evidence, ids } = fixture(1);
  // empty by default
  const before = answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId: ids[0] })!;
  assert.deepEqual(before.standingProtocols, []);
  assert.equal(/standingProtocols/.test(before.instruction), false, "no protocol nudge when none exist");

  // add a standing protocol via the write path
  recordProtocol(corpus, { statement: "re-verifies AI output against the running system", confidence: 0.8, contradicts: ["accepted a mock once"] }, now);
  const after = answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId: ids[0] })!;
  assert.equal(after.standingProtocols.length, 1);
  assert.equal(after.standingProtocols[0].hypothesis, "re-verifies AI output against the running system");
  assert.match(after.instruction, /standingProtocols|standing hypotheses/i);
});

// ── submit_answer (write-poisoning guard) ─────────────────────────────────────────────────────

test("submit_answer REJECTS silent source:user — downgrades to inferred without confirmation", () => {
  const { corpus, ids } = fixture(1);
  const res = submitAnswer(corpus, { clusterId: ids[0], text: "poison", source: "user" }); // no confirmed
  assert.equal(res.source, "inferred", "source:user without confirmed must be recorded as inferred");
  assert.equal(corpus.clusters[0].answers[0].source, "inferred");
});

test("submit_answer records source:user ONLY with source:user + confirmed:true", () => {
  const { corpus, ids } = fixture(1);
  const res = submitAnswer(corpus, { clusterId: ids[0], text: "ground truth", source: "user", confirmed: true });
  assert.equal(res.source, "user");
  assert.equal(corpus.clusters[0].answers[0].source, "user");
});

test("submit_answer with confirmed:true but no source:user does NOT escalate to user", () => {
  const { corpus, ids } = fixture(1);
  // confirmed alone, source omitted/inferred, must not become user ground truth
  const res = submitAnswer(corpus, { clusterId: ids[0], text: "x", confirmed: true });
  assert.equal(res.source, "inferred");
});

test("submit_answer throws for an unknown cluster (no phantom answers)", () => {
  const { corpus } = fixture(1);
  assert.throws(() => submitAnswer(corpus, { clusterId: "nope", text: "x" }), /no cluster/);
});

// ── export_rules_file ─────────────────────────────────────────────────────────────────────────

test("export_rules_file returns evidence-free patterns + answers + a synthesis instruction", () => {
  const { corpus, ids } = fixture(2);
  submitAnswer(corpus, { clusterId: ids[0], text: "principle here", source: "user", confirmed: true });
  const res = exportRulesFile(corpus);
  assert.equal(res.patterns.length, 2);
  assert.equal(res.answers.length, 1);
  assert.equal(res.answers[0].clusterId, ids[0]);
  assert.equal(JSON.stringify(res).includes(SENTINEL), false, "export must not contain raw snippets");
  assert.match(res.instruction, /you write the file|generates nothing/i);
  // The export surface returns untrusted corpus free text (summaries + answers): notice present.
  assert.equal(res.notice, UNTRUSTED_CORPUS_NOTICE);
});

// ── merge_clusters / add_alias (agent semantic merge) ─────────────────────────────────────────

test("merge_clusters absorbs one cluster into another, preserves answers, recomputes counts", () => {
  const { corpus, evidence, ids } = fixture(2); // counts 1 and 2, sessions s0 / s1
  getCluster(corpus, ids[0])!.answers.push({ source: "user", text: "ground truth", ts: now });
  getCluster(corpus, ids[1])!.answers.push({ source: "inferred", text: "guess", ts: now });

  const res = mergeClusters(corpus, evidence, { fromClusterId: ids[0], intoClusterId: ids[1] });
  assert.equal(getCluster(corpus, ids[0]), undefined, "from-cluster removed");
  const into = getCluster(corpus, ids[1])!;
  assert.equal(into.merged, true);
  assert.equal(into.count, 2, "union of two distinct evidence ids");
  assert.equal(into.sessionCount, 2, "two distinct sessions");
  // user answer outranks inferred after the merge
  assert.equal(effectiveAnswer(into)!.source, "user");
  assert.equal(res.answersMoved, 1);
});

test("merge_clusters throws on unknown clusterId", () => {
  const { corpus, evidence, ids } = fixture(1);
  assert.throws(() => mergeClusters(corpus, evidence, { fromClusterId: "nope", intoClusterId: ids[0] }), /no fromClusterId/);
});

test("add_alias points a new subject at an existing cluster (detector inherited)", () => {
  const { corpus, ids } = fixture(1);
  const detector = corpus.clusters[0].detector;
  const res = addAlias(corpus, { normalizedSubject: "semantically equivalent subject", clusterId: ids[0] });
  assert.equal(res.detector, detector);
  assert.equal(lookupClusterId(corpus, detector, "semantically equivalent subject"), ids[0]);
});

test("add_alias throws on unknown clusterId (poisoning guard)", () => {
  const { corpus } = fixture(1);
  assert.throws(() => addAlias(corpus, { normalizedSubject: "x", clusterId: "nope" }), /no cluster/);
});

// ── record_protocol (standing-protocol write path) ────────────────────────────────────────────

test("record_protocol appends a new protocol and clamps confidence", () => {
  const corpus = emptyCorpus(now);
  const res = recordProtocol(corpus, { statement: "prefers descriptive identifiers", confidence: 1.5, contradicts: ["named a var x once"] }, now);
  assert.equal(res.status, "created");
  assert.equal(corpus.protocols.length, 1);
  assert.equal(corpus.protocols[0].hypothesis, "prefers descriptive identifiers");
  assert.equal(corpus.protocols[0].confidence, 1, "confidence clamped to [0,1]");
  assert.deepEqual(corpus.protocols[0].openContradictions, ["named a var x once"]);
});

test("record_protocol updates an existing protocol by protocolId (no duplicate)", () => {
  const corpus = emptyCorpus(now);
  const created = recordProtocol(corpus, { statement: "v1", confidence: 0.5 }, now);
  const updated = recordProtocol(corpus, { statement: "v2 refined", confidence: 0.9, protocolId: created.protocolId }, now);
  assert.equal(updated.status, "updated");
  assert.equal(corpus.protocols.length, 1, "update must not append a duplicate");
  assert.equal(corpus.protocols[0].hypothesis, "v2 refined");
  assert.equal(corpus.protocols[0].confidence, 0.9);
});

// ── pending-question lifecycle ────────────────────────────────────────────────────────────────

test("answer_open_question mode:user MARKS the cluster pending (forwardedAt set, skipCount 0)", () => {
  const { corpus, evidence, ids } = fixture(1);
  assert.equal(corpus.clusters[0].pending, undefined, "not pending before forward");
  const res = answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId: ids[0], mode: "user" }, now)!;
  assert.equal(res.status, "pending-user");
  assert.ok(res.pending, "result echoes the pending record");
  assert.equal(res.pending!.forwardedAt, now);
  assert.equal(res.pending!.skipCount, 0);
  // it actually mutated the cluster
  assert.ok(corpus.clusters[0].pending, "cluster marked pending");
  assert.equal(corpus.clusters[0].pending!.forwardedAt, now);
});

test("re-forwarding does NOT reset forwardedAt or skipCount (idempotent on re-forward)", () => {
  const { corpus, evidence, ids } = fixture(1);
  answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId: ids[0], mode: "user" }, "2026-01-01T00:00:00.000Z");
  skipQuestion(corpus, { clusterId: ids[0] }, now); // skipCount -> 1
  const later = answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId: ids[0], mode: "user" }, "2026-12-31T00:00:00.000Z")!;
  assert.equal(later.pending!.forwardedAt, "2026-01-01T00:00:00.000Z", "forwardedAt preserved");
  assert.equal(later.pending!.skipCount, 1, "skipCount preserved (no reset/undo of demotion progress)");
});

test("submit_answer with confirmed source:user CLEARS pending; inferred does NOT", () => {
  const { corpus, evidence, ids } = fixture(2);
  answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId: ids[0], mode: "user" }, now);
  answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId: ids[1], mode: "user" }, now);

  // an INFERRED answer must not resolve the forwarded question
  submitAnswer(corpus, { clusterId: ids[1], text: "guess" });
  assert.ok(corpus.clusters[1].pending, "inferred answer leaves pending intact");

  // a confirmed USER answer resolves it
  submitAnswer(corpus, { clusterId: ids[0], text: "real", source: "user", confirmed: true });
  assert.equal(corpus.clusters[0].pending, undefined, "confirmed user answer clears pending");
});

test("get_pending_questions returns oldest-first and caps at N (default 5)", () => {
  const { corpus, evidence, ids } = fixture(7);
  // forward all 7, with increasing forwardedAt so order is observable (i=0 oldest)
  for (let i = 0; i < 7; i++) {
    const ts = `2026-06-2${i}T00:00:00.000Z`;
    answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId: ids[i], mode: "user" }, ts);
  }
  const res = getPendingQuestions(corpus);
  assert.equal(res.totalPending, 7, "all 7 are pending");
  assert.equal(res.pending.length, 5, "capped at N=5 per call");
  // oldest-first: the first five are ids[0..4] in order
  assert.deepEqual(res.pending.map((p) => p.clusterId), ids.slice(0, 5));
  // explicit smaller limit honored
  assert.equal(getPendingQuestions(corpus, { limit: 2 }).pending.length, 2);
});

test("get_pending_questions DEMOTES a question skipped K (3) times: it sorts after non-demoted", () => {
  const { corpus, evidence, ids } = fixture(2);
  // ids[0] is OLDER (would normally sort first)...
  answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId: ids[0], mode: "user" }, "2026-01-01T00:00:00.000Z");
  answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId: ids[1], mode: "user" }, "2026-02-01T00:00:00.000Z");

  // skip the older one to the demote threshold K=3
  skipQuestion(corpus, { clusterId: ids[0] }, now);
  skipQuestion(corpus, { clusterId: ids[0] }, now);
  const third = skipQuestion(corpus, { clusterId: ids[0] }, now);
  assert.equal(third.skipCount, 3);
  assert.equal(third.demoted, true, "K=3 skips marks it demoted");

  const res = getPendingQuestions(corpus);
  // even though ids[0] is older, being demoted pushes it AFTER the non-demoted ids[1]
  assert.deepEqual(res.pending.map((p) => p.clusterId), [ids[1], ids[0]]);
  assert.equal(res.pending[0].demoted, false);
  assert.equal(res.pending[1].demoted, true);
});

test("get_pending_questions is evidence-free (no snippets leak)", () => {
  const { corpus, evidence, ids } = fixture(1);
  answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId: ids[0], mode: "user" }, now);
  const res = getPendingQuestions(corpus);
  assert.equal(JSON.stringify(res).includes(SENTINEL), false, "pending list must not contain raw snippets");
  assert.equal(res.notice, UNTRUSTED_CORPUS_NOTICE);
});

test("skip_question throws for unknown and for not-pending clusters", () => {
  const { corpus, ids } = fixture(1);
  assert.throws(() => skipQuestion(corpus, { clusterId: "nope" }), /no cluster/);
  assert.throws(() => skipQuestion(corpus, { clusterId: ids[0] }), /not pending/);
});

// ── inferred-only review (answeredBy filter) ──────────────────────────────────────────────────

test("get_patterns answeredBy filter partitions user / inferred-only / none", () => {
  const { corpus, ids } = fixture(3);
  // ids[0] -> user (outranks); ids[1] -> inferred only; ids[2] -> no answer
  submitAnswer(corpus, { clusterId: ids[0], text: "u", source: "user", confirmed: true });
  submitAnswer(corpus, { clusterId: ids[1], text: "i" }); // inferred

  const inferredOnly = getPatterns(corpus, { answeredBy: "inferred" });
  assert.deepEqual(inferredOnly.patterns.map((p) => p.clusterId), [ids[1]]);
  assert.equal(inferredOnly.patterns[0].answerSource, "inferred");

  const userGrounded = getPatterns(corpus, { answeredBy: "user" });
  assert.deepEqual(userGrounded.patterns.map((p) => p.clusterId), [ids[0]]);

  const none = getPatterns(corpus, { answeredBy: "none" });
  assert.deepEqual(none.patterns.map((p) => p.clusterId), [ids[2]]);
});

test("get_patterns answeredBy:'inferred' EXCLUDES a cluster once it has a user answer (re-confirmed)", () => {
  const { corpus, ids } = fixture(1);
  submitAnswer(corpus, { clusterId: ids[0], text: "i" }); // inferred only -> listed
  assert.equal(getPatterns(corpus, { answeredBy: "inferred" }).patterns.length, 1);
  // user re-confirms -> user outranks inferred -> no longer inferred-only
  submitAnswer(corpus, { clusterId: ids[0], text: "confirmed", source: "user", confirmed: true });
  assert.equal(getPatterns(corpus, { answeredBy: "inferred" }).patterns.length, 0, "now user-grounded, not inferred-only");
});

test("get_patterns surfaces a pending flag for forwarded clusters", () => {
  const { corpus, evidence, ids } = fixture(2);
  answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId: ids[0], mode: "user" }, now);
  const res = getPatterns(corpus);
  const p0 = res.patterns.find((p) => p.clusterId === ids[0])!;
  const p1 = res.patterns.find((p) => p.clusterId === ids[1])!;
  assert.equal(p0.pending, true, "forwarded cluster reports pending:true");
  assert.equal(p1.pending, undefined, "non-forwarded cluster omits the pending flag");
});

// ── get_patterns surfacing order (firstSeen tiebreak) ─────────────────────────────────────────

test("get_patterns oldest-first (firstSeen) tiebreak among equal-count clusters", () => {
  const corpus = emptyCorpus(now);
  // three clusters, SAME count, distinct firstSeen out of clusterId order
  const a = resolveOrCreateCluster(corpus, "after-error", "a", "sa", "2026-03-01T00:00:00.000Z");
  const b = resolveOrCreateCluster(corpus, "after-error", "b", "sb", "2026-01-01T00:00:00.000Z");
  const c = resolveOrCreateCluster(corpus, "after-error", "c", "sc", "2026-02-01T00:00:00.000Z");
  for (const cl of [a, b, c]) cl.count = 5;
  const res = getPatterns(corpus);
  // equal count -> oldest firstSeen first: b (Jan) < c (Feb) < a (Mar)
  assert.deepEqual(res.patterns.map((p) => p.clusterId), [b.clusterId, c.clusterId, a.clusterId]);
});

test("get_patterns orders unanswered before answered within equal count", () => {
  const corpus = emptyCorpus(now);
  const a = resolveOrCreateCluster(corpus, "after-error", "a", "sa", "2026-01-01T00:00:00.000Z");
  const b = resolveOrCreateCluster(corpus, "after-error", "b", "sb", "2026-02-01T00:00:00.000Z");
  a.count = 5;
  b.count = 5;
  // answer the OLDER one (a). Despite being older, an answered cluster sorts after an unanswered one.
  submitAnswer(corpus, { clusterId: a.clusterId, text: "x", source: "user", confirmed: true });
  const res = getPatterns(corpus);
  assert.deepEqual(res.patterns.map((p) => p.clusterId), [b.clusterId, a.clusterId]);
});

// ── TIER 2: group_theme / get_themes (handlers) ───────────────────────────────────────────────

test("group_theme creates a theme (non-destructive) and extends an existing one by name", () => {
  const { corpus, ids } = fixture(3);
  const created = groupTheme(corpus, { name: "code tells the truth", clusterIds: [ids[0], ids[1]] }, now);
  assert.equal(created.status, "created");
  assert.deepEqual(created.memberClusterIds, [ids[0], ids[1]]);
  assert.equal(created.added, 2);
  // member clusters are untouched (not fused/removed)
  assert.equal(corpus.clusters.length, 3);

  // extend the SAME-named theme with a new member (and a duplicate, which is idempotent)
  const extended = groupTheme(corpus, { name: "code tells the truth", clusterIds: [ids[2], ids[0]] }, now);
  assert.equal(extended.status, "extended");
  assert.equal(extended.themeId, created.themeId, "extend reuses the same theme, no duplicate");
  assert.equal(extended.added, 1, "only ids[2] is newly added; ids[0] was already a member");
  assert.equal(corpus.themes.length, 1);
  assert.deepEqual(getTheme(corpus, created.themeId)!.memberClusterIds, [ids[0], ids[1], ids[2]]);
});

test("group_theme refuses a non-existent clusterId (poisoning guard)", () => {
  const { corpus } = fixture(1);
  assert.throws(() => groupTheme(corpus, { name: "x", clusterIds: ["nope"] }), /non-existent clusterId/);
});

test("get_themes returns EVIDENCE-FREE summaries (name, memberCount, answered?, pending?)", () => {
  const { corpus, ids } = fixture(2);
  const t = groupTheme(corpus, { name: "t", clusterIds: [ids[0], ids[1]] }, now);
  const res = getThemes(corpus);
  assert.equal(res.themes.length, 1);
  const summary = res.themes[0];
  assert.equal(summary.themeId, t.themeId);
  assert.equal(summary.name, "t");
  assert.equal(summary.memberCount, 2);
  assert.equal(summary.answered, false);
  assert.equal(summary.pending, undefined);
  // SENTINEL leak test: theme summaries carry no raw snippets, and no member-cluster evidenceIds
  assert.equal(JSON.stringify(res).includes(SENTINEL), false, "theme summaries must not contain raw snippets");
  assert.equal(JSON.stringify(res).includes("evidenceIds"), false);
  assert.equal(res.notice, UNTRUSTED_CORPUS_NOTICE);
});

test("get_themes reports answered + answerSource (user outranks) and pending", () => {
  const { corpus, evidence, ids } = fixture(1);
  const t = groupTheme(corpus, { name: "t", clusterIds: [ids[0]] }, now);
  submitAnswer(corpus, { themeId: t.themeId, text: "inferred guess" }); // inferred
  submitAnswer(corpus, { themeId: t.themeId, text: "user truth", source: "user", confirmed: true });
  // forward a (different) theme to mark pending
  const t2 = groupTheme(corpus, { name: "t2", clusterIds: [ids[0]] }, now);
  answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { themeId: t2.themeId, mode: "user" }, now);

  const res = getThemes(corpus);
  const s1 = res.themes.find((x) => x.themeId === t.themeId)!;
  const s2 = res.themes.find((x) => x.themeId === t2.themeId)!;
  assert.equal(s1.answered, true);
  assert.equal(s1.answerSource, "user", "user outranks inferred");
  assert.equal(s2.pending, true);
});

test("get_themes paginates with limit + nextCursor covering each theme once", () => {
  const { corpus, ids } = fixture(1);
  for (let i = 0; i < 5; i++) groupTheme(corpus, { name: `theme-${i}`, clusterIds: [ids[0]] }, `2026-06-2${i}T00:00:00.000Z`);
  const p1 = getThemes(corpus, { limit: 2 });
  assert.equal(p1.themes.length, 2);
  const p2 = getThemes(corpus, { limit: 2, cursor: p1.nextCursor });
  const p3 = getThemes(corpus, { limit: 2, cursor: p2.nextCursor });
  assert.equal(p3.nextCursor, undefined);
  const seen = [...p1.themes, ...p2.themes, ...p3.themes].map((t) => t.themeId);
  assert.equal(new Set(seen).size, 5);
});

// ── TIER 2: answer_open_question(themeId) + theme evidence ─────────────────────────────────────

test("answer_open_question on a themeId returns the depth instruction + AGGREGATED evidence and does NOT auto-resolve", () => {
  const { corpus, evidence, ids } = fixture(2);
  const t = groupTheme(corpus, { name: "broad theme", clusterIds: [ids[0], ids[1]] }, now);
  const res = answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { themeId: t.themeId })!;
  assert.ok(res);
  assert.equal(res.target, "theme");
  assert.equal(res.themeId, t.themeId);
  assert.equal(res.status, "ready");
  assert.equal(res.depthInstruction, INSTRUCTIONS.depthInstruction);
  // aggregated theme evidence across the two member clusters, with the member topics as context
  assert.ok(res.themeEvidence, "theme path returns aggregated theme evidence");
  assert.equal(res.themeEvidence!.members.length, 2);
  assert.equal(res.themeEvidence!.memberTopics.length, 2);
  // delimited untrusted snippets present (sentinel inside, but wrapped)
  const flat = JSON.stringify(res.themeEvidence);
  assert.match(flat, /UNTRUSTED-EVIDENCE/);
  assert.ok(flat.includes(SENTINEL), "member snippets are present (delimited)");
  // does NOT auto-resolve: no theme answer written, theme not pending
  assert.equal(getTheme(corpus, t.themeId)!.answers.length, 0, "the tool must not write a theme answer itself");
  assert.equal(getTheme(corpus, t.themeId)!.pending, undefined);
});

test("answer_open_question themeId mode:user MARKS the theme pending (forwarded)", () => {
  const { corpus, evidence, ids } = fixture(1);
  const t = groupTheme(corpus, { name: "t", clusterIds: [ids[0]] }, now);
  const res = answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { themeId: t.themeId, mode: "user" }, now)!;
  assert.equal(res.status, "pending-user");
  assert.equal(res.target, "theme");
  assert.ok(res.pending && res.pending.forwardedAt === now);
  assert.ok(getTheme(corpus, t.themeId)!.pending, "theme marked pending");
});

test("answer_open_question returns undefined for an unknown themeId", () => {
  const { corpus, evidence } = fixture(1);
  assert.equal(answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { themeId: "nope" }), undefined);
});

test("getThemeEvidence aggregates representative evidence across member clusters; undefined for unknown", () => {
  const { corpus, evidence, ids } = fixture(2);
  const t = groupTheme(corpus, { name: "t", clusterIds: [ids[0], ids[1]] }, now);
  const bundle = getThemeEvidence(corpus, evidence, t.themeId)!;
  assert.equal(bundle.members.length, 2);
  assert.ok(bundle.members.every((m) => m.snippets.every((s) => s.wrapped.includes(bundle.nonce))), "shared nonce across members");
  assert.equal(getThemeEvidence(corpus, evidence, "nope"), undefined);
});

// ── TIER 2: theme answers + pending + skip (handlers) ─────────────────────────────────────────

test("submit_answer on a themeId honors the user-confirmation guard and clears theme pending", () => {
  const { corpus, evidence, ids } = fixture(1);
  const t = groupTheme(corpus, { name: "t", clusterIds: [ids[0]] }, now);
  answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { themeId: t.themeId, mode: "user" }, now);

  // source:user WITHOUT confirmed -> downgraded to inferred; does NOT clear pending
  const r1 = submitAnswer(corpus, { themeId: t.themeId, text: "poison", source: "user" });
  assert.equal(r1.source, "inferred");
  assert.ok(getTheme(corpus, t.themeId)!.pending, "inferred theme answer leaves pending intact");

  // confirmed user answer -> user ground truth, CLEARS pending
  const r2 = submitAnswer(corpus, { themeId: t.themeId, text: "truth", source: "user", confirmed: true });
  assert.equal(r2.source, "user");
  assert.equal(getTheme(corpus, t.themeId)!.pending, undefined, "confirmed user theme answer clears pending");
  assert.equal(effectiveThemeAnswer(getTheme(corpus, t.themeId)!)!.source, "user");
});

test("submit_answer throws for an unknown themeId (no phantom theme answers)", () => {
  const { corpus } = fixture(1);
  assert.throws(() => submitAnswer(corpus, { themeId: "nope", text: "x" }), /no theme/);
});

test("get_pending_questions surfaces pending THEMES (oldest-first, evidence-free) alongside clusters", () => {
  const { corpus, evidence, ids } = fixture(1);
  const t1 = groupTheme(corpus, { name: "t1", clusterIds: [ids[0]] }, now);
  const t2 = groupTheme(corpus, { name: "t2", clusterIds: [ids[0]] }, now);
  answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { themeId: t1.themeId, mode: "user" }, "2026-02-01T00:00:00.000Z");
  answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { themeId: t2.themeId, mode: "user" }, "2026-01-01T00:00:00.000Z");
  // also forward the cluster so both lists are populated
  answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { clusterId: ids[0], mode: "user" }, now);

  const res = getPendingQuestions(corpus);
  assert.equal(res.totalPending, 1, "one pending cluster");
  assert.equal(res.totalPendingThemes, 2, "two pending themes");
  // themes oldest-first by forwardedAt: t2 (Jan) before t1 (Feb)
  assert.deepEqual(res.pendingThemes.map((p) => p.themeId), [t2.themeId, t1.themeId]);
  assert.equal(res.pendingThemes[0].name, "t2");
  assert.equal(res.pendingThemes[0].memberCount, 1);
  assert.equal(JSON.stringify(res).includes(SENTINEL), false, "pending themes are evidence-free");
});

test("skip_question on a themeId increments + demotes (parallels clusters)", () => {
  const { corpus, evidence, ids } = fixture(1);
  const t = groupTheme(corpus, { name: "t", clusterIds: [ids[0]] }, now);
  answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { themeId: t.themeId, mode: "user" }, now);
  const s1 = skipQuestion(corpus, { themeId: t.themeId }, now);
  assert.equal(s1.themeId, t.themeId);
  assert.equal(s1.skipCount, 1);
  skipQuestion(corpus, { themeId: t.themeId }, now);
  const s3 = skipQuestion(corpus, { themeId: t.themeId }, now);
  assert.equal(s3.demoted, true);
  // unknown / not-pending theme
  assert.throws(() => skipQuestion(corpus, { themeId: "nope" }), /no theme/);
});

test("cross-session persistence: a theme answer + pending survive serialize/load round-trip", async () => {
  // (deferred to corpus.store.test.ts for the actual disk round-trip; here we assert the in-memory
  // theme state is well-formed and answer-bearing so the store test has a valid shape to persist.)
  const { corpus, evidence, ids } = fixture(1);
  const t = groupTheme(corpus, { name: "t", clusterIds: [ids[0]] }, now);
  answerOpenQuestion(corpus, evidence, INSTRUCTIONS, { themeId: t.themeId, mode: "user" }, now);
  submitAnswer(corpus, { themeId: t.themeId, text: "inferred", source: "inferred" });
  const live = getTheme(corpus, t.themeId)!;
  assert.equal(live.answers.length, 1);
  assert.ok(live.pending);
});

// ── set_cluster_kind (R/O/C/Q/X tagging) ──────────────────────────────────────────────────────

test("set_cluster_kind writes primary + optional secondary; validates the codes", () => {
  const { corpus, ids } = fixture(1);
  const res = setClusterKind(corpus, { clusterId: ids[0], primary: "C", secondary: "O" });
  assert.equal(res.primaryKind, "C");
  assert.equal(res.secondaryKind, "O");
  assert.equal(getCluster(corpus, ids[0])!.primaryKind, "C");
  assert.equal(getCluster(corpus, ids[0])!.secondaryKind, "O");
  // re-tag WITHOUT a secondary clears the prior secondary
  setClusterKind(corpus, { clusterId: ids[0], primary: "R" });
  assert.equal(getCluster(corpus, ids[0])!.primaryKind, "R");
  assert.equal(getCluster(corpus, ids[0])!.secondaryKind, undefined);
  // invalid codes + unknown cluster throw
  assert.throws(() => setClusterKind(corpus, { clusterId: ids[0], primary: "Z" as never }), /invalid primary kind/);
  assert.throws(() => setClusterKind(corpus, { clusterId: ids[0], primary: "C", secondary: "Z" as never }), /invalid secondary/);
  assert.throws(() => setClusterKind(corpus, { clusterId: "nope", primary: "C" }), /no cluster/);
});

test("get_patterns surfaces the kind once tagged (absent until tagged)", () => {
  const { corpus, ids } = fixture(2);
  setClusterKind(corpus, { clusterId: ids[0], primary: "O", secondary: "C" });
  const res = getPatterns(corpus);
  const tagged = res.patterns.find((p) => p.clusterId === ids[0])!;
  const untagged = res.patterns.find((p) => p.clusterId === ids[1])!;
  assert.equal(tagged.primaryKind, "O");
  assert.equal(tagged.secondaryKind, "C");
  assert.equal(untagged.primaryKind, undefined, "untagged cluster omits kind");
});

// ── get_grouping_task (the tidy-up surface) ───────────────────────────────────────────────────

test("get_grouping_task returns the group-themes instruction + evidence-free cluster & theme summaries", () => {
  const { corpus, ids } = fixture(2);
  groupTheme(corpus, { name: "existing", clusterIds: [ids[0]] }, now);
  const GROUP_INSTRUCTION = "GROUP-THEMES-MARKER: fuse duplicates and form themes.";
  const res = getGroupingTask(corpus, GROUP_INSTRUCTION);
  assert.equal(res.groupThemesInstruction, GROUP_INSTRUCTION);
  assert.equal(res.clusters.length, 2);
  assert.equal(res.themes.length, 1);
  assert.match(res.instruction, /merge_clusters|group_theme/);
  // evidence-free: no raw snippets, no evidenceIds
  assert.equal(JSON.stringify(res).includes(SENTINEL), false, "grouping task must not contain raw snippets");
  assert.equal(JSON.stringify(res).includes("evidenceIds"), false);
  assert.equal(res.notice, UNTRUSTED_CORPUS_NOTICE);
});

test("get_grouping_task reports totals + cursors so a >100-cluster set is not silently truncated", () => {
  // A heavy user: 120 clusters exceeds the MAX_LIMIT (100) cap, so the page is PARTIAL and the
  // agent must learn that (totalClusters) and be able to page on (clustersCursor) — otherwise it
  // can never fuse true-duplicate clusters beyond the first 100.
  const { corpus } = fixture(120);
  const res = getGroupingTask(corpus, "instr");
  assert.equal(res.clusters.length, 100, "capped at MAX_LIMIT");
  assert.equal(res.totalClusters, 120, "reports the FULL count, not just the page");
  assert.equal(res.totalThemes, 0);
  assert.ok(res.clustersCursor, "offers a cursor when more clusters remain");
  // page the rest with the cursor and confirm the remainder appears.
  const page2 = getGroupingTask(corpus, "instr", { clustersCursor: res.clustersCursor });
  assert.equal(page2.clusters.length, 20, "the remaining 20 clusters surface on the next page");
  assert.equal(page2.clustersCursor, undefined, "no cursor once the set is exhausted");
  // small corpus: no cursor, totals match the page
  const small = getGroupingTask(fixture(2).corpus, "instr");
  assert.equal(small.totalClusters, 2);
  assert.equal(small.clustersCursor, undefined);
});

// ── ungroup_theme (the reversible "regroup freely" Tier-2 path) ────────────────────────────────

test("ungroup_theme removes members non-destructively and is the reverse of group_theme", () => {
  const { corpus, ids } = fixture(2);
  // give a cluster a user answer so we can prove ungrouping loses no cluster data
  submitAnswer(corpus, { clusterId: ids[0], text: "keep", source: "user", confirmed: true });
  const t = groupTheme(corpus, { name: "broad", clusterIds: [ids[0], ids[1]] }, now);

  const res = ungroupTheme(corpus, { themeId: t.themeId, clusterIds: [ids[0]] }, now);
  assert.equal(res.removed, 1);
  assert.deepEqual(res.memberClusterIds, [ids[1]], "only the named member dropped");
  // the cluster + its answer survive (themes are an overlay, not ownership)
  assert.equal(getCluster(corpus, ids[0])!.answers.length, 1, "ungrouping loses no cluster data");
  // removing a non-member is a no-op (idempotent); unknown theme throws
  const noop = ungroupTheme(corpus, { themeId: t.themeId, clusterIds: [ids[0]] }, now);
  assert.equal(noop.removed, 0);
  assert.throws(() => ungroupTheme(corpus, { themeId: "nope", clusterIds: [ids[1]] }, now), /no theme/);
});

test("ungroup_theme + group_theme MOVES a cluster between themes with no data loss", () => {
  const { corpus, ids } = fixture(1);
  const tA = groupTheme(corpus, { name: "A", clusterIds: [ids[0]] }, now);
  const tB = groupTheme(corpus, { name: "B", clusterIds: [] as string[] }, now);
  // move: ungroup from A, group into B
  ungroupTheme(corpus, { themeId: tA.themeId, clusterIds: [ids[0]] }, now);
  groupTheme(corpus, { name: "B", clusterIds: [ids[0]] }, now);
  assert.deepEqual(getTheme(corpus, tA.themeId)!.memberClusterIds, [], "left theme A");
  assert.deepEqual(getTheme(corpus, tB.themeId)!.memberClusterIds, [ids[0]], "joined theme B");
});

// ── dual-target contract guard (clusterId OR themeId, never both) ─────────────────────────────

test("dual-target handlers reject BOTH clusterId AND themeId instead of silently picking the theme", () => {
  const { corpus, evidence, ids } = fixture(1);
  const t = groupTheme(corpus, { name: "t", clusterIds: [ids[0]] }, now);
  const both = { clusterId: ids[0], themeId: t.themeId };
  assert.throws(() => answerOpenQuestion(corpus, evidence, INSTRUCTIONS, both), /not both/);
  assert.throws(() => submitAnswer(corpus, { ...both, text: "x" }), /not both/);
  // skip requires a pending target; the guard must fire BEFORE that check
  assert.throws(() => skipQuestion(corpus, both), /not both/);
});
