// Where a folder sits in git: its worktree top level, the repository's common dir (shared by the
// main checkout and every linked worktree, so it names the project) and the current branch.
//
// No Node imports. A mod's hooks module has no Node APIs, so file access and the command runner
// are passed in, and the path helpers below stand in for node:path. They accept Windows and POSIX
// paths alike and decide which one they are looking at from the path's shape.
//
// The git command runs first. When there is no runner (the sandbox can't run processes) or it
// fails, git's own pointer files answer the same three questions:
//   <dir>/.git directory          → it is its own common dir
//   <dir>/.git file "gitdir: X"   → X is the worktree's gitdir; X/commondir names the common dir
//   <gitdir>/HEAD                 → "ref: refs/heads/<branch>", or a bare hash when detached

// ── Paths ────────────────────────────────────────────────────────────────────────────────────

/** True for a Windows-shaped path: a drive letter, a UNC prefix, or any backslash. */
export function isWindowsPath(p) {
  return /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith("\\\\") || p.includes("\\");
}

export function isAbsolute(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\");
}

/**
 * Forward slashes, "." and ".." folded away, no trailing slash, drive letter upper-cased.
 * The root keeps its slash ("C:/", "/").
 */
export function normalize(p) {
  let s = p.replace(/\\/g, "/");
  let prefix = "";
  const drive = /^([A-Za-z]):(\/|$)/.exec(s);
  if (drive) {
    prefix = drive[1].toUpperCase() + ":/";
    s = s.slice(drive[0].length);
  } else if (s.startsWith("//")) {
    prefix = "//";
    s = s.slice(2);
  } else if (s.startsWith("/")) {
    prefix = "/";
    s = s.slice(1);
  }
  const out = [];
  for (const part of s.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else if (part !== ".." || !prefix) out.push(part);
  }
  return prefix + out.join("/") || ".";
}

/** A comparison key: normalised, and case-folded for Windows paths (case-insensitive there). */
export function pathKey(p) {
  const n = normalize(p);
  return isWindowsPath(p) || /^[A-Z]:\//.test(n) ? n.toLowerCase() : n;
}

export function join(base, rel) {
  return isAbsolute(rel) ? normalize(rel) : normalize(base + "/" + rel);
}

export function dirname(p) {
  const n = normalize(p);
  const i = n.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  if (/^[A-Z]:$/.test(n.slice(0, i))) return n.slice(0, i + 1);
  return n.slice(0, i);
}

/**
 * `p` relative to `root` with forward slashes, or null when `p` is not inside `root`. Windows
 * paths compare case-insensitively and come back lower-cased, so the same file always produces
 * the same string whichever way a tool happened to spell it.
 */
export function relativeTo(root, p) {
  const win = isWindowsPath(root) || isWindowsPath(p);
  const r = normalize(root);
  const n = normalize(p);
  const rk = win ? r.toLowerCase() : r;
  const nk = win ? n.toLowerCase() : n;
  const base = rk.endsWith("/") ? rk : rk + "/";
  if (!nk.startsWith(base)) return null;
  const rel = n.slice(base.length);
  return win ? rel.toLowerCase() : rel;
}

// ── Git ──────────────────────────────────────────────────────────────────────────────────────

/**
 * io: {
 *   run?(argv, { cwd }) → { code, stdout }   a command runner; optional
 *   stat(path) → { isDir } | null           null when the path does not exist
 *   read(path) → string                     the whole (small) file
 * }
 * Every function may be sync or async.
 *
 * Returns { resolve(dir, { now, maxAgeMs }) → { toplevel, commonDir, branch } | null }. Results
 * are cached per folder and looked up again once older than `maxAgeMs` at `now`, so worktrees
 * added or removed and branches switched show up. Calls that pass the same `now` share one answer
 * per folder. Without options an answer is kept for the life of the returned object. A folder git
 * can't place resolves to null.
 */
export function createGit(io) {
  const cache = new Map(); // folder key → { at, result }
  return {
    resolve(dir, { now = 0, maxAgeMs = Infinity } = {}) {
      const key = pathKey(dir);
      const hit = cache.get(key);
      if (hit && now - hit.at <= maxAgeMs) return hit.result;
      const result = resolveUncached(io, dir).catch(() => null);
      cache.set(key, { at: now, result });
      return result;
    },
  };
}

async function resolveUncached(io, dir) {
  if (io.run) {
    const viaCommand = await fromCommand(io, dir).catch(() => null);
    if (viaCommand) return viaCommand;
  }
  return fromFiles(io, dir);
}

async function fromCommand(io, dir) {
  const where = await io.run(["git", "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { cwd: dir });
  if (!where || where.code !== 0) return null;
  const [toplevel, commonDir] = where.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!toplevel || !commonDir) return null;
  // A repository with no commits yet has no HEAD to abbreviate; that leaves the branch unknown.
  const head = await Promise.resolve()
    .then(() => io.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }))
    .catch(() => null);
  const name = head && head.code === 0 ? head.stdout.trim() : "";
  return { toplevel: normalize(toplevel), commonDir: normalize(commonDir), branch: name && name !== "HEAD" ? name : null };
}

async function fromFiles(io, dir) {
  // A removed worktree must not walk up into the checkout that used to contain it.
  const self = await io.stat(dir);
  if (!self || !self.isDir) return null;
  let at = normalize(dir);
  for (;;) {
    const dotGit = join(at, ".git");
    const s = await io.stat(dotGit);
    if (s) {
      let gitDir = dotGit;
      let commonDir = dotGit;
      if (!s.isDir) {
        const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await io.read(dotGit));
        if (!pointer) return null;
        gitDir = join(at, pointer[1]);
        const common = await readOptional(io, join(gitDir, "commondir"));
        commonDir = common ? join(gitDir, common.trim()) : gitDir;
      }
      const head = (await readOptional(io, join(gitDir, "HEAD"))) || "";
      const ref = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head);
      return { toplevel: at, commonDir, branch: ref ? ref[1] : null };
    }
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

async function readOptional(io, p) {
  try {
    return (await io.stat(p)) ? await io.read(p) : null;
  } catch {
    return null;
  }
}
