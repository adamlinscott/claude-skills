/**
 * Zero-config DISCOVERY (the skill-friendly entry layer).
 *
 * STRUCTURAL ONLY — like the rest of the CLI, this module reads no intent. It answers two
 * deterministic questions so a skill can drive `debrief` with NO manual paths:
 *
 *   1. WHERE is the corpus? — per-project at ~/.debrief/projects/<slug>/corpus.json, or the
 *      cross-project roll-up at ~/.debrief/global/corpus.json (resolveCorpusPath).
 *   2. WHICH Claude session logs belong to this project? — scan ~/.claude/projects/*\/*.jsonl,
 *      keep the sessions whose recorded `cwd` is INSIDE the current git project root
 *      (discoverSessions); --global keeps them all.
 *
 * Every base directory is INJECTABLE (claudeProjectsDir / debriefHome / projectRoot) so unit
 * tests run against a temp layout and never touch the real ~/.claude or ~/.debrief.
 */

import { readdir, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

/** True if a file-not-found error. */
function isENOENT(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/** Default location of Claude Code's per-project session logs. */
export function defaultClaudeProjectsDir(): string {
  return path.join(homedir(), ".claude", "projects");
}

/** Default root of the per-project / global corpus store. */
export function defaultDebriefHome(): string {
  return path.join(homedir(), ".debrief");
}

/**
 * Resolve the current project root: `git rev-parse --show-toplevel`, falling back to `cwd` when
 * the directory is not a git repo (or git is absent). Always returns an absolute path.
 */
export async function resolveProjectRoot(cwd: string = process.cwd()): Promise<string> {
  try {
    const { stdout } = await pexecFile("git", ["rev-parse", "--show-toplevel"], { cwd });
    const top = stdout.trim();
    if (top) return path.resolve(top);
  } catch {
    /* not a git repo, or git missing — fall back to cwd */
  }
  return path.resolve(cwd);
}

/** Normalize an absolute path for comparison (case-fold on win32, where paths are case-insensitive). */
function normForCompare(p: string): string {
  const r = path.resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/**
 * Sanitize an absolute path into a filesystem-safe, deterministic slug used as the per-project
 * corpus directory name. Lowercased so case-variant paths (Windows is case-insensitive) never mint
 * two corpora for the same project; every non-alphanumeric run collapses to a single dash.
 *
 * Because that collapse is lossy (e.g. `/a/b` and `/a-b` both → `a-b`, and on win32
 * `C:/a/b` → `c-a-b` collides with `C:/a-b`), a short stable hash of the FULL normalized path is
 * appended so distinct project roots never share a corpus dir while the name stays human-readable.
 * The hash uses the same case-fold-on-win32 normalization as `isInsideProject`, so the same project
 * always hashes to the same suffix.
 */
export function slugForPath(p: string): string {
  const human = path
    .resolve(p)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(normForCompare(p)).digest("hex").slice(0, 8);
  return (human ? human + "-" : "") + hash;
}

/**
 * True iff `childCwd` is the project root OR a directory inside it (path-normalized;
 * case-insensitive on win32). Used to keep only the sessions that were run within this project.
 */
export function isInsideProject(childCwd: string, projectRoot: string): boolean {
  const child = normForCompare(childCwd);
  const root = normForCompare(projectRoot);
  if (child === root) return true;
  const rel = path.relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Read a session file's FIRST event that carries a `cwd`, returning that cwd (or undefined). Streams
 * line-by-line and stops at the first hit, tolerating corrupt/partial trailing lines (live-file race)
 * the same way the extractor does.
 */
export async function firstCwd(jsonlPath: string): Promise<string | undefined> {
  const stream = createReadStream(jsonlPath);
  // Swallow stream 'error' events (EACCES/EISDIR/deleted-mid-read) so an unreadable entry never
  // emits an unhandled 'error' on the raw stream.
  stream.on("error", () => {});
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      let ev: unknown;
      try {
        ev = JSON.parse(t);
      } catch {
        continue; // tolerate a corrupt/partial line
      }
      if (ev && typeof ev === "object") {
        const cwd = (ev as { cwd?: unknown }).cwd;
        if (typeof cwd === "string" && cwd.length > 0) return cwd;
      }
    }
  } catch {
    // Stream/open error (EISDIR on a dir, EACCES, deleted mid-read): tolerate like a corrupt line —
    // return undefined so discovery skips this entry rather than crashing (never crash on read).
    return undefined;
  } finally {
    rl.close();
  }
  return undefined;
}

export interface DiscoverOptions {
  /** Roll up across ALL projects (keep every session) instead of filtering to the current project. */
  global?: boolean;
  /** Override the project root (else `resolveProjectRoot()`). Ignored when `global`. */
  projectRoot?: string;
  /** Override the Claude projects dir (for tests; else `defaultClaudeProjectsDir()`). */
  claudeProjectsDir?: string;
}

/**
 * Discover the Claude Code session `.jsonl` files relevant to the requested scope.
 *  - DEFAULT (current project): keep sessions whose first recorded `cwd` is inside the project root.
 *  - `global`: keep every session across every project.
 * Returns absolute paths, sorted for deterministic ordering. A missing ~/.claude/projects yields [].
 */
export async function discoverSessions(opts: DiscoverOptions = {}): Promise<string[]> {
  const base = opts.claudeProjectsDir ?? defaultClaudeProjectsDir();
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  const projectRoot = opts.global ? undefined : opts.projectRoot ?? (await resolveProjectRoot());
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(base, entry.name);
    let files: string[];
    try {
      files = await readdir(sub);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(sub, f);
      if (opts.global) {
        out.push(full);
        continue;
      }
      // Tolerate odd/unreadable entries (a *.jsonl that is a dir, locked, EACCES, or deleted
      // mid-scan): skip the file rather than aborting the whole discovery (design: never crash
      // on read). firstCwd itself guards stream errors, but stay defensive at the call site too.
      let cwd: string | undefined;
      try {
        cwd = await firstCwd(full);
      } catch {
        continue;
      }
      if (cwd && isInsideProject(cwd, projectRoot!)) out.push(full);
    }
  }
  out.sort();
  return out;
}

export interface CorpusPathOptions {
  /** Resolve the global (cross-project) corpus instead of the per-project one. */
  global?: boolean;
  /** Override the project root (else `resolveProjectRoot()`). Ignored when `global`. */
  projectRoot?: string;
  /** Override the ~/.debrief base dir (for tests; else `defaultDebriefHome()`). */
  debriefHome?: string;
  /**
   * Create the corpus directory as a side effect (default true). Read-only commands pass `false`
   * so a pure read never mints `~/.debrief/projects/<slug>/` for a project that has no corpus yet.
   */
  create?: boolean;
}

/**
 * Resolve the corpus hot-file path for the requested scope and ensure its directory exists.
 *  - per-project: <debriefHome>/projects/<slug(projectRoot)>/corpus.json
 *  - global:      <debriefHome>/global/corpus.json
 * The evidence sidecar lives beside it (see evidencePathFor in the MCP server).
 */
export async function resolveCorpusPath(opts: CorpusPathOptions = {}): Promise<string> {
  const home = opts.debriefHome ?? defaultDebriefHome();
  let dir: string;
  if (opts.global) {
    dir = path.join(home, "global");
  } else {
    const root = opts.projectRoot ?? (await resolveProjectRoot());
    dir = path.join(home, "projects", slugForPath(root));
  }
  if (opts.create !== false) await mkdir(dir, { recursive: true });
  return path.join(dir, "corpus.json");
}
