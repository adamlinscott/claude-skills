import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * These exercise the SKILL-FRIENDLY CLI subcommands that wrap the SAME pure handlers the MCP server
 * uses (no logic duplication). Each prints JSON to stdout, so a skill can parse it from bash. We use
 * `--corpus <path>` to override zero-config so the tests never touch the real ~/.debrief / ~/.claude.
 */

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cli = join(root, "src", "cli.ts");

async function tsx(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, ["--import", "tsx", cli, ...args], { cwd: root });
}

/** A session with two distinct human turns after assistant completions → two clusters. */
const SESSION =
  [
    JSON.stringify({ type: "assistant", sessionId: "s1", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
    JSON.stringify({ type: "user", sessionId: "s1", uuid: "h1", timestamp: "2026-06-25T00:00:00Z", message: { content: [{ type: "text", text: "rename the rgb value to color" }] } }),
    JSON.stringify({ type: "assistant", sessionId: "s1", message: { role: "assistant", content: [{ type: "text", text: "Done again." }] } }),
    JSON.stringify({ type: "user", sessionId: "s1", uuid: "h2", timestamp: "2026-06-25T00:01:00Z", message: { content: [{ type: "text", text: "add tests for the new endpoint" }] } }),
  ].join("\n") + "\n";

/** Build a corpus on disk and return its path + the first clusterId. */
async function seed(dir: string): Promise<{ corpusPath: string; clusterId: string }> {
  const sessionPath = join(dir, "session.jsonl");
  const corpusPath = join(dir, "corpus.json");
  await writeFile(sessionPath, SESSION, "utf8");
  await tsx(["corpus", sessionPath, corpusPath]);
  const { stdout } = await tsx(["patterns", "--corpus", corpusPath]);
  const parsed = JSON.parse(stdout);
  return { corpusPath, clusterId: parsed.patterns[0].clusterId };
}

test("CLI patterns: prints evidence-free pattern summaries as JSON (handler shape)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-sub-"));
  try {
    const { corpusPath } = await seed(dir);
    const { stdout } = await tsx(["patterns", "--corpus", corpusPath]);
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.patterns) && parsed.patterns.length >= 2, "two clusters surfaced");
    assert.ok(typeof parsed.notice === "string", "carries the untrusted-corpus notice (handler shape)");
    for (const p of parsed.patterns) {
      assert.ok(typeof p.clusterId === "string");
      assert.equal("snippet" in p, false, "summaries are evidence-free");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI ask: returns the depth + classify instructions for the agent to reason with (return-instruction)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-sub-"));
  try {
    const { corpusPath, clusterId } = await seed(dir);
    const { stdout } = await tsx(["ask", clusterId, "--corpus", corpusPath]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.target, "cluster");
    assert.equal(parsed.status, "ready");
    assert.ok(parsed.depthInstruction.includes("open questions"), "depth instruction loaded from prompts/");
    assert.ok(typeof parsed.classifyIntent === "string" && parsed.classifyIntent.length > 0);
    assert.ok(parsed.evidence, "evidence bundle present for the agent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI answer: source:user is GATED on --confirmed (downgraded to inferred without it)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-sub-"));
  try {
    const { corpusPath, clusterId } = await seed(dir);

    // Without --confirmed, a source:user request is downgraded to inferred.
    const r1 = JSON.parse(
      (await tsx(["answer", clusterId, "just a guess", "--source", "user", "--corpus", corpusPath])).stdout,
    );
    assert.equal(r1.source, "inferred", "unconfirmed user answer is recorded inferred");

    // With --confirmed, it is honored as user ground truth.
    const r2 = JSON.parse(
      (await tsx(["answer", clusterId, "the real answer", "--source", "user", "--confirmed", "--corpus", corpusPath])).stdout,
    );
    assert.equal(r2.source, "user", "confirmed user answer is recorded user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI grouping-task: returns the live group-themes instruction + current cluster summaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-sub-"));
  try {
    const { corpusPath } = await seed(dir);
    const { stdout } = await tsx(["grouping-task", "--corpus", corpusPath]);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.groupThemesInstruction.includes("themes"), "group-themes.md loaded from prompts/");
    assert.ok(Array.isArray(parsed.clusters) && parsed.clusters.length >= 2);
    assert.ok(typeof parsed.totalClusters === "number");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI --corpus with no path is a clean error, not a silent zero-config fallthrough", async () => {
  await assert.rejects(
    () => tsx(["patterns", "--corpus"]),
    (err) => {
      const e = err as { code?: number; stderr?: string };
      assert.equal(e.code, 1, "exits 1");
      assert.match(e.stderr ?? "", /--corpus needs a path/, "prints a clean one-line message");
      assert.doesNotMatch(e.stderr ?? "", /at Object|at async|\.ts:\d+/, "no raw stack trace");
      return true;
    },
  );
});

test("CLI patterns --answered-by inferred lists inferred-only clusters (re-confirm surface)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-sub-"));
  try {
    const { corpusPath, clusterId } = await seed(dir);
    // Record an inferred answer on one cluster.
    await tsx(["answer", clusterId, "an inferred guess", "--corpus", corpusPath]);

    const inferred = JSON.parse((await tsx(["patterns", "--answered-by", "inferred", "--corpus", corpusPath])).stdout);
    assert.equal(inferred.patterns.length, 1, "only the inferred-only cluster");
    assert.equal(inferred.patterns[0].clusterId, clusterId);

    const none = JSON.parse((await tsx(["patterns", "--answered-by", "none", "--corpus", corpusPath])).stdout);
    assert.ok(none.patterns.every((p: { clusterId: string }) => p.clusterId !== clusterId), "answered cluster excluded from none");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI `--` sentinel passes verbatim text beginning with -- as a positional", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-sub-"));
  try {
    const { corpusPath, clusterId } = await seed(dir);
    // Flags first, then `--`, then the dash-leading verbatim answer text.
    const res = JSON.parse(
      (await tsx(["answer", clusterId, "--corpus", corpusPath, "--", "--maybe a guess"])).stdout,
    );
    assert.equal(res.source, "inferred");
    assert.equal(res.answer.text, "--maybe a guess", "the verbatim text was recorded, not dropped as a flag");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI themes: group then list themes (write + read wrappers reuse the handlers)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-sub-"));
  try {
    const { corpusPath, clusterId } = await seed(dir);
    const grouped = JSON.parse((await tsx(["group", "truthful code", clusterId, "--corpus", corpusPath])).stdout);
    assert.ok(typeof grouped.themeId === "string");
    assert.equal(grouped.status, "created");

    const { stdout } = await tsx(["themes", "--corpus", corpusPath]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.themes.length, 1);
    assert.equal(parsed.themes[0].name, "truthful code");
    assert.equal(parsed.themes[0].memberCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
