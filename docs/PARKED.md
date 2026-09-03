# Parked — still happening, just not today

Each item has the gate that unparks it. Nothing here is deleted.

| Item | Gate to start |
|---|---|
| Outside message bus / external supervision ("Conductor") | Core drives real sidebar tasks end to end; then define the inbound envelope (task id, objective, acceptance, cost cap) |
| Stagehand Node host (second kitchen) | Real CDP 5-step passes once (connect, observe, one `act`, teardown leaving Chrome running) |
| Durable checkpoints beyond SQLite + persisted trace | LangGraph rebase lands with parity tests |
| Portable config file + secret-store wiring (Doppler → OpenBao/keychain) | Sidebar + executor restore complete (ADR-001) |
| Oracle #13 playbook lifts (bundling, thinking selectors, project-sources sync, image downloader) | Core works; each lift lands as a versioned site adapter, not a core change |
| New userscript payloads; `hyperagent-observe` rewrite support | Core works; schema explicitly extended |
| SAM-family visual marks | DOM/AX + coordinate grounding both fail on measured cases |
| Hyperagent *writes* (beyond read-only observe) | Issue #1 gates: 1 E2E browser-control command + 1 non-destructive config write on a disposable resource with readback |
| Logged-in qualification of `chatgpt-organize` / `hyperagent-observe` | Deprioritized by owner; runs on demand, not a gate for core work |

Historical: `drop/` (except `specs/001-*/spec.md` FR-001…010 as intent floor), `vendor/` frozen, `nanobrowser-reborn-drop-map` memory superseded by the ADRs in this folder.
