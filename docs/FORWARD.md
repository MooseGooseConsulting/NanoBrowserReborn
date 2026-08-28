# Forward plan

Patrick's personal LLM web harness (Leader/Follower). Not a product.

Userscripts are **reviewed payloads** the harness injects, runs, and rewrites. One job of that pipeline is to keep those scripts current and organize ChatGPT scrap chats.

This file is the **work order**: what to build next, in what order. It is subordinate to
`docs/ARCHITECTURE.md`, which describes the target system. Where the two disagree, ARCHITECTURE.md
wins and this file is corrected.

Do not rebuild `buildDomTree` / `highlightIndex`. Do not invent a new repo. `drop/` is historical
(except `specs/001-*/spec.md`, which is the user-intent floor). `vendor/` is frozen. Work in
`apps/extension` and `apps/stagehand-host`.

Set-of-marks is **not optional as architecture** — see ARCHITECTURE.md §3. It is deferred in
*sequence* only: the userscript lane shipped with marks off, and nothing in that lane requires them.

## The plan

1. **On main** — runner/fixture, ChatGPT organize, the overlay keep-current loop, four-state
   Leader/Follower handling, and Hyperagent OBSERVE are all landed. The userscript lane is done.
2. **Next** — qualify what shipped, then work back up the stack. The corrected order lives in
   ARCHITECTURE.md §8: logged-in qualification → capability smoke → control plane and `BrowserPort`
   → marks → host → adapters → optional vision.
3. **Not started** — Conductor, control MCP, capability router, browser-control daemon, Stagehand
   host, durable checkpoints, persisted trace, canonical external configuration.

The shipped payloads are the **actuator layer** (ARCHITECTURE.md §2). They were built ahead of the
layers they hang from; their value stays capped until those exist.

## On main (item 1)

- Reviewed payload runner with current-origin registration, allow/deny checks, MAIN-world execution, and a packaged-seed/`chrome.storage.local` overlay contract.
- `chatgpt-organize` is a one-shot `chatgpt.com` job: same-origin fetch and title PATCH; its recovery loop is capped to one repaired overlay retry.
- Four-state Leader/Follower execution is merged. Keep replay, follow-up, pause/resume/cancel, and execution ordering intact.

## Landed — Hyperagent observe (merged as #8)

`hyperagent-observe` is origin-gated to `hyperagent.com` and `www.hyperagent.com`. It reads `/api/threads/{id}/status`, `/usage`, `/usage-breakdown`, and `/api/threads/{id}` with same-origin GET and treats SSE `/api/events/stream` as a refresh signal. It performs no DOM scraping, `PATCH`, `POST`, or MCP OAuth. A changed latest status enqueue/complete pair supports one recovered offscreen row; multiple cycles entirely between observations remain an explicit coverage gap because the status surface has no history.

Observed rows return through `run_userscript`; it does not merely inject a page-local observer.
Backend ingestion is still follow-on work.

## Next

Ordered in ARCHITECTURE.md §8. Standing constraints on that order:

- **Nothing downstream is legitimately startable until the capability smoke is done.** Enumerate the
  real MCP surface and traverse the authenticated UI, sending no prompts and invoking no models.
  This is issue #1's gate and it has never been run. PR #12 was built and closed for skipping it.
- **No Stagehand host code until the CDP 5-step has been run once** — connect, observe, one `act`,
  teardown that leaves Chrome running.
- **MCP / REST is the external control plane, not a Navigator action.** The daemon owns the
  credential; the extension never does. See issue #1 and ARCHITECTURE.md §4.
- LangGraph work is the durable-state rebase (`iteration` vs `navigationSteps`, pause/resume/cancel,
  side-panel events), not a framework swap.
- Marks: measure `buildDomTree` volume first; SAM only if DOM/AX observation proves insufficient.

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

Marks were off for the userscript lane and nothing there requires them. That is a property of that
lane, not a decision about the product — set-of-marks remains a core interaction surface
(ARCHITECTURE.md §3).
