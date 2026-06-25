/**
 * Merge-not-clobber reconciliation (T4, eng decision 5). Re-running the extractor must
 * PRESERVE accumulated answers. mergeCandidates folds freshly-mined candidates into the
 * existing corpus + evidence sidecar:
 *   - resolveOrCreateCluster() maps each candidate to a clusterId (existing or new) via the
 *     (detector, normalizedSubject) alias index, so re-extraction lands in the SAME bucket;
 *   - new evidence is unioned/deduped into cluster.evidenceIds (by deterministic evidenceId)
 *     and written to the sidecar;
 *   - count = number of distinct evidenceIds; sessionCount = number of distinct sessions
 *     across that evidence (recomputed from the union, so re-merging the same session never
 *     double-counts);
 *   - cluster.answers[] is NEVER touched — accumulated source:user / source:inferred answers
 *     survive re-extraction, keyed forever by the surrogate clusterId.
 */

import type { Corpus, EvidenceStore, CandidateCluster, EvidenceItem } from "./types.js";
import { resolveOrCreateCluster, makeEvidenceItem, countSessions } from "./identity.js";

/** Summary of one merge pass (for CLI progress / tests). */
export interface MergeResult {
  clustersTouched: number;
  clustersCreated: number;
  evidenceAdded: number;
}

/**
 * Fold candidates into the corpus + sidecar in place. Pure data, LLM-free. Returns a small
 * summary. Answers are preserved by construction (resolveOrCreateCluster returns the live
 * cluster object and we only ever append to evidence + recompute counts).
 */
export function mergeCandidates(
  corpus: Corpus,
  evidence: EvidenceStore,
  candidates: CandidateCluster[],
): MergeResult {
  const result: MergeResult = { clustersTouched: 0, clustersCreated: 0, evidenceAdded: 0 };
  const touched = new Set<string>();

  for (const cand of candidates) {
    const before = corpus.clusters.length;
    const cluster = resolveOrCreateCluster(corpus, cand.detector, cand.normalizedSubject, cand.summary);
    if (corpus.clusters.length > before) result.clustersCreated += 1;

    // Keep a refreshed summary on re-extraction (summary is descriptive, not identity).
    if (cand.summary) cluster.summary = cand.summary;

    const existingIds = new Set(cluster.evidenceIds);
    for (const ev of cand.evidence) {
      const item: EvidenceItem = makeEvidenceItem(ev);
      // Write the snippet to the sidecar (idempotent: same id overwrites with same content).
      evidence.items[item.id] = item;
      if (!existingIds.has(item.id)) {
        cluster.evidenceIds.push(item.id);
        existingIds.add(item.id);
        result.evidenceAdded += 1;
      }
    }

    // Recompute counts from the deduped union so a re-merge of the same session is idempotent.
    cluster.count = cluster.evidenceIds.length;
    cluster.sessionCount = countSessions(cluster.evidenceIds, evidence);

    touched.add(cluster.clusterId);
  }

  result.clustersTouched = touched.size;
  return result;
}
