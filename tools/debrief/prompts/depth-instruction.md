<!-- HUMAN-OWNED PROMPT — edit freely. Given to the connected LLM to turn a THEME (or single
     cluster) + evidence into a SET of open questions. Never templated in code. If the
     questions feel shallow or narrow, deepen this. -->

# Ask the open questions

You are given a broad THEME (several related clusters grouped together) or a single narrow
CLUSTER, with: the topic/theme name, representative evidence snippets, how often it occurred
and across how many sessions, and — when available — relational signals and the developer's
standing protocols.

**Do NOT write a single question.** One question is too narrow to surface poignant,
existential insight. Write a SET of open questions (aim for 3-6) that together pry the topic
open. Expect a follow-up loop: the agent answers what it can from the evidence, and forwards
the rest to the developer. Some questions are *meant* to be unanswerable without the human —
that's good, mark them so.

## What the set should cover (reach for the non-obvious)
- Why is this topic important to the developer — what does caring about it protect?
- Why did the developer focus on this, here and now?
- What is the underlying CAUSE? Hold the three axes below at once and ask questions that would
  distinguish them.
- What WIDER, non-obvious problem might this be a symptom of — a process, a context-flow, or a
  team-knowledge gap — rather than just this developer's taste?

## The three causal axes — never collapse to "the AI vs the developer"
Any recurring pattern can come from:
1. **LLM design** — the model's own default behaviour (e.g. it reaches for non-standard
   abbreviations unprompted).
2. **Human design** — a genuine preference or protocol the developer is enforcing (e.g. they
   truly want full, explicit names).
3. **How the LLM was used** — the failure is in the *conversation*, not either party: critical
   context was missing. Ask WHERE it went missing — this session, an earlier session by the
   same developer, or even a session by a DIFFERENT developer whose decisions were never
   carried over. This axis is usually the most non-obvious and the most useful: it points at a
   fixable systemic/process problem instead of blame.

At least one question in every set must probe axis 3 as a **hypothetical** — e.g. "could this
keep happening because [decision/constraint] was never carried into the conversation from
[a prior session / another developer]?" Use hypotheticals to open up the wider problem.

## Each question must
1. Be grounded in the SPECIFIC behaviour, with a real example from the evidence.
2. Use frequency HONESTLY — say "twice" if it's twice; never inflate to "14×".
3. Be genuinely open (a real "why"/"what if"), never a verdict or conclusion.
4. Be tagged by who can likely answer it: **"evidence"** (the agent can attempt it from the
   corpus) or **"developer"** (needs the human's ground truth, so it gets forwarded).

## Altitude
- Broad THEME → the abstract, existential questions that tie the members together.
- Single CLUSTER → still reach past the one instance toward the principle.

## Use the extra signals when present
- **Relational signals** — persists after the AI had earned trust? spans unrelated domains?
  any counterexample where the developer accepted the very thing they usually reject? Use these
  to push past surface synthesis.
- **Standing protocols / open contradictions** — target what's unresolved; don't re-ask the
  settled.

## Output
`{ "questions": [ { "q": "<question>", "answerableBy": "evidence" | "developer", "axis": "importance | focus | cause-llm | cause-human | cause-context | wider", "why": "<one line>" }, ... ] }`
