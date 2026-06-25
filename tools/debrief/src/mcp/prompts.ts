/**
 * Runtime prompt loader (T7 support).
 *
 * The depth + classify instructions are HUMAN-OWNED files under prompts/ (see prompts/README.md).
 * They are loaded FROM DISK AT RUNTIME, never inlined into code, so editing a prompt changes how
 * the connected agent reasons with NO rebuild — that is the whole point of the return-instruction
 * design (the tool never calls an LLM; it hands these instructions back to the calling agent).
 *
 * The prompts/ directory sits at the PACKAGE ROOT, a sibling of src/ (dev, run via tsx) and of
 * dist/ (built). This module lives at src/mcp/prompts.ts or dist/mcp/prompts.js, so we walk up
 * from the module's own directory until we find a prompts/ folder. That makes the lookup correct
 * in both layouts without hardcoding "../.." depths that differ between src and dist.
 */

import { readFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the package-root prompts/ directory by walking up from this module. */
async function findPromptsDir(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Walk up a bounded number of levels (src/mcp -> src -> root, or dist/mcp -> dist -> root,
  // plus slack) looking for a directory that contains a prompts/ folder.
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "prompts");
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* not here; go up one level */
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  throw new Error("could not locate the prompts/ directory relative to the debrief module");
}

/** The two instruction files handed back to the connected agent via answer_open_question. */
export interface ReturnInstructions {
  /** prompts/depth-instruction.md — how to turn a pattern/theme + evidence into open questions. */
  depthInstruction: string;
  /** prompts/classify-intent.md — how to classify a candidate turn's intent. */
  classifyIntent: string;
}

/**
 * Load both return-instruction prompts from disk. Throws a clear error if the files are missing
 * (a deploy/packaging bug worth surfacing, not silently swallowing).
 */
export async function loadReturnInstructions(): Promise<ReturnInstructions> {
  const dir = await findPromptsDir();
  const [depthInstruction, classifyIntent] = await Promise.all([
    readFile(join(dir, "depth-instruction.md"), "utf8"),
    readFile(join(dir, "classify-intent.md"), "utf8"),
  ]);
  return { depthInstruction, classifyIntent };
}

/**
 * Load the tidy-up instruction (prompts/group-themes.md) the connected agent runs to consolidate
 * the corpus: fuse true-duplicate clusters (merge_clusters/add_alias) and form broad themes
 * (group_theme). Same disk-loaded, live-editable mechanism as the depth/classify instructions —
 * the tool never groups by code; this file IS the grouping logic. Throws if the file is missing.
 */
export async function loadGroupThemesInstruction(): Promise<string> {
  const dir = await findPromptsDir();
  return readFile(join(dir, "group-themes.md"), "utf8");
}

/**
 * A live, fresh-each-call reader of the return instructions for the long-running MCP server.
 *
 * The whole point of disk-loading (vs. inlining the prompt text into code) is that a human can edit
 * prompts/depth-instruction.md or prompts/classify-intent.md and have it change how the connected
 * agent reasons with NO rebuild AND no server restart. Loading once at startup would defeat that:
 * a running `debrief serve` would serve stale text until the process was killed. So the server holds
 * one of these readers and calls it inside each answer_open_question handler.
 *
 * To avoid a disk read on literally every call while still picking up edits promptly, reads are
 * cached for a short TTL (default 1s). Within the TTL the cached text is returned; after it the
 * files are re-read. A failed read (missing prompts dir) is NOT cached and propagates, so the
 * caller can degrade just that one tool rather than crashing the whole server.
 */
export function makeInstructionsReader(ttlMs = 1000): () => Promise<ReturnInstructions> {
  let cache: ReturnInstructions | undefined;
  let loadedAt = 0;
  return async () => {
    const now = Date.now();
    if (cache && now - loadedAt < ttlMs) return cache;
    const fresh = await loadReturnInstructions();
    cache = fresh;
    loadedAt = now;
    return fresh;
  };
}

/**
 * A live, fresh-each-call reader of the group-themes tidy-up instruction (same short-TTL caching
 * and live-edit rationale as makeInstructionsReader). Used by the get_grouping_task tool so a human
 * editing prompts/group-themes.md changes the tidy-up logic with no rebuild and no server restart.
 */
export function makeGroupThemesReader(ttlMs = 1000): () => Promise<string> {
  let cache: string | undefined;
  let loadedAt = 0;
  return async () => {
    const now = Date.now();
    if (cache !== undefined && now - loadedAt < ttlMs) return cache;
    const fresh = await loadGroupThemesInstruction();
    cache = fresh;
    loadedAt = now;
    return fresh;
  };
}
