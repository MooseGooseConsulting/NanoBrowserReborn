# Feature Specification: Nano Browser modernization

**Created:** 2026-08-26  
**Status:** Draft

This specification intentionally contains only user-requested outcomes. It does not prescribe architecture.

## User Story 1 — Configuration and setup should stop being a pain

As a Nano Browser user, I want the model/provider setup to be much easier to configure and save, so I do not have to repeatedly reconstruct a complicated configuration manually.

### Acceptance intent

- I can configure the models/providers Nano needs without manually navigating a sprawling sequence of unrelated setup steps.
- I can save the resulting working configuration in a reusable form.
- I can restore/reuse that configuration instead of rebuilding it field by field.
- The setup experience tells me whether Nano is actually ready to run.

These statements define the desired user experience. They do **not** require a desktop driver, CLI, storage engine, or particular UI.

## User Story 2 — Preserve the Nano Leader/Follower workflow while modernizing it

As a Nano Browser user, I want the existing stronger-planner / fast-navigation-model workflow preserved while its obsolete runtime is modernized.

The fast inner/Follower model should be able to keep taking browser actions and should be able to tell the outer/Leader model when control should pass back, rather than the handoff being determined only by a fixed number of turns.

The user has also stated that the system **must retain the ability for deterministic scaling**. The exact meaning of that phrase is intentionally not inferred here; see `OPEN_QUESTIONS.md`.

## User Story 3 — Show me the run as control moves between models

As a Nano Browser user, I want a log of the execution as it moves along, including when control moves between the Leader and Follower, so I can understand the run.

No event schema, persistence engine, private-reasoning policy, or timeline-component design is specified by this user story.

## User Story 4 — Keep set-of-marks useful and explore an optional second generator

As a Nano Browser user, I want Nano's existing set-of-marks interaction model retained.

The user has said the marks can get out of hand and wants the implementation to reason about how marks are generated.

The user also proposed **optionally** stacking SAM 3 on top as a second mark generator. That is an experiment/candidate, not a requirement that SAM ship.

## Technical modernization request

The user explicitly asked for the obsolete LangGraph/LangChain-era internals to be modernized and asked for the rewrite to use current LangGraph.

This is a technical direction for the implementation plan, not a user story.

## Requirements

- **FR-001**: Make Nano's provider/model configuration materially easier to set up than the current manual options-page workflow.
- **FR-002**: Provide a way to save and reuse/restore a working Nano configuration rather than reconstructing it field by field.
- **FR-003**: Preserve Nano's stronger Leader/Planner and fast inner Follower/Navigator workflow while modernizing the implementation.
- **FR-004**: Allow the Follower to indicate that control should return to the Leader; fixed-turn cadence must not be the only handoff mechanism.
- **FR-005**: Retain the ability for **deterministic scaling** as explicitly stated by the user; do not invent its semantics before clarifying what existing behavior that phrase refers to.
- **FR-006**: Provide a user-visible log of the run that makes Leader/Follower control movement and execution progress understandable.
- **FR-007**: Preserve Nano's set-of-marks interaction model.
- **FR-008**: Address the user's concern that set-of-marks can become excessive/unmanageable when designing mark generation.
- **FR-009**: Evaluate an optional second visual mark-generation path, with SAM 3 specifically suggested by the user as a candidate; do not treat SAM as mandatory without evaluation/approval.
- **FR-010**: Modernize the obsolete LangGraph/LangChain integration using current LangGraph patterns and current compatible provider internals.

## Things that are explicitly not requirements in this spec

The following appeared in earlier assistant-generated documents but were not requested as product requirements:

- “private chain-of-thought” behavior;
- stale-mark/epoch rejection semantics;
- a “MarkMap” abstraction;
- OmniParser;
- partial-export completeness semantics;
- side-panel prohibition on model configuration;
- `nano doctor`;
- Native Messaging;
- SQLite;
- a desktop driver as a mandatory architecture;
- a `BrowserPort` abstraction;
- action receipts;
- exact event schemas;
- exact mark budgets/ranking algorithms;
- a Deep Agent / not-Deep-Agent invariant.

Any of those may still be a useful implementation idea, defect fix, or experiment. They belong in research/plan until explicitly approved.
