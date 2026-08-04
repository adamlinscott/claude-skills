---
name: gstack
title: Garry Tan's gstack
summary: browser QA, design review, shipping and deploy skills.
order: 2
detect: ~/.claude/skills/gstack
url: https://github.com/garrytan/gstack
requires: git=https://git-scm.com/downloads, bun=https://bun.sh
shell: bash
command: git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup
next: Try /office-hours to describe what you are building, then /review on a branch with changes and /qa on a staging URL.
---
Drives a real browser to QA your site, reviews design and code, and handles the ship-and-deploy
end of the job.

Clones into ~/.claude/skills/gstack and runs its own setup script.
