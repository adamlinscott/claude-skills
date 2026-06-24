#!/usr/bin/env node
/**
 * debrief CLI entry point (skeleton).
 * Real subcommands land per the eng-review task list (T1..T14). For now this
 * just proves the bin wires up and the extractor is reachable.
 */
import { extractHumanTurns } from "./extract/parse.js";

const [, , cmd] = process.argv;

async function main(): Promise<void> {
  switch (cmd) {
    case "version":
    case undefined:
      console.log("debrief 0.0.0 (skeleton)");
      console.log("extractor reachable:", typeof extractHumanTurns === "function");
      console.log("subcommands coming: extract | serve (mcp) | rules | metric");
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
