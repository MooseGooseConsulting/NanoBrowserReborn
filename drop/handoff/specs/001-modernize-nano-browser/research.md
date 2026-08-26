# Research / code findings

## Configuration diagnosis

Read these files at upstream commit `24a14b76e14a9c30fd84878ca7985049d1e7d064`:

- `packages/storage/lib/base/base.ts`
- `packages/storage/lib/settings/llmProviders.ts`
- `packages/storage/lib/settings/agentModels.ts`
- `packages/storage/lib/settings/generalSettings.ts`
- `pages/options/src/Options.tsx`
- `pages/options/src/components/ModelSettings.tsx`
- `pages/options/src/components/GeneralSettings.tsx`
- `pages/side-panel/src/SidePanel.tsx`
- `chrome-extension/src/background/index.ts`
- `chrome-extension/manifest.js`

### Persistence exists already

Providers, agent-model selection, and general settings all use `chrome.storage.local`. So “move everything to a database” is not the starting answer.

### Configuration is fragmented

Provider definitions and API keys are one record; Planner/Navigator assignments are another; general settings are another; other settings use more stores. There is no aggregate config object or import/export workflow.

### Setup is manual and stateful

The model options component is approximately 74 KB and contains provider creation, provider-specific fields, model-list editing, Planner/Navigator model selection and model parameters.

### Setup-complete logic is wrong

The side panel considers Nano configured if any agent model exists; `setupExecutor()` requires Navigator.

### No provider health validation during setup

Saving a provider validates required strings, not whether the endpoint/key/model is actually usable.

### Configuration is not portable

Chrome documents that `storage.local` is cleared when an extension is removed. Nano has no first-class config backup/import/export in the inspected code.

### Development extension identity may matter

Current manifest has no `key`. Chrome documents that a manifest key can control the unique extension ID during development. Investigate whether the user's actual configuration-loss experience is extension-ID churn before changing this.

### Concrete bugs

- reasoning selector uses `minimal/none` although stored type does not;
- provider save code logs full provider config including API key.

These are defects, not product requirements.

## LangGraph modernization

Use the existing reconstructed code pack as a scaffold and validate it. Re-check current LangGraph JS APIs before final implementation because this is version-sensitive.

## Leader/Follower handoff

Implement the requested model-driven return-to-Leader in the smallest way that preserves Nano's existing split. Do not add a large generic multi-agent framework unless a concrete need appears.

## Set-of-marks

First inspect Nano's existing DOM/highlight/selector pipeline before replacing any identity scheme.

The requirements are only to preserve marks, keep them manageable, and evaluate optional second visual generation. Stale-ref epochs, OmniParser, SAM refinement, and merge registries are candidate designs, not requirements.
