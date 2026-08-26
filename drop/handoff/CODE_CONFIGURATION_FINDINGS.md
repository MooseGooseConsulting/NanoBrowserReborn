# What is actually wrong with Nano's configuration/setup

This is based on the source at commit `24a14b76e14a9c30fd84878ca7985049d1e7d064`.

## The important finding

Nano **already persists configuration**. The core problem is not “there is no persistence.”

The problem is that the configuration is fragmented across multiple independent Chrome-local stores and the options UI makes the user assemble a valid runtime configuration manually.

### Provider configuration

`packages/storage/lib/settings/llmProviders.ts` stores provider configurations under `llm-api-keys` using `StorageEnum.Local`.

A provider record includes API key, base URL, model names/deployments, provider type, etc.

### Planner/Navigator selection

`packages/storage/lib/settings/agentModels.ts` stores agent/model selections separately under `agent-models`, also using `StorageEnum.Local`.

The user therefore first configures providers/models and separately maps models to Planner and Navigator.

### General runtime settings

`packages/storage/lib/settings/generalSettings.ts` stores `general-settings`, also in `StorageEnum.Local`.

Current fields include:

- `maxSteps`
- `maxActionsPerStep`
- `maxFailures`
- `useVision`
- `useVisionForPlanner`
- `planningInterval`
- `displayHighlights`
- `minWaitPageLoad`
- `replayHistoricalTasks`

### More settings exist in additional stores

The repository also has separate storage modules for firewall, speech-to-text, analytics, chat/history/favorites.

There is no single configuration object or first-class import/export path tying the relevant settings together.

## The options UI is doing far too much manually

`pages/options/src/components/ModelSettings.tsx` is about 74 KB at the inspected commit.

It independently manages provider creation, provider-specific fields, API keys, base URLs, model-name lists, Azure deployments, Planner/Navigator model selection, model parameters, reasoning effort, speech-to-text selection, and save/delete/cancel state.

The user must build and save a provider before it appears in the model list, then choose Planner/Navigator separately.

That is the setup problem.

## The current “configured” check is inconsistent

The side panel does:

```ts
const configuredAgents = await agentModelStore.getConfiguredAgents();
const hasAtLeastOneModel = configuredAgents.length > 0;
```

and considers setup complete if *any* agent is configured.

But `setupExecutor()` later requires a Navigator:

```ts
const navigatorModel = agentModels[AgentNameEnum.Navigator];
if (!navigatorModel) throw new Error(...);
```

The Planner is optional because runtime falls back to Navigator when Planner is absent, but Navigator is mandatory.

So the welcome/setup gate can claim readiness when a task still cannot start. This is an actual setup defect.

## Saved provider configuration is not connection-tested

`llmProviderStore.setProvider()` validates required fields syntactically, but does not prove the API key/base URL/model works. A real provider failure may first appear when a task runs.

A better setup flow should validate the selected provider/model before claiming readiness. This is an engineering conclusion, not a user-authored requirement.

## There is no first-class backup/import/export

No configuration import/export/backup workflow was found in the inspected options/storage code.

Chrome `storage.local` is cleared when an extension is removed, so it is not a portable configuration format even though it is appropriate for normal installed-extension persistence.

## Development extension identity may matter

Current `chrome-extension/manifest.js` has no manifest `key`.

Chrome supports a manifest key specifically to control a stable extension ID during development. Investigate whether the user's configuration-loss experience correlates with unpacked-extension ID churn before changing this.

## Concrete bugs discovered while reading configuration code

These are defects, not product requirements.

### Reasoning-effort value mismatch

The stored type permits:

```text
minimal | low | medium | high
```

but the selector contains:

```html
<option value="minimal/none">Minimal</option>
```

and casts the selected string into the narrower type.

### API key is logged

`llmProviderStore.setProvider()` logs `JSON.stringify(completeConfig)`, and `completeConfig` includes `apiKey`.

Remove or redact that log.

## What the coding agent should not assume

The code does **not** show that a desktop driver is necessary to fix configuration.

A much smaller extension-only fix can solve the immediate problem:

- one guided setup flow;
- correct completeness validation;
- one serializable configuration bundle over the existing stores;
- import/export/restore;
- connection/model validation;
- stable development extension identity if ID churn is actually reproduced.

A desktop driver remains a candidate for the larger runtime modernization, not a prerequisite for fixing setup.
