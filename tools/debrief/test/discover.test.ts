import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  slugForPath,
  resolveCorpusPath,
  discoverSessions,
  isInsideProject,
  firstCwd,
} from "../src/discover.ts";

/** Build a fake ~/.claude/projects layout: { "<dir>": [{ name, cwd? }] }. Returns the base dir. */
async function fakeClaude(
  base: string,
  layout: Record<string, Array<{ name: string; cwd?: string }>>,
): Promise<string> {
  const projectsDir = join(base, ".claude", "projects");
  for (const [dirName, sessions] of Object.entries(layout)) {
    const dir = join(projectsDir, dirName);
    await mkdir(dir, { recursive: true });
    for (const s of sessions) {
      const lines = [
        // a leading non-cwd event, then the first cwd-bearing event (mirrors a real session)
        JSON.stringify({ type: "system", subtype: "init" }),
        JSON.stringify({ type: "user", ...(s.cwd ? { cwd: s.cwd } : {}), message: { content: "hi" } }),
      ].join("\n") + "\n";
      await writeFile(join(dir, s.name), lines, "utf8");
    }
  }
  return projectsDir;
}

test("slugForPath: deterministic, lowercased, path-syntax-free", () => {
  const a = slugForPath("C:/Users/adamr/Projects/claude-skills");
  const b = slugForPath("C:/Users/adamr/Projects/claude-skills");
  assert.equal(a, b, "same path → same slug");
  assert.equal(/[\\/:]/.test(a), false, "slug carries no path separators");
  assert.equal(a, a.toLowerCase(), "slug is lowercased");
  assert.notEqual(slugForPath("/a/b"), slugForPath("/a/c"), "different paths → different slugs");
  // Collision guard: separator-vs-punctuation variants that collapse to the same human prefix must
  // NOT share a corpus dir (the disambiguating hash suffix keeps them distinct).
  assert.notEqual(slugForPath("/a/b"), slugForPath("/a-b"), "/a/b and /a-b must not collide");
});

test("firstCwd: tolerates an unreadable target (a directory) without throwing", async () => {
  const base = await mkdtemp(join(tmpdir(), "debrief-cwd-dir-"));
  try {
    const dirAsTarget = join(base, "notafile");
    await mkdir(dirAsTarget, { recursive: true });
    const got = await firstCwd(dirAsTarget); // EISDIR on the stream — must resolve undefined, not reject
    assert.equal(got, undefined);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("discoverSessions: a *.jsonl entry that is actually a directory is skipped, not fatal", async () => {
  const base = await mkdtemp(join(tmpdir(), "debrief-disc-odd-"));
  try {
    const projectRoot = process.platform === "win32" ? "C:/work/proj" : "/work/proj";
    const projectsDir = await fakeClaude(base, {
      dirA: [{ name: "good.jsonl", cwd: projectRoot }],
    });
    // A path ending in .jsonl that is a DIRECTORY (firstCwd would hit EISDIR) must be skipped.
    await mkdir(join(projectsDir, "dirA", "weird.jsonl"), { recursive: true });
    const found = await discoverSessions({ projectRoot, claudeProjectsDir: projectsDir });
    const names = found.map((p) => p.split(/[\\/]/).pop()).sort();
    assert.deepEqual(names, ["good.jsonl"], "the directory-named .jsonl is skipped, the real one kept");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("resolveCorpusPath: per-project vs global under an injected debriefHome", async () => {
  const home = await mkdtemp(join(tmpdir(), "debrief-home-"));
  try {
    const projectRoot = "C:/Users/adamr/Projects/demo-proj";
    const proj = await resolveCorpusPath({ debriefHome: home, projectRoot });
    const glob = await resolveCorpusPath({ debriefHome: home, global: true });

    assert.ok(proj.includes(join("projects", slugForPath(projectRoot))), "per-project path uses the slug");
    assert.ok(proj.endsWith("corpus.json"));
    assert.ok(glob.includes(join("global", "corpus.json")), "global path is under global/");
    assert.notEqual(proj, glob);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("isInsideProject: equal/inside true; outside/sibling false", () => {
  assert.equal(isInsideProject("/a/b", "/a/b"), true, "equal is inside");
  assert.equal(isInsideProject("/a/b/c/d", "/a/b"), true, "nested is inside");
  assert.equal(isInsideProject("/a/x", "/a/b"), false, "sibling is outside");
  assert.equal(isInsideProject("/a", "/a/b"), false, "parent is outside");
});

test("firstCwd: returns the first event's cwd, tolerating a leading cwd-less event", async () => {
  const base = await mkdtemp(join(tmpdir(), "debrief-cwd-"));
  try {
    const projectsDir = await fakeClaude(base, {
      d1: [{ name: "s.jsonl", cwd: "C:/proj/here" }],
    });
    const got = await firstCwd(join(projectsDir, "d1", "s.jsonl"));
    assert.equal(got, "C:/proj/here");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("discoverSessions: CURRENT-PROJECT scope keeps only sessions whose cwd is inside the project", async () => {
  const base = await mkdtemp(join(tmpdir(), "debrief-disc-"));
  try {
    const projectRoot = process.platform === "win32" ? "C:/work/proj" : "/work/proj";
    const inside = process.platform === "win32" ? "C:/work/proj/sub" : "/work/proj/sub";
    const outside = process.platform === "win32" ? "C:/work/other" : "/work/other";
    const projectsDir = await fakeClaude(base, {
      dirA: [{ name: "in1.jsonl", cwd: projectRoot }, { name: "in2.jsonl", cwd: inside }],
      dirB: [{ name: "out.jsonl", cwd: outside }, { name: "nocwd.jsonl" }],
    });

    const found = await discoverSessions({ projectRoot, claudeProjectsDir: projectsDir });
    const names = found.map((p) => p.split(/[\\/]/).pop()).sort();
    assert.deepEqual(names, ["in1.jsonl", "in2.jsonl"], "only the in-project sessions are kept");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("discoverSessions: --global keeps ALL sessions regardless of cwd", async () => {
  const base = await mkdtemp(join(tmpdir(), "debrief-disc-g-"));
  try {
    const projectsDir = await fakeClaude(base, {
      dirA: [{ name: "a.jsonl", cwd: "/work/proj" }],
      dirB: [{ name: "b.jsonl", cwd: "/somewhere/else" }, { name: "c.jsonl" }],
    });
    const found = await discoverSessions({ global: true, claudeProjectsDir: projectsDir });
    const names = found.map((p) => p.split(/[\\/]/).pop()).sort();
    assert.deepEqual(names, ["a.jsonl", "b.jsonl", "c.jsonl"], "global keeps every session");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("discoverSessions: a missing ~/.claude/projects yields [] (cold start, no throw)", async () => {
  const found = await discoverSessions({
    claudeProjectsDir: join(tmpdir(), "debrief-does-not-exist-" + Date.now()),
    projectRoot: "/whatever",
  });
  assert.deepEqual(found, []);
});
