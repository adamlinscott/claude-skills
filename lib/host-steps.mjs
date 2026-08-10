// The acting half of the VPS host tooling: everything with a consequence.
//
// One rule holds this file together — every subprocess and every write goes through the injected
// `run` and `fs`. Nothing here calls spawnSync or node:fs directly. That is not tidiness: it is the
// only reason a Windows machine can prove that a clone is invoked with `--` in the right place, or
// that deleting a repo called `../../etc` never reaches the disk. Reach for the real modules here
// and those tests stop existing.
//
// Decisions live in ./host-plan.mjs and are pure. If you are about to write an `if` that decides
// policy rather than sequencing, it belongs over there.

import nodePath from "node:path";
import {
  cloneArgs, GIT_SAFETY_ENV, resolveRepoPath, renderSessionUnit, renderBootstrapRunner, renderSlice,
  sessionUnitName, makeSessionId, validateSessionId,
  mergeSettings, unmergeSettings, trustDecision, capacityFor, sliceMemoryMax, logLine,
  emptyManifest, readManifest, validateUrl, validateName,
} from "./host-plan.mjs";

/**
 * The real executor. `argv` is always an array and `shell` is never set, on any platform — a shell
 * here would undo every URL check in host-plan.mjs.
 */
export function realExecutor(spawnSync) {
  return function run(command, argv, opts = {}) {
    const res = spawnSync(command, argv, {
      encoding: "utf8",
      timeout: opts.timeout ?? 120_000,
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: opts.interactive ? "inherit" : "pipe",
    });
    if (res.error) return { ok: false, code: null, stdout: "", stderr: res.error.message, failed: res.error.message };
    // A timeout kills the child and leaves status null; say so rather than reporting a blank failure.
    if (res.signal && res.status === null) {
      return { ok: false, code: null, stdout: res.stdout ?? "", stderr: res.stderr ?? "", failed: `stopped by ${res.signal}` };
    }
    return { ok: res.status === 0, code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  };
}

const expandHome = (p, home) => (String(p).startsWith("~") ? `${home}${String(p).slice(1)}` : String(p));

/**
 * Build the host operations against a given world.
 *
 * @param {object} world
 * @param {(cmd: string, argv: string[], opts?: object) => {ok:boolean, code:number|null, stdout:string, stderr:string}} world.run
 * @param {object} world.fs        node:fs-shaped: existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, readdirSync, statSync
 * @param {string} world.home
 * @param {string} world.repoRoot  where this checkout lives, for reading vps/
 * @param {(msg: string) => void} [world.log]
 */
export function createHost(world) {
  const { run, fs, home, repoRoot, log = () => {} } = world;
  // POSIX joins even when the tests run on Windows: every path here names a place on the Linux box.
  const path = world.path ?? nodePath.posix;

  const paths = {
    settings: `${home}/.claude/settings.json`,
    stateDir: `${home}/.local/state/skillhost`,
    configDir: `${home}/.config/skillhost`,
    unitDir: `${home}/.config/systemd/user`,
    manifest: `${home}/.local/state/skillhost/manifest.json`,
    logFile: `${home}/.local/state/skillhost/host.log`,
    tokenFile: `${home}/.config/skillhost/token`,
    vps: `${repoRoot}/vps`,
  };

  // ── plumbing ──────────────────────────────────────────────────────────────────────────────────

  const readIf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

  /**
   * Write through a temp file and rename, so a reader never sees half a unit and a crash mid-write
   * cannot leave a truncated one behind. `0644` for units, `0600` for anything with a secret in it.
   */
  function writeAtomic(file, contents, mode = 0o644) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, contents, { mode });
    fs.renameSync(tmp, file);
  }

  function appendLog(event, fields) {
    try {
      fs.mkdirSync(paths.stateDir, { recursive: true });
      fs.writeFileSync(paths.logFile, `${logLine(event, fields)}\n`, { flag: "a" });
    } catch {
      // Never let logging be the thing that breaks a registration.
    }
  }

  const manifest = {
    read: () => readManifest(readIf(paths.manifest)),
    write(next) {
      writeAtomic(paths.manifest, `${JSON.stringify(next, null, 2)}\n`, 0o600);
      return next;
    },
    update(fn) {
      const current = this.read();
      const next = fn(structuredClone(current)) ?? current;
      next.writtenAt = new Date().toISOString();
      return this.write(next);
    },
  };

  // ── preflight ─────────────────────────────────────────────────────────────────────────────────

  // Where a tool actually is, in absolute terms.
  //
  // `command -v` is a shell builtin, so it cannot be spawned; asking the OS via `which` is the
  // portable form. The fallback list exists for one specific case: the systemd user manager does
  // not inherit a login shell's PATH, and Claude Code's own installer puts its binary in
  // ~/.local/bin, which is exactly the directory a bare `which` may miss under a stripped
  // environment. Getting this wrong writes a unit that fails 203/EXEC in silence.
  const KNOWN_LOCATIONS = {
    claude: ["/.local/bin/claude", "/.claude/local/claude"],
  };
  const which = (name) => {
    const res = run("which", [name]);
    if (res.ok && res.stdout.trim()) return res.stdout.trim().split(/\r?\n/)[0];
    for (const suffix of KNOWN_LOCATIONS[name] ?? []) {
      const candidate = `${home}${suffix}`;
      if (fs.existsSync(candidate)) return candidate;
    }
    for (const dir of ["/usr/local/bin", "/usr/bin", "/bin"]) {
      if (fs.existsSync(`${dir}/${name}`)) return `${dir}/${name}`;
    }
    return null;
  };

  /**
   * Everything that silently stops this working on a fresh box, checked in one pass.
   *
   * Each entry carries its own fix, because a preflight that only says "no" sends the user to a
   * search engine. `severity: "stop"` means the setup cannot continue; "warn" means it will work
   * but something is worse than it should be.
   */
  function preflight({ env = {} } = {}) {
    const checks = [];
    const add = (id, ok, severity, detail, fix) => checks.push({ id, ok, severity, detail, fix });

    // Tools.
    const claudeBin = which("claude");
    add("claude", Boolean(claudeBin), "stop",
      claudeBin ? `found at ${claudeBin}` : "Claude Code is not on PATH",
      "install it: https://claude.com/claude-code");

    // `script` from util-linux, not tmux. It is what gives Claude a real terminal under systemd,
    // and it is present on essentially every Linux install — but a minimal container image is
    // exactly where it is missing, and the failure would be a unit that never starts.
    const scriptBin = which("script");
    add("script", Boolean(scriptBin), "stop",
      scriptBin ? `found at ${scriptBin}` : "`script` is missing (it comes from util-linux)",
      "sudo apt install -y bsdutils util-linux");

    const gitBin = which("git");
    add("git", Boolean(gitBin), "stop", gitBin ? `found at ${gitBin}` : "git is not installed", "sudo apt install -y git");

    const ghBin = which("gh");
    add("gh", Boolean(ghBin), "warn",
      ghBin ? `found at ${ghBin}` : "the GitHub CLI is not installed",
      "sudo apt install -y gh — without it, repos cannot be auto-trusted by ownership and each one needs approving by hand");

    // The subcommand this whole design rests on. Checked by feature, not by version number, so a
    // renamed flag is caught by name instead of by a version comparison that will rot.
    if (claudeBin) {
      const help = run(claudeBin, ["remote-control", "--help"]);
      const text = `${help.stdout}${help.stderr}`;
      const hasSpawn = /--spawn/.test(text);
      const hasWorktree = /worktree/.test(text);
      add("remote-control", help.ok && hasSpawn && hasWorktree, "stop",
        help.ok
          ? hasSpawn && hasWorktree
            ? "supports --spawn worktree"
            : "this version has no --spawn worktree"
          : "`claude remote-control --help` failed",
        "run `claude update` — worktree-per-session needs a newer Claude Code");
    }

    // Auth. Remote Control refuses a token that can only do inference, which is exactly what a
    // headless box is most likely to have been set up with.
    if (claudeBin) {
      const auth = run(claudeBin, ["auth", "status"]);
      const text = `${auth.stdout}${auth.stderr}`;
      add("claude-auth", auth.ok && !/not logged in|logged out/i.test(text), "stop",
        auth.ok ? "signed in" : "not signed in to Claude",
        "run `claude auth login` — note that `claude setup-token` will NOT work here, those tokens cannot start Remote Control");
    }
    if (env.CLAUDE_CODE_OAUTH_TOKEN) {
      add("oauth-token-env", false, "stop",
        "CLAUDE_CODE_OAUTH_TOKEN is set",
        "unset it — long-lived tokens are inference-only and Remote Control will refuse them");
    }

    // Settings that quietly turn Remote Control off. A box being hardened is exactly where these
    // get set, and nothing about the failure points back at them.
    for (const key of ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_GROWTHBOOK"]) {
      if (env[key]) add(`env-${key}`, false, "stop", `${key} is set`, `unset ${key} — it disables Remote Control`);
    }
    if (env.ANTHROPIC_BASE_URL && !/api\.anthropic\.com/.test(env.ANTHROPIC_BASE_URL)) {
      add("base-url", false, "stop", `ANTHROPIC_BASE_URL points at ${env.ANTHROPIC_BASE_URL}`,
        "unset it — Remote Control only works against api.anthropic.com");
    }

    // Linger. Without it every server dies the moment the SSH session closes, which is precisely
    // the failure this whole thing exists to prevent, and it happens in silence.
    const user = (env.USER || env.LOGNAME || "").trim();
    const linger = run("loginctl", ["show-user", user || "self", "--property=Linger"]);
    add("linger", /Linger=yes/.test(linger.stdout), "stop",
      /Linger=yes/.test(linger.stdout) ? "on" : "off — your servers would stop when you log out",
      `run: sudo loginctl enable-linger ${user || "$USER"}`);

    // The user manager has to be reachable, which it is not under sudo or a non-login shell —
    // XDG_RUNTIME_DIR and the session bus are missing there, and every `systemctl --user` fails.
    const userBus = run("systemctl", ["--user", "is-system-running"]);
    const cannotConnect = /Failed to connect|Failed to get D-Bus/i.test(`${userBus.stderr}`);
    const noSystemctl = userBus.code === null;
    add("user-systemd", !noSystemctl && !cannotConnect, "stop",
      noSystemctl ? "systemctl could not be run at all"
        : cannotConnect ? "cannot reach your systemd user manager"
        : "reachable",
      noSystemctl
        ? "this needs a Linux box with systemd"
        : "log in as a normal user over SSH rather than using sudo, then run this again");

    if ((env.USER || "") === "root" || process.getuid?.() === 0) {
      add("not-root", false, "warn", "running as root",
        "make a normal user and run this as them — most VPS hardening turns off root SSH afterwards, and the SSH key and Claude login would be left in /root");
    }

    // Inotify. Several checkouts x several sessions exhausts watches long before memory, and the
    // failure is silent: file watching just stops working.
    const watches = Number(readIf("/proc/sys/fs/inotify/max_user_watches") ?? 0);
    add("inotify", watches >= 65536, "warn",
      `max_user_watches is ${watches || "unknown"}`,
      "echo 'fs.inotify.max_user_watches=524288' | sudo tee /etc/sysctl.d/99-skillhost.conf && sudo sysctl --system");

    const mem = memTotalMb();
    add("memory", mem >= 2048, "warn", `${mem || "unknown"} MB of RAM`,
      "2 GB is the practical floor for one session at a time; add swap or a bigger box");

    return { checks, stop: checks.filter((c) => !c.ok && c.severity === "stop"), warn: checks.filter((c) => !c.ok && c.severity === "warn") };
  }

  function memTotalMb() {
    const meminfo = readIf("/proc/meminfo");
    if (!meminfo) return 0;
    const m = /MemTotal:\s+(\d+)\s+kB/.exec(meminfo);
    return m ? Math.floor(Number(m[1]) / 1024) : 0;
  }

  // ── identity ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Who is signed in, and which organisations they belong to. This is what makes trust automatic:
   * a repo you or your organisation own is code you already have, and needs no prompt.
   *
   * Returns { login: null, orgs: [] } rather than throwing when `gh` is missing or signed out — the
   * caller turns that into "cannot auto-trust", which is a different message from "not allowed".
   */
  function gitIdentity() {
    const ghBin = which("gh");
    if (!ghBin) return { login: null, orgs: [], reason: "the GitHub CLI is not installed" };
    const me = run(ghBin, ["api", "user", "--jq", ".login"]);
    if (!me.ok) return { login: null, orgs: [], reason: "not signed in to the GitHub CLI (`gh auth login`)" };
    const login = me.stdout.trim();
    // Only organisations the account is actually a member of. Public-membership-only would silently
    // narrow this, so ask the authenticated endpoint rather than /users/<login>/orgs.
    const orgsRes = run(ghBin, ["api", "user/orgs", "--paginate", "--jq", ".[].login"]);
    const orgs = orgsRes.ok ? orgsRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
    return { login, orgs, reason: null };
  }

  // ── repos ─────────────────────────────────────────────────────────────────────────────────────

  function workspaceRoot(config) {
    return expandHome(config.workspaceRoot, home);
  }

  /**
   * Register a repo: check, clone, decide trust, write the unit, start it if trusted.
   *
   * Ordering is deliberate. Everything that can refuse runs before anything that writes, so a bad
   * request leaves the box exactly as it was.
   */
  function addRepo({ url, name = null, hook = null, config, trustOverride = null, identity = null }) {
    const root = workspaceRoot(config);
    const checkedUrl = validateUrl(url, config.allowedHosts);
    if (!checkedUrl.ok) return { ok: false, reason: checkedUrl.reason };

    const chosen = name ? validateName(name) : { ok: true, name: checkedUrl.repo.toLowerCase() };
    if (!chosen.ok) return { ok: false, reason: chosen.reason };
    const resolved = resolveRepoPath(root, chosen.name);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };

    const state = manifest.read();
    const existing = (state.repos ?? []).find((r) => r.name === resolved.name);
    if (existing && existing.url !== checkedUrl.normalised) {
      // Two repos with the same basename from different owners. Adopting one under the other's
      // name would silently repoint a running server at different code.
      return {
        ok: false, conflict: true,
        reason: `"${resolved.name}" is already registered for ${existing.url}. Pass a different name.`,
      };
    }

    // Clone, or fetch if it is already there and matches.
    if (fs.existsSync(`${resolved.path}/.git`)) {
      const remote = run("git", ["-C", resolved.path, "remote", "get-url", "origin"]);
      const current = remote.ok ? remote.stdout.trim() : "";
      if (current && current !== checkedUrl.normalised) {
        return { ok: false, conflict: true, reason: `${resolved.path} already holds a clone of ${current}` };
      }
      const fetched = run("git", ["-C", resolved.path, "fetch", "--all", "--prune"], { env: GIT_SAFETY_ENV, timeout: 300_000 });
      if (!fetched.ok) return { ok: false, reason: `could not fetch ${resolved.name}: ${fetched.stderr.trim() || "git failed"}` };
    } else {
      // mkdir is the lock: it is atomic and fails if the directory exists, so two simultaneous
      // registrations of the same name cannot both start cloning into it.
      try {
        fs.mkdirSync(resolved.path, { recursive: false });
      } catch (err) {
        if (err?.code === "EEXIST") return { ok: false, reason: `${resolved.path} already exists but is not a git clone` };
        fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
        fs.mkdirSync(resolved.path);
      }
      const cloned = run("git", cloneArgs(checkedUrl.normalised, resolved.path), { env: GIT_SAFETY_ENV, timeout: 600_000 });
      if (!cloned.ok) {
        fs.rmSync(resolved.path, { recursive: true, force: true });
        return { ok: false, reason: `clone failed: ${cloned.stderr.trim() || "git failed"}` };
      }
    }

    const who = identity ?? gitIdentity();
    const trust = trustOverride === true
      ? { trusted: true, basis: "manual", reason: "trusted by hand" }
      : trustDecision({ owner: checkedUrl.owner, login: who.login, orgs: who.orgs });

    manifest.update((m) => {
      m.stem = config.stem;
      m.repos = (m.repos ?? []).filter((r) => r.name !== resolved.name);
      m.repos.push({
        name: resolved.name, url: checkedUrl.normalised, host: checkedUrl.host, owner: checkedUrl.owner,
        path: resolved.path, hook, trusted: trust.trusted, trustBasis: trust.basis,
      });
      return m;
    });
    appendLog("repo.add", { name: resolved.name, url: checkedUrl.normalised, trusted: trust.trusted, basis: trust.basis });

    // Registering a repo starts nothing. It makes the repo available to start sessions against,
    // which is a separate act with its own worktree and its own bootstrap.
    if (!trust.trusted) {
      return {
        ok: true, name: resolved.name, path: resolved.path, trusted: false, trust,
        next: `skillhost trust ${resolved.name}`,
      };
    }
    writeSessionScaffolding({ config });
    return {
      ok: true, name: resolved.name, path: resolved.path, trusted: true, trust,
      next: `skillhost session ${resolved.name} <task>`,
    };
  }

  /**
   * Trust is per repo and recorded per repo, so withdrawing it later is exact.
   *
   * Claude keeps its own record of which directories a human has accepted; writing that record is
   * what lets a session start with nobody at the keyboard. It is only ever written for a repo whose
   * ownership already passed the check, or one the user has explicitly named.
   */
  function trustRepo({ name, config }) {
    const state = manifest.read();
    const repo = (state.repos ?? []).find((r) => r.name === name);
    if (!repo) return { ok: false, reason: `no repo called "${name}" — run \`skillhost list\`` };

    const claudeJsonPath = `${home}/.claude.json`;
    let claudeJson = {};
    const raw = readIf(claudeJsonPath);
    if (raw) {
      try {
        claudeJson = JSON.parse(raw);
      } catch (err) {
        return { ok: false, reason: `~/.claude.json is not valid JSON (${err.message}) — fix it before trusting anything` };
      }
    }
    claudeJson.projects = claudeJson.projects ?? {};
    claudeJson.projects[repo.path] = { ...(claudeJson.projects[repo.path] ?? {}), hasTrustDialogAccepted: true };
    writeAtomic(claudeJsonPath, `${JSON.stringify(claudeJson, null, 2)}\n`, 0o600);

    manifest.update((m) => {
      const entry = (m.repos ?? []).find((r) => r.name === name);
      if (entry) { entry.trusted = true; entry.trustBasis = entry.trustBasis === "foreign" ? "manual" : entry.trustBasis; }
      return m;
    });
    appendLog("repo.trust", { name });
    writeSessionScaffolding({ config });
    return { ok: true, name, next: `skillhost session ${name} <task>` };
  }

  function untrustRepo({ name }) {
    const claudeJsonPath = `${home}/.claude.json`;
    const raw = readIf(claudeJsonPath);
    if (!raw) return { ok: true };
    let claudeJson;
    try {
      claudeJson = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "~/.claude.json is not valid JSON — leaving it alone" };
    }
    const state = manifest.read();
    const repo = (state.repos ?? []).find((r) => r.name === name);
    if (repo && claudeJson.projects?.[repo.path]) {
      delete claudeJson.projects[repo.path].hasTrustDialogAccepted;
      writeAtomic(claudeJsonPath, `${JSON.stringify(claudeJson, null, 2)}\n`, 0o600);
    }
    return { ok: true };
  }

  /**
   * The repos this box knows about.
   *
   * A repo is a registration, not a running thing — nothing is up until a session starts. So what
   * matters per repo is whether it may be used at all, and how much is currently running in it.
   */
  function listRepos({ config }) {
    const state = manifest.read();
    const sessions = listSessions({ config });
    return (state.repos ?? []).map((repo) => {
      const mine = sessions.filter((s) => s.repo === repo.name);
      const live = mine.filter((s) => s.alive).length;
      return {
        ...repo,
        sessions: mine.length,
        liveSessions: live,
        summary: !repo.trusted ? `not trusted — \`skillhost trust ${repo.name}\``
          : live > 0 ? `${live} session${live === 1 ? "" : "s"} running`
          : "ready — `skillhost session " + repo.name + " <task>`",
      };
    });
  }

  /** Forget a repo. Its sessions are ended first, because they live inside its clone. */
  function removeRepo({ name, config, purge = false }) {
    const resolved = resolveRepoPath(workspaceRoot(config), name);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };

    const ended = [];
    for (const session of listSessions({ config }).filter((s) => s.repo === resolved.name)) {
      endSession({ id: session.id, config, purge: true });
      ended.push(session.id);
    }
    untrustRepo({ name: resolved.name });
    if (purge) fs.rmSync(resolved.path, { recursive: true, force: true });

    manifest.update((m) => {
      m.repos = (m.repos ?? []).filter((r) => r.name !== resolved.name);
      m.sessions = (m.sessions ?? []).filter((s) => s.repo !== resolved.name);
      return m;
    });
    appendLog("repo.remove", { name: resolved.name, purge, endedSessions: ended.length });
    return { ok: true, name: resolved.name, purged: purge, endedSessions: ended };
  }

  // ── sessions ──────────────────────────────────────────────────────────────────────────────────
  // A session is the unit of work here, not a repo. One request makes one worktree, runs the
  // bootstrap to completion, and starts one Claude with Remote Control on. When it is over, that is
  // one process to stop and one worktree to reclaim.

  const sessionRoot = (config) => `${workspaceRoot(config)}/.sessions`;
  const sessionMetaFile = (id) => `${paths.stateDir}/sessions/${id}.json`;

  /**
   * Write the pieces every session shares: the template unit, the slice, and the bootstrap runner.
   *
   * Done once at setup and refreshed whenever a session starts, so a `git pull` in this checkout
   * reaches the box the next time it is used rather than needing a separate update step.
   */
  function writeSessionScaffolding({ config }) {
    const claudeBin = which("claude");
    const scriptBin = which("script");
    if (!claudeBin) return { ok: false, reason: "claude is not on PATH, so no unit can be written" };
    if (!scriptBin) return { ok: false, reason: "`script` (from util-linux) is not on PATH, so no unit can be written" };

    const runner = `${paths.stateDir}/bootstrap-runner`;
    writeAtomic(runner, renderBootstrapRunner({
      stateDir: paths.stateDir,
      hooksDir: `${paths.vps}/hooks`,
      workspaceRoot: workspaceRoot(config),
    }), 0o755);

    const templateFile = `${paths.unitDir}/${config.stem}-session@.service`;
    const sliceFile = `${paths.unitDir}/${config.stem}.slice`;
    writeAtomic(templateFile, renderSessionUnit({
      stem: config.stem,
      sessionRoot: sessionRoot(config),
      claudeBin,
      scriptBin,
      bootstrapRunner: runner,
      permissionMode: config.permissionMode,
      pathEnv: `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
      bootstrapTimeoutSec: config.bootstrapTimeoutSec ?? 600,
      slice: `${config.stem}.slice`,
    }));
    writeAtomic(sliceFile, renderSlice({ memoryMax: sliceMemoryMax(memTotalMb()) }));
    run("systemctl", ["--user", "daemon-reload"]);

    manifest.update((m) => {
      m.stem = config.stem;
      for (const file of [templateFile, sliceFile, runner]) if (!m.files.includes(file)) m.files.push(file);
      return m;
    });
    return { ok: true, templateFile, runner };
  }

  /** How many sessions may run at once across the whole box. */
  function sessionCapacity(config) {
    return config.capacity === "auto" ? capacityFor(memTotalMb(), 1, config.perSessionMb) : Number(config.capacity);
  }

  /**
   * Make a worktree and start a session in it.
   *
   * Order matters and is the point of the whole design: the worktree exists before the unit starts,
   * and the unit's ExecStartPre runs the bootstrap to completion before Claude exists. If the
   * bootstrap fails, systemd fails the unit and no session is ever registered — so a session that
   * appears in the app is one whose tree was actually prepared.
   */
  function startSession({ repo, task = "", config, suffix = null, identity = null }) {
    const state = manifest.read();
    const entry = (state.repos ?? []).find((r) => r.name === repo);
    if (!entry) return { ok: false, reason: `no repo called "${repo}" — run \`skillhost list\`` };
    if (!entry.trusted) {
      return { ok: false, reason: `${repo} is not trusted yet, so nothing may run in it. \`skillhost trust ${repo}\`` };
    }

    const live = listSessions({ config }).filter((s) => s.alive);
    const cap = sessionCapacity(config);
    if (live.length >= cap) {
      return {
        ok: false, atCapacity: true,
        reason: `${live.length} sessions are already running and this box is sized for ${cap}. End one first: skillhost end <id>`,
      };
    }

    const made = makeSessionId({ repo, task, suffix: suffix ?? randomSuffix() });
    if (!made.ok) return { ok: false, reason: made.reason };
    const id = made.id;
    const worktree = `${sessionRoot(config)}/${id}`;
    if (fs.existsSync(worktree)) return { ok: false, reason: `a session called ${id} already exists` };

    const scaffolded = writeSessionScaffolding({ config });
    if (!scaffolded.ok) return scaffolded;

    // Branch off whatever the clone's origin currently points at, so a session that starts today
    // does not begin on a HEAD from whenever the repo was registered.
    fs.mkdirSync(sessionRoot(config), { recursive: true });
    run("git", ["-C", entry.path, "fetch", "--quiet", "origin"], { env: GIT_SAFETY_ENV, timeout: 300_000 });
    const head = run("git", ["-C", entry.path, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    const base = head.ok && head.stdout.trim() ? head.stdout.trim() : "origin/HEAD";
    const added = run("git", ["-C", entry.path, "worktree", "add", "-b", `claude/${id}`, worktree, base], { timeout: 300_000 });
    if (!added.ok) {
      return { ok: false, reason: `could not make a worktree: ${added.stderr.trim() || "git failed"}` };
    }

    writeAtomic(sessionMetaFile(id), `${JSON.stringify({
      id, repo, task, hook: entry.hook ?? "", worktree, branch: `claude/${id}`,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`, 0o600);

    const unit = sessionUnitName(config.stem, id);
    const started = run("systemctl", ["--user", "start", unit]);
    if (!started.ok) {
      // The unit failing is the bootstrap refusing, most of the time. Hand back the journal rather
      // than a systemctl exit code, because the reason is always in there.
      const why = diagnoseSession({ id, config });
      run("git", ["-C", entry.path, "worktree", "remove", "--force", worktree]);
      run("git", ["-C", entry.path, "branch", "-D", `claude/${id}`]);
      fs.rmSync(sessionMetaFile(id), { force: true });
      return { ok: false, reason: `the session would not start — the bootstrap probably failed`, diagnose: why };
    }

    manifest.update((m) => {
      m.sessions = (m.sessions ?? []).filter((s) => s.id !== id);
      m.sessions.push({ id, repo, worktree, branch: `claude/${id}`, unit });
      return m;
    });
    appendLog("session.start", { id, repo, task });
    return { ok: true, id, repo, worktree, branch: `claude/${id}`, unit };
  }

  /** Four hex characters, so two sessions on the same task do not collide. */
  function randomSuffix() {
    const bytes = world.randomBytes ? world.randomBytes(2) : null;
    if (bytes) return Buffer.from(bytes).toString("hex");
    return Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  }

  /**
   * What is actually running, rather than what was once started.
   *
   * `alive` asks for the process; `unitState` asks systemd. They are reported separately and never
   * conflated, because a unit that says `active` over a dead session is the exact failure that
   * leaves the Claude app offering something with nothing behind it.
   */
  function listSessions({ config }) {
    const state = manifest.read();
    return (state.sessions ?? []).map((session) => {
      const unitState = run("systemctl", ["--user", "is-active", session.unit]).stdout.trim() || "unknown";
      const proc = run("pgrep", ["-f", `remote-control ${session.id}`]);
      const alive = proc.ok && proc.stdout.trim().length > 0;
      return {
        ...session,
        unitState,
        alive,
        orphanedWorktree: !alive && fs.existsSync(session.worktree),
        summary: alive ? "live — open it in the Claude app"
          // "activating" covers both the first run and a retry after a failure, and the two look
          // identical from here, so it says so rather than implying everything is fine.
          : unitState === "activating" ? `preparing — the bootstrap is running, or retrying after a failure (\`skillhost why ${session.id}\`)`
          : unitState === "failed" ? `failed to start — \`skillhost why ${session.id}\``
          : "ended",
      };
    });
  }

  function diagnoseSession({ id, config }) {
    const unit = sessionUnitName(config.stem, id);
    const journal = run("journalctl", ["--user", "-u", unit, "-n", "60", "--no-pager"]);
    return {
      unit,
      log: journal.ok ? journal.stdout : "(no journal available)",
      hints: [
        `journalctl --user -u ${unit} -n 60 --no-pager`,
        `systemctl --user status ${unit} --no-pager`,
        "the bootstrap runs before Claude does, so a failure here is usually the bootstrap",
      ],
    };
  }

  /**
   * End a session: stop the process, then optionally reclaim its worktree and branch.
   *
   * Stopping is a SIGTERM to the cgroup rather than a kill, which gives Claude a chance to close the
   * session properly. That matters beyond tidiness — a session killed outright can leave the Claude
   * app still offering it, with requests hanging against nothing.
   */
  function endSession({ id, config, purge = false }) {
    const checked = validateSessionId(id);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    const state = manifest.read();
    const session = (state.sessions ?? []).find((s) => s.id === checked.id);
    if (!session) return { ok: false, reason: `no session called "${checked.id}" — run \`skillhost sessions\`` };

    run("systemctl", ["--user", "stop", session.unit]);

    let reclaimed = false;
    if (purge) {
      const entry = (state.repos ?? []).find((r) => r.name === session.repo);
      if (entry) {
        const dirty = run("git", ["-C", session.worktree, "status", "--porcelain"]);
        const unpushed = run("git", ["-C", session.worktree, "log", "--branches", "--not", "--remotes", "--oneline"]);
        if ((dirty.ok && dirty.stdout.trim()) || (unpushed.ok && unpushed.stdout.trim())) {
          // Refusing is the right answer. The worktree is the only copy of that work.
          return {
            ok: true, id: checked.id, stopped: true, purged: false,
            kept: (dirty.ok && dirty.stdout.trim()) ? "uncommitted changes" : "unpushed commits",
          };
        }
        run("git", ["-C", entry.path, "worktree", "remove", "--force", session.worktree]);
        run("git", ["-C", entry.path, "branch", "-D", session.branch]);
        reclaimed = true;
      }
    }

    manifest.update((m) => {
      m.sessions = (m.sessions ?? []).filter((s) => s.id !== checked.id);
      return m;
    });
    if (reclaimed) fs.rmSync(sessionMetaFile(checked.id), { force: true });
    appendLog("session.end", { id: checked.id, purge });
    return { ok: true, id: checked.id, stopped: true, purged: reclaimed };
  }

  /**
   * Sessions whose process is gone but whose worktree is still on disk.
   *
   * This is what accumulates. Nothing else removes them, and `git worktree prune` does not help —
   * it only forgets worktrees whose directory has already vanished, which is the opposite case.
   */
  function reapSessions({ config, olderThanDays = 0, dryRun = false }) {
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    const reaped = [];
    const kept = [];
    for (const session of listSessions({ config })) {
      if (session.alive) { kept.push({ ...session, why: "still running" }); continue; }
      let mtime = 0;
      try { mtime = fs.statSync(session.worktree).mtimeMs; } catch { mtime = 0; }
      if (olderThanDays > 0 && mtime > cutoff) { kept.push({ ...session, why: "recently used" }); continue; }

      const dirty = run("git", ["-C", session.worktree, "status", "--porcelain"]);
      if (dirty.ok && dirty.stdout.trim()) { kept.push({ ...session, why: "uncommitted changes" }); continue; }
      const unpushed = run("git", ["-C", session.worktree, "log", "--branches", "--not", "--remotes", "--oneline"]);
      if (unpushed.ok && unpushed.stdout.trim()) { kept.push({ ...session, why: "unpushed commits" }); continue; }

      if (!dryRun) endSession({ id: session.id, config, purge: true });
      reaped.push(session);
    }
    return { ok: true, reaped, kept };
  }

  // ── worktrees ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Every session leaves a worktree and a branch behind, and nothing else ever removes them. Left
   * alone they fill the disk, and the first symptom is clones failing for reasons that look
   * unrelated. `git worktree prune` does not help: it only forgets worktrees whose directory has
   * already gone.
   *
   * Anything with uncommitted or unpushed work is kept, whatever its age.
   */
  function pruneWorktrees({ name, config, olderThanDays = 14, dryRun = false }) {
    const resolved = resolveRepoPath(workspaceRoot(config), name);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };

    const listed = run("git", ["-C", resolved.path, "worktree", "list", "--porcelain"]);
    if (!listed.ok) return { ok: false, reason: `could not list worktrees: ${listed.stderr.trim()}` };

    const cutoff = Date.now() - olderThanDays * 86_400_000;
    const removed = [];
    const kept = [];
    let current = {};
    const entries = [];
    for (const line of listed.stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) current = { path: line.slice(9).trim() };
      else if (line.startsWith("branch ")) current.branch = line.slice(7).trim();
      else if (line === "" && current.path) { entries.push(current); current = {}; }
    }
    if (current.path) entries.push(current);

    for (const entry of entries) {
      if (entry.path === resolved.path) continue; // the main checkout is not a worktree to reap
      let mtime = 0;
      try { mtime = fs.statSync(entry.path).mtimeMs; } catch { mtime = 0; }
      if (mtime > cutoff) { kept.push({ ...entry, why: "recently used" }); continue; }

      const dirty = run("git", ["-C", entry.path, "status", "--porcelain"]);
      if (dirty.ok && dirty.stdout.trim()) { kept.push({ ...entry, why: "uncommitted changes" }); continue; }
      const unpushed = run("git", ["-C", entry.path, "log", "--branches", "--not", "--remotes", "--oneline"]);
      if (unpushed.ok && unpushed.stdout.trim()) { kept.push({ ...entry, why: "unpushed commits" }); continue; }

      if (!dryRun) {
        run("git", ["-C", resolved.path, "worktree", "remove", "--force", entry.path]);
        if (entry.branch) run("git", ["-C", resolved.path, "branch", "-D", entry.branch.replace("refs/heads/", "")]);
      }
      removed.push(entry);
    }
    if (!dryRun && removed.length) run("git", ["-C", resolved.path, "worktree", "prune"]);
    return { ok: true, removed, kept };
  }

  function diskFree(config) {
    const res = run("df", ["-Pm", workspaceRoot(config)]);
    if (!res.ok) return null;
    const line = res.stdout.trim().split(/\r?\n/).pop() ?? "";
    const cols = line.split(/\s+/);
    return cols.length >= 4 ? { freeMb: Number(cols[3]), usePercent: cols[4] ?? "?" } : null;
  }

  // ── settings ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Merge the user-scope permission rules, and record exactly which ones were added.
   *
   * This is the highest-leverage file the setup writes: it governs every unattended session on the
   * box. It is also the one the plan review found was installed and never removed, which is why the
   * manifest entry is written in the same breath as the file.
   */
  function applySettings(additions) {
    const raw = readIf(paths.settings);
    let existing = {};
    if (raw) {
      try {
        existing = JSON.parse(raw);
      } catch (err) {
        // Refuse rather than overwrite. A settings file we cannot read may hold rules that matter.
        return { ok: false, reason: `~/.claude/settings.json is not valid JSON (${err.message}) — fix it, then run this again` };
      }
    }
    const { merged, added } = mergeSettings(existing, additions);
    writeAtomic(paths.settings, `${JSON.stringify(merged, null, 2)}\n`, 0o600);
    manifest.update((m) => {
      for (const band of ["allow", "deny", "ask"]) {
        m.settingsAdded[band] = [...new Set([...(m.settingsAdded[band] ?? []), ...added[band]])];
      }
      return m;
    });
    return { ok: true, added };
  }

  function revertSettings() {
    const state = manifest.read();
    const raw = readIf(paths.settings);
    if (!raw) return { ok: true, removed: 0 };
    let existing;
    try {
      existing = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "~/.claude/settings.json is not valid JSON — leaving it alone" };
    }
    const next = unmergeSettings(existing, state.settingsAdded);
    writeAtomic(paths.settings, `${JSON.stringify(next, null, 2)}\n`, 0o600);
    const removed = ["allow", "deny", "ask"].reduce((n, b) => n + (state.settingsAdded?.[b]?.length ?? 0), 0);
    return { ok: true, removed };
  }

  // ── token ─────────────────────────────────────────────────────────────────────────────────────

  function ensureToken(randomBytes) {
    if (fs.existsSync(paths.tokenFile)) return { ok: true, token: fs.readFileSync(paths.tokenFile, "utf8").trim(), created: false };
    const token = randomBytes(32).toString("base64url");
    writeAtomic(paths.tokenFile, `${token}\n`, 0o600);
    manifest.update((m) => {
      if (!m.files.includes(paths.tokenFile)) m.files.push(paths.tokenFile);
      return m;
    });
    return { ok: true, token, created: true };
  }

  const readToken = () => (fs.existsSync(paths.tokenFile) ? fs.readFileSync(paths.tokenFile, "utf8").trim() : null);

  return {
    paths, manifest, preflight, memTotalMb, gitIdentity, which,
    addRepo, trustRepo, untrustRepo, listRepos, removeRepo,
    startSession, listSessions, endSession, reapSessions, diagnoseSession, writeSessionScaffolding,
    sessionCapacity, pruneWorktrees, diskFree, applySettings, revertSettings, ensureToken, readToken,
    workspaceRoot, appendLog, writeAtomic, readIf,
  };
}
