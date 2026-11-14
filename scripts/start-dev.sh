#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .local/mongo-data
pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; wait || true; }
trap cleanup EXIT INT TERM
if command -v mongod >/dev/null; then
  mongod --dbpath .local/mongo-data --bind_ip 127.0.0.1 --port 27017 --quiet --logpath .local/mongo-data/mongod.log &
else
  nix-shell -p mongodb-ce --run 'exec mongod --dbpath .local/mongo-data --bind_ip 127.0.0.1 --port 27017 --quiet --logpath .local/mongo-data/mongod.log' &
fi
pids+=("$!")
python scripts/dev_backend.py &
pids+=("$!")
(cd frontend && CI=1 EXPO_NO_TELEMETRY=1 ../node_modules/.bin/expo start --web --port 8080) &
pids+=("$!")
node scripts/dev_gateway.cjs &
pids+=("$!")
wait -n
