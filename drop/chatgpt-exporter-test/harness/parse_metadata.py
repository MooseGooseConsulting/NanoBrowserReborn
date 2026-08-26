#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

HEADER_RE = re.compile(r"^//\s+@(?P<key>\S+)\s+(?P<value>.*)$")


def parse(path: Path) -> dict[str, list[str]]:
    values: dict[str, list[str]] = defaultdict(list)
    in_header = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() == "// ==UserScript==":
            in_header = True
            continue
        if line.strip() == "// ==/UserScript==":
            break
        if not in_header:
            continue
        match = HEADER_RE.match(line)
        if match:
            values[match.group("key")].append(match.group("value").strip())
    return dict(values)


def main() -> int:
    path = Path(sys.argv[1])
    metadata = parse(path)
    expected_grants = {"GM_getValue", "GM_setValue", "GM_deleteValue", "unsafeWindow"}
    assert metadata.get("version") == ["2.34.1"], metadata.get("version")
    assert len(metadata.get("match", [])) == 16, len(metadata.get("match", []))
    assert set(metadata.get("grant", [])) == expected_grants, metadata.get("grant")
    assert metadata.get("run-at") == ["document-end"], metadata.get("run-at")
    assert metadata.get("require") == [
        "https://cdn.jsdelivr.net/npm/jszip@3.9.1/dist/jszip.min.js",
        "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js",
    ]
    print(json.dumps(metadata, indent=2, ensure_ascii=False))
    print("METADATA_CONTRACT=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
