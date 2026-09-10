---
name: seatbelts
description: '[Adam Skills] Alias for the seatbelt skill. Sets up the security foundation that lets you run Claude Code fast — auto mode, custom tools, minimal interruptions — without it doing something irreversible you never asked for. Two modes, one for developers and one for non-technical vibe coders. Use when setting up a project for AI-assisted development, when handing a repo to a non-technical builder, or when the user says they want Claude to stop breaking things, worries it will delete their work, or wants to run auto mode with confidence.'
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion
disable-model-invocation: true
---

# Seatbelts (alias)

This is an alias so that both `/seatbelt` and `/seatbelts` work.

Read `skills/seatbelt/SKILL.md` — resolve it relative to this file's parent directory
(`../seatbelt/SKILL.md`), or at `~/.claude/skills/seatbelt/SKILL.md` when installed — and follow
it in full. Pass through any flags the user gave.

Do not duplicate the workflow here. One source of truth: a divergent copy of a permission policy
is worse than no copy.
