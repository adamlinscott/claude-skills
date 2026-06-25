/**
 * Identity layer (T3). The IDENTITY of a cluster is an opaque surrogate `clusterId`
 * (crypto.randomUUID), minted once and never derived from text or evidence. Answers hang
 * off the clusterId, so they survive re-normalization, merge, and split (eng decision 4).
 *
 * `(detector, normalizedSubject)` is the LOOKUP INDEX into clusters via the alias map.
 * The alias map is keyed by a deterministic COMPOSITE of (detector, normalizedSubject) so
 * two STRUCTURALLY-distinct detectors (e.g. "after-error" vs "turn-after-completion") that
 * happen to normalize to the same subject do NOT collide into one answer-bearing identity.
 * Improving the normalizer remaps the index; answers, which key off clusterId, never orphan
 * (the "normalizer-churn hazard" the design names).
 *
 * normalizeSubject() is a CHEAP DETERMINISTIC CLI rule (coarse, LLM-free). Semantic merge
 * is agent-driven later and persisted as additional aliases — NOT done here.
 */

import { randomUUID, createHash } from "node:crypto";
import type { Corpus, Cluster, EvidenceItem, EvidenceStore, Pending } from "./types.js";
import { SKIP_DEMOTE_THRESHOLD } from "./types.js";

/** Pick the later of two optional ISO timestamps as a `{ lastSurfacedAt }` spread, or `{}`. */
function maxLastSurfaced(a?: string, b?: string): { lastSurfacedAt?: string } {
  const later = a !== undefined && b !== undefined ? (a >= b ? a : b) : (a ?? b);
  return later !== undefined ? { lastSurfacedAt: later } : {};
}

/**
 * Number of DISTINCT sessions across a set of evidenceIds, read from the sidecar. Lives here
 * (not only in merge.ts) so split/merge can recompute sessionCount correctly when they move
 * evidence between clusters — otherwise sessionCount goes stale (the P2 hazard).
 */
export function countSessions(evidenceIds: string[], evidence: EvidenceStore): number {
  const sessions = new Set<string>();
  for (const id of evidenceIds) {
    const item = evidence.items[id];
    if (item) sessions.add(item.sessionId);
  }
  return sessions.size;
}

/** Mint a fresh opaque cluster identity. Never derived from content — that's the point. */
export function mintClusterId(): string {
  return randomUUID();
}

/**
 * Deterministic coarse subject normalizer. STRUCTURAL/lexical-cleanup ONLY — it reads no
 * intent (CORE PRINCIPLE); it just produces a stable cheap key so equivalent surfaces land
 * in one bucket. It is intentionally coarse; semantic merges are the agent's job, layered
 * on as aliases. Pure and deterministic: same input -> same output, always.
 *
 * Rules (order matters):
 *  - Unicode-normalize (NFKC) so curly apostrophes / full-width chars fold to canonical.
 *  - lowercase.
 *  - replace any run of non-alphanumeric chars with a single space (drops punctuation,
 *    the curly-apostrophe class that broke the T2 lexical pass, etc.).
 *  - collapse whitespace, trim.
 */
export function normalizeSubject(text: string): string {
  if (typeof text !== "string") return "";
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Separator joining detector + normalizedSubject in the composite alias key. A NUL byte can
 * never appear in a normalized subject (normalizeSubject strips all non-alphanumerics) nor
 * in a sane structural detector label, so it cannot be forged to merge two distinct keys.
 */
const ALIAS_SEP = "\u0000";

/**
 * The composite alias key. The alias map is keyed by (detector, normalizedSubject) so two
 * STRUCTURALLY-distinct detectors that happen to normalize to the same subject do NOT
 * collide into one answer-bearing identity.
 */
export function aliasKey(detector: string, normalizedSubject: string): string {
  return detector + ALIAS_SEP + normalizedSubject;
}

/**
 * Alias lookup: resolve a (detector, normalizedSubject) to its clusterId, or undefined if
 * unseen. Pure-data lookup — no LLM, no fuzzy matching (eng decisions 5, 8: CLI stays
 * LLM-free).
 */
export function lookupClusterId(
  corpus: Corpus,
  detector: string,
  normalizedSubject: string,
): string | undefined {
  return corpus.aliases[aliasKey(detector, normalizedSubject)];
}

/** Find a cluster by its surrogate id. */
export function getCluster(corpus: Corpus, clusterId: string): Cluster | undefined {
  return corpus.clusters.find((c) => c.clusterId === clusterId);
}

/**
 * Resolve an incoming (detector, normalizedSubject) to a cluster, MUTATING the corpus:
 *  - if the pair is already aliased to a clusterId, return that existing cluster
 *    (re-extraction lands in the same bucket — answers preserved);
 *  - otherwise mint a NEW clusterId, create the cluster, and register the alias.
 *
 * The alias index is what guarantees re-normalization/merge/split never orphan answers:
 * answers live on clusterId, and the subject is merely a pointer at that id.
 */
export function resolveOrCreateCluster(
  corpus: Corpus,
  detector: string,
  normalizedSubject: string,
  summary: string,
  now: string = new Date().toISOString(),
): Cluster {
  const existingId = lookupClusterId(corpus, detector, normalizedSubject);
  if (existingId) {
    const existing = getCluster(corpus, existingId);
    if (existing) return existing;
    // Best-effort CORRUPTION RECOVERY: the alias points at a clusterId with no cluster
    // object (corrupt/poisoned hot file). We re-create the identity binding under the SAME
    // id so future resolves are stable, but we CANNOT recover answers that lived on the
    // lost cluster object — answers are stored inline on the cluster, not independently
    // keyed, so once the object is gone its answers are already gone. Counts start at 0.
    const recreated: Cluster = {
      clusterId: existingId,
      detector,
      normalizedSubject,
      summary,
      count: 0,
      sessionCount: 0,
      evidenceIds: [],
      answers: [],
      firstSeen: now,
      lastActivityAt: now,
    };
    corpus.clusters.push(recreated);
    return recreated;
  }
  const clusterId = mintClusterId();
  const cluster: Cluster = {
    clusterId,
    detector,
    normalizedSubject,
    summary,
    count: 0,
    sessionCount: 0,
    evidenceIds: [],
    answers: [],
    // Stable creation timestamp + initial activity stamp. firstSeen is the oldest-first
    // surfacing tiebreak; lastActivityAt advances as the cluster is touched.
    firstSeen: now,
    lastActivityAt: now,
  };
  corpus.clusters.push(cluster);
  corpus.aliases[aliasKey(detector, normalizedSubject)] = clusterId;
  return cluster;
}

/**
 * Register an additional alias (e.g. an agent-proposed semantic merge): point a
 * (detector, normalizedSubject) at an EXISTING clusterId. Pure-data index remap — answers
 * don't move, they were never on the subject. This is how "renamed RGB->color" and "renamed
 * ID->identifier" can be merged under one cluster after the fact without losing answers.
 *
 * The corpus is UNTRUSTED (poisoning vector). We REFUSE to point an alias at a clusterId
 * that has no cluster object, so a poisoned alias map cannot manufacture a phantom
 * answer-bearing identity via the corruption-recovery branch above.
 */
export function addAlias(
  corpus: Corpus,
  detector: string,
  normalizedSubject: string,
  clusterId: string,
): void {
  if (!getCluster(corpus, clusterId)) {
    throw new Error(`addAlias: refusing to alias to non-existent clusterId ${clusterId}`);
  }
  corpus.aliases[aliasKey(detector, normalizedSubject)] = clusterId;
}

/** Result of a mergeClusters call (for handlers / tests). */
export interface MergeClustersResult {
  /** The surviving target cluster's id. */
  intoClusterId: string;
  /** The absorbed source cluster's id (removed from corpus.clusters). */
  fromClusterId: string;
  /** Evidence ids moved onto the target. */
  evidenceMoved: number;
  /** Aliases re-pointed at the target. */
  aliasesRepointed: number;
  /** Answers moved onto the target. */
  answersMoved: number;
}

/**
 * Merge `fromClusterId` INTO `intoClusterId` (eng decisions 5 & 8: agent-driven semantic
 * merge of two clusters the coarse normalizer kept apart). This is the answer-preserving
 * inverse of splitAlias:
 *  - every alias pointing at the from-cluster is re-pointed at the target;
 *  - the from-cluster's evidenceIds are unioned (deduped) onto the target;
 *  - the from-cluster's answers are appended to the target (user STILL outranks inferred at
 *    read time via effectiveAnswer — precedence is preserved by construction);
 *  - count = distinct evidence; sessionCount recomputed from the sidecar;
 *  - the from-cluster object is removed; the target is flagged `merged:true`.
 *
 * Throws if either cluster does not exist, or if from === into (no self-merge).
 */
export function mergeClusters(
  corpus: Corpus,
  fromClusterId: string,
  intoClusterId: string,
  evidence: EvidenceStore,
  now: string = new Date().toISOString(),
): MergeClustersResult {
  if (fromClusterId === intoClusterId) {
    throw new Error(`mergeClusters: cannot merge a cluster into itself (${fromClusterId})`);
  }
  const from = getCluster(corpus, fromClusterId);
  if (!from) throw new Error(`mergeClusters: no fromClusterId ${fromClusterId}`);
  const into = getCluster(corpus, intoClusterId);
  if (!into) throw new Error(`mergeClusters: no intoClusterId ${intoClusterId}`);

  // Re-point every alias that resolves to the from-cluster at the target.
  let aliasesRepointed = 0;
  for (const [key, id] of Object.entries(corpus.aliases)) {
    if (id === fromClusterId) {
      corpus.aliases[key] = intoClusterId;
      aliasesRepointed += 1;
    }
  }

  // Union evidence (dedup), preserving the target's existing ids.
  const existing = new Set(into.evidenceIds);
  let evidenceMoved = 0;
  for (const eid of from.evidenceIds) {
    if (!existing.has(eid)) {
      into.evidenceIds.push(eid);
      existing.add(eid);
      evidenceMoved += 1;
    }
  }

  // Append the from-cluster's answers. user-outranks-inferred is enforced at READ time
  // (effectiveAnswer), so simply appending preserves precedence without losing any answer.
  const answersMoved = from.answers.length;
  for (const a of from.answers) into.answers.push(a);

  // Recompute volatile counts from the deduped union.
  into.count = into.evidenceIds.length;
  into.sessionCount = countSessions(into.evidenceIds, evidence);
  into.merged = true;

  // firstSeen is STABLE: the surviving cluster keeps the EARLIER of the two creation stamps so
  // an absorbed older cluster's age is preserved for the oldest-first tiebreak. lastActivityAt
  // advances (a merge IS activity). If either firstSeen is absent (legacy corpus), prefer the
  // one that exists.
  const candidates = [into.firstSeen, from.firstSeen].filter((t): t is string => typeof t === "string");
  if (candidates.length > 0) into.firstSeen = candidates.reduce((a, b) => (a <= b ? a : b));
  into.lastActivityAt = now;

  // Pending state: if EITHER cluster had an outstanding forwarded question, the merged cluster
  // is still pending. Keep the EARLIER forwardedAt (oldest-first), the MAX skipCount (so a
  // demoted question stays demoted through a merge), and the later lastSurfacedAt.
  const fromP = from.pending;
  const intoP = into.pending;
  if (fromP && intoP) {
    into.pending = {
      forwardedAt: fromP.forwardedAt <= intoP.forwardedAt ? fromP.forwardedAt : intoP.forwardedAt,
      skipCount: Math.max(fromP.skipCount, intoP.skipCount),
      ...maxLastSurfaced(fromP.lastSurfacedAt, intoP.lastSurfacedAt),
    };
  } else if (fromP && !intoP) {
    into.pending = { ...fromP };
  }
  // (intoP && !fromP) -> into.pending already correct; (!fromP && !intoP) -> stays absent.

  // Remove the absorbed cluster object.
  corpus.clusters = corpus.clusters.filter((c) => c.clusterId !== fromClusterId);

  return { intoClusterId, fromClusterId, evidenceMoved, aliasesRepointed, answersMoved };
}

/** Options for splitAlias (P2 hazard fixes). */
export interface SplitAliasOptions {
  /**
   * The evidence sidecar. When provided, split recomputes sessionCount (distinct sessions)
   * for BOTH the new cluster AND every old cluster it migrated evidence off of, so neither
   * goes stale. Without it, sessionCount is left to the next merge to repair (legacy behavior).
   */
  evidence?: EvidenceStore;
  /**
   * If a key being moved is an OLD cluster's OWN representative (detector, normalizedSubject),
   * moving it would re-point the cluster's representative subject at the new id and orphan that
   * old cluster's source:user answers. To split a representative subject safely the caller MUST
   * supply a replacement subject for the old cluster, keyed by clusterId, which re-keys the old
   * cluster's representative AND its alias so it stays reachable. Absent a replacement for a
   * representative move, splitAlias throws (the guard).
   */
  replacementSubjects?: Record<string, string>;
}

/**
 * Split: re-point a subset of (detector, normalizedSubject) keys at a NEW clusterId
 * (because a coarse normalizer over-merged). Mints a fresh id, CREATES a real cluster
 * object for it up front (so no live alias ever dangles at a missing cluster), re-points
 * the named keys, and returns the new id.
 *
 * Surrogate keys make the split safe: the OLD cluster keeps its answers, and the new id
 * starts with empty answers. Optionally, evidenceIds attributable to the split-out subjects
 * can be migrated off the old cluster onto the new one so over-merged evidence is actually
 * partitioned rather than stranded; pass `evidenceIdsToMove` to do so.
 *
 * P2 hazards fixed:
 *  (a) Pass `options.evidence` and sessionCount is recomputed for BOTH the old and the new
 *      cluster (it no longer goes stale until the next merge).
 *  (b) Splitting a cluster's OWN representative (detector, normalizedSubject) would orphan its
 *      source:user answers (the cluster's own subject lookup would resolve to the NEW id). The
 *      split throws unless the caller supplies a replacement subject for that old cluster via
 *      `options.replacementSubjects[oldClusterId]`, which re-keys the old cluster's
 *      representative + alias so its answers stay reachable.
 */
export function splitAlias(
  corpus: Corpus,
  keysToMove: Array<{ detector: string; normalizedSubject: string }>,
  evidenceIdsToMove: string[] = [],
  options: SplitAliasOptions = {},
): string {
  const replacements = options.replacementSubjects ?? {};

  // Guard (b): refuse to silently orphan a cluster's source:user answers by moving its OWN
  // representative subject without a replacement.
  for (const { detector, normalizedSubject } of keysToMove) {
    const ownerId = lookupClusterId(corpus, detector, normalizedSubject);
    if (!ownerId) continue;
    const owner = getCluster(corpus, ownerId);
    if (!owner) continue;
    const isRepresentative =
      owner.detector === detector && owner.normalizedSubject === normalizedSubject;
    if (isRepresentative && replacements[ownerId] === undefined) {
      throw new Error(
        `splitAlias: refusing to split cluster ${ownerId}'s OWN representative subject ` +
          `(${detector} / ${normalizedSubject}) without a replacement subject — that would orphan ` +
          `its answers. Pass options.replacementSubjects[${JSON.stringify(ownerId)}].`,
      );
    }
  }

  const newId = mintClusterId();
  // Derive a representative detector/subject for the new cluster from the first moved key,
  // so reads see a well-formed cluster, not a placeholder.
  const head = keysToMove[0];
  const source = head ? getCluster(corpus, lookupClusterId(corpus, head.detector, head.normalizedSubject) ?? "") : undefined;
  const newCluster: Cluster = {
    clusterId: newId,
    detector: head?.detector ?? source?.detector ?? "",
    normalizedSubject: head?.normalizedSubject ?? source?.normalizedSubject ?? "",
    summary: source?.summary ?? "",
    count: 0,
    sessionCount: 0,
    evidenceIds: [],
    answers: [],
  };
  corpus.clusters.push(newCluster);

  // Track which old clusters we mutate so sessionCount can be recomputed for each (with evidence).
  const oldClustersTouched = new Set<Cluster>();

  // Re-key any representatives the caller provided a replacement for, BEFORE we re-point the
  // moved keys at the new id, so the old cluster's representative subject + alias stay valid.
  for (const [oldClusterId, replacementSubject] of Object.entries(replacements)) {
    const owner = getCluster(corpus, oldClusterId);
    if (!owner) continue;
    // Register a new alias for the old cluster under the replacement subject (same detector),
    // and update the cluster's representative field so its own lookup still resolves to it.
    corpus.aliases[aliasKey(owner.detector, replacementSubject)] = oldClusterId;
    owner.normalizedSubject = replacementSubject;
  }

  // Migrate the requested evidence off whichever old clusters currently hold it, onto the
  // new one (deduped), so a split that recovers an over-merge can partition evidence.
  if (evidenceIdsToMove.length > 0) {
    const moveSet = new Set(evidenceIdsToMove);
    for (const c of corpus.clusters) {
      if (c.clusterId === newId) continue;
      const kept: string[] = [];
      for (const eid of c.evidenceIds) {
        if (moveSet.has(eid)) {
          if (!newCluster.evidenceIds.includes(eid)) newCluster.evidenceIds.push(eid);
        } else {
          kept.push(eid);
        }
      }
      if (kept.length !== c.evidenceIds.length) {
        c.evidenceIds = kept;
        c.count = kept.length;
        oldClustersTouched.add(c);
      }
    }
    newCluster.count = newCluster.evidenceIds.length;
  }

  for (const { detector, normalizedSubject } of keysToMove) {
    corpus.aliases[aliasKey(detector, normalizedSubject)] = newId;
  }

  // Recompute sessionCount from the sidecar for the new cluster + every old cluster we moved
  // evidence off of, so sessionCount never goes stale (P2 hazard a).
  if (options.evidence) {
    newCluster.sessionCount = countSessions(newCluster.evidenceIds, options.evidence);
    for (const c of oldClustersTouched) {
      c.sessionCount = countSessions(c.evidenceIds, options.evidence);
    }
  }

  return newId;
}

/**
 * Stable evidence id from session + turn range (deterministic, so re-extraction dedups).
 * When turnRange is ABSENT, two distinct snippets from one session must NOT collapse to the
 * same id (that would silently drop one on merge), so we fall back to a short content hash
 * of the snippet instead of a constant suffix.
 */
export function evidenceId(
  sessionId: string,
  turnRange?: [number, number],
  snippet?: string,
): string {
  if (turnRange) return `${sessionId}:${turnRange[0]}-${turnRange[1]}`;
  const digest = createHash("sha256")
    .update(snippet ?? "")
    .digest("hex")
    .slice(0, 16);
  return `${sessionId}:h${digest}`;
}

/** Convenience: build an EvidenceItem with a deterministic id if none supplied. */
export function makeEvidenceItem(
  partial: Omit<EvidenceItem, "id"> & { id?: string },
): EvidenceItem {
  const id = partial.id ?? evidenceId(partial.sessionId, partial.turnRange, partial.snippet);
  return {
    id,
    sessionId: partial.sessionId,
    ts: partial.ts,
    turnRange: partial.turnRange,
    snippet: partial.snippet,
  };
}

/**
 * Read-time precedence: a user answer OUTRANKS any inferred answer (eng decision 5). Returns
 * the most authoritative answer for a cluster, or undefined if none. Among answers of the
 * same source, the most recent (by ts) wins.
 */
export function effectiveAnswer(cluster: Cluster): Cluster["answers"][number] | undefined {
  let best: Cluster["answers"][number] | undefined;
  for (const a of cluster.answers) {
    if (!best) {
      best = a;
      continue;
    }
    const bestRank = best.source === "user" ? 1 : 0;
    const aRank = a.source === "user" ? 1 : 0;
    if (aRank > bestRank) best = a;
    else if (aRank === bestRank && a.ts >= best.ts) best = a;
  }
  return best;
}

// ── Pending-question lifecycle (design "Interaction states" — orphaned pending questions) ──────

/**
 * MARK a cluster pending: a question for it was forwarded to the user (answer_open_question
 * mode:'user'). Idempotent on re-forward: if already pending, the original forwardedAt and the
 * accumulated skipCount are PRESERVED (a re-forward must not reset the queue position or undo a
 * demotion). Sets forwardedAt only when newly pending. Returns the resulting Pending record.
 * Throws if the cluster does not exist (no phantom pending state).
 */
export function markPending(
  corpus: Corpus,
  clusterId: string,
  now: string = new Date().toISOString(),
): Pending {
  const cluster = getCluster(corpus, clusterId);
  if (!cluster) throw new Error(`markPending: no cluster ${clusterId}`);
  if (!cluster.pending) {
    cluster.pending = { forwardedAt: now, skipCount: 0 };
  }
  // (already pending) -> keep forwardedAt + skipCount; a re-forward is not a reset.
  return cluster.pending;
}

/**
 * CLEAR a cluster's pending state (a confirmed source:user answer resolved it). Removes the
 * pending field entirely. Returns true if a pending record was present and cleared, false if
 * the cluster had none. Throws if the cluster does not exist.
 */
export function clearPending(corpus: Corpus, clusterId: string): boolean {
  const cluster = getCluster(corpus, clusterId);
  if (!cluster) throw new Error(`clearPending: no cluster ${clusterId}`);
  if (!cluster.pending) return false;
  delete cluster.pending;
  return true;
}

/**
 * SKIP a pending question: increment its skipCount and stamp lastSurfacedAt. A cluster skipped
 * SKIP_DEMOTE_THRESHOLD (K) or more times is DEMOTED in surfacing order (it sorts after
 * non-demoted), not removed and not nagging. Pending NEVER expires. Returns the updated Pending.
 * Throws if the cluster does not exist OR is not currently pending (you cannot skip a question
 * that was never forwarded).
 */
export function skipPending(
  corpus: Corpus,
  clusterId: string,
  now: string = new Date().toISOString(),
): Pending {
  const cluster = getCluster(corpus, clusterId);
  if (!cluster) throw new Error(`skipPending: no cluster ${clusterId}`);
  if (!cluster.pending) throw new Error(`skipPending: cluster ${clusterId} is not pending`);
  cluster.pending.skipCount += 1;
  cluster.pending.lastSurfacedAt = now;
  return cluster.pending;
}

/** True iff a pending record is DEMOTED (skipped at/above the demote threshold K). */
export function isDemoted(pending: Pending, threshold: number = SKIP_DEMOTE_THRESHOLD): boolean {
  return pending.skipCount >= threshold;
}

/**
 * Surfacing order for PENDING clusters (design: "oldest-unanswered first", with skipped-K-times
 * DEMOTED to sort after non-demoted). Returns a NEW array of the corpus's pending clusters,
 * ordered: oldest forwardedAt, then oldest firstSeen, then clusterId. Concretely: non-demoted
 * before demoted; within each band oldest forwardedAt first; on a forwardedAt collision, oldest
 * firstSeen first (a stable, meaningful cluster-age tiebreak — mirrors get_patterns, replacing the
 * arbitrary clusterId fallback); clusterId only as the last legacy guard for clusters lacking
 * firstSeen. Does NOT mutate. Used by get_pending_questions.
 */
export function orderPending(
  corpus: Corpus,
  threshold: number = SKIP_DEMOTE_THRESHOLD,
): Cluster[] {
  return corpus.clusters
    .filter((c): c is Cluster & { pending: Pending } => c.pending !== undefined)
    .sort((a, b) => {
      const aDem = isDemoted(a.pending, threshold) ? 1 : 0;
      const bDem = isDemoted(b.pending, threshold) ? 1 : 0;
      if (aDem !== bDem) return aDem - bDem; // non-demoted (0) before demoted (1)
      // oldest forwardedAt first
      if (a.pending.forwardedAt !== b.pending.forwardedAt) {
        return a.pending.forwardedAt < b.pending.forwardedAt ? -1 : 1;
      }
      // oldest firstSeen first (stable cluster age). Clusters WITH a firstSeen sort before those
      // without; among those with one, earlier wins. Mirrors get_patterns' meaningful tiebreak.
      const af = a.firstSeen;
      const bf = b.firstSeen;
      if (af !== undefined && bf !== undefined) {
        if (af !== bf) return af < bf ? -1 : 1;
      } else if (af !== undefined) {
        return -1;
      } else if (bf !== undefined) {
        return 1;
      }
      // last legacy guard for clusters lacking firstSeen
      return a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0;
    });
}
