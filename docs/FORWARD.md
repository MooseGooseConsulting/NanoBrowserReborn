# Forward plan

Patrick's personal LLM web harness (Leader/Follower). Not a product.

Userscripts are **reviewed payloads** the harness injects, runs, and rewrites. One job of that pipeline is to keep those scripts current and organize ChatGPT scrap chats.

This file records landed work and active work order. Target architecture and decision authority live in `docs/adr/` (ADR-001 through ADR-004) and deferred gates live in `docs/PARKED.md`.

Set-of-marks is **optional**. Do not rebuild `buildDomTree` / `highlightIndex`. Do not invent a new repo. Spec Kit is not the process. `drop/` is historical. `vendor/` is frozen. Work in `apps/extension`.

## Status

1. **Landed on main** — userscript runner/fixture, ChatGPT organize, overlay keep-current loop, four-state Leader/Follower handling, and Hyperagent OBSERVE (`hyperagent-observe`, PR #8).
2. **Landed in PR #16 (Restore & Rebase)**:
   - **Sidebar restore**: Navigator-mandatory readiness gate, pause/resume senders, run-log view, error retry, side-panel test suite.
   - **Executor restore**: Typed Follower control signal (`CONTINUE` / `SUBGOAL_COMPLETE` / `RETURN_TO_LEADER` / `BLOCKED`), enforced `planningInterval` and `maxActionsPerStep`, pause-strand fix.
   - **LangGraph rebase**: Thin `StateGraph` rebase behind `USE_GRAPH_EXECUTOR=false` with parity tests.
   - **BrowserPort seam**: In-tree port interface with `mv3` adapter and `fake` test port (ADR-003).
   - **Decisions**: ADR-001 through ADR-004 + `docs/PARKED.md`.
3. **Next up (unparked by gates in `docs/PARKED.md`)**:
   - In-tree continuous E2E qualification (`turbo e2e` headless Chromium runner).
   - Wire Executor to `BrowserPort` seam for offline `fake.ts` simulation.
   - Portable config file + secret-store wiring (Doppler → OpenBao/keychain) per ADR-001.
   - Durable checkpoints beyond SQLite + persisted trace.
   - Exterior message bus / external supervision ("Exterior Dispatcher") once core drives real sidebar tasks end to end.
   *(Note: Stagehand/CDP host is explicitly excluded from the extension roadmap per ADR-003 to preserve stealth and zero-daemon UX).*

## Gates that stay

**Mocked unit tests are not enough.**

**Human gates:** ChatGPT organize remains unproven until a logged-in `chatgpt.com` run; Hyperagent observe remains unproven until a logged-in Hyperagent run. Mocked tests prove only the exercised contracts. Characterization still requires Navigator to start a task and forbids a side panel “ready” state without Navigator (`drop/handoff/CODE_CONFIGURATION_FINDINGS.md`).

Automated coverage (necessary, not sufficient):

```text
pnpm -F chrome-extension test
```

Must cover current-origin registration, injection safety, ChatGPT keep-current recovery, and Hyperagent status/usage/SSE reduction and row handoff. No CI test is a live ChatGPT or Hyperagent login qualification.

From `apps/extension` after `corepack pnpm install`, still run:

```text
pnpm type-check
pnpm build
pnpm -F chrome-extension test
```

POC under `drop/chatgpt-exporter-test/nanobrowser-poc` remains historical proof (`node unit_service_worker.mjs`). The live helper is a TypeScript port in `apps/extension` because the extension module graph does not import `drop/`.

## Preserve

- Leader/Follower UX and Executor entrypoint
- Follow-ups, history, replay, pause/resume/cancel
- Dual counters (`maxSteps` vs planning cadence)
- Deterministic scaling as planning cadence (ADR-002: `planningInterval` backstopped by typed Follower return signals)
- Injection-safety URL blocks (`chrome://`, `chrome-extension://`, `javascript:`, `data:`)
- Apache-2.0 notices

Marks are optional; do not treat the set-of-marks interaction model as a required preserve for the userscript lane.
