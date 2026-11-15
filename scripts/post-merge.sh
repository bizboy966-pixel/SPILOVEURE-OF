#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export CI=1
export EXPO_NO_TELEMETRY=1

# The root Yarn workspace installs the shared tooling and frontend dependencies.
yarn install --frozen-lockfile --non-interactive

# MongoDB collections and indexes are initialized by the backend at startup;
# this project has no separate database migration command.
python -m compileall -q backend scripts

# Catch frontend bundling errors immediately after merged changes.
yarn --cwd frontend build
