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

> [!TIP]
> **Not a developer? Start here → [SETUP-FOR-A-COLLEAGUE.md](SETUP-FOR-A-COLLEAGUE.md).** The honest answer is that you should ask a developer to set this up for you: it takes a terminal, two clones, and a paid Claude seat to get going. That page is the checklist for them to work through on your machine. It ends with the one thing you type: `/raise-issue`.

> [!NOTE]
> These work best **alongside** other skill collections. I run them next to [Matt Pocock's skills](https://github.com/mattpocock/skills) and [Garry Tan's gstack](https://github.com/garrytan/gstack) for in-depth planning; the skills here add lifecycle gates around them. The installer can run both of their installers for you — off unless you tick them.

## 🧭 A workflow to try

A good way to feel how these fit together, end to end. The planning step can be whatever
planning command, skill, or process you like; the rest are from this repo. Run them in
order — though most are useful on their own, too.

| Command | What it does in the flow |
|---|---|
| `/seatbelt` *(beta)* | **Set the permissions.** Once per repo, before anything else. Decides what Claude can do here without asking and what it can never do, so the rest of this flow can run on auto instead of stopping to ask you. Skip it and `/goal-workflow` either interrupts constantly or runs with no brakes. |
| `/raise-issue` *(as needed)* | **Where the work comes from.** Whoever noticed the problem — usually not you — turns what they saw into an issue that names the actual code, so the plan below starts from something real instead of a forwarded message. |
| Any planning command, skill, or process | **Plan.** Start with a planning session — however you prefer to do it — and write the plan and any supporting docs to files. |
| `/assumption-inventory` | **Ground the plan in reality.** Verify what the plan assumes about the project itself: which files actually exist, what may be edited, what must not be touched — the technical terrain, not just the goals. |
| `/ttp` | **Switch to implementation mode.** The decisions are made — turn on *To the Point* so replies lead with the substance and stay focused on shipping, not re-litigating. This is where it shines: mid-build, you want progress, not discussion. |
| `/goal-workflow` | **Build.** The long, expensive bulk of the work — an autonomous loop that implements the plan to a written contract, verifying as it goes, until the invariants hold. (Run it as-is the first time; it will stop and walk you through the one-time setup it needs.) |
| `/fresh-eyes` | **Verify.** Confirm the build actually completed to spec, and surface any bugs or oversights that slipped in, via a blind reconciliation against the intent. |
| `/reground` | **Recover (as needed).** On longer follow-on sessions, if you start drifting from the main task, halt and re-anchor to codebase evidence before continuing. |

> [!TIP]
> Most of these skills are useful standalone — you don't have to run the whole chain. Reach for `/assumption-inventory` before any long task, or `/fresh-eyes` after any finished diff.

## 🧰 Skills

### `/fresh-eyes`

A subagent with zero conversation history reads your finished diff blind; the main context
then reconciles that read against the work's actual intent — the divergence is the signal.
Report-only by default; `--fix` / `--iterate` apply changes.

**When to use:** work is complete and you want unbiased confirmation nothing was missed
before shipping.

### `/ttp` (To the Point — also `/to-the-point`)

Shapes only the prose you read: leads with the substance, keeps the default answer short, and
expands only when you ask. Leaves you in control — Claude settles small, reversible, or
already-decided points and proceeds, but routes high-impact calls (architectural, production,
project shape, which features get built) up to you, one question at a time. Your reasoning,
tool use, code, and plans are untouched — it compresses the report, never the work. Persists
until "stop ttp" or "normal mode".

Also shapes the sentences themselves — one idea per sentence, active voice, one word per concept,
no stacked nouns — borrowed from controlled-language practice, with precision ranked above
simplicity so a technical term is glossed, never downgraded.

**When to use:** a session has run long or vague — especially the tail of a planning
session — and you want replies that get to the point.

### `/seatbelt` (alias `/seatbelts`) — beta

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
> Two skills here have side effects, and they are different in kind. `/seatbelt` **writes files** — settings and a hook, inside your repo, on your machine. `/raise-issue` goes further and writes **outside** it, filing an issue your whole team can see. Everything else in this collection is read-only. Both side effects happen only after you confirm them. `/seatbelt` stops Claude over-reaching; it is not a lock against a person who dismantles their own setup — and it says so, to your face, in the setup report.

**When to use:** setting a project up for AI-assisted development, handing a repo to a
non-technical builder, or any time you want to run auto mode without wondering what it might do.

### `/raise-issue` (alias `/report-issue`)

Takes the words a non-technical person actually uses — "the dashboard", "the thing that sends
the emails" — and resolves them to real code, building a **term map**: their word, the project's
word, and the `file:line` evidence for the match. Ambiguous terms are settled by asking what they
*saw*, never by showing them a symbol name. That map is what makes the resulting issue worth a
developer's time, because it arrives already pointing at the code.

The term map then does a second job: it is the duplicate key. A text search over issue titles
cannot tell that "the export button spins forever" and "my March invoice never downloaded" are
one bug. A shared code location can. No tracker's own dedupe can do this, because no tracker has
repo context at the moment the issue is being written. The duplicate check runs on every issue
and offers three outcomes — comment on the existing one, file a linked issue when two reports
touch the same area but may not share a cause, or file normally. It never merges silently.

The interview runs every time, however clear the request looked, in plain English and capped so
it does not turn into an interrogation. Before drafting, a triage gate asks whether this deserves
an issue at all, and it will say no: not a defect, already reported, not a code problem, or still
too thin to act on. It advises, never refuses — filing anyway is always one keystroke away.

> [!IMPORTANT]
> This is the one skill here Claude may offer **on its own**, without the command being typed — that is the only way it reaches someone who does not know it exists. Nothing is ever filed without an explicit yes to the finished issue.

**When to use:** something looks wrong and you want it in the team's tracker properly, written
in the codebase's own vocabulary. Off by default on the developer track; on for the
non-technical one. See [SETUP-FOR-A-COLLEAGUE.md](SETUP-FOR-A-COLLEAGUE.md) to set it up for
someone else.

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

### `/debrief` — beta

Reads back through your past Claude sessions to find the corrections you keep repeating, asks you
why each one mattered, and can write the answers up as project rules. Ships a companion MCP tool,
which the installer builds and connects for you when you tick it.

**When to use:** you notice you are correcting Claude the same way every week and want that turned
into something the project remembers.

## ⚙️ Install

Requires [git](https://git-scm.com/downloads) and [Node.js](https://nodejs.org/). Clone, then run
the installer:

```sh
git clone https://github.com/adamlinscott/claude-skills.git
cd claude-skills
node install.mjs
```

It opens a wizard that explains itself: tick what you want, confirm, done. Nothing changes until
you confirm. Re-run it any time to change your answers or repair the links.

```sh
node install.mjs --help        # every option, changes nothing
node install.mjs --uninstall   # remove what it installed
```

Because the skills are linked rather than copied, editing one in this repo updates it live in
every Claude session. Commit and push to share the change.

#### Simple or advanced

The first screen is the old Express-versus-Advanced fork every installer has had for thirty
years. It works because the audience is named in the option itself: people who customise their
machine pick Advanced because it says it is for them, and everyone else takes Simple.

| Install | Who it is for |
|---|---|
| **Advanced install** | Developers. Every skill, and you pick which ones from a checklist. This is the default answer. |
| **Simple install** | People who do not write code. A small set for describing problems and writing them up — `/raise-issue`, `/ttp`, `/memory-audit` — plus plain-English replies in every project on the machine. Nothing to choose. |

> [!WARNING]
> **Simple is not a smaller Advanced, and if you write code you do not want it.** It is a
> constrained mode: it already rewrites how Claude talks across every project on the machine, and
> it is where the guard rails go as they arrive — simplified language, and limits on what Claude
> may do without asking. That is right for someone who does not read code and wrong for you. The
> installer says so on the choosing screen and again on the Ready summary.

The screen names the developer skills Simple leaves out, so choosing it is a decision rather than
a shortcut, and the Ready summary lists every skill by name before anything is touched.

Skip the question with a flag:

```sh
node install.mjs --advanced   # every skill, via the checklist
node install.mjs --simple      # the non-technical install
```

The flag only seeds the answers. It never skips the Ready confirmation, it never installs a
third-party extra on its own, and a track default can only ever **add** to what you already have
— choosing a track cannot uninstall a skill you were using. Removing things stays with
`--uninstall`, which always shows you a list first, whatever `--for` says.

Two details worth knowing before you automate it. With no terminal to prompt in and no flag you
get the developer defaults, which now means *the skills that track defaults to* rather than
literally all of them — `/raise-issue` is off for developers, so it will not appear. And an
unattended run (`-y`, or no terminal) never switches on anything still in development, so the
plain-English replies — currently a beta feature — need either a real run you can watch or an
explicit `--beta`.

If you are running this on a colleague's machine, the installer is one step of about nine.
[SETUP-FOR-A-COLLEAGUE.md](SETUP-FOR-A-COLLEAGUE.md) is the rest.

### 📝 Global instructions

Alongside the skills, the installer offers optional instructions for your **global**
`~/.claude/CLAUDE.md` — the file Claude reads in every project. Off unless you tick them.

| Instruction | Status | What it does |
|---|---|---|
| `clear-responses` | beta | Plain, direct wording in every reply Claude writes to you: short sentences, active voice, one word per concept. Scoped to prose you read — never code, commits, files, reasoning, or subagent instructions, and it never downgrades a precise technical term to a vaguer one. |

Useful when Claude is being read by someone less technical, or by someone reading English as a
second language, and you want that everywhere rather than per-session. It is **not** `/ttp` — it
changes how sentences read, not how much Claude says or who decides what.

Each one is a file in `instructions/`, written into your `CLAUDE.md` between markers — so
re-running updates it in place and never touches anything else in that file.

### Plugin install (scaffolded, not yet published)

`.claude-plugin/` contains marketplace and plugin manifests so this collection can one day be
installed from inside Claude Code with no terminal and no clone. Nothing is live until the
marketplace is published. See [PUBLISHING.md](PUBLISHING.md) for what the files do and how to
turn them on.

Worth being straight about how that relates to the track above. The `--simple` track is
a **handover tool**: it makes the job quick for a developer sitting at a colleague's machine, but
it still needs a terminal, git, Node, a paid Claude seat and two clones, so it does not reach a
non-technical person on its own. The plugin route is the self-serve fix — two lines pasted into a
session they are already in — and it is the one that deletes most of
[SETUP-FOR-A-COLLEAGUE.md](SETUP-FOR-A-COLLEAGUE.md). It is not published yet.

## 🧪 Tests

The installer links and unlinks directories in your home folder and rewrites a global config
file, so it has a suite. No dependencies, no framework:

```sh
npm test
```

Every test spawns the real `install.mjs` as a child process with `HOME` and `USERPROFILE` pointed
at a throwaway directory, then asserts on what actually landed on disk. CI runs it on Linux and
Windows, because the link type differs between them and junctions are the harder half.

Two environment variables exist for that harness, and are read nowhere else:

| Variable | Effect |
|---|---|
| `CLAUDE_SKILLS_FORCE_PROMPT=1` | Run the arrow-key menus even when stdin is not a terminal, so a test can drive them with piped keystrokes. Set this outside a test and the installer will wait for input that never comes. |
| `CLAUDE_SKILLS_LIST_FILE` | Read the skill list from somewhere other than `skills.txt`, so a test can use a fixture. |

## 📄 License

[MIT](LICENSE). Free to use, modify, and share.
