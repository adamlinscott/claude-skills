#!/usr/bin/env bash
# One command for the tests that need a real Linux box.
#
#     ./docker/run-systemd-tests.sh
#
# Builds a throwaway container with systemd as PID 1, boots it, runs docker/systemd-tests.sh inside,
# and removes it again. Everything else in this repo is tested with `npm test` on any machine; these
# are the three or four things that genuinely cannot be.
#
# On Windows, run this from Git Bash. MSYS_NO_PATHCONV stops the shell rewriting /sys/fs/cgroup into
# a Windows path before docker ever sees it.

set -euo pipefail

IMAGE=skillhost-systemd
NAME="skillhost-test-$$"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export MSYS_NO_PATHCONV=1

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "  building $IMAGE"
docker build -q -f "$ROOT/docker/Dockerfile.systemd" -t "$IMAGE" "$ROOT" >/dev/null

echo "  booting systemd"
docker run -d --name "$NAME" --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw "$IMAGE" >/dev/null

for _ in $(seq 1 45); do
  state="$(docker exec "$NAME" systemctl is-system-running 2>&1 | tr -d '\r')"
  case "$state" in
    running|degraded) break ;;
  esac
  sleep 1
done
if [ "${state:-}" != "running" ] && [ "${state:-}" != "degraded" ]; then
  echo "  systemd never came up (last state: ${state:-unknown})"
  docker logs "$NAME" 2>&1 | tail -20
  exit 1
fi

docker exec -u dev "$NAME" bash -lc \
  'export XDG_RUNTIME_DIR=/run/user/$(id -u); /opt/claude-skills/docker/systemd-tests.sh'
