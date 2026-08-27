# Forward plan

Patrick's personal LLM web harness (Leader/Follower). Not a product.

Userscripts are **reviewed payloads** the harness injects, runs, and rewrites. One job of that pipeline is to keep those scripts current and organize ChatGPT scrap chats.

This file is the **only** forward map. There is no older work order. Do **not** do BrowserPort first. Do **not** rebase LangGraph before userscripts.

Set-of-marks is **optional**. Do not rebuild `buildDomTree` / `highlightIndex`. Do not invent a new repo. Spec Kit is not the process. `drop/` is historical. `vendor/` is frozen. Work in `apps/extension` (and later `apps/stagehand-host`).

Do **not** implement items 3–4 in the current PR. Do **not** open a second PR for them from this branch.

## The only plan

1. **Previous PR** — `run_userscript` runner + fixture payload (`cursor/userscript-executor-action-5596`). Still open; this branch rebases onto it. Do not merge it from here.
2. **This PR** — ChatGPT organize payload on that runner. Same-origin fetch. A real job. Not `click_element`.
3. **Then** — payload rewrite / keep-current, several times a day.
4. **Later, not this week** — Hyperagent observe; Stagehand host after a real CDP 5-step; four-state completion; MCP/REST; LangGraph; marks/SAM.

## This PR (item 2)

Reviewed payload `chatgpt-organize` **organizes** scrap ChatGPT chats via same-origin `fetch` (session cookie → `/api/auth/session` → conversation JSON → PATCH title). Not a catalog-id stub. Not `click_element`. Not a new runner.

- Origin lock: `chatgpt.com` and `chat.openai.com` (no www hosts). Encoded in `REVIEWED_USERSCRIPT_HOSTS` (catalog) so `register.ts` stays untouched.
- File lists stay keyed by `scriptId` (`filesForMode(mode, scriptId)` from PR #2). There is no module-global payload selector.
- One-shot: builder sets `__nanoOrganizeRun` in MAIN, injects, **waits for `__nanoChatGptOrganize.done`**, then unregisters organize ids. Sticky content-script reruns skip. Signed-out / 401 is an **action error**.
- Title only. Never archive on missing JSON, empty preview, or short chats (`titleFromPreview` requires 8+ characters).
- Fixture remains inject-proof.
- BrowserContext allow/deny lists still apply. Matches stay origin-only.

Do **not** start rewrite/keep-current, Hyperagent, Stagehand, four-state completion, MCP/REST, LangGraph, or marks in this PR.

## Next PR (item 3)

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

**Human gate for this PR:** run `chatgpt-organize` on a **logged-in `chatgpt.com` tab** and see titles change (or a signed-out action error). Characterization still holds: Navigator is required to start a task; the side panel must not say ready without Navigator (`drop/handoff/CODE_CONFIGURATION_FINDINGS.md`).

**ChatGPT organize is unproven** until that logged-in tab run. Mocked fetch in vitest is necessary, not sufficient. No ChatGPT login in CI.

Automated coverage (necessary, not sufficient):

```text
pnpm -F chrome-extension test
```

Must cover catalog id + origin gate, injected `.user.js` mocked fetch (Bearer / device / account / title PATCH / no archive), and wait-for-done / signed-out action error. Fixture inject-proof stays.

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
