---
name: to-the-point
description: 'Alias for the ttp skill. Shape user-facing output to be brief and direct — lead with the substance, keep the default answer short, and expand only when the user asks for detail. Leaves the user in control: Claude settles small, reversible, or already-decided points and proceeds, but routes high-impact calls (ADR-worthy, production, project shape, which features get built, infrastructure) to the user with enough context to decide. Only shapes prose written for the user to read; Claude''s own reasoning, tool use, code, and planning are untouched. Invoke with /to-the-point or /ttp; stays on until "stop ttp" or "normal mode".'
disable-model-invocation: true
---

# To the Point (alias)

This is an alias so that both `/ttp` and `/to-the-point` work.

Read `skills/ttp/SKILL.md` — resolve it relative to this file's parent directory
(`../ttp/SKILL.md`), or at `~/.claude/skills/ttp/SKILL.md` when installed — and follow it in full.
Pass through any flags the user gave.

Do not duplicate the rules here. One source of truth: a divergent copy drifts, and then the two
names behave differently.
