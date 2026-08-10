#!/usr/bin/env bash
# Example bootstrap hook: bring a fresh worktree up to date before a session starts.
#
# Wired in as a SessionStart hook, so it runs once per session, in the worktree that session got,
# before any work begins. Copy it, edit it, or point at your own — a repo that ships its own
# .claude/settings.json hook wins over anything named here.
#
# The environment it can rely on:
#   CLAUDE_PROJECT_DIR  the worktree this session is running in
#   SKILLHOST_REPO      the repo's name on this box
#   SKILLHOST_ROOT      the workspace root
#
# Two rules, both learned the hard way on a headless box:
#
#   1. Never wait for input. There is no terminal and nobody to type at it. A git command that
#      prompts for a password or an unknown host key does not fail — it waits forever, and it
#      holds one of this repo's session slots while it does.
#   2. Finish, or give up. The timeout below is the backstop; the hook's own registration carries
#      one too. A hook that runs for ten minutes is a session that never starts.

set -euo pipefail

export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=yes"

WORKTREE="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$WORKTREE"

echo "skillhost: preparing ${SKILLHOST_REPO:-this repo} in $WORKTREE"

# Catch up with the default branch. Fetch rather than pull: this worktree is on its own branch and
# a merge started by a hook is a surprise nobody asked for.
DEFAULT_BRANCH="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || echo main)"
timeout 120 git fetch --quiet origin "$DEFAULT_BRANCH" || echo "skillhost: could not reach origin — carrying on with what is here"

# ── Your workspace layout goes here ────────────────────────────────────────────────────────────
#
# This is where a repo like lorveil/workspace pulls its sibling repositories into place. If your
# repo already ships a script for that, call it and delete the rest of this file:
#
#     if [ -x ./scripts/pull-all.sh ]; then
#       timeout 600 ./scripts/pull-all.sh
#     fi
#
# Otherwise, one clone-or-update per repo, each with a timeout:
#
#     for entry in "api:git@github.com:lorveil/api.git" "web:git@github.com:lorveil/web.git"; do
#       dir="${entry%%:*}"; url="${entry#*:}"
#       if [ -d "$dir/.git" ]; then
#         timeout 120 git -C "$dir" fetch --quiet origin || true
#       else
#         timeout 300 git clone --quiet "$url" "$dir" || echo "skillhost: could not clone $dir"
#       fi
#     done

echo "skillhost: ready"
