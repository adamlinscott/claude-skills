# claude-skills

My personal, version-controlled [Claude Code](https://claude.com/claude-code) skills.
Each lives under `skills/<name>/SKILL.md` and is the single source of truth; an install
script links them into the global skills directory (`~/.claude/skills/`) so Claude loads
them in every session, on every machine.

## Skills

**`/reground`** — re-anchor a drifting agent to the evidence.

Halts an agent that has wandered off the task and re-grounds it in actual codebase
evidence for the work at hand, clearing speculative context without the cost of a full
compaction.

*When to use:* the agent has gone off course, hallucinated files or APIs, or started
building more than you asked for.

---

**`/context-audit`** — find what's working against Claude in a repo.

Audits the context that gets injected into every Claude session — `CLAUDE.md`,
`CONTEXT.md`, `docs/`, `.claude/agents/`, and the per-project memory directory — and
reports bloat, broken links, orphaned docs, security risks, rules that live in memory but
never reach subagents, and conflicts between memory and project instructions. Read-only;
produces a report, never edits.

*When to use:* you want to know why Claude underperforms in a repo, or you're tidying up a
`CLAUDE.md` / agents / memory setup that has grown messy.

---

**`/memory-audit`** — review Claude's per-user memory for a project.

Reads the project's per-user memory and produces a report — either a plain-English summary
or a full technical audit (classification, stale-reference checks, orphaned files,
structural smells). Report only; it never edits, renames, or deletes a memory file.

*When to use:* you suspect memory has gone stale or cluttered, or you want a readable
overview of what Claude has remembered about a project.

## Install

Requires [Node.js](https://nodejs.org/). Clone, then run the installer:

```sh
git clone https://github.com/adamlinscott/claude-skills.git
cd claude-skills
node install.mjs
```

This links each skill in `skills/` into `~/.claude/skills/<name>`. It is idempotent —
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

[MIT](LICENSE) — free to use, modify, and share.
