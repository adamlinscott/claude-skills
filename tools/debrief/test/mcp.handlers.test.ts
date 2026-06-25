import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getPatterns,
  getEvidence,
  answerOpenQuestion,
  submitAnswer,
  exportRulesFile,
  mergeClusters,
  addAlias,
  recordProtocol,
  UNTRUSTED_CORPUS_NOTICE,
} from "../src/mcp/handlers.ts";
import { resolveOrCreateCluster, getCluster, lookupClusterId, effectiveAnswer } from "../src/corpus/identity.ts";
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
