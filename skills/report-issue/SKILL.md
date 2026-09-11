---
name: report-issue
description: '[Adam''s Skills] Alias for the raise-issue skill. Turns "this is broken" into a well-formed issue in the team''s tracker, written in the codebase''s own vocabulary — a few plain-English questions, a check of which part of the code is being described, a duplicate check, then filing it once the person says yes. Built for someone who uses the product and does not read code. Invoke with /report-issue.'
allowed-tools: Read, Glob, Grep, Bash, Write, AskUserQuestion
disable-model-invocation: true
---

# Report issue (alias)

This is an alias so that both `/raise-issue` and `/report-issue` work.

Read `skills/raise-issue/SKILL.md` — resolve it relative to this file's parent directory
(`../raise-issue/SKILL.md`), or at `~/.claude/skills/raise-issue/SKILL.md` when installed — and
follow it in full. Pass through any description or flags the user gave.

Unlike its parent, this alias **is** explicit-invocation only. `/raise-issue` deliberately omits
`disable-model-invocation` so it can reach someone who says "this looks wrong" without knowing the
command exists; two skills competing to answer that same sentence would be worse than one. The
alias exists for the person who types `/report-issue`, and that is all it needs to do.

Do not duplicate the workflow here. One source of truth: a second copy of the tone rules and the
publish gate would drift, and the publish gate is what makes the parent safe to auto-invoke.
