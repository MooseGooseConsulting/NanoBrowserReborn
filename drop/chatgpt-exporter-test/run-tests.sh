#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$ROOT/results"
python "$ROOT/harness/parse_metadata.py" "$ROOT/real/chatgpt-exporter.metadata.user.js" | tee "$ROOT/results/metadata.txt"
node --check "$ROOT/harness/gm_bridge.js"
node --check "$ROOT/harness/fixture.user.js"
node --check "$ROOT/nanobrowser-poc/service-worker.js"
node --check "$ROOT/nanobrowser-poc/userscripts/compat.js"
node --check "$ROOT/nanobrowser-poc/userscripts/fixture.user.js"
python "$ROOT/harness/smoke_direct.py" | tee "$ROOT/results/direct-harness.txt"
node "$ROOT/nanobrowser-poc/unit_service_worker.mjs" | tee "$ROOT/results/nanobrowser-service-worker.txt"
echo ALL_LOCAL_TESTS=PASS | tee "$ROOT/results/summary.txt"
