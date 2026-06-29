# claude-skills

My personal, version-controlled [Claude Code](https://claude.com/claude-code) skills.
Each lives under `skills/<name>/SKILL.md` and is the single source of truth; an install
script links them into the global skills directory (`~/.claude/skills/`) so Claude loads
them in every session, on every machine.

## Skills

### `/reground`

Halts an agent that has drifted off task and re-grounds it in actual codebase evidence,
clearing speculative context without the cost of a full compaction.

**When to use:** the agent has gone off course, hallucinated files or APIs, or started
building more than you asked for.

### `/context-audit`

Audits the context injected into every Claude session (`CLAUDE.md`, `CONTEXT.md`, `docs/`,
`.claude/agents/`, and per-project memory) and flags bloat, broken links, orphaned docs,
security risks, rules that never reach subagents, and memory/instruction conflicts.
Read-only; it produces a report, never edits.

**When to use:** Claude underperforms in a repo, or a `CLAUDE.md` / agents / memory setup
has grown messy and you want it tidied.

### `/memory-audit`

Reviews a project's per-user memory and produces a report: either a plain-English summary
or a full technical audit (classification, stale-reference checks, orphaned files,
structural smells). Report only; it never edits, renames, or deletes a memory file.

**When to use:** you suspect memory has gone stale or cluttered, or you want a readable
overview of what Claude remembers about a project.

### `/fresh-eyes`

Audits a finished change with fresh eyes using double-blind reconciliation: a subagent
with zero conversation history reads the diff blind and reports what it thinks the change
does, how complete it is, and any oversights — then the main context reconciles that
blind read against the work's stated intent. The divergence is the signal. Falls back to
the current session's changes when there's no git diff. Report-only by default; after the
report it asks whether to apply fixes or iterate, and `--fix` / `--iterate` flags skip the
prompt. Nothing is edited without a flag or your approval.

**When to use:** a chunk of work is complete and you want unbiased confirmation that
nothing was missed and scope is fully covered before moving on or shipping.

### `/assumption-inventory`

A preflight for the start of a long or expensive task. Surfaces the assumptions the
work rests on — goal, root and platform scope, what may be edited, what is off-limits,
what "done" means, and open questions — and separates what can be cited from what is
being guessed. Load-bearing guesses are gated on evidence or your confirmation before
the run starts, so bad direction is caught before time is burned. It plans, it does not
build. Front end of the triad with `/reground` (mid-drift) and `/fresh-eyes` (after).

**When to use:** you're about to commit to a multi-step or high-cost run, you're
resuming ambiguous or handed-off work, or the target isn't crisply stated.

### `/goal-workflow`

Runs a settled implementation goal as a bounded autonomous build loop. Locks the goal
from the conversation and any docs written this session, front-loads every decision,
maps the terrain, and — the load-bearing step — writes a checkable completion-invariant
contract *before* any code, so verification anchors to a bar set in writing rather than
the implementer's memory. Then it loops: build, commit at intervals, push and verify at
milestones with `/fresh-eyes` against the contract, fix, and close out. It composes the
native primitives instead of reinventing them — `/goal` is the loop engine, `/fresh-eyes`
the independent verifier. Gated on the literal keyword `ultracode` in the invoking
message, which both enables xhigh + workflow orchestration (a skill can't) and confirms
intent; a missing keyword stops the skill with instructions. The implementation-phase
member of the set with `/assumption-inventory`, `/reground`, and `/fresh-eyes`.

**When to use:** a plan is settled and you want Claude to implement it end-to-end on its
own, typically after a planning skill like `/autoplan`. Invoke as `/goal-workflow
ultracode` — the goal is read from the conversation and any planning docs written this
session, so you don't restate it; add words only to steer or narrow it.

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
