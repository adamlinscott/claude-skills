// `skillhost` — register repos, and start Claude sessions in them.
//
// One sentence governs the design and is printed wherever someone might be confused by it:
//
//     Register a repo once. Every session is a fresh worktree, bootstrap already run.
//
// The shape here changed after the first real test on a VPS. It used to run one long-lived
// `claude remote-control --spawn worktree` server per repo, with sessions started from the Claude
// app's + button. That was wrong in two ways that only showed on the box: sessions started that way
// skip the bootstrap unless a Claude hook runs it, and a Claude hook can be abandoned mid-flight;
// and one server holding many registrations means killing it leaves the app offering sessions with
// nothing behind them. Now one request makes one worktree, runs the bootstrap to completion via
// systemd's ExecStartPre, and starts one Claude. If the bootstrap fails, no session exists.
//
// runCli() takes its world as an argument and returns lines plus an exit code, so every branch can
// be driven from a test with a fake executor and no VPS in sight.

import { loadConfig, uninstallPlan, validateHookName } from "./host-plan.mjs";

export const MENTAL_MODEL = "Register a repo once. Every session is a fresh worktree, bootstrap already run.";

const USAGE = `
  skillhost — register repos, and start Claude sessions in them.

  ${MENTAL_MODEL}

  Usage:  skillhost <command> [options]

  Repos — registered once, then available to start sessions against.

    add <git-url>          Clone a repo and make it available. Starts nothing.
      --name <name>          Override the name derived from the URL.
      --hook <file>          Bootstrap from vps/hooks, run before every session in this repo.
      --trust                Register it even though you do not own it. Read the warning first.
    list                   Every repo, and how many sessions are running in it.
    trust <name>           Allow a repo that was cloned but not trusted.
    remove <name>          Forget a repo. Add --purge to delete the clone too.

  Sessions — one worktree, one bootstrap, one Claude, in one step.

    session <repo> [task]  Make a worktree, run the bootstrap, start Claude with Remote Control.
    sessions               What is running, and what only thinks it is.
    end <id>               Stop a session. Add --purge to reclaim its worktree and branch.
    why <id>               Why a session did not start. Usually the bootstrap.
    reap                   End sessions whose process is gone, and reclaim their worktrees.
      --older-than <days>    Only those idle this long. Default 0, meaning every dead one.
      --dry-run              Show what would go, delete nothing.

  The box.

    doctor                 Check this box and change nothing.
    serve                  Take these commands over HTTP on loopback, so a phone can drive them.
      --port <n>             Default from vps/config.json.

  Every command takes --json for machine-readable output.
`;

/** Parse argv into { command, args, flags }. Unknown flags are kept so the caller can complain. */
export function parseArgv(argv) {
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("-")) {
      args.push(token);
      continue;
    }
    const [name, inlineValue] = token.replace(/^--?/, "").split("=");
    // Flags that take a value, so `--name foo` reads the next token rather than treating it as an
    // argument. Everything else is a boolean.
    const takesValue = ["name", "hook", "port", "older-than", "config"].includes(name);
    if (inlineValue !== undefined) flags[name] = inlineValue;
    else if (takesValue && argv[i + 1] && !argv[i + 1].startsWith("-")) flags[name] = argv[++i];
    else flags[name] = true;
  }
  return { command: args[0] ?? null, args: args.slice(1), flags };
}

const pad = (s, n) => String(s).padEnd(n);

/**
 * @param {string[]} argv
 * @param {object} world  { host, configText, availableHooks?, env? }
 * @returns {Promise<{code: number, lines: string[], data?: object}>}
 */
export async function runCli(argv, world) {
  const { host } = world;
  const lines = [];
  const say = (s = "") => lines.push(s);
  const { command, args, flags } = parseArgv(argv);
  const json = Boolean(flags.json);
  const done = (code, data) => ({ code, lines, data });

  if (!command || flags.help || flags.h) {
    say(USAGE);
    return done(command ? 0 : 1);
  }

  const loaded = loadConfig(world.configText);
  if (!loaded.ok) {
    say(`  ${loaded.reason}`);
    return done(1);
  }
  const config = loaded.config;

  switch (command) {
    // ── repos ───────────────────────────────────────────────────────────────────────────────────

    case "add": {
      const url = args[0];
      if (!url) {
        say("  Which repo? Try: skillhost add git@github.com:you/thing.git");
        return done(1);
      }
      if (flags.hook) {
        const checked = validateHookName(flags.hook, world.availableHooks ?? []);
        if (!checked.ok) {
          say(`  ${checked.reason}`);
          return done(1);
        }
      }
      const result = host.addRepo({
        url,
        name: typeof flags.name === "string" ? flags.name : null,
        hook: typeof flags.hook === "string" ? flags.hook : null,
        config,
        trustOverride: flags.trust === true ? true : null,
      });
      if (!result.ok) {
        say(`  ${result.reason}`);
        return done(result.conflict ? 2 : 1, result);
      }
      if (json) return done(0, result);

      if (!result.trusted) {
        // Not a failure. The clone is on disk; it just may not run yet, and the reason is the thing
        // the user most needs to read before allowing it to.
        say(`  Cloned ${result.name}. Nothing will run in it yet.`);
        say("");
        say(`  ${result.trust.reason}.`);
        say("");
        say("  Starting a session in a repo lets its code run on this box as you — with your");
        say("  SSH key and your Claude login within reach. If that is fine for this repo:");
        say("");
        say(`      ${result.next}`);
        return done(0, result);
      }
      say(`  ${result.name} is registered — ${result.trust.reason}.`);
      say("");
      say("  Start working in it:");
      say(`      skillhost session ${result.name} <what you are doing>`);
      return done(0, result);
    }

    case "list": {
      const repos = host.listRepos({ config });
      if (json) return done(0, { repos });
      if (repos.length === 0) {
        say("  No repos yet. Add one:");
        say("      skillhost add git@github.com:you/thing.git");
        return done(0, { repos });
      }
      const width = Math.max(4, ...repos.map((r) => r.name.length));
      say(`  ${pad("REPO", width)}  STATE`);
      for (const repo of repos) say(`  ${pad(repo.name, width)}  ${repo.summary}`);
      say("");
      say(`  ${MENTAL_MODEL}`);
      return done(0, { repos });
    }

    case "trust": {
      const name = args[0];
      if (!name) {
        say("  Which repo? Try: skillhost trust workspace");
        return done(1);
      }
      const result = host.trustRepo({ name, config });
      if (!result.ok) {
        say(`  ${result.reason}`);
        return done(1, result);
      }
      say(`  ${name} is trusted.`);
      say(`      skillhost session ${name} <what you are doing>`);
      return done(0, result);
    }

    case "remove": {
      const name = args[0];
      if (!name) {
        say("  Which repo? Try: skillhost remove workspace");
        return done(1);
      }
      const result = host.removeRepo({ name, config, purge: flags.purge === true });
      if (!result.ok) {
        say(`  ${result.reason}`);
        return done(1, result);
      }
      say(`  ${result.name} removed.`);
      if (result.endedSessions?.length) say(`  Ended ${result.endedSessions.length} session(s) in it.`);
      // Said at the moment of the decision, not only in --help, because "did that delete my work?"
      // is the question people ask straight afterwards.
      say(result.purged ? "  Its clone was deleted." : "  Its clone was left alone — pass --purge to delete it too.");
      return done(0, result);
    }

    // ── sessions ────────────────────────────────────────────────────────────────────────────────

    case "session": {
      const repo = args[0];
      if (!repo) {
        say("  Which repo? Try: skillhost session workspace fix-login");
        return done(1);
      }
      const result = host.startSession({ repo, task: args.slice(1).join(" "), config });
      if (!result.ok) {
        say(`  ${result.reason}`);
        // A failed start is nearly always the bootstrap, and the reason is in the journal rather
        // than in the exit code — so print it here instead of making them go and look.
        for (const hint of result.diagnose?.hints ?? []) say(`      ${hint}`);
        if (result.diagnose?.log) {
          say("");
          for (const line of result.diagnose.log.trim().split("\n").slice(-12)) say(`      ${line}`);
        }
        return done(result.atCapacity ? 2 : 1, result);
      }
      if (json) return done(0, result);
      say(`  ${result.id} is running.`);
      say("");
      say(`  Worktree:  ${result.worktree}`);
      say(`  Branch:    ${result.branch}`);
      say("");
      say(`  Open the Claude app — "${result.id}" is in your session list. The bootstrap has`);
      say("  already run, so it is ready to work in.");
      return done(0, result);
    }

    case "sessions": {
      const sessions = host.listSessions({ config });
      if (json) return done(0, { sessions });
      if (sessions.length === 0) {
        say("  Nothing running. Start something:");
        say("      skillhost session <repo> <what you are doing>");
        return done(0, { sessions });
      }
      const width = Math.max(7, ...sessions.map((s) => s.id.length));
      say(`  ${pad("SESSION", width)}  STATE`);
      for (const session of sessions) say(`  ${pad(session.id, width)}  ${session.summary}`);
      const orphans = sessions.filter((s) => s.orphanedWorktree);
      if (orphans.length) {
        say("");
        say(`  ${orphans.length} finished session(s) still hold a worktree. Reclaim them: skillhost reap`);
      }
      return done(0, { sessions });
    }

    case "end": {
      const id = args[0];
      if (!id) {
        say("  Which session? Run `skillhost sessions` to see them.");
        return done(1);
      }
      const result = host.endSession({ id, config, purge: flags.purge === true });
      if (!result.ok) {
        say(`  ${result.reason}`);
        return done(1, result);
      }
      say(`  ${result.id} stopped.`);
      if (flags.purge && !result.purged && result.kept) {
        // Refusing to delete is the right answer here, and it has to say why or it reads as a bug.
        say(`  Its worktree was kept — it has ${result.kept}.`);
      } else if (result.purged) {
        say("  Its worktree and branch were reclaimed.");
      } else {
        say("  Its worktree was kept — pass --purge to reclaim it.");
      }
      return done(0, result);
    }

    case "why": {
      const id = args[0];
      if (!id) {
        say("  Which session? Run `skillhost sessions` to see them.");
        return done(1);
      }
      const report = host.diagnoseSession({ id, config });
      if (json) return done(0, report);
      say(`  ${report.unit}`);
      say("");
      for (const line of String(report.log).trim().split("\n").slice(-40)) say(`      ${line}`);
      say("");
      for (const hint of report.hints) say(`  ${hint}`);
      return done(0, report);
    }

    case "reap": {
      const result = host.reapSessions({
        config,
        olderThanDays: Number(flags["older-than"] ?? 0),
        dryRun: flags["dry-run"] === true,
      });
      if (json) return done(0, result);
      const verb = flags["dry-run"] ? "would reclaim" : "reclaimed";
      say(`  ${verb} ${result.reaped.length}, kept ${result.kept.length}`);
      for (const session of result.reaped) say(`      ${verb === "reclaimed" ? "gone" : "would go"}: ${session.id}`);
      for (const session of result.kept.filter((k) => k.why !== "still running")) {
        say(`      kept ${session.id} — ${session.why}`);
      }
      return done(0, result);
    }

    // ── the box ─────────────────────────────────────────────────────────────────────────────────

    case "doctor": {
      const report = host.preflight({ env: world.env ?? {} });
      const sessions = host.listSessions({ config });
      const disk = host.diskFree(config);
      if (json) return done(report.stop.length ? 1 : 0, { report, sessions, disk });

      if (report.stop.length === 0 && report.warn.length === 0) say("  Everything checks out.");
      for (const check of [...report.stop, ...report.warn]) {
        say(`  ${check.severity === "stop" ? "PROBLEM " : "warning "} ${check.id} — ${check.detail}`);
        say(`            ${check.fix}`);
      }
      // A unit that claims to be up while nothing is behind it is the failure that leaves the Claude
      // app offering a session whose requests hang, so it gets its own line rather than a table row.
      for (const session of sessions.filter((s) => s.unitState === "active" && !s.alive)) {
        say("");
        say(`  PROBLEM  ${session.id} — the unit is up but no Claude process is running.`);
        say(`            skillhost why ${session.id}`);
      }
      const orphans = sessions.filter((s) => s.orphanedWorktree);
      if (orphans.length) {
        say("");
        say(`  warning  ${orphans.length} finished session(s) still hold a worktree — skillhost reap`);
      }
      if (disk && disk.freeMb < 2048) {
        say("");
        say(`  warning  only ${disk.freeMb} MB free — try: skillhost reap`);
      }
      say("");
      say(`  Capacity: ${host.sessionCapacity(config)} concurrent sessions on this box.`);
      return done(report.stop.length ? 1 : 0, { report, sessions, disk });
    }

    case "uninstall": {
      const steps = uninstallPlan(host.manifest.read(), { purge: flags.purge === true });
      if (json) return done(0, { steps });
      if (steps.length === 0) {
        say("  Nothing to remove — no manifest was found.");
        return done(0, { steps });
      }
      say("  This would:");
      for (const step of steps) say(`      ${step.description}`);
      say("");
      say("  Run `node host-setup.mjs --uninstall` to do it.");
      return done(0, { steps });
    }

    default:
      say(`  I do not recognise "${command}".`);
      say(USAGE);
      return done(1);
  }
}
