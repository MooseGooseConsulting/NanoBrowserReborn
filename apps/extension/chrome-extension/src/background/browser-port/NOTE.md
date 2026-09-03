# BrowserPort seam — scope note

`BrowserPort` (`observe / execute / waitFor / reconnect / release`) is the plug
defined by ADR-003. This directory holds the seam plus its two current answers:

- `mv3.ts` — the MV3 extension driver (primary actuator, answers the plug today).
- `fake.ts` — the in-memory fake for executor tests (zero Chrome).

Out of scope for this task, by design:

1. **Stagehand Node host as a second implementation.** Gated on the CDP 5-step
   per ADR-003 — no host code until that evidence passes. When it does, the host
   implements this same interface behind the plug; nothing here changes.
2. **Executor migration to the seam.** `background/agent/executor.ts` still takes
   `BrowserContext` directly. Rewiring it (and its action builder) to program
   against `BrowserPort` is follow-up work, intentionally not done here to avoid
   colliding with the in-flight executor edit.
