#!/usr/bin/env bash
set -euo pipefail

BASELINE_COMMIT="24a14b76e14a9c30fd84878ca7985049d1e7d064"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TARGET="${1:-$PWD}"

if [[ ! -d "$TARGET/.git" ]]; then
  echo "error: target is not a Git checkout: $TARGET" >&2
  exit 2
fi

CURRENT_HEAD="$(git -C "$TARGET" rev-parse HEAD)"
if [[ "$CURRENT_HEAD" != "$BASELINE_COMMIT" ]]; then
  cat >&2 <<MSG
error: this reconstructed overlay targets Nano Browser commit:
  $BASELINE_COMMIT
but target HEAD is:
  $CURRENT_HEAD

Check out the baseline first, or port the three source changes manually.
MSG
  exit 3
fi

if [[ -n "$(git -C "$TARGET" status --porcelain)" ]]; then
  echo "error: target working tree is not clean; commit/stash changes first" >&2
  exit 4
fi

cp -a "$BUNDLE_ROOT/overlay/." "$TARGET/"

echo "Overlay applied to: $TARGET"
echo "Next:"
echo "  cd '$TARGET'"
echo "  corepack pnpm install --no-frozen-lockfile"
echo "  ./scripts/validate-langgraph-modernization.sh"
