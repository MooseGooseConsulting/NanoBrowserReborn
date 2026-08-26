# Dependency upgrade audit

## Recommendation

Do **not** turn the LangGraph rewrite into a single all-major-dependencies migration. Upgrade coherent compatibility domains separately so a regression has a small search space.

## Wave 1 — LangChain/LangGraph compatibility domain

Apply with the LangGraph executor rewrite:

- `@langchain/core`
- `@langchain/langgraph`
- `@langchain/openai`
- `@langchain/anthropic`
- `@langchain/deepseek`
- `@langchain/google-genai`
- `@langchain/groq`
- `@langchain/ollama`
- `@langchain/xai`
- `@langchain/cerebras`

Keep Zod 3.25.x during this wave. Current LangChain/LangGraph accepts it and Nano Browser's dynamic action-schema path is tightly coupled to `zod-to-json-schema`.

### Acceptance gates

1. Every configured provider can instantiate.
2. Planner structured output parses.
3. Navigator dynamic action schema parses.
4. OpenAI-compatible custom endpoints still work.
5. Llama fallback response transformation still works.
6. Cancel propagates through model invocation.
7. Extension bundle contains no Node runtime shim introduced by LangGraph.

## Wave 2 — model capabilities instead of constructor-name inference

Current `BaseAgent` infers structured-output behavior from model names and provider class names. Replace that with an explicit provider/model capability descriptor:

```ts
interface ModelCapabilities {
  nativeStructuredOutput: boolean;
  toolCalling: boolean;
  imageInput: boolean;
  reasoningContent: boolean;
  abortSignal: boolean;
}
```

Resolution order should be:

```text
provider-native schema output
→ tool/function schema
→ constrained JSON
→ one bounded repair attempt
→ typed graph failure/recovery
```

This removes brittle checks such as special-casing `deepseek-r1`, Llama names, or `ChatGoogleGenerativeAI` constructor names.

## Wave 3 — durable LangGraph persistence for MV3

Implement a browser-native checkpoint saver backed by IndexedDB. Persist only serializable orchestration state and references to larger artifacts.

Do not serialize:

- CDP sessions;
- page objects;
- model clients;
- `AbortController`;
- event emitters.

On service-worker restart:

1. Recover task metadata and graph checkpoint.
2. Reconstruct provider/model clients.
3. Reattach the browser transport.
4. Re-observe the active target.
5. Validate that the stored target/page assumptions are still true.
6. Resume from a safe graph node rather than replaying an arbitrary browser side effect.

## Wave 4 — browser execution boundary

Introduce a `BrowserPort` abstraction before changing Puppeteer/CDP internals:

```ts
interface BrowserPort {
  observe(request: ObserveRequest): Promise<Observation>;
  execute(action: BrowserAction): Promise<ActionReceipt>;
  waitFor(condition: BrowserCondition): Promise<void>;
  reconnect(): Promise<void>;
  release(): Promise<void>;
}
```

Then move existing browser code behind it.

### Replace fragile element identities

A highlight index is an observation-local coordinate, not a durable identity. Introduce a `TargetRef` containing multiple hints:

- observation epoch;
- frame identity/path;
- semantic role/name;
- stable attributes/test IDs;
- DOM/path hint;
- nearby text;
- geometry as a last-resort hint.

Resolve immediately before action execution and reject ambiguous matches.

### Replace fixed sleeps

The navigator currently contains fixed waits after actions. Replace them with bounded condition waits, such as:

- navigation committed;
- DOM epoch changed;
- requested element disappeared/appeared;
- URL changed;
- network became quiet enough;
- target reached an expected state.

## Wave 5 — Zod 4

Upgrade Zod only after the provider migration stabilizes. Required tests:

- snapshots of generated Navigator JSON Schema;
- nested `additionalProperties` behavior;
- optional/nullable semantics;
- array/object unions;
- every provider's structured-output acceptance;
- Cerebras strict schemas in particular.

The current Cerebras API v2 is stricter about structured-output schemas, including `additionalProperties: false` for nested strict objects, so schema generation deserves its own migration.

## Wave 6 — frontend/build tooling

Upgrade as independent PRs:

1. TypeScript + Vite + Vitest.
2. ESLint flat configuration.
3. pnpm + Turbo.
4. React 19.
5. Tailwind 4.

React should not be upgraded simultaneously with MV3 port lifecycle changes; otherwise listener lifecycle regressions are difficult to attribute.

## Wave 7 — Puppeteer/CDP

Only after `BrowserPort` exists:

- upgrade Puppeteer/CDP types;
- add disconnect/reconnect tests;
- test target replacement after navigation;
- test iframe churn;
- test extension/service-worker restart;
- test pages with aggressive hydration and DOM replacement.
