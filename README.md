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
> These work best **alongside** other skill collections. I run them next to [Matt Pocock's skills](https://github.com/mattpocock/skills) and [Garry Tan's gstack](https://github.com/garrytan/gstack) for in-depth planning; the skills here add lifecycle gates around them. The installer can run both of their installers for you — off unless you tick them.

## 🧭 A workflow to try

A good way to feel how these fit together, end to end. The planning step can be whatever
planning command, skill, or process you like; the rest are from this repo. Run them in
order — though most are useful on their own, too.

| Command | What it does in the flow |
|---|---|
| `/seatbelt` *(beta)* | **Set the permissions.** Once per repo, before anything else. Decides what Claude can do here without asking and what it can never do, so the rest of this flow can run on auto instead of stopping to ask you. Skip it and `/goal-workflow` either interrupts constantly or runs with no brakes. |
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
> This is the only skill here that **writes** files; everything else is read-only. It stops Claude over-reaching. It is not a lock against a person who dismantles their own setup — and it says so, to your face, in the setup report.

**When to use:** setting a project up for AI-assisted development, handing a repo to a
non-technical builder, or any time you want to run auto mode without wondering what it might do.

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

It opens a wizard that explains itself: tick what you want, confirm, done. Nothing changes until
you confirm. Re-run it any time to change your answers or repair the links.

```sh
node install.mjs --help        # every option, changes nothing
node install.mjs --uninstall   # remove what it installed
```

Because the skills are linked rather than copied, editing one in this repo updates it live in
every Claude session. Commit and push to share the change.

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
installed from inside Claude Code with no terminal and no clone — which is the only route that
reaches the non-technical audience `/seatbelt --vibe` is written for. Nothing is live until the
marketplace is published. See [PUBLISHING.md](PUBLISHING.md) for what the files do and how to
turn them on.

## 🖥️ Run it on a VPS

**Register a repo once. Every session is a fresh worktree, bootstrap already run.**

A small always-on Linux server holds your repos. One request makes a git worktree, runs that repo's
setup script to completion, and opens a Claude session in it on auto mode — which you carry on with
in the Claude app or at [claude.ai/code](https://claude.ai/code), and which keeps running when your
phone sleeps.

The setup script is the part worth explaining. It runs as systemd's `ExecStartPre`, so it finishes
*before* Claude exists, and a non-zero exit means no session is registered at all. A Claude
`SessionStart` hook cannot promise that — a slow hook gets abandoned and the session starts anyway
on a tree that was never prepared, which is the failure this shape exists to remove.

### What you need first

- A **Claude subscription** (Pro, Max, Team or Enterprise). An API key will not work, and neither
  will `claude setup-token` — those tokens can only make model requests, and Remote Control refuses
  them.
- A **Linux VPS**, 2 GB of RAM or more, that you can SSH into as a normal (non-root) user.
- A **phone or laptop with a browser**, to finish signing in. The box has no browser of its own.

### Setting it up

```sh
curl -fsSL https://raw.githubusercontent.com/adamlinscott/claude-skills/main/host.sh | bash
```

That installs git, Node and Claude Code, clones this repo, and stops. Then:

```sh
cd ~/claude-skills
node host-setup.mjs            # the guided setup — asks first, changes nothing until you confirm
```

It checks the box, signs you in, writes the permission rules, installs the skills globally, clones
your repos and starts a server for each one. At the end it tells you to open the app.

```sh
node host-setup.mjs --doctor      # is this box healthy? changes nothing
node host-setup.mjs --uninstall   # remove what it installed; your clones are kept
```

### Afterwards

```sh
skillhost add git@github.com:you/thing.git    # register a repo. Starts nothing.
skillhost session thing fix-login             # worktree + bootstrap + a live session
skillhost sessions                            # what is running, and what only thinks it is
skillhost end thing-fix-login-a1b2 --purge    # stop it and reclaim its worktree
skillhost why thing-fix-login-a1b2            # why one did not start. Usually the bootstrap.
skillhost reap                                # reclaim worktrees from finished sessions
skillhost doctor                              # check everything
skillhost serve                               # take these over HTTP, so a phone shortcut can do it
```

`skillhost serve` only ever listens on loopback. Reach it over [Tailscale](https://tailscale.com) or
an SSH tunnel — it will not bind a public address whatever you put in the config. One POST starts a
session:

```sh
curl -sX POST http://127.0.0.1:7717/sessions \
  -H "Authorization: Bearer $(cat ~/.config/skillhost/token)" \
  -H 'content-type: application/json' \
  -d '{"repo":"thing","task":"fix login"}'
```

### Where your bootstrap goes

A repo that commits `.claude/bootstrap.sh` uses that. Otherwise name a script from `vps/hooks/` when
you register the repo — `vps/hooks/workspace-pull-all.sh` is the worked example, for the case where
one workspace repo pulls its siblings into place. Either way it runs in the fresh worktree, with
`CLAUDE_PROJECT_DIR`, `SKILLHOST_REPO` and `SKILLHOST_SESSION` set, before Claude starts.

### Trust, and what registering a repo actually means

Starting a repo lets code from that repo run on this box, as you, unattended — the bootstrap script
is read from the repo itself. That box holds an SSH key with push access and a signed-in Claude
account, so the decision matters.

So it is decided by ownership, and you never have to type anything extra for the normal case:

| The repo is owned by | What happens |
|---|---|
| you | cloned and started |
| an organisation you belong to | cloned and started |
| anyone else | cloned, **not** started, until you run `skillhost trust <repo>` |

Ownership is read from the GitHub CLI, so `gh auth login` is worth doing — without it nothing can be
trusted automatically and every repo needs approving by hand. Note that in a large organisation, any
member's push runs on your box; that is the trade the middle row makes.

> [!IMPORTANT]
> This box ends up holding your logged-in Claude subscription and an SSH key with push access to your
> repositories, running sessions on auto mode that restart themselves. Treat it like a machine you
> would hand someone your laptop password for. Run `/seatbelt` inside each clone before pointing it at
> anything you care about.

### Why it might not work

Every one of these fails *quietly* — the box looks fine and your phone shows nothing.
`skillhost doctor` checks all of them and prints only what is wrong, with the fix. The long version
is [vps/preflight.md](vps/preflight.md).

| Symptom | Usually |
|---|---|
| Nothing appears in the app | Signed in with `claude setup-token`, or no subscription on the account |
| A session will not start | Nearly always the bootstrap — `skillhost why <id>` prints the journal |
| A repo refuses to start sessions | The trust dialog — run `skillhost trust <repo>` |
| Everything dies when you close SSH | Linger is off: `sudo loginctl enable-linger $USER` |
| Worked yesterday, silent today | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `DISABLE_GROWTHBOOK` got set |
| Clones start failing for no clear reason | Worktrees filling the disk — `skillhost reap` |

### When not to bother

- **Your repos are on GitHub and you need nothing local.** Claude Code on the web already does this
  with no VPS at all. Try that first.
- **You only have one repo and no setup script.** SSH in, run `claude remote-control --spawn worktree`,
  done. This exists for the many-repos-one-box case, and for when a worktree needs preparing before
  work can start in it.
- **You pay per API call.** Remote Control needs a subscription.

### A note on updating

Unlike the skills, which are symlinked and update themselves, the VPS pieces are **copied** onto the
box. After `git pull`, re-run `node host-setup.mjs` to pick up the changes. `skillhost doctor` says
when your units are out of date.

## 🧪 Tests

```sh
npm test              # everything that runs anywhere. No dependencies.
npm run test:systemd  # the handful of things that need real systemd. Needs Docker.
```

The second one builds a throwaway container with systemd as PID 1 and a stand-in `claude`, then
checks the things no mock can: that the bootstrap really finishes before Claude starts, that a
*failing* bootstrap stops the session existing at all, that two sessions run side by side, and that
Claude gets a real terminal. It earned its keep several times over — it caught a unit file that
reported healthy over a dead service, a shutdown race that only appeared 2 times in 5, and two
systemd keys silently ignored because they sat in the wrong section.

## 📄 License

[MIT](LICENSE). Free to use, modify, and share.
