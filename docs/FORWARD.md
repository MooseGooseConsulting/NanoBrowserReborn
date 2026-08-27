# Forward plan

Patrick's personal LLM web harness (Leader/Follower). Not a product.

Userscripts are **reviewed payloads** the harness injects, runs, and rewrites. One job of that pipeline is to keep those scripts current and organize ChatGPT scrap chats.

This file is the **only** forward map. There is no older work order. Do **not** do BrowserPort first. Do **not** rebase LangGraph before userscripts.

Set-of-marks is **optional**. Do not rebuild `buildDomTree` / `highlightIndex`. Do not invent a new repo. Spec Kit is not the process. `drop/` is historical. `vendor/` is frozen. Work in `apps/extension` (and later `apps/stagehand-host`).

Do **not** implement items 2–4 in the current PR. Do **not** open a second PR for them from this branch.

## The only plan

1. **This PR** — `run_userscript` runner + fixture payload. Merge after review comments are clean.
2. **Next PR** — ChatGPT organize payload on that runner. Same-origin fetch. A real job. Not `click_element`.
3. **Then** — payload rewrite / keep-current, several times a day.
4. **Later, not this week** — Hyperagent observe; Stagehand host after a real CDP 5-step; four-state completion; MCP/REST; LangGraph; marks/SAM.

## This PR (item 1)

Executor action `run_userscript` registers and runs a **reviewed** fixture banner/counter. That is the working payload.

- Packaged `chrome.scripting.registerContentScripts` first (MAIN, `document_end`, `persistAcrossSessions: false`).
- Fall back to `chrome.userScripts.register` only when packaged **registration** itself fails.
- Immediate run always `chrome.scripting.executeScript`. `chrome.userScripts.execute` is unused.
- File lists are keyed by `scriptId` (`filesForMode(mode, scriptId)`). There is no module-global payload.
- Matches: current-tab origin only, portless. No `http(s)://*/*` fallback. No model `*://*/*`.
- Helper asserts the payload's allowed origin (`chatgpt-organize` → `chatgpt.com`). Not builder-only.
- `clearRegistrations` drops every reviewed id, not only the one about to run.
- BrowserContext allow/deny lists apply to the tab URL and to matches.
- If packaged register succeeds and `runOnTab` fails: unregister and throw. Same cleanup on the userScripts path.
- Navigator `script_id` is the reviewed-id enum. `chatgpt-organize` is a catalog hook (stub file) so the runner cannot ship fixture for that id. Organize/fetch body is the next PR.

Do **not** start Hyperagent, Stagehand, four-state completion, MCP/REST, LangGraph, or marks in this PR.

## Next PR (item 2)

ChatGPT organize on the same helper. Same-origin `fetch` against chatgpt.com APIs. Not `click_element`. Not a new runner.

Unproven until a **logged-in `chatgpt.com` tab**. Mocked unit tests are not that proof.

## Then (item 3)

Rewrite / keep-current the payloads as ChatGPT's DOM and APIs drift. Several times a day is the expected cadence, not a later project.

## Later, not this week (item 4)

Do not start these from this PR:

- Hyperagent observe
- Stagehand host, and only after a real CDP 5-step has been run once (connect, observe, one `act`, teardown that leaves Chrome running)
- Four-state completion
- MCP / REST
- LangGraph overlay (pause/resume/cancel, side-panel events, `iteration` vs `navigationSteps`)
- Marks / SAM (measure `buildDomTree` volume; route observe through Stagehand; SAM 3 only if observe is not enough)

No host code until that CDP 5-step has been run once. Do not start with MarkMap, SQLite, or Spec Kit regeneration.

## Gates that stay

**Mocked unit tests are not enough.**

**Human gate for this PR:** load unpacked `dist`, open a real http(s) tab, run the fixture, **see the banner on that tab**. Characterization still holds: Navigator is required to start a task; the side panel must not say ready without Navigator (`drop/handoff/CODE_CONFIGURATION_FINDINGS.md`).

**ChatGPT organize is unproven** until it has been run on a logged-in `chatgpt.com` tab. That is the next PR's gate, not this one's.

Automated coverage for the runner (necessary, not sufficient):

```text
pnpm -F chrome-extension test
```

Must cover packaged `registerContentScripts` first, `chrome.userScripts` fallback only after registration failure, origin-only matches (no model `*://*/*`, no all-sites fallback, portless patterns), MAIN world, `document_end`, and injection-safety URL blocks. No ChatGPT login in this PR. Navigator prompt must not claim ChatGPT organize/export is a registered payload.

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
