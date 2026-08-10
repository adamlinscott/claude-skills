#!/usr/bin/env node
// Sets up a fresh Linux VPS to run Claude sessions you can drive from your phone.
//
//     Register a repo once. Every session is a fresh worktree, bootstrap already run.
//
// One request makes one git worktree, runs that repo's bootstrap to completion, and starts one
// Claude with Remote Control on. The bootstrap runs as systemd's ExecStartPre, so it finishes
// before Claude exists and a failure means no session is registered at all — which is the whole
// reason this shape beats a long-lived server plus a Claude SessionStart hook.
//
// Same two halves as install.mjs, for the same reason. FIRST it asks — arrow-key checklists, typed
// answers, then a summary and a final Install/Cancel. THEN it acts. Nothing on disk is touched
// until that confirmation, so cancelling leaves the machine as it was. Every interactive thing it
// shells out to (signing in, generating a key) happens in the second half, after the wizard has
// handed the terminal back — two consumers of stdin in one process is a bug this repo has already
// had once.
//
// Everything it offers is read from disk rather than hardcoded, so this file does not need editing
// as the setup changes:
//   • ./vps/config.json        workspace root, capacity, allowed hosts, ports
//   • ./vps/repos.txt          which repos to register (repos.example.txt is the template)
//   • ./vps/permissions.json   the user-scope rules merged into ~/.claude/settings.json
//   • ./vps/hooks/*.sh         bootstrap scripts offered per repo
//   • ./vps/preflight.md       the long-form "why it might not work"
//
// Run `node host-setup.mjs --help` for the options.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import nodePath from "node:path";

import { multiSelect, chooseAction, textInput, clearScreen, canPrompt, closeInput, style } from "./lib/wizard.mjs";
import { createHost, realExecutor } from "./lib/host-steps.mjs";
import { loadConfig, parseRepos, validateUrl, deriveName, uninstallPlan } from "./lib/host-plan.mjs";

const repoRoot = nodePath.dirname(fileURLToPath(import.meta.url));
const posix = (p) => p.split(nodePath.sep).join("/");
const vpsDir = nodePath.join(repoRoot, "vps");
const readIf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

// ── Options ─────────────────────────────────────────────────────────────────────────────────────

const KNOWN_FLAGS = [
  "--help", "-h", "--doctor", "--check", "--apply", "--accept-defaults", "--yes", "-y",
  "--repos", "--skip-daemon", "--daemon", "--skip-skills", "--uninstall", "--purge",
];

const argv = process.argv.slice(2);
const flagValue = (name) => argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const has = (name) => argv.some((a) => a === name || a.startsWith(`${name}=`));

const showHelp = has("--help") || has("-h");
const doctorOnly = has("--doctor") || has("--check");
const uninstall = has("--uninstall");
const purge = has("--purge");
const skipDaemon = has("--skip-daemon");
const skipSkills = has("--skip-skills");
const acceptDefaults = has("--accept-defaults") || has("--yes") || has("-y");
const applyFlag = has("--apply");
const reposArg = flagValue("--repos");

const unknownFlags = argv.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.includes(a.split("=")[0]));

const isLinux = process.platform === "linux";
const interactive = canPrompt() && !acceptDefaults && !doctorOnly;

// A non-interactive run must not clone repos, write user-scope permissions and open units on its
// own. install.mjs can treat "no terminal" as "take the safe answers" because its safe answers are
// harmless; here they are not, so the polarity is reversed: without an explicit --apply, an
// unattended run reports and changes nothing.
const mayApply = isLinux && (interactive || applyFlag);

const host = createHost({
  run: realExecutor(spawnSync),
  fs,
  home: posix(homedir()),
  repoRoot: posix(repoRoot),
  randomBytes,
});

// ── Run ─────────────────────────────────────────────────────────────────────────────────────────
// No process.exit() anywhere, for the same reason install.mjs avoids it: console.log to a pipe is
// asynchronous and exiting would discard whatever is still buffered.

if (unknownFlags.length) {
  printBanner();
  console.log(`  Sorry — I do not recognise: ${unknownFlags.join(", ")}\n`);
  printHelp();
} else if (showHelp) {
  printBanner();
  printHelp();
} else if (uninstall) {
  await runUninstall();
} else if (doctorOnly) {
  printBanner();
  runDoctor();
} else {
  const plan = await buildPlan();
  if (!plan) {
    console.log("  Nothing was changed.\n");
  } else {
    await applyPlan(plan);
  }
}

// ── Presentation ────────────────────────────────────────────────────────────────────────────────

function printBanner() {
  console.log(
    style.cyan(String.raw`
    _   _  ___  ____ _____
   | | | |/ _ \/ ___|_   _|
   | |_| | | | \___ \ | |
   |  _  | |_| |___) || |
   |_| |_|\___/|____/ |_|
`),
  );
}

function printWelcome() {
  console.log("  Sets this box up to run Claude sessions you can drive from your phone.");
  console.log(`  ${style.bold("Register a repo once. Every session is a fresh worktree, bootstrap already run.")}`);
  if (interactive) console.log(style.dim("  Nothing changes until you confirm."));
  console.log("");
}

function printHelp() {
  console.log("  Usage:  node host-setup.mjs [options]");
  console.log("");
  console.log("  Register a repo once. Every session is a fresh worktree, bootstrap already run.");
  console.log("");
  console.log("  With no options it walks you through the setup, then asks you to confirm.");
  console.log("");
  console.log("  --help, -h                 Show this and stop. Changes nothing.");
  console.log("  --doctor, --check          Check this box and print what is wrong. Changes nothing.");
  console.log("");
  console.log("  --repos=<names>            Register these from vps/repos.txt. Comma-separated,");
  console.log("                             or 'all', or 'none'.");
  console.log("  --skip-daemon              Do not set up the HTTP wrapper for starting sessions remotely.");
  console.log("  --skip-skills              Do not install the skills at the end.");
  console.log("");
  console.log("  --accept-defaults, -y      Do not ask anything.");
  console.log("  --apply                    Actually make changes in a run that is not interactive.");
  console.log("                             Without it, an unattended run behaves like --doctor —");
  console.log("                             this setup clones repos and writes permissions, so it");
  console.log("                             will not do that because nobody happened to be watching.");
  console.log("");
  console.log("  --uninstall [--purge]      Remove what this created. Your clones are kept unless");
  console.log("                             you add --purge.");
  console.log("");
  console.log("  Examples:");
  console.log("    node host-setup.mjs                        the guided setup");
  console.log("    node host-setup.mjs --doctor               is this box ready?");
  console.log("    node host-setup.mjs --repos=all --apply    unattended, from vps/repos.txt");
  console.log("");
  console.log("  Afterwards, without coming back here:");
  console.log("    skillhost add git@github.com:you/thing.git   register a repo");
  console.log("    skillhost session <repo> <task>              start working");
  console.log("");
  if (!isLinux) {
    console.log(style.yellow(`  Note: this is a ${process.platform} machine.`));
    console.log("  --help and --doctor work anywhere; applying only happens on Linux.");
    console.log("");
  }
}

// ── Doctor ──────────────────────────────────────────────────────────────────────────────────────

function runDoctor() {
  if (!isLinux) {
    console.log(`  This box is ${process.platform}, and the setup targets Linux.`);
    console.log("  Checking what can be checked from here anyway.\n");
  }
  const report = host.preflight({ env: process.env });
  const failing = [...report.stop, ...report.warn];

  if (failing.length === 0) {
    console.log(`  ${style.green("Everything checks out.")}\n`);
  }
  for (const check of failing) {
    const label = check.severity === "stop" ? style.yellow("PROBLEM  ") : style.dim("warning  ");
    console.log(`  ${label} ${check.id} — ${check.detail}`);
    console.log(`            ${check.fix}`);
    console.log("");
  }
  console.log(style.dim(`  The long version of all of this: ${"vps/preflight.md"}`));
  console.log("");
  return report;
}

// ── Uninstall ───────────────────────────────────────────────────────────────────────────────────

async function runUninstall() {
  printBanner();
  const manifest = host.manifest.read();
  const steps = uninstallPlan(manifest, { purge });

  if (manifest.corrupt) {
    console.log(`  ${style.yellow("The manifest could not be read.")} I can only remove what I can still see.\n`);
  }
  if (steps.length === 0) {
    console.log("  Nothing to remove — no manifest was found.\n");
    return;
  }

  console.log("  This would:\n");
  for (const step of steps) console.log(`    ${step.kind === "clone" ? style.yellow(step.description) : step.description}`);
  console.log("");

  if (interactive) {
    const go = await chooseAction({
      heading: "Remove it?",
      body: purge ? [style.yellow("--purge is on: your clones and worktrees WILL be deleted.")] : ["Your clones are kept."],
      items: [
        { value: "go", label: "Remove", hint: "apply the changes above" },
        { value: "cancel", label: "Cancel", hint: "change nothing" },
      ],
    });
    closeInput();
    if (go !== "go") {
      console.log("  Nothing was changed.\n");
      return;
    }
  } else if (!applyFlag) {
    console.log("  Add --apply to actually do it.\n");
    return;
  }

  const config = loadConfig(readIf(nodePath.join(vpsDir, "config.json"))).config ?? {};
  for (const repo of manifest.repos ?? []) {
    host.removeRepo({ name: repo.name, config, purge });
    console.log(`  ${style.green("removed  ")} ${repo.name}`);
  }
  const reverted = host.revertSettings();
  console.log(reverted.ok
    ? `  ${style.green("removed  ")} ${reverted.removed} permission rule(s)`
    : `  ${style.yellow("kept     ")} permissions — ${reverted.reason}`);

  for (const file of manifest.files ?? []) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      console.log(`  ${style.green("removed  ")} ${file}`);
    }
  }
  host.manifest.write({ ...host.manifest.read(), units: [], files: [], repos: [], settingsAdded: { allow: [], deny: [], ask: [] } });
  console.log("");
  console.log("  Two things this deliberately did not do:");
  console.log("    - your Claude login is untouched. Run `claude auth logout` to sign this box out.");
  console.log("    - linger is left on. `sudo loginctl disable-linger $USER` turns it off.");
  console.log("");
}

// ── Questionnaire ───────────────────────────────────────────────────────────────────────────────

/** Gather every decision up front. Returns a plan, or null if the user aborted. Reads only. */
async function buildPlan() {
  clearScreen();
  printBanner();
  printWelcome();

  const loaded = loadConfig(readIf(nodePath.join(vpsDir, "config.json")));
  if (!loaded.ok) {
    console.log(`  ${style.yellow(loaded.reason)}\n`);
    return null;
  }
  const config = loaded.config;

  // — Preflight, before anything is asked —
  const report = host.preflight({ env: process.env });
  if (report.stop.length) {
    console.log(`  ${style.yellow("This box is not ready yet.")}\n`);
    for (const check of report.stop) {
      console.log(`    ${check.id} — ${check.detail}`);
      console.log(style.dim(`      ${check.fix}`));
      console.log("");
    }
    // Signing in is the one thing worth offering to do here and now, since it is both the most
    // common blocker and the most fiddly on a box with no browser.
    const authBlocked = report.stop.some((c) => c.id === "claude-auth");
    if (authBlocked && interactive) {
      const go = await chooseAction({
        heading: "Sign in now?",
        body: ["Signing in needs a browser, and this box has none.", "I can walk you through doing it from your phone or laptop."],
        items: [
          { value: "go", label: "Sign in now", hint: "runs claude auth login" },
          { value: "cancel", label: "Not now", hint: "fix the rest first" },
        ],
      });
      if (go === "go") {
        closeInput();
        signInToClaude();
        console.log(style.dim("\n  Run this again when the checks above pass.\n"));
        return null;
      }
    }
    if (interactive) closeInput();
    console.log(style.dim(`  More detail on every one of these: ${"vps/preflight.md"}\n`));
    return null;
  }
  for (const check of report.warn) console.log(`  ${style.dim("warning")}  ${check.id} — ${check.detail}`);
  if (report.warn.length) console.log("");

  if (!mayApply) {
    console.log(isLinux
      ? "  Not a terminal, and --apply was not given, so nothing will be changed."
      : `  This is a ${process.platform} machine — the setup applies on Linux only.`);
    console.log(style.dim("  Everything above is what a real run would have checked.\n"));
    return null;
  }

  // — Who this box is —
  const identity = host.gitIdentity();
  const repoRows = parseRepos(readIf(nodePath.join(vpsDir, "repos.txt")));
  for (const problem of repoRows.problems) console.log(`  ${style.yellow("vps/repos.txt")} ${problem}`);

  let chosenRepos = [];
  let gitName = null;
  let gitEmail = null;
  let wantDaemon = !skipDaemon;
  let wantSkills = !skipSkills;

  if (interactive) {
    try {
      console.log(`  ${style.green("Signed in")} to Claude.`);
      console.log(identity.login
        ? `  ${style.green("Signed in")} to GitHub as ${identity.login}${identity.orgs.length ? `, in ${identity.orgs.join(", ")}` : ""}.`
        : `  ${style.yellow("Not signed in")} to GitHub — ${identity.reason}.`);
      console.log("");
      if (!identity.login) {
        console.log(style.dim("  Without it, no repo can be trusted automatically and each one needs"));
        console.log(style.dim("  approving by hand. `gh auth login` fixes that.\n"));
      }

      // — Git identity, only if it is not already set —
      const currentName = host.which("git") ? runQuiet("git", ["config", "--global", "user.name"]) : "";
      const currentEmail = host.which("git") ? runQuiet("git", ["config", "--global", "user.email"]) : "";
      if (!currentName || !currentEmail) {
        gitName = await textInput({
          heading: "Who is committing?",
          note: "Goes on commits made by sessions on this box.",
          label: "name  ",
          initial: currentName || identity.login || "",
          validate: (v) => (v ? null : "a name is needed"),
        });
        if (gitName === null) return null;
        gitEmail = await textInput({
          heading: "Who is committing?",
          note: "Goes on commits made by sessions on this box.",
          label: "email ",
          initial: currentEmail || "",
          validate: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : "that does not look like an email address"),
        });
        if (gitEmail === null) return null;
      }

      // — Repos —
      if (repoRows.rows.length) {
        clearScreen();
        printBanner();
        const picked = await multiSelect({
          heading: "Repos",
          note: "From vps/repos.txt. Each becomes a server you can start sessions against.",
          items: repoRows.rows.map((r) => ({
            value: r.name,
            label: r.name,
            hint: r.hook ? `hook: ${r.hook}` : "",
            details: `${r.url}\n\nEach session on this repo gets its own git worktree.`,
          })),
          selected: repoRows.rows.map((r) => r.name),
        });
        if (!picked) return null;
        chosenRepos = repoRows.rows.filter((r) => picked.has(r.name));
      } else {
        // No repos.txt: ask for one. The first repo is the whole point of the first run, so this is
        // the one question that is never skipped.
        clearScreen();
        printBanner();
        const url = await textInput({
          heading: "Your first repo",
          note: "The one you want to start sessions against. You can add more later with `skillhost add`.",
          label: "url  ",
          placeholder: "git@github.com:you/thing.git",
          validate: (v) => {
            const checked = validateUrl(v, config.allowedHosts);
            if (!checked.ok) return checked.reason;
            return deriveName(v).ok ? null : "I could not work out a name from that URL";
          },
        });
        if (url === null) return null;
        chosenRepos = [{ name: deriveName(url).name, url, hook: null }];
      }

      // — The rest —
      clearScreen();
      printBanner();
      const extras = await multiSelect({
        heading: "Anything else",
        note: "Both recommended. Neither is needed for your first session.",
        items: [
          {
            value: "daemon",
            label: "Add repos without SSHing in",
            hint: "skillhost serve",
            details:
              "Runs a small HTTP listener on loopback so you can register a new repo from your phone, over Tailscale or an SSH tunnel.\n\nIt never listens on a public address. Sessions do not go through it — those come from the Claude app.",
          },
          {
            value: "skills",
            label: "Install the skills globally",
            hint: "runs install.mjs",
            details:
              "Links this collection's skills into ~/.claude/skills so every session on this box has them, in every repo you register.\n\nThis runs before the first server starts, so the first session already has them.",
          },
        ],
        selected: [...(skipDaemon ? [] : ["daemon"]), ...(skipSkills ? [] : ["skills"])],
      });
      if (!extras) return null;
      wantDaemon = extras.has("daemon");
      wantSkills = extras.has("skills");

      // — Confirm —
      clearScreen();
      printBanner();
      const go = await chooseAction({
        heading: "Ready",
        body: summaryLines({ chosenRepos, gitName, gitEmail, wantDaemon, wantSkills, identity, config }),
        items: [
          { value: "go", label: "Set it up", hint: "apply the changes above" },
          { value: "cancel", label: "Cancel", hint: "change nothing" },
        ],
      });
      if (go !== "go") return null;
    } finally {
      // Hand the terminal back whichever way we leave. Everything interactive from here on is a
      // child process with stdio inherited, and it needs stdin to itself.
      closeInput();
    }
  } else {
    chosenRepos = resolveReposFlag(repoRows.rows);
    for (const line of summaryLines({ chosenRepos, gitName, gitEmail, wantDaemon, wantSkills, identity, config })) {
      console.log(`  ${line}`);
    }
    console.log("");
  }

  return { config, chosenRepos, gitName, gitEmail, wantDaemon, wantSkills, identity };
}

function summaryLines({ chosenRepos, gitName, gitEmail, wantDaemon, wantSkills, identity, config }) {
  const lines = [];
  if (gitName || gitEmail) lines.push(`set git identity to ${gitName} <${gitEmail}>`);
  lines.push("merge permission rules into ~/.claude/settings.json");
  if (wantSkills) lines.push("install the skills globally (install.mjs)");
  if (chosenRepos.length === 0) lines.push("register no repos");
  for (const repo of chosenRepos) {
    const owner = validateUrl(repo.url, config.allowedHosts).owner ?? "?";
    const auto = identity.login && (owner.toLowerCase() === identity.login.toLowerCase() || identity.orgs.some((o) => o.toLowerCase() === owner.toLowerCase()));
    lines.push(`register ${repo.name}${auto ? "" : style.yellow(" — you own neither it nor its org, so it will wait for `skillhost trust`")}`);
  }
  if (wantDaemon) lines.push(`start the loopback listener on ${config.bind}:${config.port}`);
  return lines;
}

/** --repos=<names|all|none>. Defaults to all of them in an unattended run, which is the safe read. */
function resolveReposFlag(rows) {
  if (reposArg === undefined) return rows;
  const wanted = reposArg.split(",").map((s) => s.trim()).filter(Boolean);
  if (wanted.includes("none")) return [];
  if (wanted.includes("all")) return rows;
  for (const name of wanted) if (!rows.some((r) => r.name === name)) console.log(`  (--repos: nothing called "${name}" in vps/repos.txt — ignored)`);
  return rows.filter((r) => wanted.includes(r.name));
}

const runQuiet = (cmd, args) => {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  return res.status === 0 ? String(res.stdout).trim() : "";
};

// ── Acting ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Sign in, with the part nobody warns you about said out loud.
 *
 * The flow redirects to localhost on whatever device opened the link. On a laptop that is not this
 * box, so the browser lands on a page that looks broken — and the recovery is to copy that broken
 * page's address back here. A first-timer reads that as a failure and gives up.
 */
function signInToClaude() {
  console.log("");
  console.log(`  ${style.bold("Signing in to Claude.")}`);
  console.log("");
  console.log("  This box has no browser, so you finish this on your phone or laptop.");
  console.log("");
  console.log("    1. A URL is printed below. Open it on another device.");
  console.log("    2. Sign in.");
  console.log(`    3. The page it sends you to afterwards ${style.bold("will look broken")} —`);
  console.log("       \"can't reach this site\". That is expected, not a failure.");
  console.log("    4. Copy the whole address from that page and paste it back here.");
  console.log("");
  console.log(style.dim("  Smoother next time: reconnect with"));
  console.log(style.dim("      ssh -L 54545:localhost:54545 you@this-box"));
  console.log(style.dim("  and the round trip completes by itself."));
  console.log("");
  console.log(style.dim("  Note: `claude setup-token` does NOT work for this. Those tokens can only"));
  console.log(style.dim("  make model requests — Remote Control refuses them."));
  console.log("");
  spawnSync("claude", ["auth", "login"], { stdio: "inherit" });
}

async function applyPlan(plan) {
  const { config, chosenRepos, gitName, gitEmail, wantDaemon, wantSkills } = plan;
  console.log("");

  if (gitName && gitEmail) {
    spawnSync("git", ["config", "--global", "user.name", gitName], { stdio: "ignore" });
    spawnSync("git", ["config", "--global", "user.email", gitEmail], { stdio: "ignore" });
    console.log(`  ${style.green("set      ")} git identity`);
  }

  // Known hosts, before any clone. Without it the first SSH clone fails on host-key verification,
  // which reads as an authentication problem and sends people back to re-paste a key that was fine.
  installCommand();

  seedKnownHosts(config.allowedHosts);

  const permissions = readIf(nodePath.join(vpsDir, "permissions.json"));
  if (permissions) {
    try {
      const applied = host.applySettings(JSON.parse(permissions));
      console.log(applied.ok
        ? `  ${style.green("merged   ")} ${applied.added.deny.length} permission rule(s) into ~/.claude/settings.json`
        : `  ${style.yellow("PROBLEM  ")} ${applied.reason}`);
    } catch (err) {
      console.log(`  ${style.yellow("PROBLEM  ")} vps/permissions.json is not valid JSON — ${err.message}`);
    }
  }

  // Before the first server starts, deliberately. Sessions on this box run unattended and skills
  // shape how they behave, so they need to be on disk by the time the first one opens.
  if (wantSkills) {
    console.log("");
    console.log(`  ${style.bold("Installing the skills.")}`);
    console.log(style.dim("  running: node install.mjs --accept-defaults"));
    const res = spawnSync(process.execPath, [nodePath.join(repoRoot, "install.mjs"), "--accept-defaults"], { stdio: "inherit" });
    if (res.status !== 0) {
      console.log(`  ${style.yellow("skipped  ")} the skills installer exited with code ${res.status}`);
      console.log(style.dim("            run it yourself later: node install.mjs"));
    }
    console.log("");
  }

  const registered = [];
  for (const repo of chosenRepos) {
    const result = host.addRepo({ url: repo.url, name: repo.name, hook: repo.hook, config, identity: plan.identity });
    if (!result.ok) {
      console.log(`  ${style.yellow("PROBLEM  ")} ${repo.name} — ${result.reason}`);
      continue;
    }
    if (!result.trusted) {
      console.log(`  ${style.yellow("cloned   ")} ${repo.name} — ${result.trust.reason}`);
      console.log(style.dim(`            not started. When you are happy for its code to run here: skillhost trust ${repo.name}`));
      continue;
    }
    if (!result.started) {
      console.log(`  ${style.yellow("PROBLEM  ")} ${repo.name} — ${result.startError}`);
      for (const hint of host.diagnoseUnit({ name: repo.name, config }).hints) console.log(style.dim(`            ${hint}`));
      continue;
    }
    console.log(`  ${style.green("ready    ")} ${repo.name} — ${result.trust.reason}`);
    registered.push(repo.name);
  }

  if (wantDaemon) {
    const { token, created } = host.ensureToken(randomBytes);
    console.log(`  ${style.green(created ? "created  " : "kept     ")} the API token at ${host.paths.tokenFile}`);
    console.log(style.dim(`            start it with: skillhost serve`));
    void token;
  }

  printFarewell(registered, config);
}

/**
 * Put `skillhost` on PATH.
 *
 * A symlink rather than a copy, matching how install.mjs links the skills: editing this checkout
 * updates the command, and `git pull` reaches the box without a second install step. Recorded in
 * the manifest so --uninstall takes exactly this link away and nothing else.
 */
function installCommand() {
  const binDir = nodePath.join(homedir(), ".local", "bin");
  const linkPath = nodePath.join(binDir, "skillhost");
  const source = nodePath.join(repoRoot, "bin", "skillhost");
  try {
    fs.mkdirSync(binDir, { recursive: true });
    fs.chmodSync(source, 0o755);
    // readlink rather than lstat: it tells a link from a real file, and says where it points.
    let current = null;
    try {
      current = fs.readlinkSync(linkPath);
    } catch {
      current = null;
    }
    if (current === null && fs.existsSync(linkPath)) {
      console.log(`  ${style.yellow("PROBLEM  ")} something that is not our link already lives at ${linkPath}`);
      console.log(style.dim(`            move it, then run this again — or use: node ${source}`));
      return;
    }
    if (current !== source) {
      fs.rmSync(linkPath, { force: true });
      fs.symlinkSync(source, linkPath);
    }
    host.manifest.update((m) => {
      if (!m.files.includes(posix(linkPath))) m.files.push(posix(linkPath));
      return m;
    });
    console.log(`  ${style.green("linked   ")} skillhost -> ${linkPath}`);
    // Debian and Ubuntu only add ~/.local/bin to PATH if it existed when the shell started, so on a
    // box where we just created it the command is there and still not findable until they log in
    // again. Saying so now costs a line; not saying it costs a confused bug report.
    if (!String(process.env.PATH ?? "").split(":").includes(binDir)) {
      console.log(style.dim(`            not on your PATH yet — run: export PATH="$HOME/.local/bin:$PATH"`));
      console.log(style.dim(`            (and it is picked up automatically next time you log in)`));
    }
  } catch (err) {
    console.log(`  ${style.yellow("skipped  ")} could not link skillhost — ${err.message}`);
    console.log(style.dim(`            run it directly instead: node ${source}`));
  }
}

/**
 * Pre-seed the host keys for the git hosts we are allowed to clone from.
 *
 * Fetched from the host and shown, rather than pinned in this file: a fingerprint hardcoded here
 * would be wrong the day it rotates, and wrong in a way nobody could diagnose.
 */
function seedKnownHosts(hosts) {
  const sshDir = nodePath.join(homedir(), ".ssh");
  const knownHosts = nodePath.join(sshDir, "known_hosts");
  const existing = readIf(knownHosts) ?? "";
  const added = [];
  for (const host_ of hosts) {
    if (existing.includes(host_)) continue;
    const scan = spawnSync("ssh-keyscan", ["-t", "ed25519", host_], { encoding: "utf8" });
    if (scan.status !== 0 || !scan.stdout.trim()) continue;
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(knownHosts, scan.stdout, { flag: "a", mode: 0o600 });
    added.push(host_);
  }
  if (added.length) console.log(`  ${style.green("added    ")} host keys for ${added.join(", ")}`);
}

function printFarewell(registered, config) {
  console.log("");
  if (registered.length === 0) {
    console.log("  Set up, but nothing is running yet.");
    console.log("");
    console.log("  Add a repo:");
    console.log("      skillhost add git@github.com:you/thing.git");
    console.log("");
    return;
  }
  const first = registered[0];
  console.log(`  ${style.bold(`Done. ${registered.length} repo${registered.length === 1 ? "" : "s"} registered: ${registered.join(", ")}.`)}`);
  console.log("");
  console.log("  Nothing is running yet — that is deliberate. Start working:");
  console.log("");
  console.log(`      skillhost session ${first} <what you are doing>`);
  console.log("");
  console.log("  That makes a fresh worktree, runs the bootstrap, and opens a session.");
  console.log("  Carry on with it in the Claude app or at claude.ai/code.");
  console.log("");
  console.log(style.dim("  If nothing shows up:  skillhost doctor"));
  console.log(style.dim(`  Listener (optional):  skillhost serve   (loopback ${config.bind}:${config.port})`));
  console.log("");
}
