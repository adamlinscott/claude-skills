import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mintClusterId,
  normalizeSubject,
  resolveOrCreateCluster,
  lookupClusterId,
  getCluster,
  addAlias,
  splitAlias,
  mergeClusters,
  countSessions,
  evidenceId,
  makeEvidenceItem,
  aliasKey,
  effectiveAnswer,
  markPending,
  clearPending,
  skipPending,
  isDemoted,
  orderPending,
  createTheme,
  getTheme,
  getThemeByName,
  addClusterToTheme,
  removeClusterFromTheme,
  dropClusterFromAllThemes,
  effectiveThemeAnswer,
  markThemePending,
  clearThemePending,
  skipThemePending,
  orderThemePending,
} from "../src/corpus/identity.ts";
import { emptyCorpus, emptyEvidenceStore, type Corpus, type EvidenceStore } from "../src/corpus/types.ts";

const now = "2026-06-25T00:00:00.000Z";
const fresh = (): Corpus => emptyCorpus(now);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("mintClusterId returns a unique v4 UUID", () => {
  const a = mintClusterId();
  const b = mintClusterId();
  assert.match(a, UUID_RE);
  assert.match(b, UUID_RE);
  assert.notEqual(a, b);
});

test("normalizeSubject folds NFKC, curly apostrophes, full-width, case — deterministically", () => {
  // curly apostrophe (U+2019) folds, possessive 's' separates as a word
  assert.equal(normalizeSubject("RGB’s Value"), "rgb s value");
  assert.equal(normalizeSubject("rgb's value"), "rgb s value");
  // full-width chars NFKC-fold to ascii
  assert.equal(normalizeSubject("ＡＢＣ"), "abc");
  // deterministic: same input, same output
  assert.equal(normalizeSubject("Some-Subject!!"), normalizeSubject("some subject"));
  // non-string and empty inputs
  assert.equal(normalizeSubject(undefined as unknown as string), "");
  assert.equal(normalizeSubject("   "), "");
});

test("resolveOrCreateCluster mints once, returns the SAME cluster on re-resolve", () => {
  const c = fresh();
  const first = resolveOrCreateCluster(c, "after-error", "rgb value", "renamed rgb");
  const second = resolveOrCreateCluster(c, "after-error", "rgb value", "renamed rgb again");
  assert.equal(first.clusterId, second.clusterId);
  assert.equal(c.clusters.length, 1); // not a new cluster
});

test("distinct subjects get distinct clusterIds", () => {
  const c = fresh();
  const a = resolveOrCreateCluster(c, "after-error", "rgb value", "x");
  const b = resolveOrCreateCluster(c, "after-error", "id field", "y");
  assert.notEqual(a.clusterId, b.clusterId);
  assert.equal(c.clusters.length, 2);
});

test("(detector, normalizedSubject) is the composite key — same subject, different detector => different clusters", () => {
  const c = fresh();
  const a = resolveOrCreateCluster(c, "after-error", "same subject", "x");
  const b = resolveOrCreateCluster(c, "turn-after-completion", "same subject", "y");
  assert.notEqual(a.clusterId, b.clusterId);
  assert.equal(c.clusters.length, 2);
  // both keys resolve to their own cluster
  assert.equal(lookupClusterId(c, "after-error", "same subject"), a.clusterId);
  assert.equal(lookupClusterId(c, "turn-after-completion", "same subject"), b.clusterId);
});

test("aliasKey joins detector + subject with a non-collidable separator", () => {
  assert.notEqual(aliasKey("ab", "c"), aliasKey("a", "bc")); // can't be merged across the boundary
});

test("addAlias re-points a new subject at an existing cluster without moving answers", () => {
  const c = fresh();
  const cluster = resolveOrCreateCluster(c, "after-error", "rgb value", "x");
  cluster.answers.push({ source: "user", text: "I prefer descriptive names", ts: now });
  addAlias(c, "after-error", "color value", cluster.clusterId);
  // new subject resolves to the same id
  assert.equal(lookupClusterId(c, "after-error", "color value"), cluster.clusterId);
  // a re-resolve of the new subject returns the SAME cluster with answers intact
  const re = resolveOrCreateCluster(c, "after-error", "color value", "y");
  assert.equal(re.clusterId, cluster.clusterId);
  assert.equal(re.answers.length, 1);
  assert.equal(re.answers[0].text, "I prefer descriptive names");
});

test("addAlias refuses to point at a non-existent clusterId (poisoning guard)", () => {
  const c = fresh();
  assert.throws(() => addAlias(c, "after-error", "subject", "no-such-cluster"), /non-existent clusterId/);
});

test("splitAlias mints a new id, creates a real cluster, and leaves old answers in place", () => {
  const c = fresh();
  const old = resolveOrCreateCluster(c, "after-error", "rgb value", "x");
  old.answers.push({ source: "user", text: "keep me", ts: now });
  // also alias a second subject onto the old cluster (an over-merge we want to split out)
  addAlias(c, "after-error", "wat value", old.clusterId);

  const newId = splitAlias(c, [{ detector: "after-error", normalizedSubject: "wat value" }]);
  assert.match(newId, UUID_RE);
  assert.notEqual(newId, old.clusterId);

  // the new id resolves to a REAL cluster (no dangling alias)
  const newCluster = getCluster(c, newId);
  assert.ok(newCluster, "split must create a real cluster");
  assert.equal(newCluster!.answers.length, 0); // new id starts clean

  // the moved subject now points at the new id
  assert.equal(lookupClusterId(c, "after-error", "wat value"), newId);
  // the old cluster keeps its answers
  const stillOld = getCluster(c, old.clusterId);
  assert.equal(stillOld!.answers.length, 1);
  assert.equal(stillOld!.answers[0].text, "keep me");

  // INVARIANT: no alias points at a missing cluster after a split
  for (const id of Object.values(c.aliases)) {
    assert.ok(getCluster(c, id), `alias points at missing cluster ${id}`);
  }
});

test("splitAlias can migrate specific evidence to the new cluster", () => {
  const c = fresh();
  const old = resolveOrCreateCluster(c, "after-error", "rgb value", "x");
  // Split out a NON-representative alias (the representative "rgb value" is guarded — see the
  // dedicated guard test below); this exercises evidence migration without the guard.
  addAlias(c, "after-error", "wat value", old.clusterId);
  old.evidenceIds.push("s1:0-1", "s1:2-3");
  old.count = 2;
  const newId = splitAlias(
    c,
    [{ detector: "after-error", normalizedSubject: "wat value" }],
    ["s1:2-3"],
  );
  const newCluster = getCluster(c, newId)!;
  assert.deepEqual(newCluster.evidenceIds, ["s1:2-3"]);
  assert.equal(newCluster.count, 1);
  const oldAfter = getCluster(c, old.clusterId)!;
  assert.deepEqual(oldAfter.evidenceIds, ["s1:0-1"]);
  assert.equal(oldAfter.count, 1); // count decremented to match remaining evidence
});

test("evidenceId is deterministic with a turnRange and unique without (no constant-suffix collision)", () => {
  assert.equal(evidenceId("s1", [2, 5]), "s1:2-5");
  assert.equal(evidenceId("s1", [2, 5]), evidenceId("s1", [2, 5])); // deterministic
  // two DISTINCT no-range snippets from the same session must NOT collide
  const a = evidenceId("s1", undefined, "first snippet");
  const b = evidenceId("s1", undefined, "second snippet");
  assert.notEqual(a, b);
  // same content -> same id (still dedups)
  assert.equal(evidenceId("s1", undefined, "same"), evidenceId("s1", undefined, "same"));
});

test("makeEvidenceItem derives a stable id from content when no range/id given", () => {
  const i1 = makeEvidenceItem({ sessionId: "s1", snippet: "alpha" });
  const i2 = makeEvidenceItem({ sessionId: "s1", snippet: "beta" });
  assert.notEqual(i1.id, i2.id);
  assert.equal(i1.id, makeEvidenceItem({ sessionId: "s1", snippet: "alpha" }).id);
});

test("effectiveAnswer: user outranks inferred regardless of recency", () => {
  const cluster = {
    clusterId: "x",
    detector: "d",
    normalizedSubject: "s",
    summary: "",
    count: 0,
    sessionCount: 0,
    evidenceIds: [],
    answers: [
      { source: "inferred" as const, text: "inferred-late", ts: "2026-06-25T10:00:00.000Z" },
      { source: "user" as const, text: "user-early", ts: "2026-06-25T01:00:00.000Z" },
    ],
  };
  assert.equal(effectiveAnswer(cluster)!.text, "user-early");
});

test("effectiveAnswer: newest wins among same source; undefined when empty", () => {
  const base = { clusterId: "x", detector: "d", normalizedSubject: "s", summary: "", count: 0, sessionCount: 0, evidenceIds: [] };
  assert.equal(effectiveAnswer({ ...base, answers: [] }), undefined);
  const r = effectiveAnswer({
    ...base,
    answers: [
      { source: "inferred", text: "old", ts: "2026-06-25T01:00:00.000Z" },
      { source: "inferred", text: "new", ts: "2026-06-25T09:00:00.000Z" },
    ],
  });
  assert.equal(r!.text, "new");
});

test("defensive corruption branch: alias at a missing cluster is recreated under the same id (counts reset, no answer recovery)", () => {
  const c = fresh();
  const cluster = resolveOrCreateCluster(c, "after-error", "rgb value", "x");
  const id = cluster.clusterId;
  // Simulate corruption: drop the cluster object but keep the alias pointing at its id.
  c.clusters = [];
  const recreated = resolveOrCreateCluster(c, "after-error", "rgb value", "x");
  assert.equal(recreated.clusterId, id); // identity binding restored
  assert.equal(recreated.count, 0); // counts reset; answers cannot be recovered
  assert.equal(recreated.answers.length, 0);
});

// ── mergeClusters (P1 — agent semantic merge) ─────────────────────────────────────────────────

/** A corpus + sidecar with two clusters carrying evidence in distinct sessions. */
function twoClusterFixture(): { c: Corpus; e: EvidenceStore; aId: string; bId: string } {
  const c = fresh();
  const e = emptyEvidenceStore();
  const a = resolveOrCreateCluster(c, "after-error", "rgb value", "renamed rgb");
  const b = resolveOrCreateCluster(c, "after-error", "color value", "renamed color");
  e.items["sA:0-1"] = { id: "sA:0-1", sessionId: "sA", snippet: "rename rgb" };
  e.items["sB:0-1"] = { id: "sB:0-1", sessionId: "sB", snippet: "rename color" };
  a.evidenceIds = ["sA:0-1"];
  a.count = 1;
  a.sessionCount = 1;
  b.evidenceIds = ["sB:0-1"];
  b.count = 1;
  b.sessionCount = 1;
  return { c, e, aId: a.clusterId, bId: b.clusterId };
}

test("mergeClusters re-points aliases, unions evidence, recomputes counts, flags merged", () => {
  const { c, e, aId, bId } = twoClusterFixture();
  const res = mergeClusters(c, aId, bId, e); // merge A into B
  // A is gone; B survives and is flagged merged.
  assert.equal(getCluster(c, aId), undefined, "absorbed cluster must be removed");
  const into = getCluster(c, bId)!;
  assert.equal(into.merged, true);
  // evidence unioned + counts recomputed from the deduped union
  assert.deepEqual(into.evidenceIds.sort(), ["sA:0-1", "sB:0-1"]);
  assert.equal(into.count, 2);
  assert.equal(into.sessionCount, 2, "sessionCount recomputed from the sidecar (two sessions)");
  // A's old subject now resolves to B (alias re-pointed) — no dangling alias
  assert.equal(lookupClusterId(c, "after-error", "rgb value"), bId);
  for (const id of Object.values(c.aliases)) assert.ok(getCluster(c, id), "no dangling alias");
  assert.equal(res.evidenceMoved, 1);
  assert.equal(res.aliasesRepointed, 1);
});

test("mergeClusters preserves answers with user outranking inferred", () => {
  const { c, e, aId, bId } = twoClusterFixture();
  // A holds a user answer; B holds an inferred one.
  getCluster(c, aId)!.answers.push({ source: "user", text: "I prefer descriptive names", ts: now });
  getCluster(c, bId)!.answers.push({ source: "inferred", text: "maybe a preference", ts: now });
  mergeClusters(c, aId, bId, e);
  const into = getCluster(c, bId)!;
  assert.equal(into.answers.length, 2, "both answers moved onto the target");
  // user still outranks inferred at read time
  const eff = effectiveAnswer(into)!;
  assert.equal(eff.source, "user");
  assert.equal(eff.text, "I prefer descriptive names");
});

test("mergeClusters throws on unknown cluster and on self-merge", () => {
  const { c, e, aId, bId } = twoClusterFixture();
  assert.throws(() => mergeClusters(c, "nope", bId, e), /no fromClusterId/);
  assert.throws(() => mergeClusters(c, aId, "nope", e), /no intoClusterId/);
  assert.throws(() => mergeClusters(c, aId, aId, e), /into itself/);
});

// ── firstSeen / lastActivityAt + pending lifecycle ────────────────────────────────────────────

test("resolveOrCreateCluster stamps firstSeen + lastActivityAt; firstSeen stays stable on re-resolve", () => {
  const c = fresh();
  const cl = resolveOrCreateCluster(c, "after-error", "subj", "s", "2026-01-01T00:00:00.000Z");
  assert.equal(cl.firstSeen, "2026-01-01T00:00:00.000Z");
  assert.equal(cl.lastActivityAt, "2026-01-01T00:00:00.000Z");
  // re-resolve with a LATER now returns the SAME object; firstSeen must not move
  const again = resolveOrCreateCluster(c, "after-error", "subj", "s", "2026-09-09T00:00:00.000Z");
  assert.equal(again.clusterId, cl.clusterId);
  assert.equal(again.firstSeen, "2026-01-01T00:00:00.000Z", "firstSeen is set once, never reset");
});

test("mergeClusters keeps the EARLIER firstSeen and advances lastActivityAt", () => {
  const { c, e, aId, bId } = twoClusterFixture();
  getCluster(c, aId)!.firstSeen = "2026-01-01T00:00:00.000Z"; // older
  getCluster(c, bId)!.firstSeen = "2026-05-01T00:00:00.000Z"; // newer target
  mergeClusters(c, aId, bId, e, "2026-12-31T00:00:00.000Z");
  const into = getCluster(c, bId)!;
  assert.equal(into.firstSeen, "2026-01-01T00:00:00.000Z", "surviving cluster keeps the earlier firstSeen");
  assert.equal(into.lastActivityAt, "2026-12-31T00:00:00.000Z", "merge advances lastActivityAt");
});

test("markPending sets forwardedAt once; clearPending removes it; re-mark does not reset", () => {
  const c = fresh();
  const cl = resolveOrCreateCluster(c, "after-error", "subj", "s", now);
  const p = markPending(c, cl.clusterId, "2026-01-01T00:00:00.000Z");
  assert.equal(p.forwardedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(p.skipCount, 0);
  // re-mark with a later time must NOT reset forwardedAt
  const p2 = markPending(c, cl.clusterId, "2026-09-09T00:00:00.000Z");
  assert.equal(p2.forwardedAt, "2026-01-01T00:00:00.000Z");
  // clear removes the field
  assert.equal(clearPending(c, cl.clusterId), true);
  assert.equal(cl.pending, undefined);
  assert.equal(clearPending(c, cl.clusterId), false, "clearing a non-pending cluster returns false");
});

test("markPending/skipPending throw for unknown cluster; skipPending throws if not pending", () => {
  const c = fresh();
  const cl = resolveOrCreateCluster(c, "after-error", "subj", "s", now);
  assert.throws(() => markPending(c, "nope"), /no cluster/);
  assert.throws(() => skipPending(c, "nope"), /no cluster/);
  assert.throws(() => skipPending(c, cl.clusterId), /not pending/);
});

test("skipPending increments skipCount + stamps lastSurfacedAt; isDemoted at K=3", () => {
  const c = fresh();
  const cl = resolveOrCreateCluster(c, "after-error", "subj", "s", now);
  markPending(c, cl.clusterId, now);
  assert.equal(isDemoted(cl.pending!), false);
  skipPending(c, cl.clusterId, "2026-02-01T00:00:00.000Z");
  skipPending(c, cl.clusterId, "2026-02-02T00:00:00.000Z");
  assert.equal(isDemoted(cl.pending!), false, "2 skips: not yet demoted");
  const p = skipPending(c, cl.clusterId, "2026-02-03T00:00:00.000Z");
  assert.equal(p.skipCount, 3);
  assert.equal(p.lastSurfacedAt, "2026-02-03T00:00:00.000Z");
  assert.equal(isDemoted(cl.pending!), true, "3 skips (>= K): demoted");
});

test("orderPending: non-demoted before demoted, oldest forwardedAt first within band", () => {
  const c = fresh();
  const a = resolveOrCreateCluster(c, "after-error", "a", "sa", now);
  const b = resolveOrCreateCluster(c, "after-error", "b", "sb", now);
  const d = resolveOrCreateCluster(c, "after-error", "d", "sd", now);
  markPending(c, a.clusterId, "2026-01-01T00:00:00.000Z"); // oldest, but will be demoted
  markPending(c, b.clusterId, "2026-03-01T00:00:00.000Z");
  markPending(c, d.clusterId, "2026-02-01T00:00:00.000Z");
  // demote a
  skipPending(c, a.clusterId, now);
  skipPending(c, a.clusterId, now);
  skipPending(c, a.clusterId, now);
  const ordered = orderPending(c).map((cl) => cl.clusterId);
  // non-demoted oldest-first (d=Feb, b=Mar) then demoted a
  assert.deepEqual(ordered, [d.clusterId, b.clusterId, a.clusterId]);
});

test("mergeClusters folds pending: keeps earlier forwardedAt + MAX skipCount", () => {
  const { c, e, aId, bId } = twoClusterFixture();
  markPending(c, aId, "2026-01-01T00:00:00.000Z");
  markPending(c, bId, "2026-05-01T00:00:00.000Z");
  skipPending(c, aId, now);
  skipPending(c, aId, now); // from has skipCount 2
  mergeClusters(c, aId, bId, e, now);
  const into = getCluster(c, bId)!;
  assert.ok(into.pending, "merged cluster stays pending if either was pending");
  assert.equal(into.pending!.forwardedAt, "2026-01-01T00:00:00.000Z", "earlier forwardedAt kept");
  assert.equal(into.pending!.skipCount, 2, "max skipCount kept (demotion survives merge)");
});

test("mergeClusters fold: still-pending `from` into a RESOLVED `into` => survivor is BOTH pending AND user-answered", () => {
  // Pins the fromP && !intoP branch: `into` was already resolved by a confirmed user answer
  // (its pending was cleared, a source:user answer remains), and `from` still carries an
  // outstanding forwarded question. The merged subject should re-confirm: survivor is pending
  // (forwardedAt from `from`) AND still carries the user ground truth. A future refactor must
  // not silently flip this to "a resolved target swallows the pending".
  const { c, e, aId, bId } = twoClusterFixture();
  // Resolve `into` (bId): forward then a confirmed user answer clears its pending.
  markPending(c, bId, "2026-05-01T00:00:00.000Z");
  getCluster(c, bId)!.answers.push({ source: "user", text: "yes, my preference", ts: now });
  clearPending(c, bId);
  assert.equal(getCluster(c, bId)!.pending, undefined, "into is resolved (pending cleared)");
  // `from` (aId) is still pending (forwarded, never answered).
  markPending(c, aId, "2026-01-01T00:00:00.000Z");

  mergeClusters(c, aId, bId, e, now);
  const into = getCluster(c, bId)!;
  assert.ok(into.pending, "survivor is pending (the from-side open question carries over)");
  assert.equal(into.pending!.forwardedAt, "2026-01-01T00:00:00.000Z", "forwardedAt from the still-pending `from`");
  assert.equal(effectiveAnswer(into)!.source, "user", "survivor still carries the user ground truth");
});

test("orderPending: equal forwardedAt tiebreaks on firstSeen (oldest cluster first), NOT clusterId", () => {
  const c = fresh();
  const a = resolveOrCreateCluster(c, "after-error", "a", "sa", "2026-05-01T00:00:00.000Z"); // newer cluster
  const b = resolveOrCreateCluster(c, "after-error", "b", "sb", "2026-01-01T00:00:00.000Z"); // older cluster
  // Identical forwardedAt forces the tiebreak.
  const fwd = "2026-06-01T00:00:00.000Z";
  markPending(c, a.clusterId, fwd);
  markPending(c, b.clusterId, fwd);
  const ordered = orderPending(c).map((cl) => cl.clusterId);
  // older firstSeen (b) must come first regardless of how the random clusterIds compare.
  assert.deepEqual(ordered, [b.clusterId, a.clusterId], "older firstSeen wins the forwardedAt tie");
});

// ── splitAlias hazards (P2) ───────────────────────────────────────────────────────────────────

test("splitAlias recomputes sessionCount for BOTH old and new clusters when given the sidecar", () => {
  const c = fresh();
  const e = emptyEvidenceStore();
  const old = resolveOrCreateCluster(c, "after-error", "rgb value", "x");
  // over-merge a second subject onto the old cluster (the one we'll split out)
  addAlias(c, "after-error", "wat value", old.clusterId);
  // two pieces of evidence in DISTINCT sessions
  e.items["s1:0-1"] = { id: "s1:0-1", sessionId: "s1", snippet: "a" };
  e.items["s2:0-1"] = { id: "s2:0-1", sessionId: "s2", snippet: "b" };
  old.evidenceIds = ["s1:0-1", "s2:0-1"];
  old.count = 2;
  old.sessionCount = 2;

  const newId = splitAlias(
    c,
    [{ detector: "after-error", normalizedSubject: "wat value" }],
    ["s2:0-1"],
    { evidence: e },
  );
  const oldAfter = getCluster(c, old.clusterId)!;
  const newAfter = getCluster(c, newId)!;
  // old kept s1 (session s1), new took s2 (session s2): each sessionCount must be 1, not stale 2
  assert.equal(oldAfter.sessionCount, 1, "old cluster sessionCount recomputed (no longer stale)");
  assert.equal(newAfter.sessionCount, 1, "new cluster sessionCount recomputed");
  assert.equal(countSessions(oldAfter.evidenceIds, e), 1);
  assert.equal(countSessions(newAfter.evidenceIds, e), 1);
});

test("splitAlias REFUSES to split a cluster's OWN representative subject without a replacement", () => {
  const c = fresh();
  const old = resolveOrCreateCluster(c, "after-error", "rgb value", "x");
  old.answers.push({ source: "user", text: "keep me reachable", ts: now });
  // "rgb value" is the cluster's OWN representative subject — splitting it orphans the answer.
  assert.throws(
    () => splitAlias(c, [{ detector: "after-error", normalizedSubject: "rgb value" }]),
    /own representative subject|orphan/i,
  );
  // the answer is still reachable via the representative subject (nothing was moved)
  assert.equal(lookupClusterId(c, "after-error", "rgb value"), old.clusterId);
  assert.equal(getCluster(c, old.clusterId)!.answers.length, 1);
});

test("splitAlias splits a representative subject WHEN a replacement is supplied (answers stay reachable)", () => {
  const c = fresh();
  const old = resolveOrCreateCluster(c, "after-error", "rgb value", "x");
  old.answers.push({ source: "user", text: "keep me reachable", ts: now });
  const newId = splitAlias(
    c,
    [{ detector: "after-error", normalizedSubject: "rgb value" }],
    [],
    { replacementSubjects: { [old.clusterId]: "rgb specific value" } },
  );
  assert.notEqual(newId, old.clusterId);
  // the old cluster's answers stay reachable via its NEW representative subject
  assert.equal(lookupClusterId(c, "after-error", "rgb specific value"), old.clusterId);
  assert.equal(getCluster(c, old.clusterId)!.answers[0].text, "keep me reachable");
  // the moved subject now points at the new id
  assert.equal(lookupClusterId(c, "after-error", "rgb value"), newId);
  // no dangling aliases
  for (const id of Object.values(c.aliases)) assert.ok(getCluster(c, id), "no dangling alias");
});

// ── TIER 2: themes (non-destructive overlay) ──────────────────────────────────────────────────

/** A corpus with three clusters; returns their ids. */
function threeClusters(): { c: Corpus; a: string; b: string; d: string } {
  const c = fresh();
  const a = resolveOrCreateCluster(c, "after-error", "abbreviated names", "x").clusterId;
  const b = resolveOrCreateCluster(c, "after-error", "mocks in prod", "y").clusterId;
  const d = resolveOrCreateCluster(c, "after-error", "stale docs", "z").clusterId;
  return { c, a, b, d };
}

test("createTheme groups clusters non-destructively; clusters keep their identity", () => {
  const { c, a, b } = threeClusters();
  // give a member an answer to prove it is untouched by theming
  getCluster(c, a)!.answers.push({ source: "user", text: "descriptive names", ts: now });
  const t = createTheme(c, "code tells the truth", [a, b], now);
  assert.match(t.themeId, UUID_RE);
  assert.deepEqual(t.memberClusterIds, [a, b]);
  assert.deepEqual(t.answers, []);
  assert.equal(t.firstSeen, now);
  // member cluster is unchanged (its answer is intact; it is NOT removed)
  assert.equal(getCluster(c, a)!.answers.length, 1);
  assert.equal(c.clusters.length, 3, "theming does not fuse or remove clusters");
});

test("createTheme dedups members and REFUSES a non-existent clusterId (poisoning guard)", () => {
  const { c, a } = threeClusters();
  const t = createTheme(c, "dup", [a, a], now);
  assert.deepEqual(t.memberClusterIds, [a], "duplicate members collapse");
  assert.throws(() => createTheme(c, "bad", ["no-such-cluster"]), /non-existent clusterId/);
});

test("addClusterToTheme is idempotent and a cluster MAY belong to multiple themes", () => {
  const { c, a, b, d } = threeClusters();
  const t1 = createTheme(c, "theme one", [a], now);
  const t2 = createTheme(c, "theme two", [b], now);
  // add a to t2 as well -> a is now in BOTH themes
  assert.equal(addClusterToTheme(c, t2.themeId, a, now), true);
  assert.ok(getTheme(c, t1.themeId)!.memberClusterIds.includes(a));
  assert.ok(getTheme(c, t2.themeId)!.memberClusterIds.includes(a));
  // idempotent: adding a again is a no-op
  assert.equal(addClusterToTheme(c, t2.themeId, a, now), false);
  assert.equal(getTheme(c, t2.themeId)!.memberClusterIds.filter((id) => id === a).length, 1);
  // poisoning guard + unknown theme
  assert.throws(() => addClusterToTheme(c, t1.themeId, "nope", now), /non-existent clusterId/);
  assert.throws(() => addClusterToTheme(c, "no-theme", d, now), /no theme/);
});

test("removeClusterFromTheme is reversible regrouping (no cluster data lost)", () => {
  const { c, a, b } = threeClusters();
  getCluster(c, a)!.answers.push({ source: "user", text: "keep", ts: now });
  const t = createTheme(c, "t", [a, b], now);
  assert.equal(removeClusterFromTheme(c, t.themeId, a, now), true);
  assert.deepEqual(getTheme(c, t.themeId)!.memberClusterIds, [b]);
  // the cluster + its answer survive (themes are an overlay, not ownership)
  assert.equal(getCluster(c, a)!.answers.length, 1);
  // removing a non-member returns false
  assert.equal(removeClusterFromTheme(c, t.themeId, a, now), false);
  assert.throws(() => removeClusterFromTheme(c, "no-theme", b, now), /no theme/);
});

test("getThemeByName finds a theme for group_theme's extend-by-name path", () => {
  const { c, a } = threeClusters();
  const t = createTheme(c, "named theme", [a], now);
  assert.equal(getThemeByName(c, "named theme")!.themeId, t.themeId);
  assert.equal(getThemeByName(c, "missing"), undefined);
});

test("merge_clusters REWRITES theme member ids from->into (no dangling), deduping", () => {
  const { c, e, aId, bId } = twoClusterFixture();
  // a third cluster so the theme has a stable member to keep
  const keep = resolveOrCreateCluster(c, "after-error", "keep me", "k").clusterId;
  // theme1 has BOTH a and b -> after merging a INTO b, it should collapse to [b, keep] (deduped)
  const t1 = createTheme(c, "both", [aId, bId, keep], now);
  // theme2 has only a -> after merge it must become [b] (the survivor), never dangling at a
  const t2 = createTheme(c, "only a", [aId], now);

  mergeClusters(c, aId, bId, e); // merge a INTO b

  const m1 = getTheme(c, t1.themeId)!.memberClusterIds;
  assert.deepEqual(m1, [bId, keep], "from-id replaced by into-id and deduped (no double b)");
  const m2 = getTheme(c, t2.themeId)!.memberClusterIds;
  assert.deepEqual(m2, [bId], "lone from-member rewritten to the survivor");
  // INVARIANT: no theme member id is dangling after the merge
  for (const theme of c.themes) {
    for (const id of theme.memberClusterIds) assert.ok(getCluster(c, id), `dangling theme member ${id}`);
  }
});

test("dropClusterFromAllThemes removes a cluster id from every theme that referenced it", () => {
  const { c, a, b } = threeClusters();
  const t1 = createTheme(c, "t1", [a, b], now);
  const t2 = createTheme(c, "t2", [a], now);
  const touched = dropClusterFromAllThemes(c, a, now);
  assert.equal(touched, 2);
  assert.deepEqual(getTheme(c, t1.themeId)!.memberClusterIds, [b]);
  assert.deepEqual(getTheme(c, t2.themeId)!.memberClusterIds, []);
});

test("theme answers: effectiveThemeAnswer has user outrank inferred (mirrors clusters)", () => {
  const { c, a } = threeClusters();
  const t = createTheme(c, "t", [a], now);
  t.answers.push({ source: "inferred", text: "guess", ts: "2026-06-25T10:00:00.000Z" });
  t.answers.push({ source: "user", text: "ground truth", ts: "2026-06-25T01:00:00.000Z" });
  assert.equal(effectiveThemeAnswer(t)!.source, "user");
  assert.equal(effectiveThemeAnswer(t)!.text, "ground truth");
});

test("theme pending lifecycle: mark (idempotent) / skip (demote at K) / clear", () => {
  const { c, a } = threeClusters();
  const t = createTheme(c, "t", [a], now);
  const p = markThemePending(c, t.themeId, "2026-01-01T00:00:00.000Z");
  assert.equal(p.forwardedAt, "2026-01-01T00:00:00.000Z");
  // re-mark does not reset
  assert.equal(markThemePending(c, t.themeId, "2026-09-09T00:00:00.000Z").forwardedAt, "2026-01-01T00:00:00.000Z");
  skipThemePending(c, t.themeId, now);
  skipThemePending(c, t.themeId, now);
  assert.equal(isDemoted(getTheme(c, t.themeId)!.pending!), false, "2 skips: not demoted");
  const p3 = skipThemePending(c, t.themeId, now);
  assert.equal(p3.skipCount, 3);
  assert.equal(isDemoted(p3), true, "3 skips: demoted");
  // clear removes it
  assert.equal(clearThemePending(c, t.themeId), true);
  assert.equal(getTheme(c, t.themeId)!.pending, undefined);
  assert.equal(clearThemePending(c, t.themeId), false);
  // skip on a non-pending theme throws
  assert.throws(() => skipThemePending(c, t.themeId, now), /not pending/);
  assert.throws(() => markThemePending(c, "no-theme", now), /no theme/);
});

test("orderThemePending: non-demoted before demoted, oldest forwardedAt first within band", () => {
  const { c, a, b, d } = threeClusters();
  const t1 = createTheme(c, "t1", [a], "2026-01-01T00:00:00.000Z");
  const t2 = createTheme(c, "t2", [b], "2026-02-01T00:00:00.000Z");
  const t3 = createTheme(c, "t3", [d], "2026-03-01T00:00:00.000Z");
  markThemePending(c, t1.themeId, "2026-01-01T00:00:00.000Z"); // oldest, will demote
  markThemePending(c, t2.themeId, "2026-03-01T00:00:00.000Z");
  markThemePending(c, t3.themeId, "2026-02-01T00:00:00.000Z");
  for (let i = 0; i < 3; i++) skipThemePending(c, t1.themeId, now); // demote t1
  const ordered = orderThemePending(c).map((t) => t.themeId);
  assert.deepEqual(ordered, [t3.themeId, t2.themeId, t1.themeId]);
});
