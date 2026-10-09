# How are mods installed?

Research for issue #44 (map #41). Sources are the official Claude Code docs at code.claude.com, read 2026-10-09. Where the docs say nothing, this file says so.

## Short answer

A mod is not its own kind of folder. It is an ordinary Claude Code **plugin** whose `hooks/hooks.json` has a `modules` key ([overview](https://code.claude.com/docs/en/plugins/mods/overview), [create](https://code.claude.com/docs/en/plugins/mods/create)). So there is no `~/.claude/mods/` directory. A mod loads any way a plugin loads. One of those ways is a folder under `~/.claude/skills/<name>/`, which is the folder `install.mjs` already links skills into. That makes it very likely that `install.mjs` can install a mod by junctioning its folder there. The one part the docs don't settle is whether a **symlinked or junctioned** plugin folder is detected. They only say that a symlinked *skill* folder works.

## What a mod folder must contain

From the [reference, Files](https://code.claude.com/docs/en/plugins/mods/reference#files):

| File | Required | Notes |
| :- | :- | :- |
| `.claude-plugin/plugin.json` | Yes | Plugin manifest. Mods add no required fields. `name` is the only required manifest key ([manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference)). |
| `hooks/hooks.json` | Yes | `"modules": ["./register.js"]`: one path, relative to this file. This key is what makes a plugin a mod. |
| The hooks module (e.g. `hooks/register.js`) | Yes | An ES module that exports `register(on, options)`. Accepted extensions: `.js .mjs .cjs .jsx .ts .mts .cts .tsx`. No build step is needed. |
| `types/index.d.ts`, named by `"types"` in the manifest | Only if the mod uses `$.state` or adds a mods API namespace | |
| `*.test.ts` / `*.test.tsx` | No | Run by `claude plugin test`. |

Claude Code writes generated `.d.ts` files into `.claude-plugin/types/` inside the mod directory. It only does this for mods loaded with `--plugin-dir` or written by Claude in a session ([create](https://code.claude.com/docs/en/plugins/mods/create#get-the-types-for-your-build)). In a linked repo folder these files would appear in the working tree, so they may need a `.gitignore` entry. That is an inference, not a documented warning.

Name rule: `claude plugin validate` gives an error for names that start with `claude-`, `anthropic-` or `cc-plugin-` ([manifest reference, name](https://code.claude.com/docs/en/plugins/manifest-reference#name)).

## Where Claude Code loads mods from

Every route that loads a plugin also loads a mod. Each route gives the plugin an id suffix ([plugin loading reference](https://code.claude.com/docs/en/plugins/loading#find-where-a-plugin-came-from)):

| Route | Id | Persists? | Enabled by |
| :- | :- | :- | :- |
| Marketplace install: `claude plugin install name@marketplace` or `/plugin install` ([overview](https://code.claude.com/docs/en/plugins/mods/overview#install-or-update-a-mod)) | `@<marketplace>` | Yes. Copied to `~/.claude/plugins/cache/...`, except relative-path plugins in a marketplace added from a local path, which load in place | `enabledPlugins` in a settings file |
| Folder with `.claude-plugin/plugin.json` under `~/.claude/skills/` (or a project's `.claude/skills/`) | `@skills-dir` | Yes. Loads in place in every session, with no flag and no install step ([create](https://code.claude.com/docs/en/plugins/create#scaffold-a-plugin-that-loads-every-session)) | The manifest's `defaultEnabled`, which [defaults to `true`](https://code.claude.com/docs/en/plugins/manifest-reference#defaultenabled), unless `enabledPlugins` sets `"<name>@skills-dir"` |
| `claude --plugin-dir <dir>`, `--plugin-url`, or the `CLAUDE_CODE_PLUGIN_DIRS` env var (v2.1.280+, can sit in `env` in `~/.claude/settings.json`) | `@inline` | One session at a time. The env var form applies to every session that inherits it | On unless set `false` |
| A mod Claude writes in a session: `~/.claude/dev-mods/<session-id>/<mod>/` | — | Only for that session. The folder is deleted after `cleanupPeriodDays` ([create](https://code.claude.com/docs/en/plugins/mods/create#ask-claude-for-a-mod)) | A hot-reload approval prompt |
| Synced from claude.ai | `@synced` | Yes | claude.ai account |

The publish page says the same thing about the skills directory in plain terms. To share a plugin without a marketplace "for every session", people "move the plugin directory, with its `.claude-plugin/plugin.json`, under `~/.claude/skills/`" ([publish](https://code.claude.com/docs/en/plugins/publish#share-a-plugin-without-a-marketplace)). The [skills page](https://code.claude.com/docs/en/skills) adds: "add a `.claude-plugin/plugin.json` to a skill folder and it loads as a plugin named `<name>@skills-dir`, so it can bundle agents, hooks, and MCP servers."

No page says that a skills-directory plugin's hooks module runs. The mods overview says "A mod's hooks run in every kind of session that loads the plugin", and no page lists `@skills-dir` as an exception. The [admin page](https://code.claude.com/docs/en/plugins/mods/admin#decide-whether-to-leave-mods-on) ties mods Claude writes to the `skills-dir` origin when a managed allowlist is set, which suggests the mods runtime treats that origin as normal.

## How a mod is enabled

- Mods are on by default ([overview, Turn mods on or off](https://code.claude.com/docs/en/plugins/mods/overview#turn-mods-on-or-off)). A plugin is on through `enabledPlugins` or, for skills-dir and inline plugins, through `defaultEnabled`. No mod-specific switch exists.
- Off switches: disable the plugin in `/plugin` (or run `claude plugin disable <name>@skills-dir`), `--safe-mode`, `--bare`, `disableAllHooks`, or managed `allowManagedModsOnly` / `allowManagedHooksOnly` / `disableSideloadFlags` ([reference, Settings](https://code.claude.com/docs/en/plugins/mods/reference#settings-and-environment-variables)).
- Trust: no mod loads in a directory until its workspace trust prompt is accepted ([troubleshoot](https://code.claude.com/docs/en/plugins/mods/troubleshoot#no-mod-loads-in-a-directory-you-opened-for-the-first-time)). Personal-scope skills-dir plugins have none of the extra restrictions that project-scope ones have ([loading](https://code.claude.com/docs/en/plugins/loading#plugins-shared-through-a-repository)).
- Reload: an open session picks up a new plugin, or changes to `hooks/`, with `/reload-plugins`. Otherwise it loads at the next start ([skills](https://code.claude.com/docs/en/skills), [overview](https://code.claude.com/docs/en/plugins/mods/overview#install-or-update-a-mod)). Live hot-reload on save is documented only for `--plugin-dir` and Claude-written mods.
- To check: `/plugin` shows `N mod active · <name>`. `claude plugin test` run in an empty directory reports whether mods can load at all ([troubleshoot](https://code.claude.com/docs/en/plugins/mods/troubleshoot#check-whether-mods-can-load)).
- Name clash: a marketplace or `--plugin-dir` plugin with the same manifest name beats a skills-dir plugin, which then shows `Not loaded` in `/plugin` Errors ([loading, Name conflicts](https://code.claude.com/docs/en/plugins/loading#name-conflicts)).

## Version requirements

- Terminal: **v2.1.287 or later** ([overview](https://code.claude.com/docs/en/plugins/mods/overview#turn-mods-on-or-off), [create](https://code.claude.com/docs/en/plugins/mods/create)).
- Desktop app: mods work from **v2.1.286**. The app bundles its own Claude Code. Check the version with `/status` in a Code-tab local session.
- `CLAUDE_CODE_PLUGIN_DIRS` needs v2.1.280+. The reference is written against v2.1.290, and some fields need v2.1.289–292.
- Anthropic can switch installed mods off remotely with a rollout switch, which `claude plugin test` reports.

## Claude Desktop vs terminal

- Hooks run in the terminal and in the Desktop app's Code tab. They do **not** run in Desktop WSL sessions ("plugins aren't available in WSL sessions"). They run but draw nothing in the VS Code chat panel, in `claude -p` and in the Agent SDK ([overview, Where mods run](https://code.claude.com/docs/en/plugins/mods/overview#where-mods-run)).
- Drawing differs by app. `Svg` is Desktop-only. `Raster`, `Image` and a few render sites (`ToolProgress`, `TurnDuration`, `InfoNotice`) are terminal-only ([reference, Render sites and Elements](https://code.claude.com/docs/en/plugins/mods/reference#render-sites)).
- The terminal, Desktop local sessions and VS Code on one computer read the same settings files, so a user-scope plugin install is shared between them ([install](https://code.claude.com/docs/en/plugins/install#choose-an-install-scope)). On Desktop, plugins are managed through **+ > Plugins**.
- **Silent:** whether the Desktop app scans `~/.claude/skills/` for `@skills-dir` plugins. Shared settings and a bundled Claude Code suggest it does, but no page says so. Also silent: whether Desktop picks up `CLAUDE_CODE_PLUGIN_DIRS` from `env` in `~/.claude/settings.json`. The reference only says it is meant "for apps you can't pass a flag to".

## Can `install.mjs` install a mod by linking a folder?

Framing: `install.mjs` links each repo folder into `~/.claude/skills/<name>` (skills) or `~/.claude/agents/<name>` (agents). It uses a directory junction on Windows and a directory symlink elsewhere. `agents.txt` describes agents as "linked into ~/.claude/agents/<name>/, exactly as skills are."

- **Target directory:** `~/.claude/skills/<mod-name>/` is a documented, persistent, flag-free place to load plugins, and so mods. No `~/.claude/mods/` exists, and `~/.claude/agents/` is not a plugin location. The linking code the installer already uses for skills would work with the target directory unchanged.
- **Symlinks:** the [skills page](https://code.claude.com/docs/en/skills) says a personal `<skill-name>` entry "can be a symlink to a directory elsewhere on disk. Claude Code reads `SKILL.md` from the target." It does not say that the plugin check (looking for `.claude-plugin/plugin.json`) follows a symlinked folder. It says nothing about Windows junctions in any context. The [loading page](https://code.claude.com/docs/en/plugins/loading#paths-that-escape-the-plugin-directory) rejects symlinks that lead *outside the plugin root* for component paths inside a plugin. Whether a linked plugin root counts as "outside" is not stated. **The docs are silent here, so this needs a quick empirical test.** Junction a test mod into `~/.claude/skills/`, then run `claude plugin list` (skills-dir plugins have their own section) and `/plugin`.
- **Fallbacks if linking fails:**
  1. Have `install.mjs` register the repo as a **local-path marketplace**: `claude plugin marketplace add <repo>/...`, then `claude plugin install <mod>@<marketplace>`. Relative-path plugins in a local marketplace load in place, so `git pull` updates them at the next session or `/reload-plugins` with no version bump ([loading, In-place and copied plugins](https://code.claude.com/docs/en/plugins/loading#in-place-and-copied-plugins)). The repo already has a `.claude-plugin/plugin.json` at its root (`install.mjs` reads it for the repo name).
  2. Add the absolute paths to `CLAUDE_CODE_PLUGIN_DIRS` in `env` of `~/.claude/settings.json`. These load as `@inline`, and the Desktop behaviour is unknown (see above).
- **Uninstall:** delete the link, or run `claude plugin disable <name>@skills-dir` ([create](https://code.claude.com/docs/en/plugins/create#stop-loading-the-plugin)).

## Where the docs are silent

- Whether a symlinked or junctioned folder under `~/.claude/skills/` is detected as a plugin. Only symlinked skill folders are documented.
- Whether the Desktop app loads `@skills-dir` plugins, or `CLAUDE_CODE_PLUGIN_DIRS` from settings.
- Whether a skills-dir mod hot-reloads on save. Only `/reload-plugins` is documented for changes under `hooks/`.
- That a skills-dir plugin's hooks module runs. This follows from "a mod is a plugin" and is never stated directly.
