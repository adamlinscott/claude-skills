/**
 * Claude Code session-log parsing + human-turn extraction.
 *
 * Schema verified by spike against real sessions (CC 2.1.181), see README "Verified schema".
 * Each .jsonl line is one event object with a `type`. We only care about real
 * human-typed turns; everything else (tool_result carriers, slash-command
 * machinery, injected caveats, snapshots, mode events) is noise.
 *
 *   event types seen: user, assistant, system, tool_result(in user), mode,
 *     permission-mode, last-prompt, file-history-snapshot, queue-operation,
 *     attachment, ai-title
 *
 *   user.message.content is an ARRAY of blocks in real sessions:
 *     [{type:"text",text}, {type:"tool_result",tool_use_id,content,is_error}]
 *   ...but can be a STRING in lighter sessions (slash-command machinery). Handle both.
 *
 *   origin is often ABSENT and isMeta is often UNDEFINED (not false) — so gate on
 *   `isMeta !== true`, never `origin.kind === "human"` (that was a bootstrap-file artifact).
 */

export interface RawEvent {
  type?: string;
  isMeta?: boolean;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  sessionId?: string;
  message?: { role?: string; content?: unknown };
  [k: string]: unknown;
}

export interface HumanTurn {
  uuid?: string;
  parentUuid?: string | null;
  text: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  sessionId?: string;
}

interface ContentInfo {
  text: string;
  hasText: boolean;
  hasToolResult: boolean;
  blockTypes: string[];
}

/** Normalize string|array content into joined text + structural flags. */
export function normalizeContent(content: unknown): ContentInfo {
  if (typeof content === "string") {
    return { text: content, hasText: content.length > 0, hasToolResult: false, blockTypes: ["string"] };
  }
  if (Array.isArray(content)) {
    const blockTypes: string[] = [];
    const textParts: string[] = [];
    let hasToolResult = false;
    for (const b of content as Array<Record<string, unknown>>) {
      const t = typeof b?.type === "string" ? (b.type as string) : "unknown";
      blockTypes.push(t);
      if (t === "text" && typeof b.text === "string") textParts.push(b.text as string);
      if (t === "tool_result") hasToolResult = true;
    }
    const text = textParts.join("\n").trim();
    return { text, hasText: text.length > 0, hasToolResult, blockTypes };
  }
  return { text: "", hasText: false, hasToolResult: false, blockTypes: [] };
}

/**
 * True iff this event is a real human-typed turn (not tool_result-only, not an
 * injected caveat, not slash-command machinery). This is the detector's recall gate.
 */
export function isHumanTextTurn(ev: RawEvent): boolean {
  if (!ev || ev.type !== "user") return false;
  if (ev.isMeta === true) return false; // injected caveat / meta
  const info = normalizeContent(ev.message?.content);
  if (!info.hasText) return false; // tool_result-only or empty
  // slash-command machinery: <command-name>, <local-command-caveat>, <local-command-stdout>
  if (info.text.startsWith("<")) return false;
  return true;
}

/** Extract human turns from a parsed event list, in order. */
export function extractHumanTurns(events: RawEvent[]): HumanTurn[] {
  const out: HumanTurn[] = [];
  for (const ev of events) {
    if (!isHumanTextTurn(ev)) continue;
    out.push({
      uuid: ev.uuid,
      parentUuid: ev.parentUuid ?? null,
      text: normalizeContent(ev.message?.content).text,
      timestamp: ev.timestamp,
      cwd: ev.cwd,
      gitBranch: ev.gitBranch,
      version: ev.version,
      sessionId: ev.sessionId,
    });
  }
  return out;
}
