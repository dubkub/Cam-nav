#!/bin/bash
#
# Prepares a Claude Code on the web session to run this repo's tests.
#
# The build step is not optional. Workspace packages import @cam-nav/core
# through its published `exports`, which point at dist/, so on a fresh checkout
# `pnpm test` in data, routing or api fails to resolve the module until core has
# been built at least once.
set -euo pipefail

# Local sessions manage their own environment.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable pnpm >/dev/null 2>&1 || npm install --global pnpm >/dev/null 2>&1
fi

# `install` rather than a frozen/ci install: the container is snapshotted after
# this hook, and a plain install reuses the store across sessions.
pnpm install

pnpm build

echo "cam-nav ready: pnpm test (145 tests), pnpm typecheck, pnpm api, pnpm app:web"
