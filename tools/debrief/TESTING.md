# Testing debrief end-to-end

This walks you through driving the whole loop with a real, connected Claude session. The tool
itself never calls an LLM — *you* connect an agent and it does the reasoning via the tools +
the instruction sheets in `prompts/`.

## Fastest path: the zero-config CLI (no MCP, no paths)

The skill-friendly subcommands wrap the SAME handlers the MCP server uses and print JSON, so you
can drive the whole loop from bash with no corpus path and no MCP registration. Everything below
resolves the CURRENT PROJECT's corpus automatically (`--global` for the cross-project roll-up):

```bash
debrief corpus            # discover this project's sessions and merge them all
debrief patterns          # see the clusters
debrief grouping-task     # consolidate: debrief merge <from> <into> / debrief group "<name>" <ids...>
debrief themes            # pick a theme
debrief ask <themeId>     # get the depth instruction + evidence; reason to a question SET
debrief answer <id> "..."                       # record an inferred answer
debrief answer <id> "..." --source user --confirmed   # record the user's ground truth
debrief pending           # next session: unanswered questions resurface
debrief export-rules      # material for a CLAUDE.md of principles
```

The reference skill `skills/debrief/SKILL.md` (BETA) automates exactly this. Install it with
`node install.mjs --beta` from the repo root (a normal install skips the beta skill).

The connected-MCP walkthrough below is equivalent (same handlers) for clients that prefer MCP.

## 0. Build

```bash
cd tools/debrief
npm install
npm run build          # -> dist/
npm test               # sanity: should be all green
```

## 1. Build a corpus from your real sessions

Your Claude Code session logs live under `~/.claude/projects/<mangled-path>/*.jsonl`
(on Windows: `C:/Users/<you>/.claude/projects/...`). Pick a project with real back-and-forth.

```bash
# one session:
node dist/cli.js corpus "C:/Users/<you>/.claude/projects/<proj>/<session>.jsonl" my-corpus.json
# accumulate more (re-run with the same corpus file — it MERGES, never clobbers):
node dist/cli.js corpus "<another-session>.jsonl" my-corpus.json
node dist/cli.js show my-corpus.json
```

Expect a pile of **count-1 clusters** at first. That is correct: the CLI only does *exact-repeat*
structural clustering (it reads no meaning). The semantic grouping is the agent's job in step 3.
The hot file (`my-corpus.json`) is evidence-free; raw snippets live in `my-corpus.evidence.json`
(local only).

## 2. Register the server with Claude Code

Not published to npm yet, so point at the local build (use absolute paths):

```bash
claude mcp add debrief -- node "C:/Users/<you>/.../tools/debrief/dist/cli.js" serve "C:/Users/<you>/.../my-corpus.json"
```

Confirm it connected: `claude mcp list` (or `/mcp` inside a session). You should see 15 tools.

## 3. Drive the loop in a fresh Claude session

The tool is return-instruction: it hands the agent the instruction sheets + data; the agent
reasons. Suggested prompts to walk the loop:

1. **Consolidate (semantic clustering):**
   > "Use the debrief MCP tools. Call `get_grouping_task`, follow its instruction: fuse true
   > duplicate clusters with `merge_clusters`, and group related ones into themes with
   > `group_theme`. Use `set_cluster_kind` to tag each cluster's intent."

2. **Question a theme:**
   > "Call `get_themes`, pick the most interesting one, call `answer_open_question` on its
   > themeId, and follow the depth instruction: ask me a *set* of open questions. Answer the
   > evidence-answerable ones yourself from `get_evidence`; forward the rest to me."

3. **Answer + persist:**
   > "I'll answer the forwarded ones. Record my answers with `submit_answer` (confirmed:true)."

4. **Next session:** reconnect later and call `get_pending_questions` — the ones you didn't
   answer resurface (oldest first, capped, demoted after 3 skips).

5. **Export:** `export_rules_file` → the agent writes you a CLAUDE.md of principles.

## What to judge

- Do the **themes** capture real recurring patterns once the agent consolidates?
- Are the **questions** poignant, or generic? (Honest expectation: good-not-uncanny for now —
  the *relational signals* that push questions to "how did it know that" aren't computed yet;
  that's the next build. The depth prompt already uses them "when available.")
- Does the **pending loop** behave: forwarded questions resurface across reconnects, clear when
  answered?

## Known limits at this stage (not bugs)

- Clustering depends on the agent running step 1; until it does, `get_patterns` shows singletons.
- Relational signals (trust-over-time / counterfactual / cross-domain) and Claude *memory*
  ingestion are not built yet — both are post-first-test.
