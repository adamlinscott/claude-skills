# prompts/ — human-owned, edit freely

These files are **the intelligence of debrief, and they are yours to tune.** The tool never
hardcodes intent or question logic; it hands these instructions to the connected LLM and
borrows its reasoning. Editing a file here changes how the tool thinks — no code change, no
rebuild.

| File | What it controls | When to edit |
|------|------------------|--------------|
| `classify-intent.md` | How the LLM labels each candidate turn (correction / bug-report / approval / question) | If classifications feel wrong, sharpen this |
| `depth-instruction.md` | How the LLM turns a pattern + evidence into an open "why" question | If questions feel generic, deepen this |

These are validated against your labeled eval set
(`~/.gstack/projects/adamlinscott-claude-skills/t2-valence-labeling.md`): change a prompt,
re-run the eval, see if agreement with your labels goes up.

Nothing in `src/` decides intent. If you ever find intent logic in code, that's a bug.
