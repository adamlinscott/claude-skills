#!/usr/bin/env node
/**
 * debrief CLI entry point (skeleton).
 * Real subcommands land per the eng-review task list (T1..T14). The CLI does
 * deterministic STRUCTURAL work only; intent/question generation is the connected
 * LLM's job (see prompts/ and the design doc CORE PRINCIPLE).
 */
import { candidatesFromFile } from "./extract/candidates.js";

const [, , cmd, arg] = process.argv;

async function main(): Promise<void> {
  switch (cmd) {
    case "extract": {
      if (!arg) {
        console.error("usage: debrief extract <session.jsonl>");
        process.exitCode = 1;
        return;
      }
      const cands = await candidatesFromFile(arg);
      const tool = cands.filter((c) => c.precededByToolUse).length;
      const err = cands.filter((c) => c.precededByError).length;
      console.log(`structural candidates: ${cands.length}`);
      console.log(`  preceded by tool_use: ${tool} | preceded by tool error: ${err}`);
      console.log("(intent classification + question generation are the LLM's job — not done here)");
      return;
    }
    case "version":
    case undefined:
      console.log("debrief 0.0.0 (skeleton)");
      console.log("subcommands: extract <file> | serve (mcp, TODO) | rules (TODO) | metric (TODO)");
      return;
    default:
      console.error(`unknown command: ${cmd}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
