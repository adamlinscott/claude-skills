---
name: seatbelt
description: '[Adam''s Skills] Sets up the security foundation that lets you run Claude Code fast — auto mode, custom tools, minimal interruptions — without it doing something irreversible you never asked for. Two modes. Developer, a permissive default plus a thin deny-only brake on the genuinely irreversible. Vibe, deny-by-default for people who don''t know git, so code changes flow freely while merges, force-pushes, deploys, secret reads and spend are blocked at the Claude layer. Grounds itself in the repo''s existing Claude settings, instructions, MCP servers and CI before writing anything, and writes to gitignored local settings so technical and non-technical people can share one repo on different terms. Use when setting up a project for AI-assisted development, when handing a repo to a non-technical builder, or when the user says they want Claude to stop breaking things, worries it will delete their work, or wants to run auto mode with confidence. Aliased as /seatbelts.'
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion
disable-model-invocation: true
---

# Seatbelt

A seatbelt doesn't limit how fast you drive. It's what lets you drive fast at all.

This skill writes a per-person permission policy for the current repo so Claude can be given
more autonomy, not less. It is the collection's only **mutating** skill — everything else here
is read-only. For a read-only report on this repo's AI setup, use `/context-audit` instead;
this skill deliberately has no dry-run mode, because that would just be `/context-audit` again.

**What it honestly does:** stops Claude over-reaching. **What it does not do:** stop a person
who dismantles their own setup. Say this to the user; never let them believe otherwise.

**Explicit invocation only** (`disable-model-invocation: true`). Never offer or auto-run this
because a user sounded worried, said Claude broke something, or challenged a change. A developer
with their own permission setup would find an uninvited rewrite of it worse than the problem
they were complaining about. It runs when someone types `/seatbelt`, and not otherwise.

## Quick start

```
/seatbelt              # asks which mode, then sets up
/seatbelt --developer  # skip the question
/seatbelt --vibe       # skip the question
/seatbelt --allow "npm run deploy:staging"   # add one override
/seatbelt --uninstall  # remove exactly what the manifest records
```

`--developer` and `--vibe` together is an error, not a silent pick. `--uninstall` beats mode
flags. With no TTY and no mode flag (headless, or running as a subagent), print what you would
have asked and exit non-zero — never guess a mode.

## Workflow

### 1. Ask the mode first

Before any grounding. A wall of stack-detection output is the worst possible first screen for a
non-technical user, and the question costs nothing to ask early.

Frame by **consequence, not identity**. "I know what a PR is" biases everyone toward the mode
with no brakes, because everyone wants fewer prompts. Use `AskUserQuestion` with:

- **Let Claude move fast** — it can push, merge and deploy on its own. Pick this if you can read
  a diff and undo a bad merge.
- **Keep a human in the loop** — Claude writes code freely, but anything permanent (merging,
  deploying, deleting) waits for you.

If you already know the repo has CI, a committed lockfile, or several contributors in `git log`,
pre-select the matching default and ask them to confirm it rather than choose cold.

### 2. Ground

Read before deciding anything. Reuse `/context-audit`'s read list rather than restating it
(`CLAUDE.md` at every level, settings at every scope, `.claude/agents/`, project memory), then add:

```bash
git rev-parse --git-common-dir          # worktrees: .git/hooks/** is NOT where you think
git config --get core.hooksPath         # relocatable; deny the resolved path
git symbolic-ref refs/remotes/origin/HEAD
command -v gh node; gh auth status
cat .gitignore
```

Also enumerate connected MCP servers (`.mcp.json`, `~/.claude.json`, `claude mcp list`) and the
repo's manifests for a `deploy`-shaped script. Compute the **effective** policy across all four
settings scopes — a pre-existing user-scope `deny`, or a `settings.local.json` carrying
`defaultMode: bypassPermissions`, silently defeats whatever you write, and the user will blame
this skill. Report the effective result, not the written one.

Render the summary at the audience's reading level. In vibe mode that is at most: *"This looks
like a Next.js site. I found your test command. You have no safety rules set up yet."*

### 3. Write

Everything goes in **`.claude/settings.local.json`** — gitignored, personal. One repo can hold
both a developer and a non-technical builder, so the policy belongs to the person, not the project.

Non-negotiables, each one a verified footgun. Full detail in [REFERENCE.md](REFERENCE.md):

- **Verify `.claude/settings.local.json` is gitignored and add the entry if missing.** This is
  mechanical, not tidiness: a `settings.local.json` a repository could have supplied goes through
  the workspace-trust dialog; a personal one does not.
- **Never rewrite an existing `.claude/settings.json`.** Read it, fold it into the effective
  policy, and only propose additions as a diff the user approves.
- **Never emit `Write(path)`, `NotebookEdit(path)` or `Glob(path)` rules.** They are accepted and
  never matched — a silent no-op that would make your final report claim protection that does not
  exist. Use `Edit(path)` and `Read(path)`, relative-anchored (`Read(./.env*)`), never absolute.
- **MCP matchers need a trailing `.*`.** `mcp__github` matches nothing; `mcp__github__.*` matches
  the server. The irreversible acts vibe mode exists to prevent are often one MCP call away and
  touch neither Bash nor `gh`.
- **Copy `assets/guard.mjs`, never generate it.** It is tested code. Register it in
  `settings.local.json` in **exec form** with a scoped matcher, an `if` filter and a `timeout`.
- **Write the manifest** `.claude/seatbelt.manifest.json` before finishing, or `--uninstall`
  cannot tell your rules from the user's.

### 4. Report and verify

Print the three-column table — **runs freely / asks first / never** — and persist it into the
`CLAUDE.md` block so it survives the session. Vibe mode drops the middle column.

Verify by running `node .claude/assets/guard.test.mjs`. **Never probe with a live destructive
command**: the case the test exists to catch is the case where the command succeeds.

## Modes

|  | Developer | Vibe |
|---|---|---|
| `defaultMode` | `auto` | `dontAsk` |
| `allow` | empty — nothing to maintain | short, bounded, audited |
| Brake | deny-only, ~10 readable lines | deny + deny-by-default |
| Bypass | left available | `disableBypassPermissionsMode` |
| Workflow files | editable ("fix my CI" is reversible) | protected |

Developer mode carries no `ask` band on purpose. Enumerating an allowlist always misses the tail
(`git stash`, `rg`, `jq`, one-off scripts), so the developer gets interrupted anyway and flips to
bypass — the exact failure this skill exists to prevent.

## Rules that matter

- **The reversibility test.** If undoing it needs an expert or a support ticket, block it. This
  generalises to tools that don't exist yet, which is the only way the policy survives contact
  with next month's CLI.
- **Every denial carries a next action.** Denial messages are this skill's entire runtime
  surface. Problem, cause, what Claude will do instead, what the human does now, how to permit it.
  Templates per mode in [REFERENCE.md](REFERENCE.md).
- **Protect mechanism, not policy.** `guard.mjs` and `seatbelt.policy.json` are self-protected;
  `seatbelt.local.json` is not. Without that split, `--uninstall` is blocked by the thing it
  uninstalls.
- **Never write remote state.** Print the branch-protection click-path and the revert command
  beside it. An agent enabling branch protection can strand a solo developer with no reviewer.
- **Show the resolved script body before allowlisting it.** A `"deploy": "vercel --prod"` in
  `package.json` must never be laundered into an allow rule via `Bash(npm run deploy)`.

Rule sets, denial templates, the report format, error paths and click-paths:
[REFERENCE.md](REFERENCE.md).
