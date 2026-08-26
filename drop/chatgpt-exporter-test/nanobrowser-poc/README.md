# Nano Browser userscript runner POC

This is a minimal Manifest V3 extension implementing the exact fork direction evaluated for Nano Browser.

1. It first tries `chrome.userScripts.register()` for arbitrary user-supplied code.
2. Chrome 138+ requires the user to enable **Allow User Scripts** once on the extension details page.
3. If that toggle is unavailable/off, the POC falls back to `chrome.scripting.registerContentScripts()` for a reviewed script packaged with the extension.
4. The compatibility prelude supplies the four globals used by ChatGPT Exporter: `GM_getValue`, `GM_setValue`, `GM_deleteValue`, and `unsafeWindow`.

`unit_service_worker.mjs` executes the real service-worker code against browser-API mocks and verifies both registration paths, file ordering, `MAIN`-world execution, `document_end`, and persistence. `smoke_extension.py` is an optional real-Chromium E2E check for a normal environment with Playwright's bundled Chromium.

This creation sandbox had only Debian's system Chromium. Playwright's current extension test path requires its bundled `chromium` channel for headless extension loading, while the sandbox also blocks all browser navigation and remote debugging. Therefore the browser extension was not falsely marked E2E-tested here.

The packaged fallback is the recommended initial implementation for ChatGPT Exporter. Add the generic `chrome.userScripts` registry only when arbitrary user-installed scripts are a real requirement.
