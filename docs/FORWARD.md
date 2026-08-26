# Forward plan

Work in `apps/extension` and `apps/stagehand-host`. `vendor/` is frozen. Spec Kit is not the process. `drop/` is historical.

Context7 checked: Stagehand v4 (`/browserbase/stagehand`) — CDP `localBrowser.connect`, `act` / `observe` / `extract` on the Stagehand instance.

## Test gates (run these; do not claim from reading)

### Extension

From `apps/extension` after `corepack pnpm install`:

```text
pnpm type-check
pnpm build
```

Load `dist` unpacked. Confirm side panel opens. Characterization: Navigator is required to start a task; side panel must not say ready without Navigator (`drop/handoff/CODE_CONFIGURATION_FINDINGS.md`).

Existing overlay tests (after rebase, not before):

```text
drop/langgraph-overlay/overlay/chrome-extension/src/background/agent/__tests__/execution-graph.test.ts
```

### Userscript runner

```text
node drop/chatgpt-exporter-test/nanobrowser-poc/unit_service_worker.mjs
```

Must cover `chrome.userScripts` and packaged `registerContentScripts`.

### Stagehand host (when it exists)

1. Launch Chrome with `--remote-debugging-port=9222` on a profile you control.
2. Host connects with `localBrowser.connect({ cdpUrl })` then `Stagehand.create({ browser })`.
3. `observe` one instruction on the active page.
4. `act` one single-step click (or click `actions[0].selector` if observe returns locators).
5. Teardown must leave Chrome running.

No host code ships until those five steps have been run once.

## Work order

1. Build/load the cloned extension. Reproduce the readiness mismatch.
2. Implement `BrowserPort` in the host; adapter in the extension. Qualify against a real CDP URL.
3. Rebase `drop/langgraph-overlay` onto `apps/extension` Executor. Keep pause/resume/cancel and side-panel events. Keep `iteration` vs `navigationSteps` separate.
4. Follower return-to-Leader control signal; live log of role changes.
5. Userscript invocation as an agent action (POC already proves both registration paths).
6. Marks: measure `buildDomTree` volume; route observe through Stagehand; SAM 3 only if observe is not enough.
7. Config save/restore/validate on existing stores (`llm-api-keys`, `agent-models`, `general-settings`).

Do not start with MarkMap, SQLite, or Spec Kit regeneration.

## Preserve

- Leader/Follower UX and Executor entrypoint
- Follow-ups, history, replay, pause/resume/cancel
- Set-of-marks interaction model
- Dual counters (`maxSteps` vs planning cadence)
- Existing deterministic knobs until "deterministic scaling" is identified in code
- Injection-safety URL blocks (`chrome://`, `chrome-extension://`, `javascript:`, `data:`)
- Apache-2.0 notices
