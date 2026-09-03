# ADR-004 — Restore scope + marks optional + userscripts parked

- **Status:** accepted
- **Date:** 2026-09-03
- **Context:** Sidebar and executor buildings stand with live wiring but missing doors (see inventory): sidebar lacks pause/resume senders, run log, error-retry, tests, and has a readiness-gate bug; executor lacks a true Follower return signal, `maxActionsPerStep` enforcement, download/extract, and queue durability. Small (2–3B) vision grounders now match 7B systems on ScreenSpot, so pixel-coordinate grounding is viable without marks.
- **Decision:** "Restore" = fix the enumerated gaps only, no rebuilds. Set-of-marks is a deferred optional overlay (DOM/AX fast path + coordinate grounding first; SAM-family only on evidence for canvas/custom controls). The shipped userscript lane (`fixture`, `chatgpt-organize`, `hyperagent-observe`) stays landed and tested; no new payloads until the core drives a real task end to end. Outside message bus / external supervision comes much later; the sidebar user is the boss.
- **Consequence:** Build order is sidebar restore → executor restore → thin LangGraph `StateGraph` rebase → port-seam types → qualification. Everything else sits in `PARKED.md` with its gate.
