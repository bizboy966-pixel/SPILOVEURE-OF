#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; wait || true; }
trap cleanup EXIT INT TERM

case "${SPV_PREVIEW_MODE:-}" in
  isolated)
    [[ "${DB_NAME:-}" == "spiloveure_local_development" ]] || { echo "Refus : DB_NAME doit être isolée." >&2; exit 1; }
    [[ "${MONGO_URL:-}" == "mongodb://127.0.0.1:27017" ]] || { echo "Refus : MongoDB doit rester local." >&2; exit 1; }
    mongo_dir=".local/mongo-preview-data"
    mkdir -p "$mongo_dir"
    mongod --dbpath "$mongo_dir" --bind_ip 127.0.0.1 --port 27017 --quiet --logpath "$mongo_dir/mongod.log" &
    pids+=("$!")
    ready=0
    for _ in $(seq 1 40); do
      if python -c 'from pymongo import MongoClient; MongoClient("mongodb://127.0.0.1:27017", serverSelectionTimeoutMS=500).admin.command("ping")' >/dev/null 2>&1; then
        ready=1
        break
      fi
      sleep 0.5
    done
    [[ "$ready" == "1" ]] || { echo "Refus : MongoDB local ne démarre pas." >&2; exit 1; }
    export SPV_ISOLATED_CHAT_PREVIEW=1
    export UPLOADS_DIR="$PWD/backend/uploads"
    python scripts/seed_chat_preview_account.py
    python scripts/seed_chat_preview_scenarios.py
    python scripts/dev_backend.py &
    pids+=("$!")
    ;;
  vps)
    [[ -n "${SPV_PREVIEW_API_UPSTREAM:-}" ]] || { echo "Refus : SPV_PREVIEW_API_UPSTREAM est requis en mode VPS." >&2; exit 1; }
    unset SPV_ISOLATED_CHAT_PREVIEW
    ;;
  *)
    echo "Refus : définissez SPV_PREVIEW_MODE sur isolated ou vps." >&2
    exit 1
    ;;
esac

(cd frontend && CI=1 EXPO_NO_TELEMETRY=1 pnpm exec expo start --web --port "${SPV_METRO_PORT:-8080}") &
pids+=("$!")
node scripts/dev_gateway.cjs &
pids+=("$!")
wait -n
