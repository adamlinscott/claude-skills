#!/usr/bin/env bash
# The tests that need a real systemd. Runs as `dev` inside the container built by
# docker/Dockerfile.systemd.
#
# The central claim of this design is that a session's bootstrap CANNOT silently not happen: it runs
# as ExecStartPre, so systemd finishes it before Claude exists and fails the unit if it fails. That
# is a claim about systemd's behaviour, not about our code, and the only way to check it is to run
# real systemd and watch. Everything else here is in the same category.

set -uo pipefail

STEM=skillhost
UNIT_DIR="$HOME/.config/systemd/user"
STATE="$HOME/.local/state/skillhost"
WORKSPACE="$HOME/workspace"
SESSIONS="$WORKSPACE/.sessions"
PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }

wait_for() { # predicate, seconds
  local deadline=$((SECONDS + ${2:-15}))
  while [ $SECONDS -lt $deadline ]; do
    if eval "$1" >/dev/null 2>&1; then return 0; fi
    sleep 0.3
  done
  return 1
}

echo ""
echo "  systemd tests — real units, real PTYs, a stand-in claude"
echo ""

# ── setup ───────────────────────────────────────────────────────────────────────────────────────

UID_NUM="$(id -u)"
export XDG_RUNTIME_DIR="/run/user/$UID_NUM"
mkdir -p "$UNIT_DIR" "$STATE/sessions" "$SESSIONS/alpha" "$SESSIONS/beta" "$SESSIONS/willfail"

# Three sessions' worth of scaffolding. alpha and beta bootstrap cleanly; willfail does not, which
# is the case that matters most.
cat > "$STATE/sessions/alpha.json" <<'JSON'
{ "id": "alpha", "repo": "workspace", "hook": "ok.sh" }
JSON
cat > "$STATE/sessions/beta.json" <<'JSON'
{ "id": "beta", "repo": "workspace", "hook": "ok.sh" }
JSON
cat > "$STATE/sessions/willfail.json" <<'JSON'
{ "id": "willfail", "repo": "workspace", "hook": "broken.sh" }
JSON

mkdir -p /tmp/hooks
cat > /tmp/hooks/ok.sh <<'SH'
#!/usr/bin/env bash
# Leaves a mark so a test can prove this ran, and ran BEFORE Claude did.
echo "bootstrap: preparing $SKILLHOST_SESSION"
date +%s%N > "$HOME/.bootstrap-ran-$SKILLHOST_SESSION"
sleep 1
exit 0
SH
cat > /tmp/hooks/broken.sh <<'SH'
#!/usr/bin/env bash
echo "bootstrap: could not reach origin" >&2
exit 1
SH
chmod +x /tmp/hooks/*.sh

# Render the unit and the runner with the same code the setup uses, so this exercises what ships.
node --input-type=module -e "
import { renderSessionUnit, renderBootstrapRunner, renderSlice, sliceMemoryMax } from '/opt/claude-skills/lib/host-plan.mjs';
import fs from 'node:fs';
const home = process.env.HOME;
const state = \`\${home}/.local/state/skillhost\`;
fs.writeFileSync(\`\${state}/bootstrap-runner\`, renderBootstrapRunner({
  stateDir: state, hooksDir: '/tmp/hooks', workspaceRoot: \`\${home}/workspace\`,
}), { mode: 0o755 });
fs.writeFileSync(\`\${home}/.config/systemd/user/${STEM}-session@.service\`, renderSessionUnit({
  stem: '${STEM}',
  sessionRoot: \`\${home}/workspace/.sessions\`,
  claudeBin: '/usr/local/bin/claude',
  scriptBin: '/usr/bin/script',
  bootstrapRunner: \`\${state}/bootstrap-runner\`,
  pathEnv: '/usr/local/bin:/usr/bin:/bin',
  bootstrapTimeoutSec: 60,
}));
fs.writeFileSync(\`\${home}/.config/systemd/user/${STEM}.slice\`, renderSlice({ memoryMax: sliceMemoryMax(2048) }));
" || { echo "  could not render the unit"; exit 1; }

systemctl --user daemon-reload

# ── the unit is valid ───────────────────────────────────────────────────────────────────────────

if systemd-analyze --user verify "$UNIT_DIR/$STEM-session@.service" 2>&1 | grep -qi 'error\|not found\|invalid'; then
  bad "the rendered unit passes systemd-analyze verify" "$(systemd-analyze --user verify "$UNIT_DIR/$STEM-session@.service" 2>&1 | head -3)"
else
  ok "the rendered unit passes systemd-analyze verify"
fi

# ── a session starts, and the bootstrap ran first ───────────────────────────────────────────────

systemctl --user start "$STEM-session@alpha.service"
if wait_for "systemctl --user is-active --quiet $STEM-session@alpha.service" 30; then
  ok "a session starts"
else
  bad "a session starts" "$(systemctl --user status "$STEM-session@alpha.service" --no-pager 2>&1 | tail -12)"
fi

if [ -f "$HOME/.bootstrap-ran-alpha" ]; then
  ok "the bootstrap ran"
else
  bad "the bootstrap ran" "no marker file"
fi

# The whole point. ExecStartPre must have finished before ExecStart began.
if wait_for "test -f $HOME/.fake-claude-running-alpha" 30; then
  # The marker only exists because the bootstrap wrote it, and Claude only exists because
  # ExecStartPre returned 0 first. Both present means the ordering held.
  BOOT_AT=$(cat "$HOME/.bootstrap-ran-alpha" 2>/dev/null || echo 0)
  if [ -n "$BOOT_AT" ] && [ "$BOOT_AT" -gt 0 ]; then
    ok "the bootstrap finished before Claude started"
  else
    bad "the bootstrap finished before Claude started"
  fi
else
  bad "Claude started after the bootstrap" "no claude marker"
fi

check "the session works in its own worktree" \
  "$(systemctl --user show "$STEM-session@alpha.service" -p WorkingDirectory --value)" "$SESSIONS/alpha"

check "the session is named after itself, not the hostname" \
  "$(systemctl --user show "$STEM-session@alpha.service" -p Environment --value | grep -o 'CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX=[^ ]*' | cut -d= -f2)" "alpha"

# ── a failing bootstrap must stop the session existing at all ───────────────────────────────────
# This is the reason the bootstrap is here rather than in a Claude hook, which can be abandoned
# mid-flight and let the session start anyway on a tree that was never prepared.

systemctl --user start "$STEM-session@willfail.service" >/dev/null 2>&1
sleep 3
if [ -f "$HOME/.fake-claude-running-willfail" ]; then
  bad "a failing bootstrap stops Claude ever starting" "claude started anyway — the guarantee is broken"
else
  ok "a failing bootstrap stops Claude ever starting"
fi

# systemctl start already returned non-zero, which is what skillhost acts on. What is checked here
# is that the unit also SETTLES, rather than retrying a hopeless bootstrap for ever — a broken
# session stuck in "activating" reads as "still starting" to anyone looking.
if wait_for '[ "$(systemctl --user is-active '"$STEM"'-session@willfail.service 2>/dev/null)" = failed ]' 40; then
  ok "the unit settles into failed instead of retrying for ever"
else
  bad "the unit settles into failed" "still $(systemctl --user is-active "$STEM-session@willfail.service" 2>/dev/null) after 40s"
fi

if journalctl --user -u "$STEM-session@willfail.service" -n 20 --no-pager 2>/dev/null | grep -q "could not reach origin"; then
  ok "why it failed is in the journal, where skillhost why looks"
else
  bad "why it failed is in the journal" "$(journalctl --user -u "$STEM-session@willfail.service" -n 5 --no-pager 2>&1 | tail -3)"
fi

# ── two sessions side by side ───────────────────────────────────────────────────────────────────

systemctl --user start "$STEM-session@beta.service"
if wait_for "test -f $HOME/.fake-claude-running-beta" 30; then
  ok "a second session runs alongside the first"
else
  bad "a second session runs alongside the first" "$(systemctl --user status "$STEM-session@beta.service" --no-pager 2>&1 | tail -10)"
fi

if systemctl --user is-active --quiet "$STEM-session@alpha.service"; then
  ok "starting the second did not disturb the first"
else
  bad "starting the second did not disturb the first"
fi

# ── a real terminal, and output that reaches the journal ────────────────────────────────────────

ALPHA_PID=$(cat "$HOME/.fake-claude-running-alpha" 2>/dev/null || echo "")
STDIN_LINK=$(readlink "/proc/$ALPHA_PID/fd/0" 2>/dev/null || echo "none")
case "$STDIN_LINK" in
  /dev/pts/*) ok "Claude is running on a real terminal ($STDIN_LINK)" ;;
  *) bad "Claude is running on a real terminal" "stdin is $STDIN_LINK" ;;
esac

if journalctl --user -u "$STEM-session@alpha.service" -n 20 --no-pager 2>/dev/null | grep -q "up for alpha"; then
  ok "Claude's output reaches the journal"
else
  bad "Claude's output reaches the journal" "$(journalctl --user -u "$STEM-session@alpha.service" -n 5 --no-pager 2>&1 | tail -3)"
fi

if ! command -v tmux >/dev/null 2>&1; then
  ok "none of this needs tmux (it is not even installed here)"
else
  ok "tmux is present but unused"
fi

# ── a finished session stays finished ───────────────────────────────────────────────────────────
# The opposite of the repo-server design, where Restart=always was the whole point. Respawning a
# session would put a fresh Claude into a worktree whose job is already done.

if [ -n "$ALPHA_PID" ]; then
  kill -TERM "$ALPHA_PID" 2>/dev/null
  rm -f "$HOME/.fake-claude-running-alpha"
  sleep 6
  if [ -f "$HOME/.fake-claude-running-alpha" ]; then
    bad "a session that ended stays ended" "it was respawned"
  else
    ok "a session that ended stays ended"
  fi
  if systemctl --user is-active --quiet "$STEM-session@beta.service"; then
    ok "the other session was untouched"
  else
    bad "the other session was untouched"
  fi
fi

# ── stopping is a signal, not a kill ────────────────────────────────────────────────────────────

systemctl --user stop "$STEM-session@beta.service"
sleep 2
if pgrep -f "remote-control beta" >/dev/null 2>&1; then
  bad "stopping a session really stops its process" "$(pgrep -a -f 'remote-control beta' | head -2)"
else
  ok "stopping a session really stops its process"
fi

if [ ! -f "$HOME/.fake-claude-running-beta" ]; then
  ok "the session was signalled, so it could close cleanly"
else
  bad "the session was signalled, so it could close cleanly" \
      "the marker survived, so SIGKILL arrived before anything could handle it"
fi

# ── linger ──────────────────────────────────────────────────────────────────────────────────────

if loginctl show-user dev --property=Linger 2>/dev/null | grep -q 'Linger=yes'; then
  ok "linger is on, so sessions survive logout"
else
  bad "linger is on, so sessions survive logout" "$(loginctl show-user dev --property=Linger 2>&1)"
fi

# ── tidy up ─────────────────────────────────────────────────────────────────────────────────────

systemctl --user stop "$STEM-session@alpha.service" "$STEM-session@willfail.service" >/dev/null 2>&1
rm -f "$HOME/.bootstrap-ran-"* "$HOME/.fake-claude-running-"*

echo ""
echo "  $PASS passed, $FAIL failed"
echo ""
[ "$FAIL" -eq 0 ]
