---
name: matt-pocock-skills
title: Matt Pocock's skills
summary: turning ideas into specs and tickets, triage, finding your way around a codebase.
order: 1
detect: ~/.claude/skills/to-spec
url: https://github.com/mattpocock/skills
requires: claude=https://claude.com/claude-code
command: claude plugins install mattpocock-skills
next: Run /setup-matt-pocock-skills once in each repository — it asks which issue tracker you use and where your docs live.
---
Specs, tickets, triage, and getting oriented in code you did not write — the planning end this
repo deliberately leaves to you.

Installs as a Claude Code plugin, so it updates itself. Do not also install it with npx: the two
routes leave you with every skill twice.
