# Architecture

Nano Reborn is Patrick's personal LLM web harness. Not a product.

This file describes **what the system is**. `FORWARD.md` describes **what to build next** and is
subordinate to this file. Where the two disagree, this file wins and `FORWARD.md` gets corrected.

## 1. The system in one sentence

An asymmetric two-model browser agent — a strong Leader that plans and delegates, a fast Follower
that executes many browser actions per delegation — driving the user's real, already-authenticated
Chrome, and optionally taking its objectives from an external supervisor rather than from the side
panel.

## 2. Layers

```text
  (optional) CONDUCTOR ..... owns the task. External. Not this repo's runtime.
        │                    Enters as an external Leader via FLOW-005.
        ▼
     NANO RUNTIME .......... Leader/Follower loop, plan, durable run state.
        │                    LangGraph as a low-level StateGraph.
        ▼
     BROWSER PORT .......... observe / execute / waitFor / reconnect.
        │                    The only seam the runtime may depend on.
        ▼
   EXTENSION ACTUATOR ...... side panel, tab authorization, observation,
        │                    set-of-marks overlay, userScripts bridge.
        ▼
     SITE ADAPTERS ......... versioned per-site capability.
                             Userscript payloads are how adapters are delivered.
```

### Conductor (external, optional)

Owns the root objective, the approved plan, completion criteria, child tasks, and the cost ledger.
A worker finishing a turn is **not** evidence the task is done — the Conductor decides completion.
Deterministic code decides *when* to inspect; a monitor model decides *whether* correction is needed,
because "this investigation has quietly become the project" is not detectable from tool telemetry.

Nano does not implement the Conductor. Nano exposes the seam it plugs into (`FLOW-005`): whole-task
delegation, subgoal delegation, direct browser-action mode, and a raw CDP escape hatch.

The Hyperagent case is the worked example, recorded in **issue #1**: an external agent reaches a local
control MCP, which routes through a capability router to either the official API or a local
browser-control daemon that solely owns the credential and the authenticated session. Capability is
**discovered at runtime, never hard-coded** — documented tool counts have already disagreed with live
ones.

### Nano runtime

Leader is stronger/slower: receives objective, durable progress, compact evidence, prior handoff
reason; produces a plan; delegates exactly one subgoal plus acceptance criteria.

Follower is smaller/faster: receives the delegated subgoal, the current observation, and available
actions; executes many low-level actions; and **emits a typed control signal** (`CONTINUE`,
`SUBGOAL_COMPLETE`, `RETURN_TO_LEADER`, `BLOCKED`, …) that is the primary router input. Handoff is
never inferred from a fixed turn counter alone. Deterministic limits remain as safety valves, not as
the normal cadence.

Run state is four-state (`running | queued | waiting | error`) and is durable. Live browser handles,
DOM nodes, CDP sessions, and mark maps are **never** durable state.

### Browser port

The runtime depends on a narrow interface, not on extension internals: `observe`, `execute`,
`waitFor`, `reconnect`. Stagehand v4 over CDP is the intended implementation, and it must run in a
Node host — **never inside the MV3 service worker**, which cannot hold a CDP connection.

### Extension actuator

Browser-local responsibilities only: side-panel UI, current-tab authorization, page observation,
set-of-marks overlay, content/page-world integration, site-adapter execution, the
`chrome.userScripts` bridge, and the connection to the host.

Injection safety is non-negotiable: `chrome://`, `chrome-extension://`, `javascript:`, and `data:`
are blocked; registration is current-origin only; payload origin is asserted per script id.

### Site adapters

Versioned, per-site capability: semantic observations, deterministic commands, authenticated
page-side fetches, health checks, repair, extraction provenance.

**Userscript payloads are the delivery mechanism for adapters, not the top-level abstraction.**
Reviewed payloads are packaged as seeds and may be superseded by a `chrome.storage.local` overlay;
`rewrite_userscript` persists an overlay, `run_userscript` executes, and rewriting never executes.

## 3. Set-of-marks

Marks are a core interaction surface, generated **DOM/accessibility-first**. That is the fast path.

A label like `[17]` is presentation, not identity. Every observation opens a new **epoch**; an action
referencing a stale epoch is rejected and forces re-observation. Marks are budgeted and decluttered
rather than applied to every node.

Visual segmentation (SAM-family) is an **optional augmentation** for canvases, custom-rendered
controls, and unlabeled icons — never a requirement for ordinary DOM pages, and never the sole
authority on what is clickable.

## 4. Configuration and secrets

The extension is **not** the canonical store for providers, API keys, or model parameters. Canonical
configuration is a single portable, versioned document owned outside the extension, selected by named
profile, surviving extension upgrades and reinstalls. Secrets stay in the desktop environment and are
referenced (OS keychain, environment, Doppler), never mirrored into extension storage.

This is why an in-extension bearer-token UI was rejected in PR #12.

## 5. Observability

Every meaningful state transition emits a structured event, and control transfer is visible in the
user-facing timeline. The log records explicit decisions, evidence, and reason codes — not private
chain-of-thought. Mutating actions carry receipts sufficient to reconcile after a crash so an
irreversible action is not repeated.

## 6. Document precedence

| Document | Role |
| --- | --- |
| `docs/ARCHITECTURE.md` | Target state. This file. |
| `docs/FORWARD.md` | Current work order. Subordinate; must not contradict this file. |
| GitHub issue #1 | ADR for the external control plane. Normative for that surface. |
| `drop/handoff/specs/001-*/spec.md` | User-intent floor: FR-001…010 are what the user actually asked for. |
| `drop/**` (rest) | Historical. Useful as reference, not authority. |
| `vendor/**` | Frozen upstream image. Never edited. |

### On the `drop/` spec's "not requirements" list

That list is a provenance audit, not a prohibition — it separates user-requested outcomes from
assistant-invented ones, and states the excluded items "may still be a useful implementation idea…
until explicitly approved."

**They are approved here.** BrowserPort, the desktop driver, durable checkpoints, event schemas,
action receipts, epoch/stale-mark rejection, and a persisted trace are adopted as architecture by
this document. FR-001…010 remain the user-intent floor underneath them.

## 7. Status

Built and on `main`: the reviewed-payload runner with origin gating and the seed/overlay contract;
`chatgpt-organize`; the keep-current rewrite-then-run loop (capped at one retry); `hyperagent-observe`
(read-only GET + SSE); the four-state run model; CI (type-check, test, build).

Not built: the Conductor, the control MCP, the capability router, the browser-control daemon, the
Stagehand host (`apps/stagehand-host` is a README), durable checkpointing, the persisted trace, the
event timeline UI, canonical external configuration, and site adapters as a first-class layer.

Unproven regardless of CI: `chatgpt-organize` has never run against a logged-in `chatgpt.com`, and
`hyperagent-observe` has never run against a logged-in Hyperagent. Mocked tests prove only the
exercised contracts.

## 8. Known ordering error

The shipped work built the actuator and its payloads first — the leaf of the stack — ahead of the
control plane, the port, and durable state. The payloads are real and useful, but they were not the
right first move, and their value stays capped until the layers above them exist.

Corrected order:

1. **Qualify what exists.** The two logged-in runs. Cheap, and they gate everything downstream.
2. **Capability smoke.** Enumerate the real MCP surface and the authenticated UI before designing
   against either. Issue #1's gate; never completed.
3. **Control plane and port.** Typed handoff, durable run state, `BrowserPort` behind the CDP
   five-step (connect, observe, one act, teardown leaving Chrome running).
4. **Marks.** DOM/AX-first generation, epochs, budget.
5. **Host.** Move runtime, configuration, secrets, and trace out of the extension.
6. **Adapters.** Recast the shipped payloads as adapter delivery.
7. **Optional vision.** Only if observation proves insufficient.

## 9. Open questions

- **"Deterministic scaling"** (FR-005, OQ-001) is still unresolved. Existing deterministic knobs are
  preserved until the phrase is identified in code. Do not invent its semantics.
- Whether the Conductor is built in this repo or consumes it from outside. Issue #1 says this repo
  owns "only the local control tooling," which implies outside.
