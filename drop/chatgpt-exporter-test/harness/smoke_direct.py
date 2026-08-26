#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent


def main() -> int:
    html = (ROOT / "fixture.html").read_text(encoding="utf-8")
    bridge = (ROOT / "gm_bridge.js").read_text(encoding="utf-8")
    script = (ROOT / "fixture.user.js").read_text(encoding="utf-8")

    with tempfile.TemporaryDirectory(prefix="userscript-profile-") as profile:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                profile,
                executable_path="/usr/bin/chromium",
                headless=True,
                args=["--no-sandbox"],
                accept_downloads=True,
            )
            page = context.pages[0] if context.pages else context.new_page()
            page.set_content(html, wait_until="domcontentloaded")
            page.evaluate(bridge)
            page.evaluate(script)
            page.wait_for_selector("html[data-userscript-loaded='true']")

            first = page.evaluate("window.__userscriptRuntimeFixture")
            assert first == {
                "loaded": True,
                "runs": 1,
                "unsafeWindowIsPageWindow": True,
            }, first

            page.click("#fixture-export-helper")
            with page.expect_download() as pending:
                page.click("#fixture-export-markdown")
            download = pending.value
            downloaded_path = Path(download.path())
            content = downloaded_path.read_text(encoding="utf-8")
            assert "Does the userscript runner work?" in content
            assert "local compatibility fixture" in content

            # Re-execute as a userscript manager or harness would after a SPA lifecycle event.
            page.locator("#fixture-export-helper").evaluate("node => node.remove()")
            page.locator("#fixture-menu").evaluate("node => node.remove()")
            page.evaluate(script)
            second = page.evaluate("window.__userscriptRuntimeFixture")
            assert second["runs"] == 2, second
            assert page.evaluate("GM_getValue('fixtureRuns')") == 2
            page.evaluate("GM_deleteValue('fixtureRuns')")
            assert page.evaluate("GM_getValue('fixtureRuns', 0)") == 0

            result = {
                "mode": "Playwright evaluate + four-function GM shim",
                "script_executes": True,
                "unsafe_window": True,
                "gm_storage_get_set_delete": True,
                "state_survives_reinjection": True,
                "download_triggered": True,
                "download_name": download.suggested_filename,
                "download_preview": content[:180],
                "sandbox_navigation_note": "Chromium navigation is blocked by administrator; fixture used page.set_content on about:blank"
            }
            print(json.dumps(result, indent=2))
            print("DIRECT_HARNESS=PASS")
            context.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
