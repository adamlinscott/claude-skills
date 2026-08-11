# Setting this up for a non-technical colleague

**This page is written for you, the developer, not for your colleague.** It is a checklist you
work through **sitting at their machine**, with their accounts. At the end they get one sentence
and one thing to type. They never see a terminal again.

Be honest with yourself about the cost before you start: **45 to 90 minutes**, most of it waiting
on installers and sign-ins. Five of the steps below fail in ways your colleague could not
diagnose alone, which is exactly why you are doing it and not them. The real fix is the plugin
route — two lines pasted into a Claude Code session, no terminal, no clone — and it is not
published yet. See [PUBLISHING.md](PUBLISHING.md). Until it is, this page is the route.

Work top to bottom. Do not skip ahead; each step assumes the one above it succeeded.

---

## 1. git

Stock Windows and a fresh Mac do not have it, and the repo clones below are the first thing that
fails without it.

- **Windows:** install [Git for Windows](https://git-scm.com/download/win). Accept the defaults.
- **macOS:** run `git --version` in Terminal. If it is missing, macOS offers the Xcode command
  line tools; accept.
- **Linux:** `sudo apt install git` or the distro equivalent.

Check: `git --version` prints a version.

## 2. Node.js

The installer is a Node script.

Install the current LTS from [nodejs.org](https://nodejs.org/). Accept the defaults.

Check: `node --version` prints a version. If the terminal was already open, close it and open a
new one first — the PATH change does not reach an existing shell.

## 3. Claude Code, and its billing

This is the hard stop nobody warns about. Installing Claude Code is easy. Being allowed to *use*
it is a separate problem, and it is not a technical one — it is a purchase.

Install it, then sort out **one** of these before you go further:

- **A paid seat.** Claude Pro, Max, or a seat on your organisation's Team or Enterprise plan.
  If your organisation buys the seats, this is a request to whoever owns that budget, and it can
  take days. Start it before you sit down at the machine.
- **An API key.** An Anthropic Console account with billing set up, and the key set on their
  machine. This bills per token against whoever owns the key.

Check: run `claude` in a terminal, ask it anything, and get an answer back. Do not proceed on a
trial that expires this week — your colleague will hit the wall alone, weeks from now, with no
idea what happened.

## 4. Clone the skills repo

```sh
git clone https://github.com/adamlinscott/claude-skills.git
cd claude-skills
```

Put it somewhere permanent. The installer **links** the skills rather than copying them, so if
this folder later moves or is deleted, every skill stops working. Their home directory is fine.
Their Downloads folder is not.

## 5. Clone the product repo too

Easy to forget, and it is the step that makes the difference between a working setup and a
puzzling one. Your colleague needs **both** repos:

- the skills repo, from step 4, which is installed once and then never opened again;
- **the actual codebase your team works on**, which is where they will run Claude.

The skills only do anything useful when Claude is running *inside* the product repo, because that
is where the code, the issue tracker and the project's vocabulary live.

```sh
cd ..
git clone <your team's repo URL>
```

They will need read access on that repo under their own account. Check that now, not later.

## 6. Run the installer

From inside the skills repo:

```sh
cd claude-skills
node install.mjs --simple
```

`--simple` is the non-technical install: it skips every checklist, installs only the
problem-reporting skills, and sets Claude up to write in plain English everywhere on this
machine. You still get the Ready summary; nothing on disk changes until you confirm it, so read
it before you accept.

Both the choosing screen and the Ready summary carry a warning telling a developer not to pick
this. That warning is for you on **your** machine, not here — on your colleague's machine, Simple
is the right answer. Read it and continue.

Without the flag the installer asks you to choose, and **Advanced is the default answer** — so if
you run it bare here, do not just press Enter.

Two things in that summary are worth reading properly rather than nodding through:

- **`clear-responses` is global.** It writes to `~/.claude/CLAUDE.md` and changes how Claude
  writes in *every* project on this machine, not just the product repo. That is intended here.
  `node install.mjs --uninstall` removes it. It also leaves a `~/.claude/CLAUDE.md.bak` behind
  holding the previous version, refreshed every time the file changes.
- **No third-party collection is installed on this route, and none is offered.** The summary
  will not mention any, because there is nothing to mention — that is step 8's job if you want it.
- **Nothing already on this machine is removed.** A setup choice can only add. Only a checklist
  you actually saw can take something away.

## 7. `gh auth login`

Without this, `/raise-issue` can write a perfect issue and then have nowhere to put it. It falls
back to printing the issue for a copy and paste, which works, but it means your colleague is
back to bothering you.

Install the [GitHub CLI](https://cli.github.com/), then:

```sh
gh auth login
```

Sign in **as your colleague**, on their GitHub account, not yours. Issues they file should carry
their name so the developer picking it up can ask them a follow-up question.

Check: `gh auth status` says logged in, and from inside the product repo `gh issue list` returns
something rather than an error.

If your team is on GitLab, the equivalent is `glab auth login`. If your tracker is neither, skip
this step and read step 8.

## 8. Optional: richer issue templates

Skip this and everything still works — `/raise-issue` has its own template and writes
`docs/agents/issue-tracker.md` itself when it can work out where issues go. This step buys you
issues written in your team's own spec format instead of the built-in one.

It is **two commands, and the first is easy to miss.** Step 6 deliberately installs no
third-party collections, so the skill the second command needs does not exist on this machine yet.

First, in any terminal:

```
claude plugins install mattpocock-skills
```

Then, in a Claude session started **inside the product repo**, not the skills repo:

```
/setup-matt-pocock-skills
```

This is a third-party collection, maintained by someone else, and it installs as a plugin that
updates itself. Read what it is about to run before you accept it, and decide whether you want a
standing auto-update on a machine you are handing over.

## 9. Prove it works before you leave

Do not hand this over untested. From inside the **product repo**, on their machine, as them:

```
claude
```

then type `/raise-issue` and file something small and real. Watch it interview you, ground the
words in the code, and confirm before publishing. If it can reach the tracker, you are done. If
it offers to save a file instead, something in step 7 did not take.

---

## What to send them

One sentence:

> Open Claude in the project folder and type `/raise-issue` whenever something looks wrong — it
> will ask you a few questions and file it properly for the team.

One thing for them to type:

```
/raise-issue
```

That is the whole handover. They do not need to know about git, Node, the installer, or anything
else on this page. If they describe a problem to Claude without using the command, Claude may
offer `/raise-issue` on its own; nothing is ever filed without them saying yes.
