# Stagehand host

Node process that owns [Stagehand](https://github.com/browserbase/stagehand) v4 and talks to the user's Chrome over CDP.

Context7 checked: `@browserbasehq/stagehand` v4 — `localBrowser.connect({ cdpUrl })`, `Stagehand.create({ browser })`, instance methods `act` / `observe` / `extract`. Connecting to an existing browser does not close it on teardown.

This host implements `BrowserPort` for the extension:

- `observe` → `stagehand.observe`
- `execute` → `stagehand.act` (locator click when observe returns a selector)
- `waitFor` → condition wait, not a fixed sleep
- `reconnect` → new CDP attach after Chrome or worker restart

Not implemented yet. See `docs/FORWARD.md`. Do not put Stagehand inside the MV3 service worker.
