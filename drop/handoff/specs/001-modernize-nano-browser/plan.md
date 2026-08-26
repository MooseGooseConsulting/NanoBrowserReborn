# Implementation plan

This is a proposed engineering plan, not a list of user requirements.

## Phase 1 — Fix the configuration/setup that is actually broken

Do this before inventing a desktop architecture.

1. Write characterization tests around provider storage, Planner/Navigator storage, general settings, side-panel setup gate, and `setupExecutor()` requirements.
2. Create one configuration-bundle service over the existing stores. Do not replace all storage first.
3. Add import/export/restore of that configuration with validation.
4. Replace the current setup gate with one readiness function shared by side panel and task startup. Navigator is mandatory in current code; Planner is optional if fallback remains.
5. Add a guided quick-setup path: provider → credentials/endpoint → Navigator → optional Planner → validate → save.
6. Add provider/model validation so “saved” and “working” are not conflated.
7. Fix the `minimal/none` mismatch and API-key logging.
8. Reproduce the actual configuration-loss workflow. If unpacked extension-ID churn is involved, stabilize development identity; do not assume it.

## Phase 2 — Validate and finish the LangGraph/provider modernization

Use `NanoBrowser_LangGraph_Modernization_Rebuilt.zip`.

- apply/rebase against current upstream;
- install dependencies;
- type-check;
- run tests/build;
- update to current LangGraph APIs as necessary;
- preserve existing Leader/Follower behavior.

## Phase 3 — Add requested dynamic handoff

Extend Follower output with the smallest control signal needed to keep going locally or pass control back.

Preserve existing deterministic controls until “deterministic scaling” is semantically resolved.

## Phase 4 — Add requested run log

Build on Nano's existing event manager/side-panel message flow. Show which role is acting, browser progress, and control handoff. Exact event schema/persistence is implementation detail.

## Phase 5 — Set-of-marks investigation

Document the existing generation pipeline from `buildDomTree.js`, DOM service, highlights and selector map.

Then solve observed problems only:

- mark volume/manageability;
- optional second visual generation experiment.

Benchmark SAM 3 as the user-suggested candidate. Other visual parsers may be research comparators, not requirements.

## Candidate — thin extension + desktop driver

Evaluate after Phase 1. It may still be useful for the larger runtime, secrets, external browser transport, or optional local vision, but it is not required merely to make setup sane.
