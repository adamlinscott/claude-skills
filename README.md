# claude-skills

My personal, version-controlled [Claude Code](https://claude.com/claude-code) skills.
Each lives under `skills/<name>/SKILL.md` and is the single source of truth; an install
script links them into the global skills directory (`~/.claude/skills/`) so Claude loads
them in every session, on every machine.

These are **not** meant to replace other skill collections — they work best alongside
them. I run them next to [Matt Pocock's skills](https://github.com/mattpocock/skills) and
[Garry Tan's gstack](https://github.com/garrytan/gstack); those bring the planning,
review, and engineering-discipline workflows, and the skills here add lifecycle gates
(plan-ahead, build, verify, recover) that slot in around them. See [A workflow to
try](#a-workflow-to-try) below for how they fit together.

## A workflow to try

A good way to feel how these fit together, end to end. The planning step can be whatever
planning command, skill, or process you like; the rest are from this repo. Run them in
order — though most are useful on their own, too.

| Command | What it does in the flow |
|---|---|
| Any planning command, skill, or process | **Plan.** Start with a planning session — however you prefer to do it — and write the plan and any supporting docs to files. |
| `/assumption-inventory` | **Ground the plan in reality.** Verify what the plan assumes about the project itself: which files actually exist, what may be edited, what must not be touched — the technical terrain, not just the goals. |
| `/goal-workflow` | **Build.** The long, expensive bulk of the work — an autonomous loop that implements the plan to a written contract, verifying as it goes, until the invariants hold. (Run it as-is the first time; it will stop and walk you through the one-time setup it needs.) |
| `/fresh-eyes` | **Verify.** Confirm the build actually completed to spec, and surface any bugs or oversights that slipped in, via a blind reconciliation against the intent. |
| `/reground` | **Recover (as needed).** On longer follow-on sessions, if you start drifting from the main task, halt and re-anchor to codebase evidence before continuing. |

## Skills

### `/fresh-eyes`

A subagent with zero conversation history reads your finished diff blind; the main context
then reconciles that read against the work's actual intent — the divergence is the signal.
Report-only by default; `--fix` / `--iterate` apply changes.

**When to use:** work is complete and you want unbiased confirmation nothing was missed
before shipping.

### `/goal-workflow`

An autonomous build loop for a settled plan. Writes a checkable completion contract before
any code, then loops — build with explicit subagent fan-out, verify at milestones with
`/fresh-eyes` — until the contract holds. Gated on a `--confirm` flag asserting you've set
ultracode effort (`/effort ultracode`) and auto-accept mode (Shift+Tab). Without it the
skill stops, gives the setup steps, and offers two paths: a managed `--confirm` run, or a
copy-pasteable `/goal` command that hands the work to native goal + workflow orchestration
for the fullest fan-out. An optional `--commit` flag (default off) turns on commit-at-
intervals and push-at-milestones in either path; without it, version control stays with you.

**When to use:** a plan is settled and you want Claude to implement it end-to-end. Invoke
as `/goal-workflow --confirm`; the goal is read from context, so you don't restate it.

### `/assumption-inventory`

A preflight for a long or expensive task. Surfaces what the work assumes — goal, scope,
what may and must not be edited, what "done" means — and separates cited fact from guess,
gating the load-bearing guesses before time is burned. Also pressure-tests the plan's
acceptance criteria — flagging any that are vague or rest on unproven assumptions — and
asks the blocking uncertainties (scope boundaries, interpretations, soft "done" bars) as
structured questions rather than burying them in prose.

**When to use:** before committing to a multi-step run, or when resuming ambiguous work.

### `/reground`

Halts a drifted agent and re-anchors it to actual codebase evidence, without a full
compaction.

**When to use:** the agent has gone off course, hallucinated files or APIs, or overbuilt.

### `/context-audit`

Audits the context injected into every session (`CLAUDE.md`, `CONTEXT.md`, `docs/`, agents,
memory) and flags bloat, broken links, security risks, and conflicts. Read-only.

**When to use:** Claude underperforms in a repo, or the setup has grown messy.

### `/memory-audit`

Reviews a project's per-user memory and reports — a plain-English summary or a full
technical audit. Report only; never edits.

**When to use:** you suspect memory has gone stale, or want an overview of what Claude
remembers.

## Install

Requires [Node.js](https://nodejs.org/). Clone, then run the installer:

```sh
git clone https://github.com/adamlinscott/claude-skills.git
cd claude-skills
node install.mjs
```

This links each skill in `skills/` into `~/.claude/skills/<name>`. It is idempotent;
re-run any time to repair links. It will **not** overwrite a real directory it did not
create; if it reports a `SKIP`, move or delete that directory and re-run.

- macOS / Linux: directory symlinks.
- Windows: junctions (no admin rights or Developer Mode needed).

Because the links point back here, editing a skill in this repo updates it live in every
Claude session. Commit and push to share the change.

Remove the links (leaves the repo and any unrelated skills untouched):

```sh
node install.mjs --uninstall
```

## Adding a skill

1. Create `skills/<name>/SKILL.md` (see the [skill format docs](https://code.claude.com/docs/en/skills)).
2. Run `node install.mjs` to link it.
3. Commit and push.

## License

[MIT](LICENSE). Free to use, modify, and share.
