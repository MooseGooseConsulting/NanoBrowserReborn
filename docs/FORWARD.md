# Forward plan

Patrick's personal LLM web harness (Leader/Follower). Not a product.

Userscripts are **payloads** the harness injects, runs, and rewrites. One job of that pipeline is to keep those scripts current and organize ChatGPT scrap chats.

Set-of-marks is **optional**. Do not rebuild `buildDomTree` / `highlightIndex`. Do not start the Stagehand host in the userscript slice. Do not apply the LangGraph overlay. Do not invent a new repo. Spec Kit is not the process. `drop/` is historical.

Work in `apps/extension` (and later `apps/stagehand-host`). `vendor/` is frozen.

## This slice: harden the userscript registration helper

Executor action `run_userscript` already registers and runs a **reviewed** fixture payload. This slice hardens that helper:

- Registration matches are the current tab origin only (no ports, no `http(s)://*/*` fallback, no model `*://*/*`).
- Fall back to `chrome.userScripts` only when packaged **registration** fails. If `runOnTab` fails after a successful packaged register, unregister and throw.
- Immediate run always uses `chrome.scripting.executeScript`. `chrome.userScripts.execute` (Chrome 135+) is unused.
- Require a real injectable http(s) tab URL before any persistent registration.
- Pass existing BrowserContext allow/deny lists into the helper. Marks stay off.

Fixture banner/counter remains the only payload. Do **not** implement ChatGPT export/scrape in this slice.

## Next slice

ChatGPT organize payload on the same registration helper, using **same-origin fetch**, not `click_element`.

## Later (not this slice)

- Stagehand host (`BrowserPort` / CDP). No host code until the five-step gate below has been run once.
- LangGraph overlay rebase onto Executor (pause/resume/cancel, side-panel events, `iteration` vs `navigationSteps`).
- Marks: measure `buildDomTree` volume; route observe through Stagehand; SAM 3 only if observe is not enough.
- Config save/restore/validate on existing stores (`llm-api-keys`, `agent-models`, `general-settings`).

Do not start with MarkMap, SQLite, or Spec Kit regeneration.

## Test gates (run these; do not claim from reading)

### Extension

From `apps/extension` after `corepack pnpm install`:

```text
pnpm type-check
pnpm build
pnpm -F chrome-extension test
```

Load `dist` unpacked. Confirm side panel opens. Characterization: Navigator is required to start a task; side panel must not say ready without Navigator (`drop/handoff/CODE_CONFIGURATION_FINDINGS.md`).

### Userscript runner

```text
pnpm -F chrome-extension test
```

Must cover packaged `registerContentScripts` first, `chrome.userScripts` fallback only after registration failure, origin-only matches (no model `*://*/*`, no all-sites fallback, portless patterns), MAIN world, `document_end`, and injection-safety URL blocks. No ChatGPT login. Navigator prompt must not claim ChatGPT organize/export is a registered payload.

POC under `drop/chatgpt-exporter-test/nanobrowser-poc` remains historical proof (`node unit_service_worker.mjs`). The live helper is a TypeScript port in `apps/extension` because the extension module graph does not import `drop/`.

Existing overlay tests (after rebase, not before):

```text
drop/langgraph-overlay/overlay/chrome-extension/src/background/agent/__tests__/execution-graph.test.ts
```

### Stagehand host (when it exists)

1. Launch Chrome with `--remote-debugging-port=9222` on a profile you control.
2. Host connects with `localBrowser.connect({ cdpUrl })` then `Stagehand.create({ browser })`.
3. `observe` one instruction on the active page.
4. `act` one single-step click (or click `actions[0].selector` if observe returns locators).
5. Teardown must leave Chrome running.

No host code ships until those five steps have been run once.

## Preserve

- Leader/Follower UX and Executor entrypoint
- Follow-ups, history, replay, pause/resume/cancel
- Dual counters (`maxSteps` vs planning cadence)
- Existing deterministic knobs until "deterministic scaling" is identified in code
- Injection-safety URL blocks (`chrome://`, `chrome-extension://`, `javascript:`, `data:`)
- Apache-2.0 notices

Marks are optional; do not treat the set-of-marks interaction model as a required preserve for the userscript lane.
