# ADR-002 — "Deterministic scaling" means planning cadence (`planningInterval`)

- **Status:** accepted
- **Date:** 2026-09-03
- **Context:** Spec FR-005 / OQ-001 left "must retain the ability for deterministic scaling" deliberately unresolved; code has three knobs (`maxSteps`, `planningInterval`, `maxActionsPerStep`).
- **Decision:** The phrase names `planningInterval` — the Leader re-plans every N Navigator turns. `maxSteps` remains as a safety valve, not the normal handoff. `maxActionsPerStep` is currently prompt-hint-only and must be explicitly enforced-or-removed (see restore list).
- **Consequence:** Follower-initiated return (`CONTINUE / SUBGOAL_COMPLETE / RETURN_TO_LEADER / BLOCKED`) becomes the primary router; fixed cadence is the backstop, never the only handoff.
