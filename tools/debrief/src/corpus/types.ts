/**
 * Versioned corpus schema (T3 identity + T4 store).
 *
 * Two physical files (eng decision 2):
 *   - the HOT FILE (corpus.json): patterns + answers + aliases + standing-protocol
 *     state. Small, EVIDENCE-FREE, atomic temp+rename writes, lock-free reads. The
 *     evidence-free hot file IS the privacy-clean portable/standard shape by construction.
 *   - the EVIDENCE SIDECAR (corpus.evidence.json): bulky snippets keyed by id. Never
 *     loaded for a normal corpus read; pulled only when a question is live (get_evidence).
 *
 * Identity model (eng decision 4 — SUPERSEDES patternId=hash):
 *   - `clusterId` (crypto.randomUUID) is the OPAQUE SURROGATE identity, minted once per
 *     cluster. It is the answer-bearing key. Answers travel with the clusterId, forever.
 *   - `(detector, normalizedSubject)` is a LOOKUP INDEX into clusters, never the identity.
 *   - `aliases` maps normalizedSubject -> clusterId. Re-normalize / merge / split are all
 *     index remaps; answers NEVER orphan because they hang off clusterId, not the subject.
 *
 * The word "detector" = a STRUCTURAL candidate-source label (e.g. "turn-after-completion",
 * "after-error"), NOT a lexical/intent matcher (CORE PRINCIPLE).
 */

/** Current schema version of the hot file. Bump on any breaking shape change. */
export const SCHEMA_VERSION = 1 as const;
/** Current schema version of the evidence sidecar. */
export const EVIDENCE_SCHEMA_VERSION = 1 as const;

/**
 * N — default cap on how many PENDING questions get_pending_questions surfaces per call/session
 * (design "Interaction states": "at most N surfaced per session, oldest-unanswered first").
 * The queue can't overwhelm; visibility is bounded even though pending never expires.
 */
export const MAX_PENDING_SURFACED = 5;
/**
 * K — default skip threshold. A pending question skipped K or more times is DEMOTED in surfacing
 * priority (sorts after non-demoted), not removed and not nagging (design "Interaction states").
 */
export const SKIP_DEMOTE_THRESHOLD = 3;

/** Provenance of an answer. A `user` answer outranks any `inferred` answer (eng decision 5). */
export type AnswerSource = "user" | "inferred";

/**
 * R/O/C/Q/X intent taxonomy (prompts/classify-intent.md): R=redirect, O=observed,
 * C=continue, Q=query, X=not-a-real-turn. The CLI never derives this (CORE PRINCIPLE — intent
 * is the LLM's job); it is the connected agent's classification, stored verbatim. A cluster may
 * carry a primary kind plus an optional secondary (a turn that genuinely does two things).
 */
export type Kind = "R" | "O" | "C" | "Q" | "X";

/** The set of valid kind codes (for runtime validation at the write boundary). */
export const KINDS: readonly Kind[] = ["R", "O", "C", "Q", "X"] as const;

/**
 * An accumulated answer to a cluster's open question. Question TEXT is never persisted
 * (it is an ephemeral rendering the caller reproduces on demand, design doc); the stable
 * artifact is the answer keyed by clusterId.
 */
export interface Answer {
  /** `user` = human-confirmed ground truth (outranks); `inferred` = agent-reasoned. */
  source: AnswerSource;
  text: string;
  /** ISO-8601 timestamp this answer was written. */
  ts: string;
}

/**
 * Pending-question state for a cluster (design "Interaction states" — orphaned pending
 * questions). A question forwarded to the user (answer_open_question mode:'user') becomes
 * PENDING and re-surfaces across sessions; it NEVER expires. A confirmed source:user answer
 * CLEARS it (the pending field is removed). The record hangs off the cluster (co-located with
 * answers + evidence) so it travels with the surrogate clusterId like everything else.
 */
export interface Pending {
  /** ISO-8601 timestamp the question was first forwarded to the user. The oldest-first sort key. */
  forwardedAt: string;
  /**
   * Number of times this pending question has been SKIPPED (surfaced but deferred). A cluster
   * skipped >= K times (SKIP_DEMOTE_THRESHOLD) is DEMOTED in surfacing priority (sorts after
   * non-demoted), not removed and not nagging.
   */
  skipCount: number;
  /**
   * ISO-8601 timestamp it was last SKIPPED (via skip_question), if ever. Stamped ONLY on skip —
   * get_pending_questions surfacing is a lock-free read that does NOT stamp this, so the field
   * records the last time the question was deferred, never a mere surfacing.
   */
  lastSurfacedAt?: string;
}

/**
 * A recurring behavior the miner surfaced, identified by an opaque surrogate `clusterId`.
 * Evidence SNIPPETS are NOT here — only `evidenceIds`, which key into the sidecar.
 */
export interface Cluster {
  /** Opaque surrogate UUID. The answer-bearing identity. Minted once, never derived. */
  clusterId: string;
  /** Structural candidate-source label (e.g. "after-error"). NOT a lexical matcher. */
  detector: string;
  /** Coarse deterministic CLI-derived subject. The current INDEX key; may be re-keyed. */
  normalizedSubject: string;
  /** Short human-readable description of the behavior. */
  summary: string;
  /**
   * Primary R/O/C/Q/X kind for this cluster (the connected agent's classification, never the
   * CLI's — CORE PRINCIPLE). OPTIONAL: absent until an agent tags it via set_cluster_kind.
   */
  primaryKind?: Kind;
  /**
   * Optional SECONDARY kind, set ONLY when the turn(s) genuinely do two things (e.g. C+O:
   * "looks good, but the login page 403s"). Omitted otherwise.
   */
  secondaryKind?: Kind;
  /** Total occurrences across all sessions. Volatile; grows on re-extraction. */
  count: number;
  /** Number of distinct sessions the behavior appeared in. Volatile. */
  sessionCount: number;
  /** Keys into the evidence sidecar. Snippets themselves live there, not here. */
  evidenceIds: string[];
  /**
   * Optional cached question text. NORMALLY ABSENT — questions are regenerated by the
   * connected LLM via the return-instruction. Present only if a caller chose to cache one.
   */
  question?: string;
  /** Accumulated answers (user + inferred). A user answer outranks inferred at read time. */
  answers: Answer[];
  /**
   * True iff this cluster is the TARGET of an agent-driven semantic merge (eng decisions 5 &
   * 8): it absorbed another cluster's aliases + evidence + answers. get_patterns surfaces this
   * so a connected agent can distinguish a merged cluster from a raw (CLI-coarse) one. Absent
   * (or false) on raw clusters. Merges are revisitable, not append-only-calcified.
   */
  merged?: boolean;
  /**
   * Pending-question state. PRESENT iff a question for this cluster has been forwarded to the
   * user (answer_open_question mode:'user') and not yet resolved by a confirmed source:user
   * answer. Re-surfaces across sessions (never expires); CLEARED (field removed) when the user
   * answers. Absent on clusters with no outstanding forwarded question.
   */
  pending?: Pending;
  /**
   * ISO-8601 timestamp the cluster was first created (minted). STABLE — set once and never
   * changed, even on merge (the surviving target keeps the EARLIER firstSeen of the two). Used
   * as the deterministic oldest-first tiebreak in surfacing order (get_patterns), replacing the
   * arbitrary clusterId tiebreak. Optional for backward-compat with pre-firstSeen corpora.
   */
  firstSeen?: string;
  /**
   * ISO-8601 timestamp of the last activity that touched this cluster (creation, new evidence
   * merged in, or a merge). Volatile; advances over the cluster's life. Optional for backward-
   * compat with pre-lastActivityAt corpora.
   */
  lastActivityAt?: string;
}

/**
 * TIER 2 — a broad THEME (group-themes.md "broad themes" job). A NON-DESTRUCTIVE overlay that
 * GROUPS related clusters under an abstract theme WITHOUT fusing them: member clusters keep their
 * own counts/answers/evidence intact and a cluster MAY belong to MULTIPLE themes. Themes are
 * reversible (regroup freely; no data loss). A theme is itself QUESTION-ABLE at the abstract
 * level, so it carries its OWN answers[] + pending (the depth step asks theme-level existential
 * questions) — mirroring clusters.
 *
 * Themes are EVIDENCE-FREE: they hold only memberClusterIds + answers, never snippets. Aggregated
 * evidence is pulled on demand by walking the member clusters into the sidecar, never stored here.
 */
export interface Theme {
  /** Opaque surrogate UUID (crypto.randomUUID). Stable identity; answers hang off it. */
  themeId: string;
  /** Short human-readable theme name (e.g. "insists the code tells the truth"). */
  name: string;
  /**
   * The clusters grouped under this theme. A non-destructive reference set: clusters keep their
   * own identity/answers/evidence and may also belong to other themes. Deduped; a removed cluster
   * (merge/removal) is rewritten/dropped here so no member id ever dangles.
   */
  memberClusterIds: string[];
  /** Accumulated theme-level answers (user + inferred). user outranks inferred at read time. */
  answers: Answer[];
  /**
   * Theme-level pending-question state. Present iff a THEME question was forwarded to the user
   * (answer_open_question mode:'user' on this themeId) and not yet resolved. Mirrors Cluster.pending.
   */
  pending?: Pending;
  /** ISO-8601 timestamp the theme was created. Stable; the oldest-first surfacing tiebreak. */
  firstSeen: string;
  /** ISO-8601 timestamp of the last activity touching this theme (create, regroup, answer). */
  lastActivityAt: string;
}

/**
 * Standing-protocol state (eng decision 7): inferred protocols / hypotheses about how the
 * developer works, carried so the depth instruction can push on standing hypotheses
 * instead of re-deriving surface questions each session. The strictly-better-each-session
 * artifact is accumulated protocols + resolved tensions, NOT answer count.
 */
export interface StandingProtocol {
  /** Opaque surrogate id for this hypothesis (UUID), so it too is stably referenceable. */
  protocolId: string;
  /** The inferred protocol/hypothesis, e.g. "verifies AI output against the running system". */
  hypothesis: string;
  /** Confidence in [0,1]. Agent-maintained; the CLI never computes intent-bearing values. */
  confidence: number;
  /** Open contradictions / tensions observed against this hypothesis, still unresolved. */
  openContradictions: string[];
  /** clusterIds this hypothesis was inferred from (provenance back into the evidence graph). */
  supportingClusterIds: string[];
  /** ISO-8601 timestamp last updated. */
  updatedAt: string;
}

/**
 * A reserved ingestion source slot. v1 populates "claude-sessions" / "claude-memory";
 * the "git" slot is reserved but unpopulated (design doc, Open Questions).
 */
export interface Source {
  /** Source kind, e.g. "claude-sessions", "claude-memory", "git" (reserved). */
  kind: string;
  /** Optional free-form locator (path, repo, etc.). */
  ref?: string;
}

/**
 * The HOT FILE. Small, evidence-free, atomically written. This is the portable/standard
 * shape: it contains no raw snippets, so sharing it never leaks transcript content.
 */
export interface Corpus {
  /** Hot-file schema version. */
  schemaVersion: number;
  /** ISO-8601 timestamp of the last write. */
  generatedAt: string;
  /** Ingestion sources (with a reserved "git" slot). */
  sources: Source[];
  /** The mined clusters (patterns), keyed internally by clusterId. */
  clusters: Cluster[];
  /**
   * Alias index: composite (detector, normalizedSubject) key -> clusterId (see aliasKey()
   * in identity.ts — the key joins detector and normalizedSubject with a NUL byte so two
   * structurally-distinct detectors never collide). The LOOKUP layer that makes identity
   * survive re-normalization / merge / split. Many keys may point at one clusterId (a
   * merge); a split mints a new clusterId and re-points some keys at it. NOT the identity —
   * answers hang off clusterId, so a remap here never orphans an answer.
   */
  aliases: Record<string, string>;
  /** Standing-protocol hypotheses (eng decision 7). */
  protocols: StandingProtocol[];
  /**
   * TIER 2 — broad THEMES: a non-destructive overlay grouping related clusters (Tier 1) under
   * abstract, question-able themes. Optional for backward-compat with pre-themes corpora (the
   * loader defaults it to []); evidence-free by construction (themes carry no snippets).
   */
  themes: Theme[];
}

/** One stored evidence snippet, keyed by id, living only in the sidecar. */
export interface EvidenceItem {
  /** Stable id referenced by Cluster.evidenceIds. */
  id: string;
  /** The session this snippet came from. */
  sessionId: string;
  /** ISO-8601 timestamp of the underlying turn, if known. */
  ts?: string;
  /** Session-local turn indices [start, end] the snippet spans, if known. */
  turnRange?: [number, number];
  /** The raw snippet text (bulky; never enters the hot file). */
  snippet: string;
}

/** The EVIDENCE SIDECAR file shape. */
export interface EvidenceStore {
  /** Sidecar schema version. */
  schemaVersion: number;
  /** Snippets keyed by EvidenceItem.id. */
  items: Record<string, EvidenceItem>;
}

/**
 * A freshly-mined candidate cluster, BEFORE it is reconciled against the existing corpus.
 * The miner produces these; mergeCandidates() resolves each to a clusterId (existing or
 * new) and folds it in without clobbering accumulated answers.
 */
export interface CandidateCluster {
  detector: string;
  normalizedSubject: string;
  summary: string;
  count: number;
  sessionCount: number;
  /** Evidence to attach. Snippets go to the sidecar; only ids land on the cluster. */
  evidence: EvidenceItem[];
}

/** Build an empty, well-formed hot file. */
export function emptyCorpus(now: string): Corpus {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    sources: [],
    clusters: [],
    aliases: {},
    protocols: [],
    themes: [],
  };
}

/** Build an empty, well-formed evidence sidecar. */
export function emptyEvidenceStore(): EvidenceStore {
  return { schemaVersion: EVIDENCE_SCHEMA_VERSION, items: {} };
}
