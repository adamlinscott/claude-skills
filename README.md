<div align="center">

# 🧩 claude-skills

[![Claude Code](https://shieldcn.dev/badge/Claude-Code-D97757.svg?logo=anthropic&variant=branded&size=xs&mode=light)](#-claude-skills)
[![MCP Ready](https://shieldcn.dev/badge/MCP-ready-111827.svg?logo=ri%3AVscMcp&variant=branded&size=xs&mode=light)](#-claude-skills)
[![Platform](https://shieldcn.dev/badge/runs_on-mac_linux_windows-3b82f6.svg?variant=branded&size=xs)](#%EF%B8%8F-install)

![Stars + License](https://shieldcn.dev/group/github/stars/adamlinscott/claude-skills+github/license/adamlinscott/claude-skills.svg?variant=branded&size=xs)

<hr>

</div>

Each skill lives under `skills/<name>/SKILL.md` and is the single source of truth; an install
script links them into the global skills directory (`~/.claude/skills/`) so Claude loads
them in every session, on every machine.

> [!NOTE]
> These work best **alongside** other skill collections. I run them next to [Matt Pocock's skills](https://github.com/mattpocock/skills) and [Garry Tan's gstack](https://github.com/garrytan/gstack) for in-depth planning; the skills here add lifecycle gates around them.

## 🧭 A workflow to try

A good way to feel how these fit together, end to end. The planning step can be whatever
planning command, skill, or process you like; the rest are from this repo. Run them in
order — though most are useful on their own, too.

| Command | What it does in the flow |
|---|---|
| `/seatbelt` | **Set the permissions.** Once per repo, before anything else. Decides what Claude can do here without asking and what it can never do, so the rest of this flow can run on auto instead of stopping to ask you. Skip it and `/goal-workflow` either interrupts constantly or runs with no brakes. |
| Any planning command, skill, or process | **Plan.** Start with a planning session — however you prefer to do it — and write the plan and any supporting docs to files. |
| `/assumption-inventory` | **Ground the plan in reality.** Verify what the plan assumes about the project itself: which files actually exist, what may be edited, what must not be touched — the technical terrain, not just the goals. |
| `/ttp` | **Switch to implementation mode.** The decisions are made — turn on *To the Point* so replies lead with the substance and stay focused on shipping, not re-litigating. This is where it shines: mid-build, you want progress, not discussion. |
| `/goal-workflow` | **Build.** The long, expensive bulk of the work — an autonomous loop that implements the plan to a written contract, verifying as it goes, until the invariants hold. (Run it as-is the first time; it will stop and walk you through the one-time setup it needs.) |
| `/fresh-eyes` | **Verify.** Confirm the build actually completed to spec, and surface any bugs or oversights that slipped in, via a blind reconciliation against the intent. |
| `/reground` | **Recover (as needed).** On longer follow-on sessions, if you start drifting from the main task, halt and re-anchor to codebase evidence before continuing. |

> [!TIP]
> Most of these skills are useful standalone — you don't have to run the whole chain. Reach for `/assumption-inventory` before any long task, or `/fresh-eyes` after any finished diff.

## 🧰 Skills

### `/seatbelt` (alias `/seatbelts`)

A seatbelt doesn't limit how fast you drive. It's what lets you drive fast at all.

Writes a per-repo, per-person permission policy so you can hand Claude more autonomy, not less.
Two modes. **Developer**: a permissive default plus a thin deny-only brake, roughly ten readable
lines, no allowlist to maintain. **Vibe**: deny-by-default for someone who doesn't know git, so
code changes flow freely while merges, force-pushes, deploys, secret reads and spend are blocked
at the Claude layer, in plain English, with a next step every time.

Grounds itself in the repo's existing Claude settings, instructions, MCP servers and CI first,
then writes to gitignored local settings — so a technical and a non-technical person can share
one repo on different terms. Ships a tested `guard.mjs` hook that fails closed and checks it's
still alive at session start.

> [!IMPORTANT]
> This is the only skill here that **writes** files; everything else is read-only. It stops Claude over-reaching. It is not a lock against a person who dismantles their own setup — and it says so, to your face, in the setup report.

**When to use:** setting a project up for AI-assisted development, handing a repo to a
non-technical builder, or any time you want to run auto mode without wondering what it might do.

### `/fresh-eyes`

A subagent with zero conversation history reads your finished diff blind; the main context
then reconciles that read against the work's actual intent — the divergence is the signal.
Report-only by default; `--fix` / `--iterate` apply changes.

**When to use:** work is complete and you want unbiased confirmation nothing was missed
before shipping.

### `/ttp` (To the Point)

Shapes only the prose you read: leads with the substance, keeps the default answer short, and
expands only when you ask. Leaves you in control — Claude settles small, reversible, or
already-decided points and proceeds, but routes high-impact calls (architectural, production,
project shape, which features get built) up to you, one question at a time. Your reasoning,
tool use, code, and plans are untouched — it compresses the report, never the work. Persists
until "stop ttp" or "normal mode".

**When to use:** a session has run long or vague — especially the tail of a planning
session — and you want replies that get to the point.

### `/goal-workflow`

An autonomous build loop for a settled plan. Writes a checkable completion contract before
any code, then loops — build with explicit subagent fan-out, verify at milestones with
`/fresh-eyes` — until the contract holds. Gated on a `--confirm` flag asserting you've set
ultracode effort (`/effort ultracode`) and auto-accept mode (Shift+Tab). Without it the
skill stops, gives the setup steps, and offers two paths: a managed `--confirm` run, or a
copy-pasteable `/goal` command that hands the work to native goal + workflow orchestration
for the fullest fan-out. An optional `--commit` flag (default off) turns on commit-at-
intervals and push-at-milestones in either path; without it, version control stays with you.

> [!IMPORTANT]
> `/goal-workflow` runs an autonomous, potentially long and expensive loop. The first run stops and walks you through the one-time setup; by default it makes **no commits** unless you pass `--commit`.

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

## ⚙️ Install

Requires [Node.js](https://nodejs.org/). Clone, then run the installer:

```sh
git clone https://github.com/adamlinscott/claude-skills.git
cd claude-skills
node install.mjs
```

This links each skill in `skills/` into `~/.claude/skills/<name>`. It is idempotent;
re-run any time to repair links.

- 🐧 macOS / Linux: directory symlinks.
- 🪟 Windows: junctions (no admin rights or Developer Mode needed).

> [!WARNING]
> The installer will **not** overwrite a real directory it did not create. If it reports a `SKIP`, move or delete that directory and re-run.

Because the links point back here, editing a skill in this repo updates it live in every
Claude session. Commit and push to share the change.

Remove the links (leaves the repo and any unrelated skills untouched):

```sh
node install.mjs --uninstall
```

### Plugin install (scaffolded, not yet published)

`.claude-plugin/` contains marketplace and plugin manifests so this collection can one day be
installed from inside Claude Code with no terminal and no clone — which is the only route that
reaches the non-technical audience `/seatbelt --vibe` is written for. Nothing is live until the
marketplace is published. See [PUBLISHING.md](PUBLISHING.md) for what the files do and how to
turn them on.

## 📄 License

[MIT](LICENSE). Free to use, modify, and share.
