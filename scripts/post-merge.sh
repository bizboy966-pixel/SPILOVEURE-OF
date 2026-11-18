#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile
# SPILOVEURE keeps its existing VPS backend. Never push a scaffold DB here.
pnpm run test:migration
