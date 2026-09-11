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

## ✨ Latest update — recalibrated for Claude Opus 5 and Fable 5.1

Prompting advice ages, and some of it inverts. The whole collection has been read back through
against Anthropic's current guidance: newer models already check their own work, delegate, and
reason without being told to, so the effort moves earlier — into planning and scoping, which is
also what lets a run sit at a *lower* thinking effort and still land it.

- **New — `/build-it`.** Point it at a ticket, a plan file, or just say what you want built. It
  asks what the source and the code can't answer, pins what will and won't change, then builds.
- **New — `model-calibration`.** Anthropic's own prompt snippets, verbatim, in your global
  `CLAUDE.md`: reply length, narration, delegation, scope.
- **Updated —** `/context-audit` now flags instructions in *your* repo that have aged the same
  way. `/fresh-eyes` fans out less, `/ttp` reaches written files, reports got shorter.
- **Retired —** `/goal-workflow` and `/assumption-inventory`, both superseded by `/build-it`.
  Nothing is deleted when it retires: it stays working and says what to use instead.

Already installed? `git pull` is the whole update — the skills are linked, not copied.

> [!TIP]
> **Not a developer? Start here → [SETUP-FOR-A-COLLEAGUE.md](SETUP-FOR-A-COLLEAGUE.md).** The honest answer is that you should ask a developer to set this up for you: it takes a terminal, two clones, and a paid Claude seat to get going. That page is the checklist for them to work through on your machine. It ends with the one thing you type: `/raise-issue`.

> [!NOTE]
> These work best **alongside** other skill collections. I run them next to [Matt Pocock's skills](https://github.com/mattpocock/skills) and [Garry Tan's gstack](https://github.com/garrytan/gstack) for in-depth planning; the skills here add lifecycle gates around them. The installer can run both of their installers for you — off unless you tick them.

## 🎯 What these are for

A skill is not a way to make the model cleverer. It is already cleverer than the instructions
most people have time to write, and every model release moves more of that work inside the model —
the patterns that used to need spelling out are now the default, and some of the spelling-out has
started to actively get in the way.

What has *not* moved inside the model is the two ends of the conversation:

- **Getting what only you know out of your head.** The model cannot read the ticket you did not
  write, the reason behind the decision, or the boundary you assumed was obvious. Most of these
  skills are shaped around asking the right small number of questions at the right moment —
  `/build-it` before the code, `/raise-issue` before a report reaches your team, `/are-we-done`
  before a session closes.
- **Giving it back in a form a human can act on.** A correct answer nobody finishes reading has
  not been delivered. Hence the length caps, the plain-English rules, the ban on showing raw
  diffs to someone who does not read code, and `/ttp`.

So the reliable ones here are less "Claude can now do X" and more "the prompt you would have
written, if you'd had twenty minutes and remembered everything". That is why so much of this
collection is questions and report formats rather than clever machinery — and it is the reason a
skill gets *retired* here when the model stops needing it.

## 🧭 A workflow to try

A good way to feel how these fit together, end to end. The planning step can be whatever
planning command, skill, or process you like; the rest are from this repo. Run them in
order — though most are useful on their own, too.

| Command | What it does in the flow |
|---|---|
| `/seatbelt` *(beta)* | **Set the permissions.** Once per repo, before anything else. Decides what Claude can do here without asking and what it can never do, so the rest of this flow can run on auto instead of stopping to ask you. Skip it and `/build-it` either interrupts constantly or runs with no brakes. |
| `/raise-issue` *(as needed)* | **Where the work comes from.** Whoever noticed the problem — usually not you — turns what they saw into an issue that names the actual code, so the plan below starts from something real instead of a forwarded message. |
| Any planning command, skill, or process | **Plan.** Start with a planning session — however you prefer to do it — and write the plan and any supporting docs to files. |
| `/ttp` | **Switch to implementation mode.** The decisions are made — turn on *To the Point* so replies lead with the substance and stay focused on shipping, not re-litigating. This is where it shines: mid-build, you want progress, not discussion. |
| `/build-it 412` | **Build.** Point it at the work — a ticket number, the plan file you just wrote, or nothing at all, in which case it takes the plan agreed above. It reads the source and the code, asks whatever neither of those answered — the *why*, above all — pins in writing which files will change and which will not, then builds to that. The scope note is a real file, so the review below has something concrete to check against. |
| `/fresh-eyes` | **Verify.** Confirm the build actually completed to spec, and surface any bugs or oversights that slipped in, via a blind reconciliation against the intent. |
| `/are-we-done` | **Close the loop.** Before you call it a session, confirm nothing is still undecided — no half-decided suggestion, no unanswered question, no marker the diff left behind. A clean sweep answers in one line; otherwise it names the blockers or asks you about the open calls. |
| `/ship-it` | **Ship.** Get the verified work all the way out — merged, released, and confirmed running in every environment, production last. If the release would also carry unreleased work by other people, it names whose and asks before production. |
| `/reground` | **Recover (as needed).** On longer follow-on sessions, if you start drifting from the main task, halt and re-anchor to codebase evidence before continuing. |
| `/brief-me` | **Re-enter (as needed).** You came back on Monday to a session you left on Friday. Get a plain-English briefing on what it is, where it got to, and what it is waiting on from you, before you touch anything. |

> [!TIP]
> Most of these skills are useful standalone — you don't have to run the whole chain. Reach for `/build-it` whenever a ticket is ready, or `/fresh-eyes` after any finished diff.

## 🧰 Skills

### `/build-it`

A ticket is a compressed message. It records *what* somebody decided and almost never *why* —
because the why was obvious in the room, and the room is gone by the time anyone implements it.
Build straight from the ticket text and you are building from the compression artefact.

Point it at the work. A ticket number is the tidiest input — it reads the whole issue, body,
comments and linked tickets, because the comment that reversed the decision is rarely folded back
into the description — but a plan file, a description typed straight after the command, or nothing
at all (in which case it takes the plan agreed in the conversation above) all work the same way.
**No issue tracker is required.**

Then it reads the code those words actually name, and only then asks you anything — and only what
neither the source nor the code could answer. There is no question quota: a well-written ticket
often gets none, a one-line request earns as many as it genuinely takes. What is fixed is the
rule, not the number — never ask what you could have read.

If what you have handed it turns out to be **big and still foggy**, it says so rather than
building into the fog, and points at a planning pass first: `/wayfinder` when the decisions are
not made yet, `/grilling` when the idea needs stress-testing. That is a recommendation, not a
refusal — say build it anyway and it will.

Then it writes the scope down before it writes any code: what will change, and — the part that
earns the file — **what will not**, each with a line on why not and where it goes instead. Scope
does not creep because someone decides to expand it. It creeps because nobody wrote down where
the edge was, so every individual step past it looked like ordinary diligence. A written edge
turns those steps back into visible decisions. It goes to disk, so it survives compaction on a
long build and gives `/fresh-eyes` a concrete bar to check against rather than the implementer's
memory of intent.

Then it builds that, and stops — naming the next step rather than running it. `--scope-only` pins
the scope and writes no code. `--commit` turns on commits; without it, version control stays with
you.

**When to use:** something is ready to implement — most often a ticket you want a fresh session to
pick up, but equally the plan you just finished agreeing, or a change you can describe in a
sentence. It is the natural partner to whatever files your tickets — `/raise-issue` here, or Matt
Pocock's `/wayfinder` and `/to-tickets`.

### `/fresh-eyes`

A subagent with zero conversation history reads your finished diff blind; the main context
then reconciles that read against the work's actual intent — the divergence is the signal.
Report-only by default; `--fix` / `--iterate` apply changes.

**When to use:** work is complete and you want unbiased confirmation nothing was missed
before shipping.

### `/are-we-done`

A close-out gate, not a review. It asks one question — *can this session close?* — where done
means **nothing is still undecided**, not that everything is finished. An item parked with a
reason is closed; an item nobody ruled on is not, however small.

It sweeps the same six sources every run: the todo list, the promises the session made to itself
("leaving that for now", questions you never answered), the state of the work tree, `TODO`
markers the diff itself introduced, whether tests actually ran *after* the last edit, and every
issue or PR number mentioned — each resolved to its real title, never left as a bare `#123`.
Then each hit lands in exactly one bucket: done, won't do, deferred, blocker, or undecided.

It is strict by default — a dirty tree and a suite not re-run since the last edit are open points
— but the floor lifts on evidence about how your project actually works: if CI runs the suite on
every push and this session pushed, testing was not left undecided. Where it sees a stable
pattern it can offer, once, to remember it for the project, so later sessions inherit the floor.
It never assumes; and if the session was compacted it says so rather than reporting a source it
can only half-read as clean.

A clean sweep gets two lines and no more, plus a paste-ready `Parked:` block if anything was
deferred, so the parking outlives the session that decided it (`/raise-issue` files whatever
deserves a tracked issue). Blockers get a flat list — what broke, where, what it blocks. Genuinely open calls come back as questions with real options — do it
now, defer, won't do — so the decision is yours to make rather than to approve. Read-only: it fixes nothing and decides nothing for you.

**When to use:** the work looks finished and you are about to end the session, ship, or hand off.

### `/ship-it` (and `/ship-it-now`)

Merged is not shipped, and a green deploy job is not proof anything is running. This grounds
itself first — the branches this session wrote, the PRs behind them (including the closed-unmerged
ones that look done and aren't), the environments the repo actually defines in its own CI/CD
files, and the route from branch to production — then lands the work, releases it, and verifies
each environment against the deployed SHA rather than against the job going green.

The part that earns its keep is the ride-along check. On most repos a release carries everything
sitting unreleased on the target branch, which routinely includes work by other developers and
other agent sessions. Before production it works out what else is going out, summarises in a few
lines whose work it is and what it does, and asks. Merge conflicts are resolved at low effort and
in passing; it stops for a conflict only where the two sides genuinely want different behaviour,
or where resolving either way would quietly remove what the other side added.

`/ship-it-now` is the same skill with that one question turned off — it still prints who is
riding along, it just doesn't wait for you, and it needs `/ship-it` installed beside it. Both are
offered on the developer setup only — merging and deploying to production is not a thing to hand
someone who cannot judge what came back. Both take no arguments by default; an optional scope
override (`only staging`) narrows which environments it deploys to.

**When to use:** the work is done and verified and you want it live, not just merged.

### `/ttp` (To the Point — also `/to-the-point`)

Shapes only the prose you read: leads with the substance, keeps the default answer short, and
expands only when you ask. Leaves you in control — Claude settles small, reversible, or
already-decided points and proceeds, but routes high-impact calls (architectural, production,
project shape, which features get built) up to you, one question at a time. Your reasoning,
tool use, code, and plans are untouched — it compresses the report, never the work. Persists
until "stop ttp" or "normal mode".

No slash needed: a bare `ttp` or `to the point`, on its own or tacked onto the end of another
message, turns it on. Naming it is the trigger — a general "keep it short" is honoured for that
reply without switching the session into a mode you did not ask for.

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
> Three skills here have side effects, and they are different in kind. `/seatbelt` **writes files** — settings and a hook, inside your repo, on your machine. `/raise-issue` goes further and writes **outside** it, filing an issue your whole team can see. `/ship-it` goes furthest of all: it **merges and deploys**, ending at production. Everything else in this collection is read-only. All three happen only after you confirm them — with the deliberate exception of `/ship-it-now`, which is that confirmation waived on purpose, by you, in the command you typed. `/seatbelt` stops Claude over-reaching; it is not a lock against a person who dismantles their own setup — and it says so, to your face, in the setup report.

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

### `/reground`

Halts a drifted agent and re-anchors it to actual codebase evidence, without a full
compaction.

**When to use:** the agent has gone off course, hallucinated files or APIs, or overbuilt.

### `/brief-me`

You left the session on Friday and came back on Monday. Reading the last message does not help:
it was written for someone who was here five minutes ago, and leans on pronouns, on shorthand
coined mid-session, and on file names introduced hours back. It continues the thread; it does
not introduce it.

Prints one short briefing that puts you back in the chair — what the session is, where it got
to, what is on disk right now, what it needs from you split into *decide* / *tell me* / *do*,
and the single next step if you just say go. It checks git and the files before it narrates, so
a half-applied edit or a branch that moved under you gets named rather than smoothed over, and
anything it is only recalling gets marked as recalled. Report only; it writes nothing and does
not resume the work.

**When to use:** you have come back to a long-running session and have no idea where you were.

### `/check-skill-updates` — beta

Skills are installed as links, not copies, so the collection updates the moment the clone they
point at does — and nothing tells you when that clone has fallen behind. This checks, and offers
to pull.

Deliberately quiet. It speaks only when there is actually an update: up to date, offline, or a
clone that is dirty or on a branch all produce silence rather than a status line nobody asked for.
It checks at most once a day, and once you have said no to a version it never raises that version
again. Other skills call it at a natural close — `/are-we-done` on a clean answer, `/ship-it` once
the release is verified, `/brief-me` on re-entry — and never next to a blocker or a failed ship.

Beta while it is being lived with: left out of a normal install unless you tick it, and applied on
the guided setup only after being named and labelled beta in the summary.

**When to use:** directly, when you want to know if you are current; otherwise it finds you.

### `/context-audit`

Audits the context injected into every session (`CLAUDE.md`, `CONTEXT.md`, `docs/`, agents,
memory) and flags bloat, broken links, security risks, and conflicts. Read-only.

It also looks for **instructions that have aged badly** — lines written for an older model that
now cause the opposite of what they were for. Mandated self-verification, shouted `CRITICAL: you
MUST` emphasis, "if in doubt, use this tool", "only report high-severity issues", stale model
identifiers. These are invisible precisely because they used to work, and nobody goes back and
deletes them. It is careful to leave your actual safety gates alone: emphasis on something
irreversible is doing real work, and only emphasis on ordinary instructions gets flagged.

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

**Staying up to date is `git pull`, not a re-install.** The links point at this clone, so pulling
updates every installed skill at once; re-running the installer is for adding or removing skills,
and never refreshes content because there is no copy to refresh. The one exception is the optional
instruction blocks, which really are copied into your global `CLAUDE.md` — `node install.mjs
--refresh` rewrites those and repairs any dangling link, without adding or removing anything.
`/check-skill-updates` does all of it for you, and tells you when there is something to pull.

#### Two conventions worth knowing

**Every skill here is tagged.** Each `SKILL.md` description starts with `[Adam's Skills]`, so when
you are scrolling a skill list in Claude — mixed in with gstack, Matt Pocock's, and whatever else
you have installed — you can see at a glance which collection a skill came from. It is a label
only; it changes nothing about when a skill triggers.

**Retired skills are not deleted.** A removed folder leaves anyone who already installed it
holding a command that has silently stopped existing, with no clue where it went. So a retired
skill stays in the repo, still works if you insist, and spends its retirement saying it is retired
and naming its replacement. `deprecated.txt` lists them; the installer marks them on the
checklist, offers once to remove any you still have, and never installs one on a new machine.

Two skills are retired so far, both superseded by `/build-it`. `/goal-workflow` gated on maximum
effort, mandated subagent fan-out and re-verified at every milestone — current models make all
three redundant or actively counterproductive, which is why it stopped performing well.
`/assumption-inventory` was the preflight that fed it: its six slots are now the four headings of
the scope note `/build-it` writes before any code, so running both filled the same form twice. Its
root-and-platform check and its cite-or-flag discipline moved across rather than being lost.

#### Simple or advanced

The first screen is the old Express-versus-Advanced fork every installer has had for thirty
years. It works because the audience is named in the option itself: people who customise their
machine pick Advanced because it says it is for them, and everyone else takes Simple.

| Install | Who it is for |
|---|---|
| **Advanced install** | Developers. Every skill, and you pick which ones from a checklist. This is the default answer. |
| **Simple install** | People who do not write code. A small set for describing problems, writing them up, and finding your place again — `/raise-issue`, `/ttp`, `/brief-me`, `/memory-audit` — plus plain-English replies in every project on the machine. Nothing to choose. |

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
| `model-calibration` | beta | Anthropic's own recommended prompt snippets, reproduced verbatim: how much Claude says, how it formats a reply, how long the files it writes run, when it narrates, when it corrects itself, when it delegates, and staying inside the scope you asked for. |

`clear-responses` is useful when Claude is being read by someone less technical, or by someone
reading English as a second language, and you want that everywhere rather than per-session. It is
**not** `/ttp` — it changes how sentences read, not how much Claude says or who decides what.

`model-calibration` collects the prompt snippets Anthropic publishes in the guides for Claude
Opus 5, Claude Fable 5.1, and the cross-model best-practices page — the ones that make sense
switched on everywhere rather than per-task. They are reproduced **verbatim**, not paraphrased:
the wording has been tested, and rewriting it would be guessing at which parts were load-bearing.

Almost every current-model default pulls towards *more* — longer replies, longer documents, more
narration, more delegation, more scope — so the block is mostly a set of brakes. It is the right
home for them because none of it is a workflow; it is ambient behaviour, and restating it inside
every skill would be worse. It also carries one instruction about what **not** to add back: no
"double-check your work", which now compounds with self-checking the model already does.

It is a real chunk of your global `CLAUDE.md` — around 135 lines — which is a cost worth knowing
about. It replaces rather more than that in ad-hoc rules for most people.

If you suspect a repo has accumulated the older kind, `/context-audit` now looks for exactly
that — see its *Legacy prompting patterns* check.

Each one is a file in `instructions/`, written into your `CLAUDE.md` between HTML-comment markers
— so re-running updates it **in place**, never duplicates it, and never touches a line you wrote
yourself. The installer removes the old region and writes the current one rather than trying to
merge, which is what makes running it twice identical to running it once. It backs the file up to
`CLAUDE.md.bak` immediately before any change, refuses to write at all if the edit does not settle
after one pass, and warns rather than guessing if it finds a half-deleted marker.

That logic is a pure string transform in `lib/claude-md.mjs`, and you can prove it yourself
without touching your real file:

```sh
node tools/instructions/verify.mjs
```

It runs the edit against in-memory fixtures — repeat runs, changed content, hand-edited blocks,
duplicated blocks, orphaned markers, CRLF files, and a file full of your own notes — and prints a
pass/fail count.

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

## 📄 License

[MIT](LICENSE). Free to use, modify, and share.
