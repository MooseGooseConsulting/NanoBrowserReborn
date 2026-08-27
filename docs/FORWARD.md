# Forward plan

Patrick's personal LLM web harness (Leader/Follower). Not a product.

Userscripts are **reviewed payloads** the harness injects, runs, and rewrites. One job of that pipeline is to keep those scripts current and organize ChatGPT scrap chats.

This file is the **only** forward map. There is no older work order. Do **not** do BrowserPort first. Do **not** rebase LangGraph before userscripts.

Set-of-marks is **optional**. Do not rebuild `buildDomTree` / `highlightIndex`. Do not invent a new repo. Spec Kit is not the process. `drop/` is historical. `vendor/` is frozen. Work in `apps/extension` (and later `apps/stagehand-host`).

Do **not** implement item 3 in the current PR. Do **not** open a second PR for it from this branch. Do **not** continue, rebase, or close PR #8 (observe) or PR #4 (four-state) from this branch.

## The only plan

1. **On main** — `run_userscript` runner + fixture (#2), ChatGPT organize (#9, `89ca7cf`), and `rewrite_userscript` overlay (#10, `0544b74`). Not open.
2. **This PR** — operational keep-current loop. Leader/Navigator detects a failed chatgpt-organize run, calls `rewrite_userscript` with a repaired overlay, then `run_userscript` again.
3. **Later, not this week** — Hyperagent observe; Stagehand host after a real CDP 5-step; four-state completion; MCP/REST; LangGraph; marks/SAM.

## On main (item 1)

- #2 `run_userscript` runner + fixture. File lists keyed by `filesForMode(mode, scriptId)`.
- #6/#7 Extension CI (type-check, test, build).
- #9 `chatgpt-organize` reviewed payload. Origin lock `chatgpt.com` only. One-shot executeScript (no sticky register). Per-tab serialize. Same-origin fetch → PATCH title. Signed-out / 401 / PATCH `success:false` / total detail-fetch failure are action errors. `register.ts` was not edited in #9.
- #10 `rewrite_userscript` overlay in `chrome.storage.local`. Packaged `public/userscripts/*.user.js` stay the seed. Run injects overlay when present (`chrome.userScripts.execute({ code })` when available, otherwise executeScript func/args). Contract tokens required before persist. Leftover packaged registrations are cleared first.

## This PR (item 2)

The missing control pipeline so rewrite actually serves "several times a day":

- Classify a failed chatgpt-organize run: timeout waiting for `__nanoChatGptOrganize.done`, or contract/action error from seed drift, is **keep-current eligible**.
- Signed-out, 401, origin lock, and overlapping in-flight organize are **not** keep-current. Those stay ordinary action errors.
- Surface classification in `ActionResult` so Navigator memory sees it (`KEEP_CURRENT` on one error line; `KEEP_CURRENT_PAYLOAD` is the same overlay or seed bytes Chrome would inject).
- Navigator then calls `rewrite_userscript` with a repaired overlay (same contract tokens / same-origin fetch title PATCH semantics) and `run_userscript` once. Cap: one rewrite-then-run per script id per task.
- Origin lock stays `chatgpt.com` only. No archive. No blob/data URL inject. Prefer `chrome.userScripts.execute` when available.
- Tests inject the **same bytes** Chrome would run (overlay or seed `.user.js`). No parallel TS reimplementation of the userscript. No ChatGPT login in CI.
- `register.ts` is not edited. Stay in `apps/extension`. Do not touch Hyperagent observe, Stagehand, four-state, marks/SAM, LangGraph, or MCP/REST.

Do **not** start Hyperagent observe, Stagehand, four-state completion, MCP/REST, LangGraph, or marks in this PR. Do not add `hyperagent-observe` to the catalog.

## Later, not this week (item 3)

Do not start these from this PR:

- Hyperagent observe (PR #8 already exists elsewhere)
- Stagehand host, and only after a real CDP 5-step has been run once (connect, observe, one `act`, teardown that leaves Chrome running)
- Four-state completion (PR #4 already exists elsewhere)
- MCP / REST
- LangGraph overlay (pause/resume/cancel, side-panel events, `iteration` vs `navigationSteps`)
- Marks / SAM (measure `buildDomTree` volume; route observe through Stagehand; SAM 3 only if observe is not enough)

No host code until that CDP 5-step has been run once. Do not start with MarkMap, SQLite, or Spec Kit regeneration.

## Gates that stay

**Mocked unit tests are not enough.**

**Human gate for this PR:** logged-in `chatgpt.com` organize proof of the keep-current loop (fail → rewrite overlay → run again). Rewrite a payload on a real http(s) tab and see the overlay take effect. Characterization still holds: Navigator is required to start a task; the side panel must not say ready without Navigator (`drop/handoff/CODE_CONFIGURATION_FINDINGS.md`).

Do not block this PR on the human gate.

Automated coverage (necessary, not sufficient):

```text
pnpm -F chrome-extension test
```

Must cover keep-current eligible vs not-eligible classify, timeout/contract observation carrying the same overlay or seed bytes Chrome would run, one rewrite-then-run cap, signed-out/401 not triggering rewrite guidance, and existing rewrite/organize/fixture inject-proof. No ChatGPT login in CI.

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
