#!/usr/bin/env python3
"""Run the real ChatGPT Exporter bundle in a persistent Chromium profile.

This runner deliberately uses the user's existing authenticated browser session. It does
not extract credentials or call an unofficial API from outside the page. Close any Chrome
process already using the selected profile directory before launching it.
"""
from __future__ import annotations

import argparse
import re
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

METADATA_RE = re.compile(r"^//\s+@(?P<key>\S+)\s+(?P<value>.*)$", re.MULTILINE)


def metadata(script: str, key: str) -> list[str]:
    return [m.group("value").strip() for m in METADATA_RE.finditer(script) if m.group("key") == key]


def fetch_text(url: str) -> str:
    with urllib.request.urlopen(url, timeout=30) as response:  # noqa: S310 - explicit user-provided metadata URLs
        return response.read().decode("utf-8")


def inject(page: Page, dependency_code: list[str], exporter_code: str) -> None:
    # The exporter already falls back to localStorage when GM storage is absent. These
    # definitions preserve the expected userscript globals and keep settings persistent.
    page.evaluate(
        """
        () => {
          const prefix = '__chatgpt_exporter_gm__:';
          globalThis.unsafeWindow = globalThis;
          globalThis.GM_getValue = (key, fallback = undefined) => {
            const raw = localStorage.getItem(prefix + key);
            if (raw === null) return fallback;
            try { return JSON.parse(raw); } catch { return fallback; }
          };
          globalThis.GM_setValue = (key, value) => localStorage.setItem(prefix + key, JSON.stringify(value));
          globalThis.GM_deleteValue = (key) => localStorage.removeItem(prefix + key);
        }
        """
    )
    for code in dependency_code:
        page.add_script_tag(content=code)
    page.add_script_tag(content=exporter_code)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", type=Path, default=Path(__file__).with_name("chatgpt.user.js"))
    parser.add_argument("--profile-dir", type=Path, required=True)
    parser.add_argument("--url", default="https://chatgpt.com/")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--skip-requires", action="store_true", help="Use only if JSZip/html2canvas are injected another way")
    args = parser.parse_args()

    if not args.script.exists():
        print(f"Missing {args.script}. Run fetch-current.sh first.", file=sys.stderr)
        return 2

    exporter_code = args.script.read_text(encoding="utf-8")
    dependency_code = [] if args.skip_requires else [fetch_text(url) for url in metadata(exporter_code, "require")]

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(args.profile_dir.expanduser().resolve()),
            executable_path="/usr/bin/chromium",
            headless=args.headless,
            args=["--no-sandbox"],
            accept_downloads=True,
        )
        page = context.pages[0] if context.pages else context.new_page()
        loaded = {"value": False}

        def on_console(message):
            print(f"browser[{message.type}]: {message.text}")
            if "[Exporter] Loaded" in message.text:
                loaded["value"] = True

        page.on("console", on_console)
        page.goto(args.url, wait_until="domcontentloaded")
        inject(page, dependency_code, exporter_code)
        page.wait_for_timeout(2500)

        labels = page.get_by_text("Export Helper", exact=True)
        count = labels.count()
        print(f"EXPORTER_CONSOLE_LOADED={loaded['value']}")
        print(f"EXPORT_HELPER_COUNT={count}")
        print("The browser remains open for interactive export; press Enter here to close it.")
        input()
        context.close()
    return 0 if loaded["value"] or count > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
