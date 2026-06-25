# debrief corpus — versioned format specification (v1)

This document is the public contract for the `corpus.json` format. The `debrief` MCP server
and CLI are the reference implementation; the format is the product (CEO plan E1). A
JSON Schema accompanies this prose:

- `corpus.schema.json` — the hot file (this is the portable/standard shape).
- `corpus.evidence.schema.json` — the evidence sidecar (local only, never shared).

The TypeScript source of truth for the shapes is `src/corpus/types.ts`; the JSON Schemas
are kept byte-for-byte consistent with it and a test validates a corpus against them.

## Two files, one corpus

| File | Contents | Portable? |
|------|----------|-----------|
| `corpus.json` (hot file) | patterns (clusters) + accumulated answers + alias index + standing-protocol state + sources | **Yes.** Evidence-free by construction — carries only `evidenceIds`, never snippets. Sharing it leaks no transcript. |
| `corpus.evidence.json` (sidecar) | raw transcript snippets keyed by id | **No.** Stays local. Loaded only when a question is live (`get_evidence`). |

This split is a privacy invariant, not a convenience: the evidence-free hot file is the
standard shape *by construction*. The single serialization choke point (`serializeCorpus`)
strips any stray snippet a malformed cluster might carry, so a hot file can never leak a raw
snippet even if an upstream bug attaches one to a cluster.

## Versioning

- `schemaVersion` (hot file) and `schemaVersion` (sidecar) are independent integers, both
  `1` in v1.
- A reader that encounters an unknown `schemaVersion` MUST surface a recoverable error and
  MUST NOT silently migrate or overwrite the file (the reference implementation raises
  `CorpusReadError` with `kind: "schema"`).
- A reader that encounters a structurally JSON-valid file whose ELEMENT shapes violate the
  schema (e.g. a cluster missing required fields, a wrong-typed `count`) MUST surface a
  recoverable error and MUST NOT load it silently (the reference implementation validates the
  parsed corpus against `corpus.schema.json` with Ajv and raises `CorpusReadError` with
  `kind: "corrupt"`). Absent top-level collections are defaulted (a sparse-but-valid file
  loads); only element-shape drift is rejected.
- A `git` source slot is reserved in `sources` but unpopulated in v1.

### `Source.ref` MUST be a non-identifying logical locator

`Source.ref` is an OPTIONAL free-form locator. Because the hot file is the portable/standard
shape that may be shared, `Source.ref` MUST be a **non-identifying logical locator** (e.g.
`"claude-sessions"`, a tool/source name, or a repo slug) — **never an absolute filesystem
path** (e.g. `C:/Users/<name>/.claude/projects`). An absolute path leaks the user's home
directory and username and would break the "sharing the hot file leaks nothing identifying"
invariant. Producers populating `Source.ref` are responsible for keeping it path-free and
non-identifying.

## Read/durability rules (reference implementation)

- **Atomic writes.** Writes serialize, write to a unique same-directory temp file, then
  `fs.rename` over the target. `rename` is atomic on a single filesystem, so an interrupted
  write leaves either the old complete file or the new complete file — never a half-written
  one, and never an orphaned temp file under normal completion.
- **Lock-free reads.** Reads take no writer lock. A read that races a write observes either
  the pre-rename or the post-rename file; both are complete. (This is what lets a
  long-running MCP server read while the CLI miner writes, and vice versa.)
- **Cold start.** A missing OR empty/whitespace-only file is treated as a fresh empty
  corpus, not an error.
- **Corruption.** Unparseable or ill-shaped JSON (including a truncated trailing line from a
  crash mid-write) is surfaced as a recoverable error, never a raw crash.

## Identity model (the load-bearing design)

- **`clusterId` is the identity.** An opaque surrogate UUID, minted once per cluster, never
  derived from text or evidence. Answers hang off the `clusterId`, forever.
- **`(detector, normalizedSubject)` is a lookup INDEX, not the identity.** The `aliases` map
  is keyed by a composite of `detector` and `normalizedSubject` (joined with a NUL byte, so
  two structurally-distinct detectors that normalize to the same subject never collide) and
  maps to a `clusterId`.
- **`detector`** is a STRUCTURAL candidate-source label (e.g. `after-error`,
  `turn-after-completion`), never a lexical/intent matcher. Intent classification is the
  connected LLM's job, never the CLI's.
- **`normalizedSubject`** is a cheap, deterministic, coarse CLI rule (Unicode NFKC fold,
  lowercase, strip non-alphanumerics, collapse whitespace). Semantic merges are agent-driven
  and persisted as additional aliases.
- **Re-normalize / merge / split are all index remaps.** Because answers key off
  `clusterId`, improving the normalizer (the inevitable "normalizer churn") never orphans an
  accumulated answer.
  - **alias** = `addAlias` points another `(detector, normalizedSubject)` at an existing
    `clusterId`. The reference implementation refuses to alias to a non-existent `clusterId`
    (poisoning guard). Surfaced over MCP as `add_alias({ normalizedSubject, clusterId })` (the
    detector is inherited from the target cluster).
  - **merge** = `mergeClusters` absorbs one whole cluster INTO another (the agent-driven
    semantic merge of two clusters the coarse normalizer kept apart): it re-points the
    from-cluster's aliases at the target, unions/dedups `evidenceIds`, MOVES the from-cluster's
    `answers[]` onto the target (a `user` answer still outranks `inferred` at read time),
    recomputes `count`/`sessionCount` from the sidecar, removes the from-cluster, and flags the
    target **`merged: true`**. Surfaced over MCP as
    `merge_clusters({ fromClusterId, intoClusterId })`; unknown ids and self-merge throw.
  - **split** = `splitAlias` mints a new `clusterId`, **eagerly creates a real cluster object
    for it** (so no live alias ever dangles), re-points the named keys, and optionally
    migrates a chosen subset of `evidenceIds` to the new cluster. The old cluster keeps its
    answers; the new one starts clean. When given the evidence sidecar it recomputes
    `sessionCount` for BOTH the old and new clusters (so neither goes stale). It **refuses to
    split a cluster's OWN representative `(detector, normalizedSubject)`** without a replacement
    subject — doing so would re-point the cluster's own lookup at the new id and orphan its
    `source:user` answers; pass a replacement subject (keyed by the old `clusterId`) to re-key
    the representative safely.
- **`merged`** is an OPTIONAL boolean on a cluster, set only on the TARGET of a
  `mergeClusters`. `get_patterns` surfaces it so a connected agent can distinguish a merged
  cluster from a raw (CLI-coarse) one. Merges are revisitable, not append-only-calcified.

### Referential integrity

Every value in `aliases` MUST reference an existing `clusterId` in `clusters`. The reference
implementation maintains this invariant (split creates the cluster eagerly; merge validates
the target). A reader encountering a dangling alias should treat it as best-effort corruption
recovery: the binding can be restored under the same id, but answers that lived on a lost
cluster object cannot be recovered (answers are stored inline on the cluster, not
independently keyed).

## Answers and precedence

- Each cluster accumulates `answers[]` of `{ source: "user" | "inferred", text, ts }`.
- **A `user` answer outranks any `inferred` answer.** Among answers of the same source, the
  most recent (`ts`) wins. `effectiveAnswer(cluster)` implements this read-time precedence.
- **Question text is NOT persisted.** It is an ephemeral rendering the connected LLM
  reproduces on demand. The stable artifact is the answer, keyed by `clusterId`. (`question`
  is an optional cache slot, normally absent.)

## Standing protocols (deepens over time)

The corpus carries `protocols[]`: accumulated hypotheses about how the developer works, each
with a `confidence` in `[0,1]`, `openContradictions[]`, and `supportingClusterIds[]`. These
make the self-model "deepen over time" — the depth instruction is **parameterized by this
state** so each session pushes on standing hypotheses/tensions instead of re-deriving surface
questions.

- **Write path.** `record_protocol({ statement, confidence, contradicts?, protocolId?,
  supportingClusterIds? })` appends a new protocol (minting a `protocolId`) or, when an
  existing `protocolId` is supplied, updates it in place (no duplicate). `confidence` is
  clamped to `[0,1]`. **The tool STORES what the connected agent supplies — it never generates
  protocols with an LLM.**
- **Read path.** `answer_open_question` returns the current `standingProtocols` in its result
  and references them in its instruction, so the connected agent reasons against them.

## Merge-not-clobber (re-extraction)

Re-running the extractor must preserve accumulated answers. `mergeCandidates`:

1. resolves each candidate to a `clusterId` via the alias index (re-extraction lands in the
   SAME bucket);
2. unions/dedups evidence into `evidenceIds` (by deterministic `evidenceId`) and writes
   snippets to the sidecar;
3. recomputes `count` (distinct evidence) and `sessionCount` (distinct sessions) from the
   deduped union, so re-merging the same session is idempotent (no double-count);
4. **never touches `answers[]`** — `source:user` and `source:inferred` answers survive
   re-extraction.

## Evidence ids

`evidenceId(sessionId, turnRange?, snippet?)` is deterministic so re-extraction dedups:
- with a `turnRange`: `"<sessionId>:<start>-<end>"`;
- without a `turnRange`: `"<sessionId>:h<16-hex-of-sha256(snippet)>"` — a content hash, so
  two distinct no-range snippets from one session do NOT collide (which would silently drop
  one on merge).

## Security model (v1) — the corpus is untrusted

- **Injection-in.** `get_evidence` wraps each snippet in begin/end delimiters carrying a
  fresh per-call nonce and labels the content as untrusted DATA, not instructions, so a
  snippet cannot forge a closing delimiter to break out and a calling agent never executes
  adversarial snippet text.
- **Write poisoning.** `submit_answer` never silently records `source:"user"`. A user-trust
  answer requires an explicit `confirmed: true`; absent it, the answer is recorded
  `source:"inferred"` (lower trust). A write to a non-existent cluster is refused (no
  phantom-answer fabrication).

## Caller responsibility

`summary`, `answer.text`, and (the optional) `question` are free-form strings that are part
of the portable surface. The format guarantees the hot file carries no raw evidence
*snippet*, but it cannot guarantee a caller did not paste snippet content into a summary or
answer. Keeping those snippet-free is the caller's responsibility.
