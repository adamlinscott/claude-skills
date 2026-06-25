import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildServer, evidencePathFor } from "../src/mcp/server.ts";

const SENTINEL = "WIRE-RAW-SNIPPET-5521";

/** A two-cluster corpus + sidecar written to disk, the way the CLI miner would. */
async function seedCorpus(dir: string): Promise<{ corpusPath: string; clusterIds: string[] }> {
  const corpusPath = join(dir, "corpus.json");
  const evidencePath = evidencePathFor(corpusPath);
  const c1 = "11111111-1111-1111-1111-111111111111";
  const c2 = "22222222-2222-2222-2222-222222222222";
  const corpus = {
    schemaVersion: 1,
    generatedAt: "2026-06-25T00:00:00.000Z",
    sources: [],
    clusters: [
      { clusterId: c1, detector: "after-error", normalizedSubject: "rgb value", summary: "s1", count: 3, sessionCount: 2, evidenceIds: ["e1"], answers: [] },
      { clusterId: c2, detector: "turn-after-completion", normalizedSubject: "naming", summary: "s2", count: 1, sessionCount: 1, evidenceIds: ["e2"], answers: [] },
    ],
    aliases: {},
    protocols: [],
  };
  const evidence = {
    schemaVersion: 1,
    items: {
      e1: { id: "e1", sessionId: "sess-A", snippet: `${SENTINEL}-one` },
      e2: { id: "e2", sessionId: "sess-B", snippet: `${SENTINEL}-two` },
    },
  };
  await writeFile(corpusPath, JSON.stringify(corpus), "utf8");
  await writeFile(evidencePath, JSON.stringify(evidence), "utf8");
  return { corpusPath, clusterIds: [c1, c2] };
}

/** Stand up server + client over an in-memory transport pair against a seeded corpus. */
async function connect(corpusPath: string): Promise<Client> {
  const server = await buildServer({ corpusPath, evidencePath: evidencePathFor(corpusPath) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** Pull the JSON payload out of a tool result's first text-content block. */
function payload(res: unknown): any {
  const content = (res as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0].text);
}

test("MCP server exposes all eight tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath } = await seedCorpus(dir);
  const client = await connect(corpusPath);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
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
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("get_patterns over the wire excludes inline evidence and paginates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath } = await seedCorpus(dir);
  const client = await connect(corpusPath);

  const all = payload(await client.callTool({ name: "get_patterns", arguments: {} }));
  assert.equal(all.patterns.length, 2);
  assert.equal(JSON.stringify(all).includes(SENTINEL), false, "no raw evidence in summaries");

  const page1 = payload(await client.callTool({ name: "get_patterns", arguments: { limit: 1 } }));
  assert.equal(page1.patterns.length, 1);
  assert.ok(page1.nextCursor, "must offer a cursor when more remain");
  const page2 = payload(await client.callTool({ name: "get_patterns", arguments: { limit: 1, cursor: page1.nextCursor } }));
  assert.equal(page2.patterns.length, 1);
  assert.equal(page2.nextCursor, undefined);
  assert.notEqual(page1.patterns[0].clusterId, page2.patterns[0].clusterId);

  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("get_evidence over the wire delimits snippets as untrusted data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);
  const client = await connect(corpusPath);

  const bundle = payload(await client.callTool({ name: "get_evidence", arguments: { clusterId: clusterIds[0] } }));
  assert.equal(bundle.snippets.length, 1);
  assert.match(bundle.snippets[0].wrapped, /UNTRUSTED-EVIDENCE/);
  assert.ok(bundle.snippets[0].wrapped.includes(bundle.nonce));
  assert.match(bundle.notice, /not instructions/i);
  assert.ok(bundle.snippets[0].wrapped.includes(`${SENTINEL}-one`));

  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("answer_open_question over the wire returns the instruction and does NOT resolve", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);
  const client = await connect(corpusPath);

  const res = payload(await client.callTool({ name: "answer_open_question", arguments: { clusterId: clusterIds[0] } }));
  assert.equal(res.status, "ready");
  assert.equal(res.mode, "none");
  assert.ok(res.depthInstruction.length > 0, "returns the runtime-loaded depth instruction");
  assert.ok(res.evidence && res.evidence.snippets.length === 1);

  // it did not write an answer to disk (no auto-resolution)
  const hot = JSON.parse(await readFile(corpusPath, "utf8"));
  const cl = hot.clusters.find((c: { clusterId: string }) => c.clusterId === clusterIds[0]);
  assert.equal(cl.answers.length, 0, "answer_open_question must not write an answer itself");

  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("answer_open_question mode:user over the wire forwards WITH evidence + depth instruction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);
  const client = await connect(corpusPath);

  const res = payload(
    await client.callTool({ name: "answer_open_question", arguments: { clusterId: clusterIds[0], mode: "user" } }),
  );
  assert.equal(res.status, "pending-user");
  assert.equal(res.mode, "user");
  assert.ok(res.depthInstruction.length > 0, "forward must carry the depth instruction");
  assert.ok(res.evidence && res.evidence.snippets.length === 1, "forward must carry the evidence bundle");
  assert.ok(res.evidence.snippets[0].wrapped.includes(`${SENTINEL}-one`));

  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("submit_answer over the wire rejects silent source:user; persists atomically when confirmed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);
  const client = await connect(corpusPath);

  // source:user WITHOUT confirmed -> downgraded to inferred
  const r1 = payload(await client.callTool({ name: "submit_answer", arguments: { clusterId: clusterIds[0], text: "poison", source: "user" } }));
  assert.equal(r1.source, "inferred");

  // source:user WITH confirmed:true -> recorded as user ground truth, persisted to disk
  const r2 = payload(await client.callTool({ name: "submit_answer", arguments: { clusterId: clusterIds[0], text: "ground truth", source: "user", confirmed: true } }));
  assert.equal(r2.source, "user");

  const hot = JSON.parse(await readFile(corpusPath, "utf8"));
  const cl = hot.clusters.find((c: { clusterId: string }) => c.clusterId === clusterIds[0]);
  assert.equal(cl.answers.length, 2);
  assert.deepEqual(cl.answers.map((a: { source: string }) => a.source).sort(), ["inferred", "user"]);

  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("export_rules_file over the wire returns synthesis material, not a generated file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath } = await seedCorpus(dir);
  const client = await connect(corpusPath);

  const res = payload(await client.callTool({ name: "export_rules_file", arguments: {} }));
  assert.equal(res.patterns.length, 2);
  assert.ok(Array.isArray(res.answers));
  assert.match(res.instruction, /SYNTHESIS INSTRUCTION/);
  assert.equal(JSON.stringify(res).includes(SENTINEL), false);

  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("merge_clusters over the wire absorbs one cluster into the other and persists merged:true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);
  const client = await connect(corpusPath);

  const res = payload(
    await client.callTool({ name: "merge_clusters", arguments: { fromClusterId: clusterIds[1], intoClusterId: clusterIds[0] } }),
  );
  assert.equal(res.intoClusterId, clusterIds[0]);

  const hot = JSON.parse(await readFile(corpusPath, "utf8"));
  assert.equal(hot.clusters.length, 1, "absorbed cluster removed on disk");
  assert.equal(hot.clusters[0].clusterId, clusterIds[0]);
  assert.equal(hot.clusters[0].merged, true, "target persisted with merged:true");
  assert.equal(hot.clusters[0].count, 2, "evidence unioned (e1 + e2)");

  // get_patterns now reports the merged flag over the wire
  const patterns = payload(await client.callTool({ name: "get_patterns", arguments: {} }));
  assert.equal(patterns.patterns[0].merged, true);

  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("merge_clusters over the wire surfaces an unknown clusterId as a recoverable error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);
  const client = await connect(corpusPath);

  const res = (await client.callTool({ name: "merge_clusters", arguments: { fromClusterId: "nope", intoClusterId: clusterIds[0] } })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /no fromClusterId/);

  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("add_alias over the wire re-points a subject and persists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);
  const client = await connect(corpusPath);

  const res = payload(await client.callTool({ name: "add_alias", arguments: { normalizedSubject: "rgb colour value", clusterId: clusterIds[0] } }));
  assert.equal(res.clusterId, clusterIds[0]);
  assert.equal(res.detector, "after-error", "detector inherited from the target cluster");

  const hot = JSON.parse(await readFile(corpusPath, "utf8"));
  assert.ok(Object.values(hot.aliases).includes(clusterIds[0]), "alias persisted to the target id");

  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("record_protocol over the wire appends a standing protocol and answer_open_question returns it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);
  const client = await connect(corpusPath);

  const rec = payload(await client.callTool({ name: "record_protocol", arguments: { statement: "verifies against the running system", confidence: 0.8, contradicts: ["accepted a mock once"] } }));
  assert.equal(rec.status, "created");

  const hot = JSON.parse(await readFile(corpusPath, "utf8"));
  assert.equal(hot.protocols.length, 1);
  assert.equal(hot.protocols[0].hypothesis, "verifies against the running system");

  // answer_open_question now threads the standing protocol back to the agent
  const aq = payload(await client.callTool({ name: "answer_open_question", arguments: { clusterId: clusterIds[0] } }));
  assert.equal(aq.standingProtocols.length, 1);
  assert.equal(aq.standingProtocols[0].hypothesis, "verifies against the running system");

  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("get_patterns minCount over the wire filters below the bar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath } = await seedCorpus(dir); // c1 count 3, c2 count 1
  const client = await connect(corpusPath);

  const all = payload(await client.callTool({ name: "get_patterns", arguments: {} }));
  assert.equal(all.patterns.length, 2);
  const barred = payload(await client.callTool({ name: "get_patterns", arguments: { minCount: 2 } }));
  assert.equal(barred.patterns.length, 1, "only the count-3 cluster clears a minCount:2 bar");
  assert.equal(barred.patterns[0].count, 3);

  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("MCP server surfaces a corrupt corpus as a recoverable error, not a crash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const corpusPath = join(dir, "corpus.json");
  await writeFile(corpusPath, "{ corrupt", "utf8");
  const client = await connect(corpusPath);

  const res = (await client.callTool({ name: "get_patterns", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /corpus read error \(corrupt\)/);

  await client.close();
  await rm(dir, { recursive: true, force: true });
});
