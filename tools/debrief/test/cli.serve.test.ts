import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/**
 * End-to-end smoke test of the `serve` (and its `mcp` alias) CLI dispatch path — the wiring that the
 * in-memory buildServer tests do NOT exercise: that the subcommand resolves the corpus path, derives
 * the evidence sidecar, keeps startup chatter on STDERR (so STDOUT carries only JSON-RPC), and stands
 * up a working stdio server. A regression renaming the case or printing the banner to stdout would
 * pass every other test but fail here.
 */

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** A minimal valid corpus on disk so the server has something to serve. */
async function seedCorpus(dir: string): Promise<string> {
  const corpusPath = join(dir, "corpus.json");
  const corpus = {
    schemaVersion: 1,
    generatedAt: "2026-06-25T00:00:00.000Z",
    sources: [],
    clusters: [],
    aliases: {},
    protocols: [],
  };
  await writeFile(corpusPath, JSON.stringify(corpus), "utf8");
  return corpusPath;
}

/**
 * Spawn `node --import tsx src/cli.ts <cmd> <corpusPath>`, drive an MCP initialize + tools/list over
 * stdio, and return the captured stdout / stderr. Resolves once the tools/list response (id 2) is
 * seen on stdout or a timeout elapses.
 */
async function driveServer(cmd: "serve" | "mcp", corpusPath: string): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", CLI, cmd, corpusPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  const send = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");

  // initialize, then (after a beat) ask for the tool list.
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.0" },
    },
  });
  await delay(150);
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  // Wait until the id:2 response arrives on stdout, or give up after a bounded window.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !/"id"\s*:\s*2\b/.test(stdout)) {
    await delay(50);
  }

  child.kill();
  return { stdout, stderr };
}

/** Parse newline-delimited JSON-RPC frames out of a stdout blob. */
function frames(stdout: string): any[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

for (const cmd of ["serve", "mcp"] as const) {
  test(`debrief ${cmd} stands up a stdio MCP server: JSON-RPC on stdout, banner on stderr`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "debrief-serve-"));
    try {
      const corpusPath = await seedCorpus(dir);
      const { stdout, stderr } = await driveServer(cmd, corpusPath);

      // (a) stdout is pure JSON-RPC and lists the five tool names.
      const msgs = frames(stdout);
      const toolList = msgs.find((m) => m.id === 2);
      assert.ok(toolList, "expected a tools/list response (id 2) on stdout");
      const names = toolList.result.tools.map((t: { name: string }) => t.name).sort();
      assert.deepEqual(names, [
        "add_alias",
        "answer_open_question",
        "export_rules_file",
        "get_evidence",
        "get_patterns",
        "merge_clusters",
        "record_protocol",
        "submit_answer",
      ]);

      // (b) the startup banner is on STDERR, never on stdout (stdout must stay clean for JSON-RPC).
      assert.match(stderr, /MCP server starting/i);
      assert.ok(stderr.includes(corpusPath), "banner names the corpus path (on stderr)");
      assert.equal(/MCP server starting/i.test(stdout), false, "no human banner may leak onto stdout");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
