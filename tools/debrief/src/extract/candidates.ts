/**
 * Structural candidate source (T5 + T2-structural).
 *
 * STRUCTURAL ONLY — per CORE PRINCIPLE, this reads no intent. It finds human turns
 * and attaches STRUCTURAL context (what the AI did just before, whether a tool call
 * errored). It does NOT decide whether a turn is a correction/bug-report/approval/
 * question — that is the connected LLM's job, downstream. No keyword/regex matching.
 *
 * Pipeline:  .jsonl  ─stream→ events ─extractCandidates→ Candidate[] (turn + structural context)
 *                                                              │
 *                                              (handed to the LLM for classification)
 */

import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { isHumanTextTurn, normalizeContent, type RawEvent, type HumanTurn } from "./parse.js";

/** Structural summary of the assistant turn before a human turn. Context for the LLM. */
export interface AssistantContext {
  tools: string[]; // tool_use names the AI used (structural)
  text: string; // the AI's last text — passed to the LLM as context, NOT classified here
  hadToolUse: boolean;
}

export interface Candidate {
  turn: HumanTurn;
  precededByAssistant: boolean; // the human turn responds to something the AI did
  precededByToolUse: boolean; // the AI ran tool(s) just before
  precededByError: boolean; // a tool_result with is_error:true since the last human turn
  ai: AssistantContext | null; // structural context for the LLM
}

function toHumanTurn(ev: RawEvent): HumanTurn {
  return {
    uuid: ev.uuid,
    parentUuid: ev.parentUuid ?? null,
    text: normalizeContent(ev.message?.content).text,
    timestamp: ev.timestamp,
    cwd: ev.cwd,
    gitBranch: ev.gitBranch,
    version: ev.version,
    sessionId: ev.sessionId,
  };
}

function summarizeAssistant(ev: RawEvent): AssistantContext {
  const c = ev.message?.content;
  const tools: string[] = [];
  const textParts: string[] = [];
  if (Array.isArray(c)) {
    for (const b of c as Array<Record<string, unknown>>) {
      if (b?.type === "tool_use" && typeof b.name === "string") tools.push(b.name as string);
      if (b?.type === "text" && typeof b.text === "string") textParts.push(b.text as string);
    }
  } else if (typeof c === "string") {
    textParts.push(c);
  }
  return { tools: [...new Set(tools)], text: textParts.join("\n").trim(), hadToolUse: tools.length > 0 };
}

function hasErrorToolResult(ev: RawEvent): boolean {
  const c = ev.message?.content;
  if (!Array.isArray(c)) return false;
  return (c as Array<Record<string, unknown>>).some((b) => b?.type === "tool_result" && b.is_error === true);
}

/**
 * Pure + testable: ordered events → structural candidates. The "window" between two
 * human turns tracks whether the AI acted and whether a tool errored; those flags ride
 * along with the next human turn so the LLM can weigh them.
 */
export function extractCandidates(events: RawEvent[]): Candidate[] {
  const out: Candidate[] = [];
  // Window = events since the last human turn. Tool use and errors are accumulated across
  // the WHOLE window, because a real exchange is assistant(tool_use) → tool_result →
  // assistant(text summary) → human. Looking only at the immediately-preceding assistant
  // turn misses the tools (it's usually the text summary). Caught by running on real data.
  let windowTools = new Set<string>();
  let toolUseSinceHuman = false;
  let errorSinceHuman = false;
  let sawAssistantSinceHuman = false;
  let lastAssistantText = "";

  const resetWindow = () => {
    windowTools = new Set<string>();
    toolUseSinceHuman = false;
    errorSinceHuman = false;
    sawAssistantSinceHuman = false;
    lastAssistantText = "";
  };

  for (const ev of events) {
    if (ev.type === "assistant") {
      const a = summarizeAssistant(ev);
      a.tools.forEach((t) => windowTools.add(t));
      if (a.hadToolUse) toolUseSinceHuman = true;
      if (a.text) lastAssistantText = a.text; // keep the latest AI prose as context
      sawAssistantSinceHuman = true;
      continue;
    }
    if (ev.type === "user") {
      if (hasErrorToolResult(ev)) errorSinceHuman = true; // tool_result carriers are user events
      if (isHumanTextTurn(ev)) {
        out.push({
          turn: toHumanTurn(ev),
          precededByAssistant: sawAssistantSinceHuman,
          precededByToolUse: toolUseSinceHuman,
          precededByError: errorSinceHuman,
          ai: sawAssistantSinceHuman
            ? { tools: [...windowTools], text: lastAssistantText, hadToolUse: toolUseSinceHuman }
            : null,
        });
        resetWindow();
      }
    }
  }
  return out;
}

/** Stream one session file, tolerating corrupt/partial trailing lines. */
export async function* streamSession(path: string): AsyncGenerator<RawEvent> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as RawEvent;
    } catch {
      /* tolerate corrupt / partial trailing line (live file mid-write) */
    }
  }
}

export async function candidatesFromFile(path: string): Promise<Candidate[]> {
  const events: RawEvent[] = [];
  for await (const ev of streamSession(path)) events.push(ev);
  return extractCandidates(events);
}
