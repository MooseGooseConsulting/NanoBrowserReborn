#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent


def wait_for_service_worker(context):
    if context.service_workers:
        return context.service_workers[0]
    return context.wait_for_event("serviceworker", timeout=10000)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="nanobrowser-poc-profile-") as profile:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                profile,
                channel="chromium",
                headless=True,
                args=[
                    "--no-sandbox",
                    f"--disable-extensions-except={ROOT}",
                    f"--load-extension={ROOT}",
                ],
            )
            worker = wait_for_service_worker(context)
            extension_id = worker.url.split("/")[2]

            # Wait for asynchronous registration and inspect the actual browser registries.
            status = None
            for _ in range(30):
                status = worker.evaluate("chrome.storage.local.get('runnerStatus')")
                if status.get("runnerStatus"):
                    break
                worker.evaluate("new Promise(resolve => setTimeout(resolve, 100))")
            assert status and status.get("runnerStatus", {}).get("ok") is True, status

            mode = status["runnerStatus"]["mode"]
            if mode == "chrome.userScripts":
                registered = worker.evaluate("chrome.userScripts.getScripts({ids: ['nano-userscript-poc']})")
                assert len(registered) == 1, registered
            else:
                registered = worker.evaluate("chrome.scripting.getRegisteredContentScripts({ids: ['nano-userscript-poc-packaged']})")
                assert len(registered) == 1, registered
                assert registered[0]["world"] == "MAIN", registered

            result = {
                "extension_id": extension_id,
                "registration_mode": mode,
                "registered_script_count": len(registered),
                "registered_world": registered[0].get("world"),
                "service_worker_status": status,
                "sandbox_navigation_note": "The Chromium build blocks all non-blank navigation, so runtime injection is covered by the separate direct harness"
            }
            print(json.dumps(result, indent=2))
            print("NANOBROWSER_EXTENSION_REGISTRATION=PASS")
            context.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
