#!/usr/bin/env bash
# Landing bar for privacy-screen: unit tests + live /api/health if the app is up.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT="${PRIVACY_SCREEN_PORT:-31338}"
HEALTH="http://127.0.0.1:${PORT}/api/health"
echo "== bun test tests/ =="
bun test tests/
python3 "$ROOT/scripts/live_health.py" "$HEALTH"
