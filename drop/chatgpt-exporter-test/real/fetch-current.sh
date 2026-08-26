#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="https://raw.githubusercontent.com/pionxzh/chatgpt-exporter/master/dist/chatgpt.user.js"
OUT="${1:-$HERE/chatgpt.user.js}"
curl --fail --location --retry 3 "$URL" --output "$OUT"
node --check "$OUT"
printf 'Downloaded %s bytes to %s\n' "$(wc -c < "$OUT")" "$OUT"
