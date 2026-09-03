# ADR-001 — Configuration home: portable file + secret refs, extension holds zero secrets

- **Status:** accepted
- **Date:** 2026-09-03
- **Context:** Provider/model config is fragmented across `chrome.storage.local` stores (`llm-api-keys`, `agent-models`, `general-settings`), wiped on extension remove, with no export path; side-panel readiness disagrees with `setupExecutor()` (see `drop/handoff/CODE_CONFIGURATION_FINDINGS.md`).
- **Decision:** Canonical config is a single portable versioned document outside the extension with named profiles; secrets live in the desktop environment only — Doppler now, OpenBao later, OS keychain as long-term best. The extension holds zero secrets and never sees keys.
- **Consequence:** Closes the PR #12 bearer-token-UI pattern permanently; requires a config-bundle service + guided setup + connection validation before "ready" is ever claimed.
