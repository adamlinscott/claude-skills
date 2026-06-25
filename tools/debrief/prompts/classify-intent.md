<!-- HUMAN-OWNED PROMPT — edit freely. Given to the connected LLM to read ONE developer chat
     turn (+ structural context) and tag it. The tool NEVER classifies intent in code; this
     file is the classifier. Validate changes against the T2 eval set. -->

# Classify a turn

You are given ONE developer chat turn from a coding session, plus structural context (what
the AI had just done: tools used, whether a tool call errored, the AI's last message). Read
the MEANING, not keywords.

## Kind — a PRIMARY label, plus a SECONDARY only if the turn truly does two things

- **R — redirect**: wants the AI to do it differently, undo, or change course.
- **O — observed**: reports reality contradicting the AI — a bug, a failed result, a false
  claim by the AI, or a stale/incorrect artifact. (The developer verifying against the running
  system — this is often the most valuable signal.)
- **C — continue**: accepts/approves and moves on, gives a new objective, or hands off the
  next task.
- **Q — query**: a pure information request; the right response is to answer it, not to treat
  it as a correction.
- **X — not a real turn**: noise (machine text, empty, irrelevant).

Many turns do two things at once. "Looks good, but the login page 403s" is primary **C** with
secondary **O**. Set `secondary` ONLY when a genuine second intent is present; otherwise omit
it. Pick the label that carries the turn's main weight as `primary`.

## Topic — name what the turn is ABOUT, narrowly and faithfully

Give a short topic label (≈3-6 words) for the concrete thing this turn is about, e.g.
"abbreviated variable names", "mock data in production", "stale plan status in docs". Keep it
SPECIFIC to this turn. Do NOT abstract up to grand themes here — a separate tidy-up step
(see group-themes) groups related topics later. Where two turns are about the same concrete
thing, prefer the same wording so they pile together naturally.

## Output

JSON:
`{ "primary": "R|O|C|Q|X", "secondary": "R|O|C|Q|X" (optional), "topic": "<3-6 words>", "confidence": 0.0-1.0, "why": "<one sentence>" }`
