# Tasks

## Phase 1 — Configuration/setup first

- [ ] T001 Add characterization tests for provider, agent-model, and general-settings stores.
- [ ] T002 Add a test showing the current side-panel readiness mismatch with `setupExecutor()` Navigator requirements.
- [ ] T003 Implement one shared configuration-readiness function and use it in side panel and task startup.
- [ ] T004 Implement a configuration-bundle read/write service over existing settings stores.
- [ ] T005 Add configuration export.
- [ ] T006 Add configuration import with validation and clear conflicts/errors.
- [ ] T007 Add a first-run/quick-setup flow for provider → Navigator → optional Planner → validation.
- [ ] T008 Add provider/model validation before declaring setup ready.
- [ ] T009 Fix the `minimal/none` reasoning-effort mismatch.
- [ ] T010 Remove/redact provider logging that includes API keys.
- [ ] T011 Reproduce configuration loss across update/reload/reinstall/unpacked-ID scenarios and document the actual failure mode.
- [ ] T012 If development ID churn is confirmed, implement/test a stable development-ID strategy.
- [ ] T013 Add restore/update/reinstall qualification tests for the supported config workflow.
- [ ] T014 Run type-check, tests, and production build.

## Phase 2 — Existing LangGraph modernization pack

- [ ] T015 Inspect/rebase `NanoBrowser_LangGraph_Modernization_Rebuilt.zip` against current upstream.
- [ ] T016 Run clean install/type-check/tests/build and fix current API incompatibilities.
- [ ] T017 Re-check current LangGraph JS APIs and update only where required.
- [ ] T018 Re-check all upgraded provider integrations with characterization tests.

## Phase 3 — Requested Leader/Follower behavior

- [ ] T019 Add a minimal Follower control output that can continue locally or return control to Leader.
- [ ] T020 Update orchestration so Follower control can trigger handoff without waiting solely for fixed cadence.
- [ ] T021 Preserve existing deterministic controls while FR-005 wording is unresolved.
- [ ] T022 Add tests for multiple Follower actions under one Leader delegation and early Follower→Leader return.

## Phase 4 — Requested execution log

- [ ] T023 Map existing event-manager and side-panel event plumbing.
- [ ] T024 Add explicit control-handoff/progress events using the existing event system where practical.
- [ ] T025 Render those events in the side panel as a live run log.
- [ ] T026 Add a test showing a Leader→Follower→Leader run and intervening browser progress.

## Phase 5 — Set-of-marks investigation

- [ ] T027 Document the current set-of-marks/highlight generation pipeline from actual code.
- [ ] T028 Measure/fixture cases where current marks become excessive.
- [ ] T029 Implement the smallest mark-volume controls supported by observed problems.
- [ ] T030 Build an optional SAM 3 visual-mark experiment without making it default.
- [ ] T031 Compare the SAM experiment with the existing mark generator and document whether it materially helps.
- [ ] T032 Only after evidence, propose deeper mark architecture changes for approval.

## Final

- [ ] T033 Run a read-only spec/plan/task consistency pass.
- [ ] T034 Run the complete qualification suite and list remaining work without inventing new requirements.
