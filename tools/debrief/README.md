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

```bash
debrief extract <session.jsonl>                 # structural candidate stats (no write)
debrief corpus  <session.jsonl> [corpus.json]   # merge candidates -> hot file + sidecar
debrief show    [corpus.json]                    # print the evidence-free hot file summary
debrief serve   [corpus.json]                    # start the MCP stdio server (alias: mcp)
```

## MCP server

`debrief serve [corpus.json]` (alias `debrief mcp`) stands up a stdio MCP server over the
corpus. It speaks JSON-RPC on stdout (startup chatter stays on stderr) and exposes **eight
tools**. The tool never calls an LLM — read/return tools hand context + the depth/classify
instructions back to the connected agent to reason with, and the write tools persist only
what the agent supplies:

- `get_patterns({ detector?, answered?, minCount?, limit?, cursor? })` — evidence-free pattern
  summaries, paginated. `minCount` applies a minimum-occurrence bar (surface a few sharp
  patterns, not many noisy ones). Each summary carries `merged` when the cluster is an
  agent-merged one.
- `get_evidence({ clusterId })` — full evidence for one cluster; each snippet is wrapped in
  nonce delimiters and labelled untrusted data.
- `answer_open_question({ clusterId, mode? })` — returns the evidence bundle + the
  depth/classify instructions (loaded live from `prompts/`) + the corpus's `standingProtocols`
  for the agent to reason with. `mode:'user'` forwards (`status: pending-user`) with the same
  material so the agent can regenerate the open question and surface it.
- `submit_answer({ clusterId, text, source?, confirmed? })` — writes an answer; `source:user`
  is honored only with `confirmed:true`, otherwise downgraded to `inferred`.
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

Register it with Claude Code:

```bash
claude mcp add debrief -- npx -y @adamlinscott/debrief serve
```

…or the equivalent config block (e.g. `.mcp.json` / `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "debrief": {
      "command": "npx",
      "args": ["-y", "@adamlinscott/debrief", "serve"]
    }
  }
}
```

The two instruction files under `prompts/` are read **live** per `answer_open_question` call
(short-TTL cache): edit a prompt and a running server picks it up — no rebuild, no restart.

## Build order (from eng review)

Done: `.jsonl` format spike, structural candidate source, corpus identity (T3) + store
(T4: hot file + evidence sidecar, atomic writes, merge-not-clobber), the versioned format
(`SPEC.md` + JSON Schema), and the MCP server (`get_patterns` / `get_evidence` /
`answer_open_question` / `submit_answer` / `export_rules_file` / `merge_clusters` /
`add_alias` / `record_protocol`, via `debrief serve`).
Next: the corrections metric. Full task list:
`~/.gstack/projects/adamlinscott-claude-skills/tasks-eng-review-*.jsonl`.
