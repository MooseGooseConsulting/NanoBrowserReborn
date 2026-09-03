# Stagehand host (Standalone prototype)

Node process exploring [Stagehand](https://github.com/browserbase/stagehand) v4 over CDP against Chrome.

> [!NOTE]
> **Not used by the extension.**
> Per ADR-003, the extension is a sidebar-first product driving tabs through native MV3 APIs and reviewed userscripts for maximum stealth (zero debugger banners, authentic cookies/sessions, no background Node daemon). Stagehand requires an external Node process and `--remote-debugging-port`, which introduces high bot-detection visibility.
> This directory is preserved only as an unstarted standalone prototype if external headless batch scraping is ever needed outside the browser extension.

Context7 checked: `@browserbasehq/stagehand` v4 — `localBrowser.connect({ cdpUrl })`, `Stagehand.create({ browser })`, instance methods `act` / `observe` / `extract`. Connecting to an existing browser does not close it on teardown.
Do not put Stagehand inside the MV3 service worker.
