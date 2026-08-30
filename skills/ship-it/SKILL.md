---
name: ship-it
description: 'Get the work done in this conversation all the way out — merged, and deployed to every environment the repo has, production included. Grounds itself first in the branches written during this session, the open and closed PRs behind them, and the environments and CI/CD workflows the repo actually defines, then lands and releases the work and verifies each environment is running the commit. If the release would carry other people''s unreleased changes along with it, summarises whose work rides along and asks for confirmation before touching production. Takes no arguments by default; an optional scope override such as "only staging" limits which environments it deploys to. Invoke with /ship-it.'
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion
---

# Ship It

The work of this conversation is finished, or the user thinks it is. Your job is to get it
**all the way out** — merged, released, and running in every environment this repo deploys to,
production included — and to prove it got there rather than assume it did.

Two failure modes to hold in mind. The first is stopping early: a merged PR is not a shipped
change, and a green deploy job is not proof the environment is running your commit. The second
is shipping more than the user knows about: on most repos a release carries everything sitting
unreleased on the target branch, which can include work by other people and other agent
sessions. Section 4 exists entirely for that.

## 1. Ground yourself before doing anything

Take no action until you can name, from evidence, all four of these. Read; do not recall.

**The work.** What this session actually produced — the branches you created or committed to,
and the commits on them. If the session is long or compacted and you cannot reconstruct it
confidently, do not guess: check `git log --author` for the configured user, recent branches
(`git branch --sort=-committerdate`), and the current branch, and state which of it you are
treating as "the work" so the user can correct you.

**The PRs.** For each branch: is there a PR, is it open, merged, or closed-unmerged? A branch
whose PR was closed without merging is a trap — the work looks done and is not.
`gh pr list --state all --head <branch>` and `gh pr view` settle it.

**The environments.** What this repo actually deploys, and where. Do not assume a shape. Read
the CI/CD definitions: `.github/workflows/*`, `gh api repos/{owner}/{repo}/environments`,
plus whatever config is present — `vercel.json`, `fly.toml`, `Procfile`, `Dockerfile`,
`.circleci/`, `charts/`, `terraform/`. Work out from those files what triggers each deploy:
a push to a branch, a tag or release, a manual `workflow_dispatch`, or an external system
Claude cannot reach at all.

**The route.** The ordered path from the branch to production — for example
`branch → PR → main → auto-deploy staging → tag → production`. Name the base branch from the
repo, not from habit.

If the repo defines no deploy mechanism you can see, say so and stop. Do not invent one.

## 2. Scope

Default: **every environment, ending at production.**

The user may pass an override — `only staging`, `staging only`, `skip prod`, `--env=dev,staging`.
Honour it literally, narrowing which environments you deploy to and nothing else. Say in your
final report which environments were deliberately left out, so a partial ship never reads as a
finished one.

## 3. Land the work

Bring each branch to merged, in dependency order. Open the PR if there isn't one; if a PR was
closed unmerged, ask before reopening — that closure may have been deliberate.

Before merging, make sure the branch is current with its base. Rebase or merge the base in,
whichever this repo does. On conflict, apply the policy in section 6.

Wait for required checks to pass. If a check fails on your own work, fix it — that is part of
shipping. If it fails on something you did not touch, stop and report; do not merge around it.

## 4. The confirmation gate — what rides along

Before anything reaches production, work out what else is going with it: everything on the
target branch (or between the last release and the new one) that is not yours. Use
`git log <last-released-ref>..<target> --format='%h %an %s'` — the release tag, the currently
deployed SHA, or the last production deploy, whichever this repo makes knowable.

**If everything in the release is this session's work**, no gate. Proceed.

**If it is not**, stop and ask. First a **very short** summary — a few lines, not a changelog:
each other author, and in plain terms what their change does. Then ask with the
**AskUserQuestion tool** — a real "are you sure?", not a sentence in prose. Offer:

- Ship everything (recommended when the extra work is small and routine)
- Cancel — do not deploy

If the repo genuinely supports releasing only your commits, offer that as a third option. Do
not offer it otherwise; a cherry-pick invented on the spot is worse than an honest question.

Never bypass this gate on your own judgement. If the user wants it skipped, that is `/ship-it-now`,
which is their decision to make and not yours.

## 5. Deploy, then verify

Deploy to each in-scope environment in the repo's own order, lowest first, production last.
Trigger deploys the way the repo does it — merge, tag, release, or `gh workflow run`. Watch each
run to completion (`gh run watch`); a queued job is not a deployed one.

Then **verify**, per environment, and prefer proof over inference: the deployed SHA from a
health or version endpoint, `gh api .../deployments`, the platform's own CLI, or the release
tag on the environment. If an environment cannot be verified from here, say exactly that — do
not upgrade "the job went green" into "it is live".

If a deploy fails, stop the chain there. Report what failed, what is already live, and what
your recommended next step is. Never quietly retry into production.

## 6. Merge conflicts

Resolve conflicts yourself, at low effort, when the resolution is obvious: both sides added to
the same list, formatting or import churn, a lockfile, one side is a strict superset. Keep both
intentions. Then make sure it still builds.

**Stop and ask the operator** — with AskUserQuestion — only when the conflict signals something
a merge cannot decide:

- The two sides want different behaviour from the same code. A genuine divergence of intent.
- Resolving either way removes or breaks behaviour the other side deliberately added.
- The conflict is in something structural — schema, migrations, config, a security or access
  rule — where a wrong guess is expensive and quiet.

When you stop, describe the two intentions in one line each and name who wrote each side.
Everything else: resolve, note it in the final report, and keep moving.

## 7. Report

Close with a short report: what shipped, which PRs merged, which environments are confirmed
running which commit, anything deliberately skipped, any conflict you resolved on your own
judgement, and anything still outstanding. If the work did not fully ship, say so in the first
line rather than the last.

## 8. Close-out check, after the ship (optional)

Once the report is out and the environments are confirmed, run `/are-we-done` if it is
installed. Skip this silently if it is not: never a prerequisite, never installed on the fly.

**After, not before.** `/ship-it` is often used deliberately to push work that is still in
testing, with a dirty tree and known gaps. A close-out sweep run before landing would flag every
one of those as undecided and argue with a user who has already decided — the fastest way to
make both skills annoying. Run afterwards, the same sweep is information rather than an
obstacle: the release is out, and the question changes from *may I ship?* to *what is left, now
that shipping is no longer the thing occupying you?*

It never gates the ship and never reverses one. Anything it surfaces is next session's work, or
the user's call — including a blocker, which by this point is a known-shipped defect to decide
about, not a reason to hold a release that has already gone.
