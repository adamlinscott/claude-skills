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

test("MCP server exposes all fifteen tools", async () => {
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
    "get_grouping_task",
    "get_patterns",
    "get_pending_questions",
    "get_themes",
    "group_theme",
    "merge_clusters",
    "record_protocol",
    "set_cluster_kind",
    "skip_question",
    "submit_answer",
    "ungroup_theme",
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

test("pending lifecycle over the wire: forward persists pending; survives reconnect (cross-session); user answer clears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);

  // Session 1: forward a question to the user (mode:'user') -> marks + PERSISTS pending.
  {
    const client = await connect(corpusPath);
    const res = payload(
      await client.callTool({ name: "answer_open_question", arguments: { clusterId: clusterIds[0], mode: "user" } }),
    );
    assert.equal(res.status, "pending-user");
    assert.ok(res.pending && typeof res.pending.forwardedAt === "string", "result echoes the pending record");
    assert.equal(res.pending.skipCount, 0);
    await client.close();
  }

  // It is on disk (persisted) so it survives across sessions.
  const hot1 = JSON.parse(await readFile(corpusPath, "utf8"));
  const cl1 = hot1.clusters.find((c: { clusterId: string }) => c.clusterId === clusterIds[0]);
  assert.ok(cl1.pending, "pending persisted to disk");

  // Session 2 (a FRESH server reading the same file): get_pending_questions surfaces it.
  {
    const client = await connect(corpusPath);
    const pend = payload(await client.callTool({ name: "get_pending_questions", arguments: {} }));
    assert.equal(pend.totalPending, 1);
    assert.equal(pend.pending.length, 1);
    assert.equal(pend.pending[0].clusterId, clusterIds[0]);
    assert.equal(pend.pending[0].demoted, false);
    assert.equal(JSON.stringify(pend).includes(SENTINEL), false, "pending list is evidence-free");

    // Defer it once via skip_question -> persists an incremented skipCount.
    const sk = payload(await client.callTool({ name: "skip_question", arguments: { clusterId: clusterIds[0] } }));
    assert.equal(sk.skipCount, 1);
    await client.close();
  }
  const hot2 = JSON.parse(await readFile(corpusPath, "utf8"));
  const cl2 = hot2.clusters.find((c: { clusterId: string }) => c.clusterId === clusterIds[0]);
  assert.equal(cl2.pending.skipCount, 1, "skip persisted");

  // Session 3: a confirmed source:user answer RESOLVES it -> pending cleared on disk.
  {
    const client = await connect(corpusPath);
    const r = payload(
      await client.callTool({ name: "submit_answer", arguments: { clusterId: clusterIds[0], text: "real answer", source: "user", confirmed: true } }),
    );
    assert.equal(r.source, "user");
    const pend = payload(await client.callTool({ name: "get_pending_questions", arguments: {} }));
    assert.equal(pend.totalPending, 0, "user answer cleared the pending question");
    await client.close();
  }
  const hot3 = JSON.parse(await readFile(corpusPath, "utf8"));
  const cl3 = hot3.clusters.find((c: { clusterId: string }) => c.clusterId === clusterIds[0]);
  assert.equal(cl3.pending, undefined, "pending cleared on disk");

  await rm(dir, { recursive: true, force: true });
});

test("skip_question over the wire surfaces unknown/not-pending as a recoverable error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);
  const client = await connect(corpusPath);

  const unknown = (await client.callTool({ name: "skip_question", arguments: { clusterId: "nope" } })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /no cluster/);

  // a real but not-pending cluster also errors (you can't skip what was never forwarded)
  const notPending = (await client.callTool({ name: "skip_question", arguments: { clusterId: clusterIds[0] } })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(notPending.isError, true);
  assert.match(notPending.content[0].text, /not pending/);

  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("get_patterns answeredBy:'inferred' over the wire lists only inferred-only clusters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);
  const client = await connect(corpusPath);

  // cluster[0] gets a user answer; cluster[1] gets an inferred-only answer.
  await client.callTool({ name: "submit_answer", arguments: { clusterId: clusterIds[0], text: "u", source: "user", confirmed: true } });
  await client.callTool({ name: "submit_answer", arguments: { clusterId: clusterIds[1], text: "i" } }); // inferred

  const inferred = payload(await client.callTool({ name: "get_patterns", arguments: { answeredBy: "inferred" } }));
  assert.equal(inferred.patterns.length, 1);
  assert.equal(inferred.patterns[0].clusterId, clusterIds[1]);
  assert.equal(inferred.patterns[0].answerSource, "inferred");

  const userGrounded = payload(await client.callTool({ name: "get_patterns", arguments: { answeredBy: "user" } }));
  assert.equal(userGrounded.patterns.length, 1);
  assert.equal(userGrounded.patterns[0].clusterId, clusterIds[0]);

  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("TIER 2 over the wire: group_theme creates+extends, get_themes is evidence-free, persists across reconnect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);

  let themeId: string;
  // Session 1: create a theme grouping both clusters (non-destructive), persisted to disk.
  {
    const client = await connect(corpusPath);
    const res = payload(await client.callTool({ name: "group_theme", arguments: { name: "code tells the truth", clusterIds } }));
    assert.equal(res.status, "created");
    assert.equal(res.added, 2);
    themeId = res.themeId;
    await client.close();
  }
  // both clusters survive on disk (theming fused nothing)
  const hot1 = JSON.parse(await readFile(corpusPath, "utf8"));
  assert.equal(hot1.clusters.length, 2, "theming does not fuse/remove clusters");
  assert.equal(hot1.themes.length, 1, "theme persisted to disk");

  // Session 2 (fresh server): get_themes surfaces it, evidence-free; extend by name is idempotent.
  {
    const client = await connect(corpusPath);
    const themes = payload(await client.callTool({ name: "get_themes", arguments: {} }));
    assert.equal(themes.themes.length, 1);
    assert.equal(themes.themes[0].memberCount, 2);
    assert.equal(JSON.stringify(themes).includes(SENTINEL), false, "theme summaries are evidence-free");

    const ext = payload(await client.callTool({ name: "group_theme", arguments: { name: "code tells the truth", clusterIds: [clusterIds[0]] } }));
    assert.equal(ext.status, "extended");
    assert.equal(ext.themeId, themeId, "extend reuses the theme");
    assert.equal(ext.added, 0, "already a member");
    await client.close();
  }
});

test("ungroup_theme over the wire regroups a cluster between themes (reversible, no data loss)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);
  const client = await connect(corpusPath);

  // group cluster[0] into theme A, then MOVE it to theme B via ungroup + group.
  const a = payload(await client.callTool({ name: "group_theme", arguments: { name: "A", clusterIds: [clusterIds[0]] } }));
  const b = payload(await client.callTool({ name: "group_theme", arguments: { name: "B", clusterIds: [] } }));

  const un = payload(await client.callTool({ name: "ungroup_theme", arguments: { themeId: a.themeId, clusterIds: [clusterIds[0]] } }));
  assert.equal(un.removed, 1);
  assert.deepEqual(un.memberClusterIds, [], "cluster left theme A");
  await client.callTool({ name: "group_theme", arguments: { name: "B", clusterIds: [clusterIds[0]] } });

  // persisted: A is empty, B holds the cluster, and the cluster itself was never destroyed.
  const hot = JSON.parse(await readFile(corpusPath, "utf8"));
  const themeA = hot.themes.find((t: { themeId: string }) => t.themeId === a.themeId);
  const themeB = hot.themes.find((t: { themeId: string }) => t.themeId === b.themeId);
  assert.deepEqual(themeA.memberClusterIds, []);
  assert.deepEqual(themeB.memberClusterIds, [clusterIds[0]]);
  assert.equal(hot.clusters.length, 2, "ungrouping fused/destroyed nothing");

  // unknown theme surfaces as a recoverable error
  const bad = (await client.callTool({ name: "ungroup_theme", arguments: { themeId: "nope", clusterIds: [clusterIds[0]] } })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /no theme/);

  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("dual-target tools over the wire reject BOTH clusterId AND themeId (recoverable error)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);
  const client = await connect(corpusPath);
  const { themeId } = payload(await client.callTool({ name: "group_theme", arguments: { name: "t", clusterIds } }));
  const both = { clusterId: clusterIds[0], themeId };

  for (const name of ["answer_open_question", "submit_answer", "get_evidence"] as const) {
    const args = name === "submit_answer" ? { ...both, text: "x" } : both;
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(res.isError, true, `${name} must reject both targets`);
    assert.match(res.content[0].text, /not both/);
  }

  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("answer_open_question(themeId) over the wire returns aggregated theme evidence + instruction, no auto-resolve", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);
  const client = await connect(corpusPath);

  const { themeId } = payload(await client.callTool({ name: "group_theme", arguments: { name: "broad", clusterIds } }));
  const res = payload(await client.callTool({ name: "answer_open_question", arguments: { themeId } }));
  assert.equal(res.target, "theme");
  assert.equal(res.status, "ready");
  assert.ok(res.depthInstruction.length > 0);
  assert.ok(res.themeEvidence && res.themeEvidence.members.length === 2, "aggregated across member clusters");
  assert.match(JSON.stringify(res.themeEvidence), /UNTRUSTED-EVIDENCE/);
  // forward mode:user marks the theme pending and persists
  const fwd = payload(await client.callTool({ name: "answer_open_question", arguments: { themeId, mode: "user" } }));
  assert.equal(fwd.status, "pending-user");

  const hot = JSON.parse(await readFile(corpusPath, "utf8"));
  assert.ok(hot.themes[0].pending, "theme pending persisted");

  // get_pending_questions surfaces the pending theme
  const pend = payload(await client.callTool({ name: "get_pending_questions", arguments: {} }));
  assert.equal(pend.totalPendingThemes, 1);
  assert.equal(pend.pendingThemes[0].themeId, themeId);

  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("get_evidence(themeId) over the wire aggregates member evidence as untrusted data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);
  const client = await connect(corpusPath);
  const { themeId } = payload(await client.callTool({ name: "group_theme", arguments: { name: "t", clusterIds } }));
  const bundle = payload(await client.callTool({ name: "get_evidence", arguments: { themeId } }));
  assert.equal(bundle.members.length, 2);
  assert.match(JSON.stringify(bundle), /UNTRUSTED-EVIDENCE/);
  assert.ok(JSON.stringify(bundle).includes(`${SENTINEL}-one`));
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("submit_answer(themeId, confirmed) over the wire records user ground truth + clears theme pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);
  const client = await connect(corpusPath);
  const { themeId } = payload(await client.callTool({ name: "group_theme", arguments: { name: "t", clusterIds } }));
  await client.callTool({ name: "answer_open_question", arguments: { themeId, mode: "user" } });

  const r = payload(await client.callTool({ name: "submit_answer", arguments: { themeId, text: "the code must not lie", source: "user", confirmed: true } }));
  assert.equal(r.source, "user");
  const hot = JSON.parse(await readFile(corpusPath, "utf8"));
  assert.equal(hot.themes[0].answers.length, 1);
  assert.equal(hot.themes[0].pending, undefined, "confirmed user theme answer cleared pending on disk");
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("set_cluster_kind over the wire persists the kind and get_patterns surfaces it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath, clusterIds } = await seedCorpus(dir);
  const client = await connect(corpusPath);

  const res = payload(await client.callTool({ name: "set_cluster_kind", arguments: { clusterId: clusterIds[0], primary: "O", secondary: "C" } }));
  assert.equal(res.primaryKind, "O");
  assert.equal(res.secondaryKind, "C");

  const hot = JSON.parse(await readFile(corpusPath, "utf8"));
  const cl = hot.clusters.find((c: { clusterId: string }) => c.clusterId === clusterIds[0]);
  assert.equal(cl.primaryKind, "O");

  const patterns = payload(await client.callTool({ name: "get_patterns", arguments: {} }));
  const p0 = patterns.patterns.find((p: { clusterId: string }) => p.clusterId === clusterIds[0]);
  assert.equal(p0.primaryKind, "O");
  assert.equal(p0.secondaryKind, "C");

  // invalid kind surfaces as a recoverable error (zod enum rejects it before the handler)
  const bad = (await client.callTool({ name: "set_cluster_kind", arguments: { clusterId: clusterIds[0], primary: "Z" } })) as { isError?: boolean };
  assert.equal(bad.isError, true);

  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("get_grouping_task over the wire returns the live group-themes instruction + evidence-free summaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-mcp-"));
  const { corpusPath } = await seedCorpus(dir);
  const client = await connect(corpusPath);

  const res = payload(await client.callTool({ name: "get_grouping_task", arguments: {} }));
  // the live prompts/group-themes.md content is returned (loaded from disk)
  assert.ok(res.groupThemesInstruction.length > 0);
  assert.match(res.groupThemesInstruction, /theme|merge|group/i);
  assert.equal(res.clusters.length, 2);
  assert.ok(Array.isArray(res.themes));
  assert.match(res.instruction, /merge_clusters|group_theme/);
  assert.equal(JSON.stringify(res).includes(SENTINEL), false, "grouping task is evidence-free");

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
