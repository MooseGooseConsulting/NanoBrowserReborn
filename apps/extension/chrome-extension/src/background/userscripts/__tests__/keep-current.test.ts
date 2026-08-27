import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CHATGPT_ORGANIZE_FILE, CHATGPT_ORGANIZE_SCRIPT_ID } from '../catalog';
import { createMemoryOverlayStorage, type UserscriptOverlay } from '../overlay';
import { assertSourceMatchesChatGptOrganizeContract } from '../chatgpt-organize-contract';
import { validateOverlaySource, wrapOverlaySourceWithOriginLock } from '../rewrite';
import {
  buildKeepCurrentActionResult,
  classifyOrganizeKeepCurrentFailure,
  extractKeepCurrentPayloadSource,
  KEEP_CURRENT_ERROR_PREFIX,
  KEEP_CURRENT_PAYLOAD_HEADER,
  loadCurrentKeepCurrentPayload,
  setPackagedSeedLoaderForTests,
} from '../keep-current';
import { navigatorSystemPromptTemplate } from '../../agent/prompts/templates/navigator';
import { rewriteUserscriptActionSchema, runUserscriptActionSchema } from '../../agent/actions/schemas';

function packagedOrganizeSource() {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, '../../../../public/userscripts/chatgpt-organize.user.js'), 'utf8');
}

function navigatorMemoryLastLine(error: string): string {
  return error.split('\n').pop() || '';
}

afterEach(() => {
  setPackagedSeedLoaderForTests(null);
});

describe('keep-current organize failure classification', () => {
  it('treats timeout waiting for done as eligible', () => {
    expect(classifyOrganizeKeepCurrentFailure('chatgpt-organize timed out waiting for done')).toEqual({
      eligible: true,
      kind: 'timeout_waiting_for_done',
    });
    expect(classifyOrganizeKeepCurrentFailure('chatgpt-organize timed out')).toEqual({
      eligible: true,
      kind: 'timeout_waiting_for_done',
    });
    expect(classifyOrganizeKeepCurrentFailure('chatgpt-organize did not report a result')).toEqual({
      eligible: true,
      kind: 'timeout_waiting_for_done',
    });
  });

  it('treats contract and action drift as eligible', () => {
    expect(classifyOrganizeKeepCurrentFailure('chatgpt-organize source missing contract token: PATCH')).toEqual({
      eligible: true,
      kind: 'contract_or_action_drift',
    });
    expect(classifyOrganizeKeepCurrentFailure('/conversation/abc rejected: success=false')).toEqual({
      eligible: true,
      kind: 'contract_or_action_drift',
    });
    expect(classifyOrganizeKeepCurrentFailure('chatgpt-organize rename failed for 2 chat(s)')).toEqual({
      eligible: true,
      kind: 'contract_or_action_drift',
    });
    expect(classifyOrganizeKeepCurrentFailure('/conversations?offset=0&limit=100 failed: 404 Not Found')).toEqual({
      eligible: true,
      kind: 'contract_or_action_drift',
    });
  });

  it.each([
    'Not signed in. This payload has no login UI.',
    'session failed: 401 Unauthorized',
    '/backend-api/conversations?offset=0&limit=100 failed: 429 Too Many Requests',
    'chatgpt-organize already in flight on tab 12',
    'chatgpt-organize is only allowed on chatgpt.com (host: example.com)',
    'URL: https://example.com/ is not allowed',
    'overlay inject refused: example.com is not allowed',
    'one-shot only; skip sticky content-script rerun',
    'executeScript failed: Could not establish connection',
    'userScripts.execute is not available',
    'chatgpt-organize helper files missing after inject',
    'chatgpt-organize storage quota exceeded',
  ])('does not treat %s as keep-current', reason => {
    expect(classifyOrganizeKeepCurrentFailure(reason)).toEqual({
      eligible: false,
      kind: 'not_eligible',
    });
  });
});

describe('keep-current ActionResult observation', () => {
  it('attaches the packaged seed bytes Chrome would run on a timeout', async () => {
    const seed = packagedOrganizeSource();
    setPackagedSeedLoaderForTests(async file => {
      expect(file).toBe(CHATGPT_ORGANIZE_FILE);
      return seed;
    });
    const storage = createMemoryOverlayStorage();
    const result = await buildKeepCurrentActionResult({
      reason: 'chatgpt-organize timed out waiting for done',
      scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
      storage,
      alreadyRewritten: false,
    });
    expect(result.includeInMemory).toBe(true);
    expect(result.error.includes('\n')).toBe(false);
    expect(navigatorMemoryLastLine(result.error)).toContain(KEEP_CURRENT_ERROR_PREFIX);
    expect(navigatorMemoryLastLine(result.error)).toContain('timeout_waiting_for_done');
    expect(navigatorMemoryLastLine(result.error)).toMatch(/rewrite_userscript/);
    expect(navigatorMemoryLastLine(result.error)).toMatch(/run_userscript once/);
    expect(result.extractedContent).toContain(KEEP_CURRENT_PAYLOAD_HEADER);
    const bytes = extractKeepCurrentPayloadSource(result.extractedContent || '');
    expect(bytes).toBe(seed);
    assertSourceMatchesChatGptOrganizeContract(bytes);
    validateOverlaySource(CHATGPT_ORGANIZE_SCRIPT_ID, bytes);
  });

  it('attaches overlay source when an overlay is stored — same bytes inject would eval', async () => {
    const overlaySource = `${packagedOrganizeSource()}\n/* keep-current-repair */`;
    const overlay: UserscriptOverlay = {
      scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
      source: overlaySource,
      rewrittenAt: Date.now(),
      sourceHash: 'overlay-hash',
    };
    const storage = createMemoryOverlayStorage({ [CHATGPT_ORGANIZE_SCRIPT_ID]: overlay });
    setPackagedSeedLoaderForTests(async () => {
      throw new Error('seed loader must not run when overlay exists');
    });
    const result = await buildKeepCurrentActionResult({
      reason: '/conversation/abc rejected: success=false',
      scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
      storage,
      alreadyRewritten: false,
    });
    const bytes = extractKeepCurrentPayloadSource(result.extractedContent || '');
    expect(bytes).toBe(overlaySource);
    expect(result.error).toContain('source_kind=overlay');
    expect(result.extractedContent).toContain('source_kind=overlay');
    const wrapped = wrapOverlaySourceWithOriginLock(bytes, ['chatgpt.com']);
    expect(wrapped).toContain(overlaySource);
    expect(wrapped).not.toMatch(/blob:/);
    validateOverlaySource(CHATGPT_ORGANIZE_SCRIPT_ID, bytes);
  });

  it('round-trips overlay bytes even when the source contains the end fence', async () => {
    const overlaySource = `${packagedOrganizeSource()}\n-----END USERSCRIPT-----\n/* trap */`;
    const storage = createMemoryOverlayStorage({
      [CHATGPT_ORGANIZE_SCRIPT_ID]: {
        scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
        source: overlaySource,
        rewrittenAt: Date.now(),
        sourceHash: 'fence-hash',
      },
    });
    const result = await buildKeepCurrentActionResult({
      reason: 'chatgpt-organize timed out waiting for done',
      scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
      storage,
      alreadyRewritten: false,
    });
    expect(extractKeepCurrentPayloadSource(result.extractedContent || '')).toBe(overlaySource);
  });

  it('uses the injected overlay snapshot, not a later storage rewrite', async () => {
    const ranSource = `${packagedOrganizeSource()}\n/* ran */`;
    const laterSource = `${packagedOrganizeSource()}\n/* later */`;
    const storage = createMemoryOverlayStorage({
      [CHATGPT_ORGANIZE_SCRIPT_ID]: {
        scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
        source: laterSource,
        rewrittenAt: 2,
        sourceHash: 'later',
      },
    });
    const result = await buildKeepCurrentActionResult({
      reason: 'chatgpt-organize timed out waiting for done',
      scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
      storage,
      alreadyRewritten: false,
      injected: {
        kind: 'overlay',
        overlay: {
          scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
          source: ranSource,
          rewrittenAt: 1,
          sourceHash: 'ran',
        },
      },
    });
    expect(extractKeepCurrentPayloadSource(result.extractedContent || '')).toBe(ranSource);
    expect(result.extractedContent).not.toContain('/* later */');
  });

  it('does not attach KEEP_CURRENT guidance for signed-out or 401', async () => {
    const seed = packagedOrganizeSource();
    setPackagedSeedLoaderForTests(async () => seed);
    const storage = createMemoryOverlayStorage();
    for (const reason of ['Not signed in. This payload has no login UI.', 'session failed: 401 Unauthorized']) {
      const result = await buildKeepCurrentActionResult({
        reason,
        scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
        storage,
        alreadyRewritten: false,
      });
      expect(result.error).toBe(reason);
      expect(result.error).not.toContain(KEEP_CURRENT_ERROR_PREFIX);
      expect(result.extractedContent).toBeNull();
    }
  });

  it('caps the loop after a rewrite this task', async () => {
    setPackagedSeedLoaderForTests(async () => packagedOrganizeSource());
    const result = await buildKeepCurrentActionResult({
      reason: 'chatgpt-organize timed out waiting for done',
      scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
      storage: createMemoryOverlayStorage(),
      alreadyRewritten: true,
    });
    expect(result.error).toContain('already_retried');
    expect(result.error).toContain('after rewrite_userscript this task');
    expect(result.error.includes('\n')).toBe(false);
    expect(result.extractedContent).toBeNull();
    expect(navigatorMemoryLastLine(result.error)).not.toMatch(/then run_userscript once/);
  });

  it('loadCurrentKeepCurrentPayload returns overlay source over seed', async () => {
    const seed = packagedOrganizeSource();
    setPackagedSeedLoaderForTests(async () => seed);
    const overlaySource = `${seed}\n/* overlay */`;
    const storage = createMemoryOverlayStorage({
      [CHATGPT_ORGANIZE_SCRIPT_ID]: {
        scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
        source: overlaySource,
        rewrittenAt: 1,
        sourceHash: 'h',
      },
    });
    const payload = await loadCurrentKeepCurrentPayload(storage, CHATGPT_ORGANIZE_SCRIPT_ID);
    expect(payload.kind).toBe('overlay');
    expect(payload.source).toBe(overlaySource);
  });

  it('loads packaged seed via chrome.runtime.getURL — same bytes as public/userscripts', async () => {
    const seed = packagedOrganizeSource();
    const previousChrome = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        getURL: (path: string) => {
          expect(path).toBe(CHATGPT_ORGANIZE_FILE);
          return `chrome-extension://nano-test/${path}`;
        },
      },
    };
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain(CHATGPT_ORGANIZE_FILE);
      return new Response(seed, { status: 200 });
    }) as typeof fetch;
    try {
      const payload = await loadCurrentKeepCurrentPayload(createMemoryOverlayStorage(), CHATGPT_ORGANIZE_SCRIPT_ID);
      expect(payload.kind).toBe('seed');
      expect(payload.source).toBe(seed);
    } finally {
      (globalThis as { chrome?: unknown }).chrome = previousChrome;
      globalThis.fetch = previousFetch;
    }
  });
});

describe('keep-current navigator prompt and schemas', () => {
  it('tells Navigator the rewrite-then-run-once loop', () => {
    expect(navigatorSystemPromptTemplate).toMatch(/KEEP_CURRENT/);
    expect(navigatorSystemPromptTemplate).toMatch(/KEEP_CURRENT_PAYLOAD/);
    expect(navigatorSystemPromptTemplate).toMatch(/already_retried/);
    expect(navigatorSystemPromptTemplate).toMatch(/same contract tokens/);
    expect(navigatorSystemPromptTemplate).toMatch(/run_userscript once/);
    expect(navigatorSystemPromptTemplate).toMatch(/after rewrite succeeds/);
    expect(navigatorSystemPromptTemplate).toMatch(/Do not rewrite for signed-out, 401/);
    expect(runUserscriptActionSchema.description).toMatch(/KEEP_CURRENT/);
    expect(rewriteUserscriptActionSchema.description).toMatch(/KEEP_CURRENT/);
    expect(rewriteUserscriptActionSchema.description).toMatch(/title PATCH/);
  });
});
