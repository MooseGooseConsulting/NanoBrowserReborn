# Forward plan

Patrick's personal LLM web harness (Leader/Follower). Not a product.

Userscripts are **reviewed payloads** the harness injects, runs, and rewrites. One job of that pipeline is to keep those scripts current and organize ChatGPT scrap chats.

This file is the **only** forward map. There is no older work order. Do **not** do BrowserPort first. Do **not** rebase LangGraph before userscripts.

Set-of-marks is **optional**. Do not rebuild `buildDomTree` / `highlightIndex`. Do not invent a new repo. Spec Kit is not the process. `drop/` is historical. `vendor/` is frozen. Work in `apps/extension` (and later `apps/stagehand-host`).

## The only plan

1. **On main** — runner/fixture, ChatGPT organize, the overlay keep-current loop, and four-state Leader/Follower handling are landed.
2. **This PR** — Hyperagent OBSERVE (`hyperagent-observe`): same-origin GET + SSE, one telemetry row per observed enqueue-to-complete run, no Hyperagent writes.
3. **Later** — Stagehand host after a real CDP 5-step; MCP dispatch/config REST behind contract tests; LangGraph; marks/SAM.

## On main (item 1)

- Reviewed payload runner with current-origin registration, allow/deny checks, MAIN-world execution, and a packaged-seed/`chrome.storage.local` overlay contract.
- `chatgpt-organize` is a one-shot `chatgpt.com` job: same-origin fetch and title PATCH; its recovery loop is capped to one repaired overlay retry.
- Four-state Leader/Follower execution is merged. Keep replay, follow-up, pause/resume/cancel, and execution ordering intact.

## This PR (item 2) — Hyperagent observe

`hyperagent-observe` is origin-gated to `hyperagent.com` and `www.hyperagent.com`. It reads `/api/threads/{id}/status`, `/usage`, `/usage-breakdown`, and `/api/threads/{id}` with same-origin GET and treats SSE `/api/events/stream` as a refresh signal. It performs no DOM scraping, `PATCH`, `POST`, or MCP OAuth. The current status surface has no run history, so cycles entirely between observations are reported as an explicit coverage gap rather than fabricated as a single row.

This PR must return observed rows through `run_userscript`; it must not merely inject a page-local observer. Backend ingestion, MCP dispatch, and REST configuration are follow-on work.

## Later (item 3)

Do not start these from the runner or from the observe stacked PR:

- Stagehand host, and only after a real CDP 5-step has been run once (connect, observe, one `act`, teardown that leaves Chrome running)
- Four-state completion (PR #4 already exists elsewhere)
- MCP / REST
- LangGraph overlay (pause/resume/cancel, side-panel events, `iteration` vs `navigationSteps`)
- Marks / SAM (measure `buildDomTree` volume; route observe through Stagehand; SAM 3 only if observe is not enough)

No host code until that CDP 5-step has been run once. Do not start with MarkMap, SQLite, or Spec Kit regeneration.

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
- Existing deterministic knobs until "deterministic scaling" is identified in code
- Injection-safety URL blocks (`chrome://`, `chrome-extension://`, `javascript:`, `data:`)
- Apache-2.0 notices

Marks are optional; do not treat the set-of-marks interaction model as a required preserve for the userscript lane.
