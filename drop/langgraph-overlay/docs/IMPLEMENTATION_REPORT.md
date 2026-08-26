# Nano Browser LangGraph modernization — implementation report

## Baseline

This overlay targets upstream Nano Browser commit:

`24a14b76e14a9c30fd84878ca7985049d1e7d064`

The baseline executor is a hand-written `for` loop that periodically runs a planner and otherwise runs the navigator. The modernization keeps the external `Executor` API and side-panel event contract while moving control flow into LangGraph.

## Implemented runtime rewrite

The executor is now driven by a typed LangGraph state machine:

```text
START
  ↓
guard ──terminal──────────────→ END
  │
  ├── planning due ─→ planner ──done→ END
  │                    │
  │                    └──────────→ navigator
  │                                  │
  └──────────────────────────────────┘
                         navigator → guard
```

Graph state is deliberately compact:

- `iteration`: legacy max-step loop count.
- `navigationSteps`: the existing `AgentContext.nSteps`, used for planning cadence.
- `latestPlanOutput`: latest planner result.
- `navigatorDone`: navigator completion signal requiring planner validation.
- `terminalReason`: `completed`, `max_steps`, `max_failures`, or `stopped`.

The distinction between `iteration` and `navigationSteps` matters: Nano Browser historically used one counter for the `maxSteps` loop and another for planner cadence. Collapsing them changes behavior under planner/navigation failures.

## Preserved behavior

The rewrite intentionally retains:

- `Executor` as the background-service entry point.
- Existing `PlannerAgent` and `NavigatorAgent` implementations.
- Existing planner and navigator model configuration.
- Follow-up tasks and shared message history.
- Pause, resume and cancel.
- Existing event emission consumed by the side panel.
- Analytics callbacks.
- Browser context ownership and cleanup.
- Replay-history storage and replay execution.

## LangGraph/browser choice

The graph imports from `@langchain/langgraph/web` explicitly. Nano Browser runs inside a Manifest V3 Chrome service worker; the browser entrypoint avoids accidentally depending on Node-only async-local-storage initialization.

This first rewrite does **not** use `MemorySaver`. In-memory checkpoints do not solve the principal MV3 failure mode because service-worker suspension destroys the process. Durable checkpoints belong in the next persistence wave and should use IndexedDB / extension storage with a browser-native `BaseCheckpointSaver` implementation.

## Tests supplied

`execution-graph.test.ts` tests the routing semantics without invoking a model or browser:

- planner runs at task start;
- navigator runs between planning intervals;
- planner runs at configured intervals;
- navigator completion causes immediate planner validation;
- every terminal reason reaches `END`;
- planner completion reaches `END`;
- recursion headroom scales with `maxSteps`.

## Dependency modernization in this wave

The old LangChain 0.x package family is upgraded as a unit rather than mixing a current LangGraph runtime with old provider integrations:

| Package | Baseline | Modernized pin |
|---|---:|---:|
| `@langchain/core` | 0.3.79 | 1.2.9 |
| `@langchain/langgraph` | absent | 1.4.12 |
| `@langchain/openai` | 0.6.16 | 1.5.10 |
| `@langchain/anthropic` | 0.3.33 | 1.5.8 |
| `@langchain/deepseek` | 0.1.0 | 1.1.10 |
| `@langchain/google-genai` | 0.2.18 | 2.3.0 |
| `@langchain/groq` | 0.2.4 | 1.3.1 |
| `@langchain/ollama` | 0.2.4 | 1.3.0 |
| `@langchain/xai` | ^0.1.0 | 1.4.10 |
| `@langchain/cerebras` | 0.0.4 | 1.0.4 |

Node 22.12.0 from Nano Browser's `.nvmrc` satisfies the current OpenAI integration's Node 22 requirement.

## Important reconstruction note

This archive is a reconstruction of the modernization bundle from the retained implementation and research context after the original transient sandbox file expired. The runtime design and overlay are reproduced; the original byte-for-byte ZIP and its generated lockfile/build logs were not retained. Regenerate `pnpm-lock.yaml` after applying the overlay and run the supplied validation script.
