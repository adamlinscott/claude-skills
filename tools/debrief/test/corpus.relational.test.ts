import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeRelational,
  aggregateThemeRelational,
  rollupThemeRelationalFromMembers,
  relationalTimeline,
  themeRelationalTimeline,
  resolveOrCreateCluster,
  mergeClusters,
  splitAlias,
  createTheme,
  getCluster,
  coarseSubject,
  MAX_SUBJECT_TOKENS,
} from "../src/corpus/identity.ts";
import { mergeCandidates } from "../src/corpus/merge.ts";
import { serializeCorpus } from "../src/corpus/store.ts";
import {
  emptyCorpus,
  emptyEvidenceStore,
  type Corpus,
  type EvidenceStore,
  type EvidenceItem,
} from "../src/corpus/types.ts";

const now = "2026-06-25T00:00:00.000Z";

// Privacy-sensitive raw values that MUST stay in the sidecar and NEVER reach the hot file.
const ABS_PATH_A = "C:/Users/adamr/Projects/alpha";
const ABS_PATH_B = "C:/Users/adamr/Projects/beta";
const BRANCH_A = "feature/secret-ticket-123";
const BRANCH_B = "main";

function ev(
  partial: Partial<EvidenceItem> & { id: string; sessionId: string },
): EvidenceItem {
  return { snippet: "snip", ...partial };
}

// ── computeRelational: counts + timestamps ─────────────────────────────────────────────────────

test("computeRelational counts distinct sessions / repos / branches and min/max ts", () => {
  const evidence: EvidenceStore = emptyEvidenceStore();
  evidence.items["e1"] = ev({ id: "e1", sessionId: "s1", cwd: ABS_PATH_A, gitBranch: BRANCH_A, ts: "2026-01-01T00:00:00Z" });
  evidence.items["e2"] = ev({ id: "e2", sessionId: "s1", cwd: ABS_PATH_A, gitBranch: BRANCH_B, ts: "2026-03-01T00:00:00Z" });
  evidence.items["e3"] = ev({ id: "e3", sessionId: "s2", cwd: ABS_PATH_B, gitBranch: BRANCH_B, ts: "2026-02-01T00:00:00Z" });

  const r = computeRelational(["e1", "e2", "e3"], evidence);
  assert.equal(r.distinctSessions, 2, "s1, s2");
  assert.equal(r.distinctRepos, 2, "ABS_PATH_A, ABS_PATH_B");
  assert.equal(r.distinctBranches, 2, "BRANCH_A, BRANCH_B");
  assert.equal(r.occurrences, 3);
  assert.equal(r.firstTs, "2026-01-01T00:00:00Z", "min ts");
  assert.equal(r.lastTs, "2026-03-01T00:00:00Z", "max ts");
});

test("computeRelational tolerates missing items, missing cwd/gitBranch/ts", () => {
  const evidence: EvidenceStore = emptyEvidenceStore();
  evidence.items["e1"] = ev({ id: "e1", sessionId: "s1" }); // no cwd/gitBranch/ts
  // "missing" id has no sidecar entry — must be skipped, not counted.
  const r = computeRelational(["e1", "missing"], evidence);
  assert.equal(r.occurrences, 1, "only the present item counts");
  assert.equal(r.distinctSessions, 1);
  assert.equal(r.distinctRepos, 0, "no cwd -> 0 distinct repos");
  assert.equal(r.distinctBranches, 0);
  assert.equal(r.firstTs, undefined);
  assert.equal(r.lastTs, undefined);
});

test("relationalTimeline returns the sorted ascending ts list (objective, no gap labels)", () => {
  const evidence: EvidenceStore = emptyEvidenceStore();
  evidence.items["e1"] = ev({ id: "e1", sessionId: "s1", ts: "2026-03-01T00:00:00Z" });
  evidence.items["e2"] = ev({ id: "e2", sessionId: "s1", ts: "2026-01-01T00:00:00Z" });
  evidence.items["e3"] = ev({ id: "e3", sessionId: "s2" }); // no ts -> omitted
  const tl = relationalTimeline(["e1", "e2", "e3"], evidence);
  assert.deepEqual(tl, ["2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"]);
});

// ── recompute on merge (mergeCandidates / mergeClusters) ─────────────────────────────────────────

test("mergeCandidates computes relational facts and recomputes them on re-extraction (no double count)", () => {
  const corpus: Corpus = emptyCorpus(now);
  const evidence: EvidenceStore = emptyEvidenceStore();
  mergeCandidates(corpus, evidence, [
    {
      detector: "after-error",
      normalizedSubject: "rgb value",
      summary: "s",
      count: 0,
      sessionCount: 0,
      evidence: [
        { id: "s1:0-1", sessionId: "s1", cwd: ABS_PATH_A, gitBranch: BRANCH_A, ts: "2026-01-01T00:00:00Z", snippet: "a" },
        { id: "s2:0-1", sessionId: "s2", cwd: ABS_PATH_B, gitBranch: BRANCH_B, ts: "2026-02-01T00:00:00Z", snippet: "b" },
      ],
    },
  ]);
  const c = corpus.clusters[0];
  assert.ok(c.relational, "relational facts attached on merge");
  assert.equal(c.relational!.distinctSessions, 2);
  assert.equal(c.relational!.distinctRepos, 2);
  assert.equal(c.relational!.distinctBranches, 2);
  assert.equal(c.relational!.occurrences, 2);
  assert.equal(c.relational!.firstTs, "2026-01-01T00:00:00Z");
  assert.equal(c.relational!.lastTs, "2026-02-01T00:00:00Z");

  // Re-extract the SAME evidence: idempotent — counts must not grow.
  mergeCandidates(corpus, evidence, [
    {
      detector: "after-error",
      normalizedSubject: "rgb value",
      summary: "s",
      count: 0,
      sessionCount: 0,
      evidence: [
        { id: "s1:0-1", sessionId: "s1", cwd: ABS_PATH_A, gitBranch: BRANCH_A, ts: "2026-01-01T00:00:00Z", snippet: "a" },
      ],
    },
  ]);
  assert.equal(corpus.clusters[0].relational!.occurrences, 2, "re-extraction does not double-count");
  assert.equal(corpus.clusters[0].relational!.distinctRepos, 2);
});

test("mergeClusters recomputes the relational rollup from the deduped union", () => {
  const corpus: Corpus = emptyCorpus(now);
  const evidence: EvidenceStore = emptyEvidenceStore();
  const a = resolveOrCreateCluster(corpus, "after-error", "subj-a", "sa", now);
  const b = resolveOrCreateCluster(corpus, "after-error", "subj-b", "sb", now);
  evidence.items["ea"] = ev({ id: "ea", sessionId: "s1", cwd: ABS_PATH_A, gitBranch: BRANCH_A, ts: "2026-01-01T00:00:00Z" });
  evidence.items["eb"] = ev({ id: "eb", sessionId: "s2", cwd: ABS_PATH_B, gitBranch: BRANCH_B, ts: "2026-05-01T00:00:00Z" });
  a.evidenceIds = ["ea"];
  b.evidenceIds = ["eb"];

  mergeClusters(corpus, b.clusterId, a.clusterId, evidence, now);
  const survivor = getCluster(corpus, a.clusterId)!;
  assert.ok(survivor.relational);
  assert.equal(survivor.relational!.distinctSessions, 2);
  assert.equal(survivor.relational!.distinctRepos, 2);
  assert.equal(survivor.relational!.distinctBranches, 2);
  assert.equal(survivor.relational!.occurrences, 2);
  assert.equal(survivor.relational!.firstTs, "2026-01-01T00:00:00Z");
  assert.equal(survivor.relational!.lastTs, "2026-05-01T00:00:00Z");
});

test("splitAlias recomputes relational facts for BOTH new and old clusters when given the sidecar", () => {
  const corpus: Corpus = emptyCorpus(now);
  const evidence: EvidenceStore = emptyEvidenceStore();
  // One over-merged cluster holding two distinct-repo evidence items.
  const c = resolveOrCreateCluster(corpus, "after-error", "merged", "m", now);
  evidence.items["e1"] = ev({ id: "e1", sessionId: "s1", cwd: ABS_PATH_A, gitBranch: BRANCH_A, ts: "2026-01-01T00:00:00Z" });
  evidence.items["e2"] = ev({ id: "e2", sessionId: "s2", cwd: ABS_PATH_B, gitBranch: BRANCH_B, ts: "2026-02-01T00:00:00Z" });
  c.evidenceIds = ["e1", "e2"];
  c.relational = computeRelational(c.evidenceIds, evidence);

  // Split out a NEW subject (NOT the cluster's representative) and move e2 to it.
  const newId = splitAlias(
    corpus,
    [{ detector: "after-error", normalizedSubject: "split-out" }],
    ["e2"],
    { evidence },
  );
  const oldC = getCluster(corpus, c.clusterId)!;
  const newC = getCluster(corpus, newId)!;
  assert.equal(oldC.relational!.distinctRepos, 1, "old cluster now sees only ABS_PATH_A");
  assert.equal(oldC.relational!.occurrences, 1);
  assert.equal(newC.relational!.distinctRepos, 1, "new cluster sees only ABS_PATH_B");
  assert.equal(newC.relational!.occurrences, 1);
});

// ── theme aggregation ───────────────────────────────────────────────────────────────────────────

test("aggregateThemeRelational unions distinct counts across members (no double count of shared session)", () => {
  const corpus: Corpus = emptyCorpus(now);
  const evidence: EvidenceStore = emptyEvidenceStore();
  const a = resolveOrCreateCluster(corpus, "after-error", "a", "a", now);
  const b = resolveOrCreateCluster(corpus, "after-error", "b", "b", now);
  // Both members touch session s1 (shared) -> union distinctSessions must be 2, NOT 3.
  evidence.items["e1"] = ev({ id: "e1", sessionId: "s1", cwd: ABS_PATH_A, gitBranch: BRANCH_A, ts: "2026-01-01T00:00:00Z" });
  evidence.items["e2"] = ev({ id: "e2", sessionId: "s1", cwd: ABS_PATH_A, gitBranch: BRANCH_A, ts: "2026-04-01T00:00:00Z" });
  evidence.items["e3"] = ev({ id: "e3", sessionId: "s2", cwd: ABS_PATH_B, gitBranch: BRANCH_B, ts: "2026-02-01T00:00:00Z" });
  a.evidenceIds = ["e1"];
  b.evidenceIds = ["e2", "e3"];
  const theme = createTheme(corpus, "T", [a.clusterId, b.clusterId], now);

  const r = aggregateThemeRelational(corpus, theme, evidence);
  assert.equal(r.distinctSessions, 2, "s1 shared across members -> union is 2, not 3");
  assert.equal(r.distinctRepos, 2, "ABS_PATH_A (shared) + ABS_PATH_B -> 2");
  assert.equal(r.distinctBranches, 2);
  assert.equal(r.occurrences, 3, "e1 + e2 + e3");
  assert.equal(r.firstTs, "2026-01-01T00:00:00Z");
  assert.equal(r.lastTs, "2026-04-01T00:00:00Z");

  const tl = themeRelationalTimeline(corpus, theme, evidence);
  assert.deepEqual(tl, ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", "2026-04-01T00:00:00Z"]);
});

test("rollupThemeRelationalFromMembers (corpus-only) sums occurrences, MIN/MAX ts, MAX-over-members distinct*", () => {
  const corpus: Corpus = emptyCorpus(now);
  const a = resolveOrCreateCluster(corpus, "after-error", "a", "a", now);
  const b = resolveOrCreateCluster(corpus, "after-error", "b", "b", now);
  a.relational = { distinctSessions: 3, distinctRepos: 2, distinctBranches: 1, occurrences: 5, firstTs: "2026-02-01T00:00:00Z", lastTs: "2026-03-01T00:00:00Z" };
  b.relational = { distinctSessions: 1, distinctRepos: 4, distinctBranches: 2, occurrences: 2, firstTs: "2026-01-01T00:00:00Z", lastTs: "2026-04-01T00:00:00Z" };
  const theme = createTheme(corpus, "T", [a.clusterId, b.clusterId], now);

  const r = rollupThemeRelationalFromMembers(corpus, theme)!;
  assert.equal(r.occurrences, 7, "sum 5 + 2");
  assert.equal(r.distinctSessions, 3, "max(3,1)");
  assert.equal(r.distinctRepos, 4, "max(2,4)");
  assert.equal(r.distinctBranches, 2, "max(1,2)");
  assert.equal(r.firstTs, "2026-01-01T00:00:00Z", "min");
  assert.equal(r.lastTs, "2026-04-01T00:00:00Z", "max");
});

test("rollupThemeRelationalFromMembers returns undefined when no member carries relational facts", () => {
  const corpus: Corpus = emptyCorpus(now);
  const a = resolveOrCreateCluster(corpus, "after-error", "a", "a", now);
  const theme = createTheme(corpus, "T", [a.clusterId], now);
  assert.equal(rollupThemeRelationalFromMembers(corpus, theme), undefined);
});

// ── PRIVACY: raw cwd / gitBranch NEVER reach the serialized hot file ─────────────────────────────

test("PRIVACY SENTINEL: no absolute path / branch string appears anywhere in the serialized hot file", () => {
  const corpus: Corpus = emptyCorpus(now);
  const evidence: EvidenceStore = emptyEvidenceStore();
  mergeCandidates(corpus, evidence, [
    {
      detector: "after-error",
      normalizedSubject: "rgb value",
      summary: "s",
      count: 0,
      sessionCount: 0,
      evidence: [
        { id: "s1:0-1", sessionId: "s1", cwd: ABS_PATH_A, gitBranch: BRANCH_A, ts: "2026-01-01T00:00:00Z", snippet: "raw a" },
        { id: "s2:0-1", sessionId: "s2", cwd: ABS_PATH_B, gitBranch: BRANCH_B, ts: "2026-02-01T00:00:00Z", snippet: "raw b" },
      ],
    },
  ]);
  const hot = JSON.stringify(serializeCorpus(corpus, now));
  // The hot file must carry only COUNTS, never the raw privacy-sensitive values.
  assert.equal(hot.includes(ABS_PATH_A), false, "absolute path A must not leak into the hot file");
  assert.equal(hot.includes(ABS_PATH_B), false, "absolute path B must not leak into the hot file");
  assert.equal(hot.includes(BRANCH_A), false, "branch A must not leak into the hot file");
  assert.equal(hot.includes(BRANCH_B), false, "branch B must not leak into the hot file");
  assert.equal(hot.includes("raw a"), false, "snippet must not leak into the hot file");
  // GENERIC path-syntax scan (not just the fixture constants): no Windows-drive or POSIX home path
  // shape may survive anywhere in the serialized hot file. This catches a path that slipped past the
  // hard-coded constants above (the false-assurance gap the prior sentinel had).
  assertNoPathSyntax(hot);
  // But the COUNTS ARE present (the privacy-clean facts).
  const parsed = JSON.parse(hot);
  assert.equal(parsed.clusters[0].relational.distinctRepos, 2);
  assert.equal(parsed.clusters[0].relational.distinctBranches, 2);
});

/** Path-syntax shapes that must NEVER appear in the serialized hot file (drive letter / POSIX home). */
const PATH_SYNTAX = [/[A-Za-z]:[\\/]/, /\/(Users|home)\//i];
function assertNoPathSyntax(serialized: string): void {
  for (const re of PATH_SYNTAX) {
    assert.equal(re.test(serialized), false, `path-syntax ${re} must not appear in the hot file`);
  }
}

// ── coarseSubject: bounds the hot-file subject so a whole turn / typed path can't leak verbatim ───

test("coarseSubject normalizes AND caps to MAX_SUBJECT_TOKENS (bounded bucket label, not the whole turn)", () => {
  // Short turn: passes through normalize unchanged (under the cap).
  assert.equal(coarseSubject("Rename the RGB value, please!"), "rename the rgb value please");
  // Long turn: capped to the first MAX_SUBJECT_TOKENS tokens (the rest stays only in the sidecar).
  const longTurn = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  const capped = coarseSubject(longTurn);
  assert.equal(capped.split(" ").length, MAX_SUBJECT_TOKENS, "capped to the token budget");
  assert.equal(capped, Array.from({ length: MAX_SUBJECT_TOKENS }, (_, i) => `word${i}`).join(" "));
});

test("coarseSubject strips path SYNTAX from a typed absolute path (no drive/colon/slash survives)", () => {
  // A turn that is just an absolute path: the literal path shape must not survive into the label.
  const subject = coarseSubject("C:/Users/adamr/Projects/secret/file.ts");
  assertNoPathSyntax(subject);
  assert.equal(subject.includes(":"), false);
  assert.equal(subject.includes("/"), false);
});

test("PRIVACY: the SIDECAR holds the raw cwd / gitBranch (the only place they live)", () => {
  const corpus: Corpus = emptyCorpus(now);
  const evidence: EvidenceStore = emptyEvidenceStore();
  mergeCandidates(corpus, evidence, [
    {
      detector: "after-error",
      normalizedSubject: "s",
      summary: "s",
      count: 0,
      sessionCount: 0,
      evidence: [{ id: "s1:0-1", sessionId: "s1", cwd: ABS_PATH_A, gitBranch: BRANCH_A, snippet: "x" }],
    },
  ]);
  const side = JSON.stringify(evidence);
  assert.equal(side.includes(ABS_PATH_A), true, "sidecar holds the raw cwd");
  assert.equal(side.includes(BRANCH_A), true, "sidecar holds the raw gitBranch");
});
