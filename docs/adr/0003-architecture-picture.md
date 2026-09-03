# ADR-003 — Architecture picture: sidebar-first, BrowserPort-as-plug, Stagehand optional

- **Status:** accepted
- **Date:** 2026-09-03
- **Context:** `docs/FORWARD.md` (main) and PR #14 `ARCHITECTURE.md` disagreed on authority, BrowserPort's role, and marks; MV3 service workers cannot hold CDP connections while Stagehand v4 needs Node; in-browser extension code is the least-detectable driver.
- **Decision:** Sidebar-first product: the MV3 extension living in the user's visible Chrome is the primary actuator. `BrowserPort` (`observe / execute / waitFor / reconnect / release`) is a plug *inside our code*, not a rival platform — MV3 answers it today, a Node Stagehand host may answer it later. The extension is the least-tell driver (no launched browser, no debugger banner); any CDP use attaches to the already-running Chrome and stays off the `Runtime` domain on hot paths.
- **Consequence:** No host code until the CDP 5-step passes; Stagehand is an opt-in second kitchen behind the same plug, never the default path. Following qualification, Stagehand is excluded from the extension product path to eliminate debugger banners and external Node daemon requirements. The extension is 100% native MV3 and userscripts.
