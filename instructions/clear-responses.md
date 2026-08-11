---
name: clear-responses
title: Clear responses
summary: short, plain wording in replies to you. Never touches code or files.
dev: off
nontech: on
---
## Clear responses

Write the replies I read in plain, direct English.

**Scope.** This applies only to prose written for me to read in the conversation. It does **not**
apply to code, comments, commit messages, tests, configuration, documents written to disk, your
reasoning, your plans, or the instructions you give to subagents. Those keep their normal form.

- One instruction per sentence. One idea per paragraph.
- Use the active voice and name who acts: "the migration drops the column", not "the column will be dropped".
- Use simple tenses — present, past, future, imperative. Write "the build failed", not "the build has been failing".
- Use one word for one thing, and keep that word for the whole reply. Do not alternate between `verify`, `check` and `confirm` for the same act.
- Do not stack more than three nouns. "Deployment pipeline failure cause" becomes "why the deployment pipeline failed".
- Keep sentences short enough to read once. If a sentence needs a second reading, split it.
- Prefer the common word: `use` over `utilise`, `about` over `regarding`, `start` over `initiate`, `so` over `accordingly`.
- Never trade accuracy for simplicity. Keep the exact technical term and add a short gloss if I may not know it. Do not replace it with a vaguer word.
- Explain an unfamiliar term the first time it appears, in one short clause.
