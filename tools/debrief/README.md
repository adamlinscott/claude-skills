# debrief

Debrief your AI coding sessions. `debrief` mines a developer's Claude Code session
logs for recurring moments where they corrected or redirected the AI, clusters them
into evidence-backed patterns, and exposes them over MCP so a connected agent can ask
open "why" questions and infer the developer's underlying engineering protocols.

Status: **early build** (skeleton + verified extractor). Greenfield, cross-platform,
no Docker, no Git Bash. Design docs live under `~/.gstack/projects/adamlinscott-claude-skills/`.

## Why

Every fresh AI session is a blank slate; you re-explain how you work. `debrief` builds
a portable, local corpus of how you actually work and feeds it back to the model. Two
consumers share one engine:
- **B (MCP server):** a fresh agent interrogates the corpus and asks/answers open questions.
- **C (rules file):** a regenerable `CLAUDE.md` expressing your underlying principles.

The tool **never calls an LLM itself** — it returns patterns + evidence + a depth
instruction and borrows the connected agent's reasoning.

## Locked architecture (eng review, 2026-06-24)

1. Question-gen = **return-instruction** (MCP sampling rejected — deprecated 2026-07-28).
2. Corpus store = **JSON hot file + evidence sidecar**; the evidence-free hot file is
   the privacy-clean portable shape. Reads take no writer lock.
3. Identity = **opaque surrogate `clusterId` (UUID)**; `(detector, normalizedSubject)`
   is a lookup index, never the identity. (No content-hash patternId.)
4. **Intent is the LLM's job, never hardcoded.** The CLI emits high-recall candidates by
   STRUCTURE only (a human turn after an assistant completion/tool_use; `tool_result.is_error`)
   and the **connected LLM classifies intent** (correction / bug-report / approval / question)
   and generates the "why" questions. No keyword/regex/valence matching, not even a first
   draft — the T2 spike proved lexical intent-matching fails (31-51% unclassifiable, broken
   by curly apostrophes). `src/extract/parse.ts` is structural-only; it reads no intent.
5. Corpus carries **standing-protocol state** (hypotheses + open contradictions) so depth
   compounds across sessions instead of re-litigating questions.

## Verified schema (T1 spike, CC 2.1.181)

Confirmed against real sessions, NOT assumed:
- Each `.jsonl` line is one event with a `type`. Skip non-message types: `mode`,
  `permission-mode`, `last-prompt`, `file-history-snapshot`, `queue-operation`,
  `attachment`, `ai-title`, `system`.
- `user.message.content` is an **array** of blocks in real sessions
  (`text`, `tool_result`), but can be a **string** in lighter sessions. Handle both.
- `origin` is often **absent**; `isMeta` is often **undefined** (not `false`). Gate on
  `isMeta !== true`, never on `origin.kind`.
- Human turns = `type:"user"` + a `text` block + not `tool_result`-only + text not
  starting with `<` (slash-command/caveat machinery).
- `tool_result.is_error` is a free "the AI's action failed" signal (often precedes a correction).
- `parentUuid` chains turns → use it to find the assistant turn before a user turn
  (the after-completion gate). `version` per event → format-drift detection.

See `src/extract/parse.ts` for the implementation and `test/parse.test.ts` for fixtures
built from real turns.

## Corpus format (the product)

The versioned `corpus.json` format is the public contract. See `SPEC.md` and the JSON
Schemas (`corpus.schema.json`, `corpus.evidence.schema.json`). Two files:

- **hot file** (`corpus.json`) — patterns + answers + alias index + standing-protocol
  state. Evidence-FREE by construction (only `evidenceIds`, never snippets); this is the
  portable/standard shape. Atomic temp+rename writes; lock-free reads.
- **evidence sidecar** (`corpus.evidence.json`) — raw snippets keyed by id; stays local.

Identity is an opaque surrogate `clusterId`; `(detector, normalizedSubject)` is a lookup
index (the `aliases` map). Re-extraction MERGES (never clobbers): `source:user` answers
survive forever, keyed by `clusterId`. A `user` answer outranks any `inferred` one.

## Develop

```bash
cd tools/debrief
npm install
npm test          # node --test (extractor + corpus identity/store/merge/access/schema/cli)
npm run dev       # run the CLI
npm run build     # tsc -> dist/
```

## CLI

### Zero-config discovery (no paths required)

Every corpus-bearing command resolves the corpus automatically:
- **default = the CURRENT PROJECT** — `~/.debrief/projects/<project-slug>/corpus.json` (+ a
  `.evidence.json` sidecar beside it). The project root is `git rev-parse --show-toplevel`
  (falling back to the cwd).
- **`--global`** — the cross-project roll-up at `~/.debrief/global/corpus.json`.
- An explicit positional path (back-compat) or `--corpus <path>` always overrides.

`debrief corpus` (no args) discovers this project's sessions by scanning
`~/.claude/projects/*/*.jsonl` and keeping the ones whose recorded `cwd` is inside the project
root, then merges them ALL into the resolved corpus. `--global` keeps every session. See
`src/discover.ts`.

```bash
debrief extract <session.jsonl>                 # structural candidate stats (no write)
debrief corpus  [session.jsonl] [corpus.json]   # merge candidates -> hot file + sidecar (zero-config; --global)
debrief show    [corpus.json]                    # print the evidence-free hot file summary (--global)
debrief serve   [corpus.json]                    # start the MCP stdio server (alias: mcp) (--global)
```

### Skill-friendly subcommands (wrap the SAME handlers as the MCP server)

These call the exact pure functions in `src/mcp/handlers.ts` (no logic duplication) and print
JSON to stdout, so a skill can drive the whole loop from bash with no paths and no MCP
registration. All honor the zero-config / `--global` / `--corpus` resolution above.

```bash
debrief patterns                                 # evidence-free pattern summaries (get_patterns)
debrief themes                                   # evidence-free theme summaries (get_themes)
debrief evidence <clusterId|themeId>             # delimited untrusted evidence (get_evidence)
debrief ask <clusterId|themeId> [--mode self|user]   # return-instruction payload (answer_open_question)
debrief answer <id> "<text>" [--source user --confirmed]  # write an answer (submit_answer; user GATED on --confirmed)
debrief grouping-task                            # tidy-up instruction + summaries (get_grouping_task)
debrief group <name> <clusterId...>              # create/extend a theme (group_theme)
debrief ungroup <themeId> <clusterId...>         # remove clusters from a theme (ungroup_theme)
debrief merge <fromClusterId> <intoClusterId>    # semantic merge (merge_clusters)
debrief add-alias <normalizedSubject> <clusterId>  # lighter merge (add_alias)
debrief set-kind <clusterId> <R|O|C|Q|X> [secondary]  # tag intent (set_cluster_kind)
debrief pending                                  # forwarded-but-unanswered questions (get_pending_questions)
debrief skip <clusterId|themeId>                 # defer a pending question (skip_question)
debrief record-protocol "<statement>" [--confidence 0..1]  # record a standing protocol (record_protocol)
debrief export-rules                             # material + synthesis instruction for a CLAUDE.md (export_rules_file)
```

The reference skill at `skills/debrief/SKILL.md` (BETA) drives this loop end to end.

## MCP server

`debrief serve [corpus.json]` (alias `debrief mcp`) stands up a stdio MCP server over the
corpus. It speaks JSON-RPC on stdout (startup chatter stays on stderr) and exposes **fifteen
tools**. The tool never calls an LLM — read/return tools hand context + the depth/classify
instructions back to the connected agent to reason with, and the write tools persist only
what the agent supplies:

- `get_patterns({ detector?, answered?, answeredBy?, minCount?, limit?, cursor? })` —
  evidence-free pattern summaries, paginated. `minCount` applies a minimum-occurrence bar
  (surface a few sharp patterns, not many noisy ones). `answeredBy:'inferred'` lists the
  inferred-only clusters you can re-confirm with the user ("I previously inferred X — still
  right?"); `'user'` lists user-grounded; `'none'` lists unanswered. Each summary carries
  `merged` when the cluster is an agent-merged one and `pending` when a question for it has been
  forwarded to the user. Surfacing order: frequency (count) first, then unanswered-before-answered,
  then oldest-first by `firstSeen`.
- `get_evidence({ clusterId })` — full evidence for one cluster; each snippet is wrapped in
  nonce delimiters and labelled untrusted data.
- `answer_open_question({ clusterId, mode? })` — returns the evidence bundle + the
  depth/classify instructions (loaded live from `prompts/`) + the corpus's `standingProtocols`
  for the agent to reason with. `mode:'user'` forwards (`status: pending-user`) with the same
  material so the agent can regenerate the open question and surface it — and MARKS the cluster
  pending so it re-surfaces across sessions (via `get_pending_questions`) until answered.
- `submit_answer({ clusterId, text, source?, confirmed? })` — writes an answer; `source:user`
  is honored only with `confirmed:true`, otherwise downgraded to `inferred`. A confirmed
  `source:user` answer CLEARS the cluster's pending state (resolves the forwarded question).
- `get_pending_questions({ limit? })` — lists forwarded-but-unanswered questions, OLDEST-first,
  capped at N (default 5), with questions skipped >= K (3) times DEMOTED (sorted last, never
  removed/nagging). Evidence-free: each entry carries a summary + a pointer to `get_evidence`.
  Pending never expires.
- `skip_question({ clusterId })` — defer a pending question (increments its skip count; demotes
  after K skips). Throws if the cluster is unknown or not currently pending.
- `merge_clusters({ fromClusterId, intoClusterId })` — agent-driven semantic merge: absorb one
  cluster into another (re-points aliases, unions evidence, moves answers with user still
  outranking inferred, recomputes counts, flags the target `merged:true`).
- `add_alias({ normalizedSubject, clusterId })` — lighter merge: point a semantically-equivalent
  subject at an existing cluster (detector inherited from the target; refuses unknown ids).
- `record_protocol({ statement, confidence, contradicts?, protocolId?, supportingClusterIds? })`
  — append/update a standing protocol (hypothesis + confidence + open contradictions). Stores
  what you supply; never generates protocols with an LLM.
- `export_rules_file()` — returns summaries + answers + a synthesis instruction for the agent
  to author a `CLAUDE.md` (consumer C).
- `set_cluster_kind({ clusterId, primary, secondary? })` — tag a cluster's R/O/C/Q/X kind
  (R=redirect, O=observed, C=continue, Q=query, X=not-a-real-turn). Stores the connected agent's
  classification verbatim (the CLI never derives intent); `get_patterns` surfaces it once tagged.
- `get_grouping_task({ limit?, clustersCursor?, themesCursor? })` — the tidy-up surface: returns the
  live `prompts/group-themes.md` instruction PLUS the current evidence-free cluster and theme
  summaries so the agent can consolidate the corpus. Reports `totalClusters` / `totalThemes` and
  paging cursors so a >100-item set is never silently truncated.

**Tier-2 themes overlay.** Themes are a NON-DESTRUCTIVE overlay that GROUPS related clusters under
an abstract theme WITHOUT fusing them — member clusters keep their own counts/answers/evidence and a
cluster MAY belong to multiple themes, so themes are fully reversible (regroup freely; no data loss).
A theme is itself QUESTION-ABLE at the abstract level: it carries its own `answers[]` and `pending`,
so `answer_open_question`, `submit_answer`, `get_pending_questions`, and `skip_question` all accept a
`themeId` (theme-level existential questions), with the same write-poisoning guard and
`user`-outranks-`inferred` precedence as clusters.

- `group_theme({ name, clusterIds })` — create a theme grouping related clusters, or EXTEND an
  existing theme by name (idempotent member add; refuses a non-existent `clusterId`). Returns `themeId`.
- `ungroup_theme({ themeId, clusterIds })` — the reverse: REMOVE clusters from a theme
  (non-destructive — the cluster keeps its data and any other theme membership). Combine with
  `group_theme` to MOVE a cluster between themes. This is what makes "regroup freely" reachable.
- `get_themes({ limit?, cursor? })` — evidence-free theme summaries (`name`, `memberCount`,
  `answered?`, `answerSource?`, `pending?`), paginated oldest-first.

Register it with Claude Code. This is an early build (not yet on npm), so register the locally
installed binary at **user scope** (`-s user`) so the zero-config server is available in every
project — `debrief serve` re-resolves the per-project corpus from its launch cwd:

```bash
# after `node install.mjs --beta` (which npm-links the global `debrief`):
claude mcp add -s user debrief -- debrief serve

# or point straight at the built CLI (no npm link needed):
claude mcp add -s user debrief -- node "<repo>/tools/debrief/dist/cli.js" serve
```

…or the equivalent config block (e.g. `.mcp.json` / `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "debrief": {
      "command": "debrief",
      "args": ["serve"]
    }
  }
}
```

Once published to npm, the install-free form will be `claude mcp add -s user debrief -- npx -y @adamlinscott/debrief serve`.

The two instruction files under `prompts/` are read **live** per `answer_open_question` call
(short-TTL cache): edit a prompt and a running server picks it up — no rebuild, no restart.

## Install as a repo skill (BETA)

From the repo root, `install.mjs` links skills into `~/.claude/skills`. A **normal** run is
unchanged and **skips** the `debrief` skill. The `--beta` flag opts in and sets up the tool:

```bash
node install.mjs --beta            # link the debrief skill, npm install + build the tool,
                                   # npm link the global `debrief` command, and best-effort
                                   # `claude mcp add -s user debrief -- debrief serve`
node install.mjs --beta --uninstall   # undo the link + best-effort `claude mcp remove -s user debrief`
```

Every step is idempotent. If the `claude` CLI is absent, `--beta` prints manual MCP-registration
instructions instead of failing. The skill itself needs NO MCP registration — it drives the CLI.

## Build order (from eng review)

Done: `.jsonl` format spike, structural candidate source, corpus identity (T3) + store
(T4: hot file + evidence sidecar, atomic writes, merge-not-clobber), the versioned format
(`SPEC.md` + JSON Schema), the Tier-2 themes overlay (non-destructive grouping), and the MCP
server (`get_patterns` / `get_evidence` / `answer_open_question` / `submit_answer` /
`export_rules_file` / `merge_clusters` / `add_alias` / `record_protocol` /
`get_pending_questions` / `skip_question` / `group_theme` / `ungroup_theme` / `get_themes` /
`set_cluster_kind` / `get_grouping_task`, via `debrief serve`).
Next: the corrections metric. Full task list:
`~/.gstack/projects/adamlinscott-claude-skills/tasks-eng-review-*.jsonl`.
