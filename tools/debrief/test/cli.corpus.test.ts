import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cli = join(root, "src", "cli.ts");

const SENTINEL = "TOP-SECRET-TRANSCRIPT-CONTENT-9173";

const SESSION = [
  JSON.stringify({ type: "assistant", sessionId: "s1", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] } }),
  JSON.stringify({ type: "user", sessionId: "s1", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "boom", is_error: true }] } }),
  JSON.stringify({ type: "user", sessionId: "s1", uuid: "h1", timestamp: "2026-06-25T00:00:00Z", message: { content: [{ type: "text", text: `that 403 is back ${SENTINEL}` }] } }),
  JSON.stringify({ type: "assistant", sessionId: "s1", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
  JSON.stringify({ type: "user", sessionId: "s1", uuid: "h2", timestamp: "2026-06-25T00:01:00Z", message: { content: [{ type: "text", text: `now add tests ${SENTINEL}` }] } }),
].join("\n") + "\n";

async function tsx(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, ["--import", "tsx", cli, ...args], { cwd: root });
}

test("CLI corpus: hot file is EVIDENCE-FREE, sidecar holds the snippet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-cli-"));
  const sessionPath = join(dir, "session.jsonl");
  const corpusPath = join(dir, "corpus.json");
  const evidencePath = join(dir, "corpus.evidence.json");
  await writeFile(sessionPath, SESSION, "utf8");

  await tsx(["corpus", sessionPath, corpusPath]);

  const hot = await readFile(corpusPath, "utf8");
  const side = await readFile(evidencePath, "utf8");
  assert.equal(hot.includes(SENTINEL), false, "hot file must not contain the raw snippet");
  assert.equal(side.includes(SENTINEL), true, "sidecar must hold the raw snippet");

  // hot file is valid against the published schema shape (basic structural check)
  const parsed = JSON.parse(hot);
  assert.equal(parsed.schemaVersion, 1);
  assert.ok(Array.isArray(parsed.clusters) && parsed.clusters.length >= 1);

  await rm(dir, { recursive: true, force: true });
});

test("CLI corpus: turns differing only in case/whitespace/punctuation cluster into ONE (count 2), hot file stays evidence-free", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-cli-"));
  const sessionPath = join(dir, "session.jsonl");
  const corpusPath = join(dir, "corpus.json");
  const evidencePath = join(dir, "corpus.evidence.json");

  // Two human turns whose text is identical up to case / whitespace / punctuation, each
  // following an assistant completion (same "turn-after-completion" detector). Under the
  // coarse normalizeSubject they MUST fold to the same normalizedSubject and cluster as one.
  const VARIANT_A = `Rename ${SENTINEL} the RGB value, please!`;
  const VARIANT_B = `rename   ${SENTINEL}  the rgb VALUE please`;
  const clusterSession =
    [
      JSON.stringify({ type: "assistant", sessionId: "s1", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
      JSON.stringify({ type: "user", sessionId: "s1", uuid: "h1", timestamp: "2026-06-25T00:00:00Z", message: { content: [{ type: "text", text: VARIANT_A }] } }),
      JSON.stringify({ type: "assistant", sessionId: "s1", message: { role: "assistant", content: [{ type: "text", text: "Done again." }] } }),
      JSON.stringify({ type: "user", sessionId: "s1", uuid: "h2", timestamp: "2026-06-25T00:01:00Z", message: { content: [{ type: "text", text: VARIANT_B }] } }),
    ].join("\n") + "\n";
  await writeFile(sessionPath, clusterSession, "utf8");

  await tsx(["corpus", sessionPath, corpusPath]);

  const hot = JSON.parse(await readFile(corpusPath, "utf8"));
  // The two variants collapse into a single turn-after-completion cluster with count 2.
  const turnAfterCompletion = hot.clusters.filter((c: { detector: string }) => c.detector === "turn-after-completion");
  assert.equal(turnAfterCompletion.length, 1, "the two variants must cluster into ONE cluster");
  assert.equal(turnAfterCompletion[0].count, 2, "the clustered count must be 2 (both turns)");

  // The hot file remains EVIDENCE-FREE: neither raw (verbatim) variant snippet leaks into it.
  // normalizedSubject is a coarse normalized LABEL (lowercased, punctuation stripped), not the
  // raw turn text — so the exact raw snippets never appear in the hot file.
  const hotText = await readFile(corpusPath, "utf8");
  assert.equal(hotText.includes(VARIANT_A), false, "hot file must not contain raw variant A snippet");
  assert.equal(hotText.includes(VARIANT_B), false, "hot file must not contain raw variant B snippet");
  // The sidecar holds the raw snippets verbatim.
  const side = await readFile(evidencePath, "utf8");
  assert.equal(side.includes(VARIANT_A), true, "sidecar must hold raw variant A verbatim");
  assert.equal(side.includes(VARIANT_B), true, "sidecar must hold raw variant B verbatim");

  await rm(dir, { recursive: true, force: true });
});

test("CLI corpus: re-extraction is idempotent (merge-not-clobber, no double count)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-cli-"));
  const sessionPath = join(dir, "session.jsonl");
  const corpusPath = join(dir, "corpus.json");
  await writeFile(sessionPath, SESSION, "utf8");

  await tsx(["corpus", sessionPath, corpusPath]);
  const after1 = JSON.parse(await readFile(corpusPath, "utf8"));
  await tsx(["corpus", sessionPath, corpusPath]);
  const after2 = JSON.parse(await readFile(corpusPath, "utf8"));

  assert.equal(after1.clusters.length, after2.clusters.length);
  const counts1 = after1.clusters.map((c: { count: number }) => c.count).sort();
  const counts2 = after2.clusters.map((c: { count: number }) => c.count).sort();
  assert.deepEqual(counts1, counts2, "counts must not grow on re-extraction of the same session");

  await rm(dir, { recursive: true, force: true });
});

test("CLI corpus: captures cwd/gitBranch into the SIDECAR only (NOT the hot file); hot file carries relational COUNTS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-cli-"));
  const sessionPath = join(dir, "session.jsonl");
  const corpusPath = join(dir, "corpus.json");
  const evidencePath = join(dir, "corpus.evidence.json");

  // Privacy-sensitive absolute path + branch on each turn event. They must land in the sidecar
  // ONLY; the hot file must carry only the distinctRepos/distinctBranches COUNTS.
  const ABS_PATH = "C:/Users/adamr/Projects/PRIVATE-REPO-4242";
  const BRANCH = "feature/SECRET-BRANCH-4242";
  const relSession =
    [
      JSON.stringify({ type: "assistant", sessionId: "s1", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
      JSON.stringify({ type: "user", sessionId: "s1", uuid: "h1", timestamp: "2026-06-25T00:00:00Z", cwd: ABS_PATH, gitBranch: BRANCH, message: { content: [{ type: "text", text: `please rename ${SENTINEL} the value` }] } }),
    ].join("\n") + "\n";
  await writeFile(sessionPath, relSession, "utf8");

  await tsx(["corpus", sessionPath, corpusPath]);

  const hotText = await readFile(corpusPath, "utf8");
  const sideText = await readFile(evidencePath, "utf8");

  // PRIVACY: the raw absolute path + branch live ONLY in the sidecar.
  assert.equal(hotText.includes(ABS_PATH), false, "hot file must NOT contain the absolute cwd path");
  assert.equal(hotText.includes(BRANCH), false, "hot file must NOT contain the git branch");
  assert.equal(sideText.includes(ABS_PATH), true, "sidecar must hold the raw cwd");
  assert.equal(sideText.includes(BRANCH), true, "sidecar must hold the raw gitBranch");

  // The hot file carries the privacy-clean relational COUNTS.
  const hot = JSON.parse(hotText);
  const cl = hot.clusters[0];
  assert.ok(cl.relational, "hot-file cluster carries relational facts");
  assert.equal(cl.relational.distinctRepos, 1, "one distinct cwd -> distinctRepos 1");
  assert.equal(cl.relational.distinctBranches, 1, "one distinct branch -> distinctBranches 1");
  assert.equal(cl.relational.occurrences, 1);

  await rm(dir, { recursive: true, force: true });
});

test("CLI corpus: an absolute path TYPED INTO A TURN does not leak path-syntax into the hot file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-cli-"));
  const sessionPath = join(dir, "session.jsonl");
  const corpusPath = join(dir, "corpus.json");
  const evidencePath = join(dir, "corpus.evidence.json");

  // The user types an absolute path in the turn TEXT itself (not the cwd field). normalizedSubject is
  // derived from this prose via coarseSubject — it must hold a bounded, path-syntax-free label, with
  // the verbatim path surviving ONLY in the sidecar snippet.
  const TYPED_PATH = "C:/Users/adamr/Projects/secret/file.ts";
  const pathSession =
    [
      JSON.stringify({ type: "assistant", sessionId: "s1", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
      JSON.stringify({ type: "user", sessionId: "s1", uuid: "h1", timestamp: "2026-06-25T00:00:00Z", message: { content: [{ type: "text", text: `please look at ${TYPED_PATH} and fix it` }] } }),
    ].join("\n") + "\n";
  await writeFile(sessionPath, pathSession, "utf8");

  await tsx(["corpus", sessionPath, corpusPath]);

  const hotText = await readFile(corpusPath, "utf8");
  const sideText = await readFile(evidencePath, "utf8");

  // GENERIC path-syntax scan over the hot file: no Windows-drive or POSIX home path shape may survive.
  assert.equal(/[A-Za-z]:[\\/]/.test(hotText), false, "no drive-letter path syntax in the hot file");
  assert.equal(/\/(Users|home)\//i.test(hotText), false, "no POSIX home path syntax in the hot file");
  // The verbatim typed path survives ONLY in the sidecar snippet.
  assert.equal(hotText.includes(TYPED_PATH), false, "the typed path must not appear verbatim in the hot file");
  assert.equal(sideText.includes(TYPED_PATH), true, "the sidecar snippet holds the typed path verbatim");

  await rm(dir, { recursive: true, force: true });
});

test("CLI corpus: refuses to overwrite a CORRUPT corpus (recoverable, exit 1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "debrief-cli-"));
  const sessionPath = join(dir, "session.jsonl");
  const corpusPath = join(dir, "corpus.json");
  await writeFile(sessionPath, SESSION, "utf8");
  await writeFile(corpusPath, "{ corrupt", "utf8");

  await assert.rejects(
    () => tsx(["corpus", sessionPath, corpusPath]),
    (err: unknown) => {
      const e = err as { code?: number; stderr?: string };
      return e.code === 1 && /corpus read error \(corrupt\)/.test(e.stderr ?? "");
    },
  );
  // the corrupt file is untouched (not clobbered)
  assert.equal(await readFile(corpusPath, "utf8"), "{ corrupt");

  await rm(dir, { recursive: true, force: true });
});
