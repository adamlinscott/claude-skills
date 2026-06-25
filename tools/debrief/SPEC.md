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
| `corpus.json` (hot file) | patterns (clusters) + themes + accumulated answers + alias index + standing-protocol state + sources | **Yes.** Evidence-free by construction — carries only `evidenceIds`, never raw snippets, and the relational facts are COUNTS, never raw paths. (One caveat: `normalizedSubject` is a bounded coarse label *derived* from turn prose — see the Identity model — so it is not strictly counts-only, though path syntax never survives it.) |
| `corpus.evidence.json` (sidecar) | raw transcript snippets + each turn's privacy-sensitive `cwd` / `gitBranch`, keyed by id | **No.** Stays local. Loaded only when a question is live (`get_evidence`) or to compute relational facts. |

This split is a privacy invariant, not a convenience: the evidence-free hot file is the
standard shape *by construction*. The single serialization choke point (`serializeCorpus`)
strips any stray snippet a malformed cluster might carry, so a hot file can never leak a raw
snippet even if an upstream bug attaches one to a cluster.

> **Caveat — before enabling sharing (E4):** the cluster `normalizedSubject` is a *bounded*
> coarse label (normalize + cap to the first N tokens of a turn), not a hash, so a short
> label CAN still contain a secret or path typed in a turn's opening words. This is accepted
> for v1 because the hot file is local and sharing is deferred. **Before the sharing feature
> ships, tighten this** — make labels prose-free (opaque/hashed + agent-assigned clean topics)
> or run a secret/path scrubber over them. Until then, do not treat the hot file as safe to
> publish unreviewed.

## Corpus locations (zero-config discovery)

The reference CLI/MCP resolve the corpus with NO path required (`src/discover.ts`):

- **Per-project (default):** `~/.debrief/projects/<project-slug>/corpus.json`, where `<project-slug>`
  is the sanitized (lowercased, non-alphanumerics collapsed to `-`) absolute project root from
  `git rev-parse --show-toplevel` (falling back to the cwd).
- **Global (`--global`):** `~/.debrief/global/corpus.json` — the cross-project roll-up.
- The evidence sidecar always lives beside the hot file (`corpus.evidence.json`).
- An explicit path argument or `--corpus <path>` overrides discovery (back-compat).

Session discovery scans `~/.claude/projects/*/*.jsonl`. For the per-project scope it keeps sessions
whose first recorded `cwd` is INSIDE the project root (path-normalized; case-insensitive on win32);
`--global` keeps all. These locations are a property of the reference implementation, not the
portable format — the `corpus.json` *shape* below is the contract, wherever the file lives.

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
  lowercase, strip non-alphanumerics, collapse whitespace). When derived from a whole turn the CLI
  additionally **BOUNDS it to the first `MAX_SUBJECT_TOKENS` (12) tokens** (`coarseSubject`) so the
  hot file holds a short bucket LABEL, not the entire message. Semantic merges are agent-driven and
  persisted as additional aliases.
  - **Privacy caveat (it is derived prose, not counts).** `normalizedSubject` is the ONE hot-file
    field derived from turn text, so — unlike the relational COUNTS — it is not snippet-free in the
    strict sense: a path/username at the very start of a turn can survive (folded) within the first
    12 tokens. What is guaranteed is that the literal path SYNTAX never survives (`coarseSubject`
    strips slashes/colons), so the hot file carries no path-SHAPED string, and the verbatim turn text
    (and full path) lives only in the sidecar snippet. Treat `normalizedSubject` as a bounded coarse
    label, not as a counts-only field.
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
- **Inferred answers are reviewable.** Because inferred answers can be silently wrong, the
  agent can list the inferred-only clusters (those whose effective answer is `source:inferred`,
  i.e. no `user` answer yet) via `get_patterns({ answeredBy: "inferred" })` and re-confirm them
  with the user ("I previously inferred X — still right?"). `answeredBy` also takes `"user"`
  (user-grounded) and `"none"` (unanswered).

## Cluster timestamps (surfacing order)

- **`firstSeen`** (optional ISO-8601) is the cluster's creation time, set ONCE and never
  changed. On a `mergeClusters` the surviving cluster keeps the EARLIER of the two `firstSeen`
  values (an absorbed older cluster's age is preserved). It is the deterministic **oldest-first
  tiebreak** for surfacing order.
- **`lastActivityAt`** (optional ISO-8601) advances whenever the cluster is touched (creation,
  new evidence merged in via `mergeCandidates`, or a `mergeClusters`). Volatile.
- Both are optional for backward-compat with pre-`firstSeen` corpora; readers MUST tolerate
  their absence.
- **`get_patterns` surfacing order:** frequency (`count`) descending, then
  unanswered-before-answered, then oldest-first by `firstSeen` (clusters lacking `firstSeen`
  sort last within that band, then `clusterId` as a final deterministic guard). Evidence-free
  and paginated.

## Pending questions (forwarded-but-unanswered)

A question forwarded to the user (`answer_open_question` mode `"user"`) becomes **pending** and
re-surfaces across sessions until answered. It is carried on the cluster as an OPTIONAL
`pending` record `{ forwardedAt, skipCount, lastSurfacedAt? }`:

- **`forwardedAt`** — when the question was first forwarded (the oldest-first sort key).
- **`skipCount`** — times the pending question has been skipped (deferred).
- **`lastSurfacedAt`** — when it was last surfaced/skipped, if ever.

Lifecycle (design "Interaction states" — orphaned pending questions):

- **Mark.** `answer_open_question` mode `"user"` MARKS the cluster pending (sets `forwardedAt`
  if new). Re-forwarding is idempotent: it PRESERVES the original `forwardedAt` and the
  accumulated `skipCount` (no reset, no undo of demotion progress).
- **Never expires.** Pending is still valid until answered; only its visibility is bounded.
- **Surface (capped).** `get_pending_questions({ limit? })` returns at most **N** pending
  clusters (default `MAX_PENDING_SURFACED` = 5), OLDEST `forwardedAt` first, evidence-free
  (summary + a pointer to `get_evidence`). The queue can't overwhelm even though pending never
  expires.
- **Demote.** A pending question skipped **K** (`SKIP_DEMOTE_THRESHOLD` = 3) or more times is
  DEMOTED in surfacing order (sorts AFTER non-demoted), not removed and not nagging.
  `skip_question({ clusterId })` increments `skipCount` + stamps `lastSurfacedAt`; it throws if
  the cluster is unknown or not currently pending.
- **Resolve.** A confirmed `source:user` answer (`submit_answer` with `source:"user"` +
  `confirmed:true`) CLEARS the pending state (removes the field). An `inferred` answer does NOT
  clear pending — the forwarded question still awaits genuine user ground truth.
- **Merge.** If either merged cluster was pending, the surviving cluster stays pending with the
  EARLIER `forwardedAt` and the MAX `skipCount` (a demotion survives a merge).

## Two tiers: clusters (Tier 1) and themes (Tier 2)

- **Tier 1 — clusters** are the narrow, answer-bearing, attributable units (the identity model
  above). Same-topic duplicates are fused conservatively via `merge_clusters` / `add_alias`.
- **Tier 2 — themes** are a NON-DESTRUCTIVE overlay that GROUPS related clusters under an abstract
  theme WITHOUT fusing them. Member clusters keep their own `count`/`answers`/`evidence` intact, and
  a cluster MAY belong to MULTIPLE themes. Themes are reversible (regroup freely; no data loss). A
  theme is itself QUESTION-ABLE at the abstract level, so it carries its OWN `answers[]` and
  `pending` (the depth step asks theme-level existential questions). Themes are **evidence-free**:
  they hold only `memberClusterIds` + `answers`, never snippets.

Each theme is `{ themeId (UUID), name, memberClusterIds[], answers[], pending?, firstSeen,
lastActivityAt }`.

- **Write path.** `group_theme({ name, clusterIds })` creates a theme or EXTENDS an existing one by
  name (idempotent member add; refuses a non-existent `clusterId`). Returns `themeId`.
- **Un-group path (reversibility).** `ungroup_theme({ themeId, clusterIds })` REMOVES clusters from a
  theme non-destructively — the cluster keeps its counts/answers/evidence and any OTHER theme
  membership. Combined with `group_theme` it MOVES a cluster between themes, making the
  "regroup freely; no data loss" property reachable over the wire. Throws on an unknown `themeId`.
- **Read path.** `get_themes({ limit?, cursor? })` returns evidence-free summaries (`name`,
  `memberCount`, `answered?`, `answerSource?`, `pending?`), paginated oldest-first.
- **Question a theme.** `answer_open_question({ themeId })` aggregates representative evidence across
  the member clusters (delimited untrusted) + the member topics and returns the depth instruction so
  the connected agent produces the theme-level question SET. `mode:'user'` marks the THEME pending.
- **Answer / pending / skip.** `submit_answer`, `get_pending_questions` (themes surface in
  `pendingThemes[]` / `totalPendingThemes`), and `skip_question` all accept a `themeId`. The
  write-poisoning guard and `user`-outranks-`inferred` precedence apply identically to themes; a
  confirmed `source:user` theme answer CLEARS the theme's pending state.

### Referential integrity (themes)

Every `memberClusterIds` entry MUST reference an existing cluster. The reference implementation
maintains this: a `merge_clusters` that absorbs `from` INTO `into` REWRITES every theme's
`from` member id to `into` (deduped), so no member id ever dangles; an outright cluster removal
drops the id from every theme.

## Kind tagging (R/O/C/Q/X taxonomy)

A cluster carries an OPTIONAL `primaryKind` and (only when a turn genuinely does two things)
`secondaryKind`, each one of `R` (redirect), `O` (observed), `C` (continue), `Q` (query), `X`
(not-a-real-turn). The CLI NEVER derives intent (CORE PRINCIPLE) — `set_cluster_kind({ clusterId,
primary, secondary? })` STORES the connected agent's classification verbatim (validated against the
enum). `get_patterns` surfaces the kind once tagged. Both fields are optional for backward-compat.

## Grouping task (the tidy-up surface)

`get_grouping_task({ limit?, clustersCursor?, themesCursor? })` returns the live
`prompts/group-themes.md` instruction text (loaded from disk, same mechanism as the depth/classify
instructions) PLUS the current evidence-free cluster and theme summaries, so the connected agent can
run the tidy-up: fuse true duplicates (`merge_clusters` / `add_alias`) and form broad themes
(`group_theme`). It also reports `totalClusters` / `totalThemes` and `clustersCursor` /
`themesCursor` so a heavy user with more than the cap (100) clusters/themes knows the consolidation
set is PARTIAL and can page the full set — otherwise true duplicates beyond the first page would be
invisible and unfusable. The tool generates nothing.

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

## Evidence item — privacy-sensitive context (`cwd` / `gitBranch`)

Each sidecar `EvidenceItem` carries `{ id, sessionId, ts?, turnRange?, cwd?, gitBranch?, snippet }`.

- **`cwd`** (optional) — the turn's working directory (the Claude Code `cwd`). It is an absolute
  path that leaks the user's home directory / username, so it is **PRIVACY-SENSITIVE**.
- **`gitBranch`** (optional) — the turn's git branch (the Claude Code `gitBranch`). Also
  privacy-sensitive (a branch name can reveal a feature/ticket).

Both live **ONLY in the sidecar** and are **NEVER copied to the hot file**. The hot file carries
only the privacy-clean COUNTS derived from them (`Cluster.relational.distinctRepos` /
`distinctBranches`). The CLI captures them from the session events onto the sidecar evidence item;
they never transit the portable surface.

## Relational facts (objective signals — facts only, no verdict)

A cluster carries an OPTIONAL `relational` rollup — objective relational FACTS the connected agent
interprets into the relational signals when it writes questions (the depth instruction references
relational signals "when available"). **The code renders NO verdict/label/threshold** ("trust
earned", "cross-domain: yes" are the LLM's calls, never the code's). It is COUNTS + TIMESTAMPS only:

```jsonc
"relational": {
  "distinctSessions": 9,   // distinct sessions the cluster's evidence spans
  "distinctRepos": 3,      // COUNT of distinct cwd values (raw paths NEVER copied to the hot file)
  "distinctBranches": 4,   // COUNT of distinct gitBranch values (raw branches NEVER copied)
  "firstTs": "<iso>",      // earliest evidence timestamp (omitted if no evidence carried a ts)
  "lastTs": "<iso>",       // latest evidence timestamp
  "occurrences": 14        // distinct evidence items (mirrors count)
}
```

- **Privacy-clean by construction.** `distinctRepos` / `distinctBranches` are the SIZES of the
  distinct-`cwd` / distinct-`gitBranch` sets; the raw values are read from the sidecar to count them
  but are never written to the hot file. So the portable hot file never leaks an absolute path.
- **Recomputed, never stale.** `computeRelational(evidenceIds, evidence)` recomputes the rollup from
  the deduped evidence union on every `mergeCandidates` (re-extraction), `mergeClusters`, and
  `splitAlias` (when given the sidecar), so the facts stay correct as evidence accumulates.
- **`firstTs` / `lastTs`** are the min / max evidence timestamps via LEXICOGRAPHIC comparison.
  PRECONDITION: this is correct only when every evidence `ts` is a UNIFORM ISO-8601 representation in
  UTC `Z` — which Claude Code emits and the parser passes through verbatim (no normalization). Mixed
  precision or a non-UTC offset would misorder near-equal instants; a future source emitting those
  must normalize to epoch before min/max. Optional — omitted when no evidence carried a `ts`. The
  whole `relational` field is optional for backward-compat (the loader tolerates its absence).
- **`occurrences`** counts only evidence items PRESENT in the sidecar (a dangling `evidenceId` is
  skipped), so it normally mirrors `count` but can be slightly LESS if an id dangles.

#### v1 scope (which T1 relational signals the facts cover)

T1 (design doc, finding 2) named THREE relational signals needed to clear "uncanny": (a)
cross-domain breadth, (b) trust-over-time, (c) counterfactual/principle acceptance. **v1's
relational facts cover cross-domain breadth + recurrence timing only** (`distinctRepos` /
`distinctBranches` + the `timeline`). **Trust-over-time and counterfactual-acceptance are
DEFERRED** — no fact is computed for them yet (the depth prompt asks for them "when available" and
tolerates their absence). Follow-up facts to compute: an assistant-reliability run-length before a
re-verify (trust-over-time), and an accepted-vs-rejected outcome on evidence (counterfactual). This
gap is tracked here rather than left silent.

### How the facts are surfaced (this is the point — the agent interprets them)

- **`get_patterns`** includes each cluster's stored `relational` rollup in the (evidence-free)
  summary.
- **`get_themes`** includes a THEME-level `relational` rollup aggregated from members' STORED
  relational facts (corpus-only, no sidecar): `occurrences` is the SUM, `firstTs`/`lastTs` the
  MIN/MAX; the `distinct*` counts are a **MAX-over-members APPROXIMATION** (without the sidecar the
  exact union — whether two members share a session/repo/branch — is not derivable; MAX is a safe
  lower bound). Because the rollup shares the `RelationalFacts` shape with the EXACT counts returned
  elsewhere, the summary carries an **in-band `relationalApprox: true`** marker (present whenever
  `relational` is) so a consuming agent treats the theme `distinct*` as a floor, not an exact value.
  The **exact union** is available via `answer_open_question({ themeId })`.
- **`answer_open_question`** (cluster OR theme) returns a `relationalFacts` object: the rollup
  COUNTS + timespan PLUS a **`timeline`** — the sorted (ascending) list of correction timestamps
  assembled from the sidecar evidence (objective; helps the agent judge "recurs after long gaps").
  For a cluster these are that cluster's facts; for a theme they are the **EXACT union** across the
  member clusters (aggregated directly from the unioned `evidenceIds` against the sidecar, so no
  approximation). NO verdict text.

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
