# Applying and continuing the Nano Browser modernization

## 1. Apply the supplied overlay

From the root of a clean checkout at commit `24a14b76e14a9c30fd84878ca7985049d1e7d064`:

```bash
cp -a /path/to/bundle/overlay/. .
corepack pnpm install --no-frozen-lockfile
./scripts/validate-langgraph-modernization.sh
```

Or use the included helper:

```bash
/path/to/bundle/scripts/apply-overlay.sh /path/to/nanobrowser
```

Commit the regenerated `pnpm-lock.yaml` with the source changes.

## 2. What to inspect first in code review

### Control semantics

Confirm the following are intentional:

- initial planner pass remains;
- `planningInterval` is based on navigation steps;
- `maxSteps` remains based on legacy loop iterations;
- navigator `done` is not accepted as final until planner validation;
- planner `done` sets the final answer and terminates;
- max failures are a failure, not an accidental pause;
- user stop maps to cancellation.

### Manifest V3 compatibility

Check the generated background bundle for Node-only imports. The source intentionally imports:

```ts
@langchain/langgraph/web
```

rather than depending on package condition resolution implicitly.

## 3. Provider smoke matrix

For each provider configured in Nano Browser, run one trivial planner response and one navigator action schema response. At minimum cover:

- OpenAI;
- Anthropic;
- Gemini;
- Groq;
- Cerebras;
- DeepSeek;
- xAI/Grok;
- Ollama;
- OpenRouter/custom OpenAI-compatible endpoint;
- Llama custom response adapter.

Record separately whether each model supports:

- schema-native structured output;
- function/tool calling;
- images;
- reasoning controls;
- abort signals.

That matrix becomes the seed for the capability registry described in the dependency audit.

## 4. Add durable persistence

Create `IndexedDbCheckpointSaver extends BaseCheckpointSaver` and make task ID the LangGraph `thread_id`.

Persist compact orchestration state. Keep browser runtime handles outside graph state and reconstruct them after worker restart.

A safe resume flow is:

```text
service worker starts
      ↓
load active task + checkpoint
      ↓
recreate LLM/provider objects
      ↓
reattach BrowserPort/CDP
      ↓
new observation epoch
      ↓
validate pending intent / target reference
      ↓
resume graph at safe boundary
```

## 5. Add browser-side idempotency

Before resuming browser actions, give each externally visible action an action ID and store a receipt after execution. A resumed graph can then distinguish:

- action never attempted;
- action attempted, outcome unknown;
- action completed with receipt.

For ambiguous outcomes, re-observe the page and evaluate the postcondition before repeating the action.

## 6. Replace sleeps with conditions

Move waits into `BrowserPort.waitFor()`. Browser automation should wait on explicit state changes, not sleep for an arbitrary second after every action.

## 7. Upgrade remaining internals in isolated waves

Recommended order:

```text
LangGraph + LangChain family       ← this bundle
        ↓
model capability registry
        ↓
IndexedDB checkpointing / resume
        ↓
BrowserPort + TargetRef + epochs
        ↓
condition waits / action receipts
        ↓
Zod 4 schema migration
        ↓
TypeScript / Vite / Vitest
        ↓
ESLint
        ↓
pnpm / Turbo
        ↓
React 19
        ↓
Tailwind 4
        ↓
Puppeteer / CDP upgrade
```

This ordering keeps each change testable and gives later migrations cleaner architectural boundaries.
