# claude-skills

My personal, version-controlled [Claude Code](https://claude.com/claude-code) skills.
Each lives under `skills/<name>/SKILL.md` and is the single source of truth; an install
script links them into the global skills directory (`~/.claude/skills/`) so Claude loads
them in every session, on every machine.

## Skills

| Skill | What it does |
|-------|--------------|
| **reground** | Halts a drifting agent and re-anchors it to codebase evidence for the current task — clears speculative context without a full compaction. Trigger when the agent has gone off course, hallucinated files/APIs, or over-built. |
| **context-audit** | Audits a repo's Claude context setup (CLAUDE.md, CONTEXT.md, `docs/`, `.claude/agents/`, per-project memory). Reports bloat, broken links, orphaned docs, security risks, and memory/instruction conflicts. |
| **memory-audit** | Audits Claude's per-user memory for a project and produces a report (non-technical summary or full technical audit). Report only — never edits memory. |

## Install

Requires [Node.js](https://nodejs.org/). Clone, then run the installer:

```sh
git clone <this-repo-url> claude-skills
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
