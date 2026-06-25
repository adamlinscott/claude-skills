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

## Develop

```bash
cd tools/debrief
npm install
npm test          # node --test over the extractor
npm run dev       # run the CLI skeleton
npm run build     # tsc -> dist/
```

## Build order (from eng review)

Primary spikes first: `.jsonl` format (done) and detector valence (next).
Then corpus identity + sidecar, the MCP server, consumer C, the corrections metric.
Full task list: `~/.gstack/projects/adamlinscott-claude-skills/tasks-eng-review-*.jsonl`.
