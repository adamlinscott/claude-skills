#!/usr/bin/env bash
# First line on a brand new Linux box.
#
#     curl -fsSL https://raw.githubusercontent.com/adamlinscott/claude-skills/main/host.sh | bash
#
# You cannot run a Node script before Node exists, and you cannot clone this repo before git does.
# So this installs the four things the setup needs, clones the repo, and hands over. It prints what
# it is about to do and waits for a yes first — piping a script into bash should have to earn that.
#
# Everything it installs is from the distribution's own packages or the vendor's own installer.
# Nothing here is clever, and it is short enough to read before you run it.

set -euo pipefail

REPO_URL="${SKILLHOST_REPO_URL:-https://github.com/adamlinscott/claude-skills.git}"
CHECKOUT="${SKILLHOST_CHECKOUT:-$HOME/claude-skills}"
ASSUME_YES="${SKILLHOST_YES:-0}"

say() { printf '  %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" = "0" ]; then
  say ""
  say "You are root."
  say ""
  say "Do not set this up as root. Most VPS hardening turns off root SSH afterwards, and your"
  say "SSH key and Claude login would be sitting in /root when it does."
  say ""
  say "Make a normal user first, then run this as them:"
  say "    adduser dev && usermod -aG sudo dev && su - dev"
  say ""
  exit 1
fi

if ! have apt-get; then
  say ""
  say "This expects a Debian or Ubuntu box — it uses apt."
  say "On anything else, install git, curl and Node 20+ yourself, then:"
  say "    git clone $REPO_URL $CHECKOUT && cd $CHECKOUT && node host-setup.mjs"
  say ""
  exit 1
fi

MISSING=()
for tool in git curl; do have "$tool" || MISSING+=("$tool"); done
NEED_NODE=0
if ! have node || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]; then
  NEED_NODE=1
fi
NEED_CLAUDE=0
have claude || NEED_CLAUDE=1

say ""
say "This will set this box up to run Claude sessions you can drive from your phone."
say ""
say "About to:"
[ ${#MISSING[@]} -gt 0 ] && say "  - apt-get install ${MISSING[*]}"
[ "$NEED_NODE" = "1" ] && say "  - install Node 20 from nodesource"
[ "$NEED_CLAUDE" = "1" ] && say "  - install Claude Code from claude.ai/install.sh"
say "  - clone $REPO_URL into $CHECKOUT"
say "  - run: node host-setup.mjs   (which asks before it changes anything)"
say ""
say "It will ask for sudo for the apt steps and nothing else."
say ""

if [ "$ASSUME_YES" != "1" ]; then
  # Read from the terminal, not stdin: stdin is the script itself when this is piped into bash.
  if [ -r /dev/tty ]; then
    printf '  Go ahead? [y/N] '
    read -r reply < /dev/tty
    case "$reply" in [yY]*) ;; *) say "Nothing was changed."; exit 0 ;; esac
  else
    say "No terminal to ask on. Re-run with SKILLHOST_YES=1 if you meant it."
    exit 1
  fi
fi

if [ ${#MISSING[@]} -gt 0 ]; then
  say "installing ${MISSING[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y -qq "${MISSING[@]}"
fi

if [ "$NEED_NODE" = "1" ]; then
  say "installing Node 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi

if [ "$NEED_CLAUDE" = "1" ]; then
  say "installing Claude Code"
  curl -fsSL https://claude.ai/install.sh | bash
  # Its installer puts the binary in ~/.local/bin, which is not on PATH on a bare Debian box.
  export PATH="$HOME/.local/bin:$PATH"
  if ! grep -qs '\.local/bin' "$HOME/.profile" 2>/dev/null; then
    printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.profile"
    say "added ~/.local/bin to your PATH in ~/.profile"
  fi
fi

if [ -d "$CHECKOUT/.git" ]; then
  say "updating $CHECKOUT"
  git -C "$CHECKOUT" pull --ff-only --quiet || say "could not fast-forward — leaving your checkout as it is"
else
  say "cloning into $CHECKOUT"
  git clone --quiet "$REPO_URL" "$CHECKOUT"
fi

say ""
say "Done. Now:"
say "    cd $CHECKOUT && node host-setup.mjs"
say ""
say "One thing to know before you start: signing in needs a browser, and this box has none."
say "Have your phone or laptop to hand — the setup walks you through it."
say ""
