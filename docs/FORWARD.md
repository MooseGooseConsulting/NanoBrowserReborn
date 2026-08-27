# Forward plan

Patrick's personal LLM web harness (Leader/Follower). Not a product.

Userscripts are **reviewed payloads** the harness injects, runs, and rewrites. One job of that pipeline is to keep those scripts current and organize ChatGPT scrap chats.

This file is the **only** forward map. There is no older work order. Do **not** do BrowserPort first. Do **not** rebase LangGraph before userscripts.

Set-of-marks is **optional**. Do not rebuild `buildDomTree` / `highlightIndex`. Do not invent a new repo. Spec Kit is not the process. `drop/` is historical. `vendor/` is frozen. Work in `apps/extension` (and later `apps/stagehand-host`).

Do **not** implement item 3 in the current PR. Do **not** open a second PR for it from this branch. Do **not** continue, rebase, or close PR #8 (observe) or PR #4 (four-state) from this branch.

## The only plan

1. **On main** — `run_userscript` runner + fixture payload (#2) and ChatGPT organize payload (#9). Squash-merged as `89ca7cf`. Not open.
2. **This PR** — payload rewrite / keep-current. Overlays in `chrome.storage.local` so reviewed payloads can be updated without a rebuild.
3. **Later, not this week** — Hyperagent observe; Stagehand host after a real CDP 5-step; four-state completion; MCP/REST; LangGraph; marks/SAM.

## On main (item 1)

- #2 `run_userscript` runner + fixture. File lists keyed by `filesForMode(mode, scriptId)`.
- #6/#7 Extension CI (type-check, test, build).
- #9 `chatgpt-organize` reviewed payload. Origin lock `chatgpt.com` only. One-shot executeScript (no sticky register). Per-tab serialize. Same-origin fetch → PATCH title. Signed-out / 401 / PATCH `success:false` / total detail-fetch failure are action errors. `register.ts` was not edited in #9.

## This PR (item 2)

`rewrite_userscript` stores a rewritten overlay keyed by reviewed script id. Chrome cannot write packaged `public/userscripts/*.user.js` files; those stay the reviewed seed. `run_userscript` injects the overlay via `chrome.scripting.executeScript` (`world: MAIN`, func/args — never a page URL) when present, otherwise the packaged seed.

- Known reviewed ids only (`fixture`, `chatgpt-organize`). Unknown ids fail closed.
- Source must be non-empty, look like a userscript IIFE, and include the payload identity hook the runner already waits on. Reject `chrome://`, `chrome-extension://`, `javascript:`, `data:` tricks. Size-cap the source.
- Persist `{ scriptId, source, rewrittenAt, sourceHash }`. Return a short ACT_OK with id + hash. Do **not** execute the new source as part of rewrite.
- `reset: true` deletes the overlay and falls back to the seed.
- Overlay `scriptId` must match the selected id (fixture overlay cannot run as chatgpt-organize).
- Organize overlay runs still origin-lock `chatgpt.com`, serialize per tab, and wait for `__nanoChatGptOrganize.done`.
- Tests inject the **same bytes Chrome would run**: overlay source when set; otherwise `chatgpt-organize.user.js` under `public/userscripts/`. No parallel TS reimplementation. No live ChatGPT. No login in CI.
- `register.ts` is not edited. Navigator prompt / `run_userscript` schema mention overlay vs seed honestly. Rewrite is not `registerContentScripts`.

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

**Human gate for this PR:** rewrite a payload, run it on a real http(s) tab, see the overlay take effect. **chatgpt-organize still needs a logged-in `chatgpt.com` tab** to be proven. Characterization still holds: Navigator is required to start a task; the side panel must not say ready without Navigator (`drop/handoff/CODE_CONFIGURATION_FINDINGS.md`).

Do not block this PR on the human gate.

Automated coverage (necessary, not sufficient):

```text
pnpm -F chrome-extension test
```

Must cover rewrite accept/reject/reset, overlay inject vs seed, organize origin lock / wait-for-done / signed-out with seed and overlay, and id-mismatch fail-closed. Fixture inject-proof stays. No ChatGPT login in CI.

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
