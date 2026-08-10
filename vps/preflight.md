# Why it might not work

Every entry here is a real way a fresh VPS fails, and every one of them fails *quietly* — the box
looks fine, the unit says it is running, and your phone shows nothing.

`skillhost doctor` checks all of these and prints only the ones that are wrong, each with the
command that fixes it. This file is the long version, and it is a plain document on purpose: add a
row when you hit something new, without touching any code.

## Before Claude will connect at all

| Symptom | Cause | Fix |
|---|---|---|
| "Remote Control requires a full-scope login token" | You signed in with `claude setup-token`, or `CLAUDE_CODE_OAUTH_TOKEN` is set. Those tokens can only make model requests — they cannot start a Remote Control session. | `unset CLAUDE_CODE_OAUTH_TOKEN`, then `claude auth login`. |
| Nothing appears in the app, no error anywhere | No subscription on the account. Remote Control needs Pro, Max, Team or Enterprise. An API key will not do. | Sign in with a subscribed account. On Team or Enterprise an Owner also has to enable it. |
| Worked yesterday, silent today | Someone set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `DISABLE_GROWTHBOOK`. Either one turns Remote Control off. A hardening script is exactly where these get set. | Unset both and restart the units. |
| Sessions never register | `ANTHROPIC_BASE_URL` points somewhere other than `api.anthropic.com`. | Unset it. |
| `--spawn` is not recognised | Claude Code is too old for worktree-per-session. | `claude update` |

## Before a session will start

| Symptom | Cause | Fix |
|---|---|---|
| A session will not start at all | Nearly always the bootstrap. It runs before Claude does, and a non-zero exit deliberately stops the session existing. | `skillhost why <id>` — the reason is in the journal. |
| `skillhost session` says the repo is not trusted | The trust dialog has not been accepted for that repo, so nothing may run in it unattended. | `skillhost trust <repo>` |
| A session sits in "preparing" for a while | The bootstrap is running, or retrying once after a failure. It settles within about ten seconds. | `skillhost why <id>` if it stays there. |
| `status=203/EXEC` | The unit points at a binary that is not there. Claude Code's own installer puts it in `~/.local/bin`, not `/usr/local/bin`. | Re-run `node host-setup.mjs`, which resolves the real path and writes it in. |
| The unit is `active` but no session is in the app | The process behind it died. `skillhost list` checks for a live Claude process rather than trusting the unit, so it reports these separately. | `journalctl --user -u skillhost@<repo> -n 40 --no-pager` |

## After you disconnect

| Symptom | Cause | Fix |
|---|---|---|
| Everything stops the moment you close SSH | Linger is off, so systemd shuts your user services down at logout. This is the failure the whole setup exists to prevent, and it is completely silent. | `sudo loginctl enable-linger $USER` |
| Everything is gone after a reboot | Linger again, or the units were never enabled. | `loginctl show-user $USER --property=Linger` and `systemctl --user is-enabled skillhost@<repo>` |
| A session vanished on its own | A network outage of about ten minutes ends a Remote Control session and exits the process. | Nothing to do — `Restart=always` brings the server back. Start a new session in the app. |

## When the box gets full or busy

| Symptom | Cause | Fix |
|---|---|---|
| Clones start failing for no obvious reason | Worktrees. Every session leaves one behind and nothing removes them on its own. `git worktree prune` does not help: it only forgets worktrees whose directory has already gone. | `skillhost reap --dry-run`, then without it. Anything with uncommitted or unpushed work is kept. |
| Sessions are killed, or the box stops answering SSH | Out of memory. Each session is a large Node process; the OOM killer does not politely pick a session. | Lower `capacity` in `vps/config.json`, or add swap. `capacity: "auto"` sizes it from RAM. |
| File watching silently stops working | inotify watches exhausted. Several checkouts across several sessions runs out long before memory does. | `echo 'fs.inotify.max_user_watches=524288' \| sudo tee /etc/sysctl.d/99-skillhost.conf && sudo sysctl --system` |

## Things that are not broken

- **A registered repo runs nothing until you start a session.** That is the point: a session is a
  worktree, a finished bootstrap and a Claude, made together or not at all.
- **A session that ended stays ended.** It is not respawned — a fresh Claude in a worktree whose job
  is already done is worse than nothing.
- **`skillhost serve` only listens on loopback.** That is deliberate. Reach it over Tailscale or an
  SSH tunnel; it will not bind a public address whatever you put in the config.
- **A repo you do not own clones but does not start.** Starting it means letting its code run here
  as you. `skillhost trust <repo>` when you have decided that is fine.
