# Publishing this collection as a plugin

The manifests in `.claude-plugin/` are **scaffolded but not published**. Nothing here is live
until someone runs `/plugin marketplace add` against this repo, so the files are inert and cost
nothing while they sit there.

Why they exist: the current install path is `git clone` → `cd` → `node install.mjs`. That is
fine for a developer and impassable for the non-technical audience `/seatbelt --vibe` and
`/raise-issue` are written for — a person who does not know what a pull request is needs a
terminal, git, Node, a paid Claude seat, two clones, and an understanding of `cd` before they
ever see a skill. The plugin route is two lines pasted into a Claude Code session they are
already sitting in.

The installer now has a guided route (`node install.mjs --for=someone-else`, see
[SETUP-FOR-A-COLLEAGUE.md](SETUP-FOR-A-COLLEAGUE.md)), and that changes the framing here but not
the conclusion. That route is a **handover tool**: it is run by a developer, sitting at the
colleague's machine, and it takes 45 to 90 minutes. It makes the setup survivable, not
self-serve. Publishing this marketplace is still the only thing that removes the terminal, git,
both clones and the installer from the colleague's path, and it deletes roughly half the steps
in that checklist. It remains the highest-value unshipped item in this repo.

## What the two files do

| File | Role |
|---|---|
| `.claude-plugin/marketplace.json` | The **catalog**. Names the marketplace, its owner, and which plugins it offers. This is what `/plugin marketplace add` reads. |
| `.claude-plugin/plugin.json` | The **plugin** itself: name, description, author, license. Read once a user installs. |

This repo is both the marketplace and the single plugin in it, which is why the plugin entry
uses `"source": "./"` — the plugin root is the repo root.

The entry lists each skill directory explicitly under `skills`. With a marketplace-root source
the listed paths are the complete set, so **a new skill directory must be added to that array**
or it will not load for plugin users. It will still work for `install.mjs` users, which makes
this an easy thing to forget — check both when you add a skill.

## Publishing, when you want to

1. **Pick the final marketplace name.** It is public — users type it as
   `/plugin install claude-skills@adamlinscott-claude-skills`. Each user can register only one
   marketplace per name. A set of names is reserved for Anthropic (`claude-plugins-official`,
   `agent-skills`, `anthropic-*` and others); anything that impersonates an official source is
   blocked at load time, not just at registration.
2. **Push to the default branch.** The marketplace is served from the repo itself; there is no
   registry to submit to and no review queue.
3. **Test the real path before telling anyone.** In a scratch directory:
   ```
   /plugin marketplace add adamlinscott/claude-skills
   /plugin install claude-skills@adamlinscott-claude-skills
   ```
   Then confirm the skills actually appear and run.
4. **Announce with both routes.** Developers keep `node install.mjs`; everyone else gets the two
   `/plugin` lines.

## Things that will bite you

**Invocation changes.** Plugin skills are namespaced by plugin name. `/seatbelt` becomes
`/claude-skills:seatbelt`. Any documentation, and any skill that tells the user to run another
skill, needs to survive both forms. The `/seatbelts` alias exists partly for this reason —
people will fumble the exact name either way.

**Version pinning.** If you set `version` in `plugin.json` or in the marketplace entry, the
plugin is pinned to that string and users only get updates when it changes. Omit it and the git
commit SHA is used, so every push ships. Neither is wrong; decide deliberately. The manifests
here omit it, which means push-to-ship.

**Updates are pull-based.** Users run `/plugin marketplace update` to refresh their copy. A
critical fix does not reach anyone automatically.

**Relative paths need a git source.** `"source": "./"` resolves against a local copy of the
marketplace. If someone adds the marketplace by direct URL to `marketplace.json`, only that one
file is downloaded and the relative path cannot resolve. Distribute via the GitHub repo, not a
raw file URL.

**Renames are not free.** If you rename or drop a plugin entry, existing users break unless you
add a `renames` map pointing the old name at the new one (or at `null` if removed).

## Not doing this yet

Leaving the manifests unpublished is a real option and costs nothing. The audience that needs
them is the non-technical one, and if in practice a developer always sets `/seatbelt --vibe` up
on someone else's machine, the clone path was always sufficient and this stays scaffolding.
