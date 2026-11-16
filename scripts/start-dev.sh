#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -z "${SPV_PREVIEW_API_UPSTREAM:-}" ]]; then
  echo "Refus : le backend local est désactivé. Configurez SPV_PREVIEW_API_UPSTREAM pour le preview Replit." >&2
  exit 1
fi
pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; wait || true; }
trap cleanup EXIT INT TERM
(cd frontend && CI=1 EXPO_NO_TELEMETRY=1 ../node_modules/.bin/expo start --web --port 8080) &
pids+=("$!")
node scripts/dev_gateway.cjs &
pids+=("$!")
wait -n
