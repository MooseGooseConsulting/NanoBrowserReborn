#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "error: run this script inside the Nano Browser Git checkout" >&2
  exit 2
fi
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "error: Node.js is required" >&2
  exit 3
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(`.`)[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(`.`)[1]')"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 12) )); then
  echo "error: Node >= 22.12.0 is required; found $(node --version)" >&2
  exit 4
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm is not on PATH. Use Corepack / the repository's pinned pnpm 9.15.1 first." >&2
  exit 5
fi

if [[ ! -d node_modules ]]; then
  echo "error: dependencies are not installed. Run: pnpm install --no-frozen-lockfile" >&2
  exit 6
fi

printf '\n== Focused LangGraph routing tests ==\n'
pnpm --filter chrome-extension exec vitest run \
  src/background/agent/__tests__/execution-graph.test.ts

printf '\n== Chrome extension type-check ==\n'
pnpm --filter chrome-extension type-check

printf '\n== Chrome extension production build ==\n'
pnpm --filter chrome-extension build

printf '\n== Full workspace type-check ==\n'
pnpm type-check

printf '\n== Source formatting check ==\n'
pnpm exec prettier --check \
  chrome-extension/src/background/agent/execution-graph.ts \
  chrome-extension/src/background/agent/__tests__/execution-graph.test.ts \
  chrome-extension/src/background/agent/executor.ts \
  chrome-extension/package.json

printf '\nValidation completed successfully.\n'
