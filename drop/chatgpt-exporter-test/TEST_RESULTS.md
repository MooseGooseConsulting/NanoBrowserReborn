# Test results

Run date: 2026-08-25 America/Chicago (container clock recorded the following UTC date).

## Passed

- Current metadata contract reproduced from upstream v2.34.1: 16 ChatGPT match patterns, two `@require` dependencies, four grants, and `document-end` execution.
- All included JavaScript passes `node --check`.
- Playwright in-page compatibility smoke test:
  - userscript executes,
  - `unsafeWindow === window`,
  - GM get/set/delete shim works,
  - state survives script reinjection,
  - a Markdown download is generated with the expected conversation content.
- Nano Browser service-worker logic test:
  - native `chrome.userScripts.register()` branch verified,
  - packaged `chrome.scripting.registerContentScripts()` fallback verified,
  - file order, `MAIN` world, `document_end`, and persistence verified.

## Not run in this sandbox

- The real 903,608-byte upstream bundle could not be downloaded because the shell/browser had no outbound network connectivity.
- Authenticated ChatGPT E2E could not run because the sandbox Chromium blocks all non-blank browser navigation.
- Unpacked-extension E2E could not run because only Debian's system Chromium was installed; Playwright's supported headless extension path uses its bundled `chromium` channel.

The directory includes `real/fetch-current.sh`, `real/run_real_exporter.py`, and `nanobrowser-poc/smoke_extension.py` to perform those final checks on a normal desktop environment.
