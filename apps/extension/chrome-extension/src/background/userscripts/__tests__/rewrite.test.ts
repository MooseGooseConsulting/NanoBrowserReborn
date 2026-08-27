import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  allContentScriptIds,
  allUserScriptIds,
  CHATGPT_ORGANIZE_FILE,
  CHATGPT_ORGANIZE_SCRIPT_ID,
  COMPAT_FILE,
  FIXTURE_SCRIPT_ID,
  PACKAGED_MODE_FILE,
} from '../catalog';
import { createMemoryOverlayStorage, getOverlayForScript, overlayStorageKeyFor, type UserscriptOverlay } from '../overlay';
import {
  injectReviewedOverlay,
  injectUserscriptSourceInPage,
  MAX_OVERLAY_SOURCE_BYTES,
  OVERLAY_INJECT_MODE,
  rewriteUserscript,
  validateOverlaySource,
  wrapOverlaySourceWithOriginLock,
} from '../rewrite';
import { executeChatGptOrganizeOnce } from '../organize-run';
import { URLNotAllowedError } from '@src/background/browser/views';
import { assertChatGptOrganizeTabAllowed } from '../organize-run';
import type { UserscriptChromeApi } from '../register';
import {
  isUserscriptOnlyAction,
  REWRITE_USERSCRIPT_ACTION,
  rewriteUserscriptActionSchema,
  RUN_USERSCRIPT_ACTION,
  runUserscriptActionSchema,
} from '../../agent/actions/schemas';
import { navigatorSystemPromptTemplate } from '../../agent/prompts/templates/navigator';
import { assertSourceMatchesChatGptOrganizeContract } from '../chatgpt-organize-contract';

function packagedOrganizeSource() {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, '../../../../public/userscripts/chatgpt-organize.user.js'), 'utf8');
}

function validFixtureOverlaySource(marker = 'overlay-fixture') {
  return `(() => { globalThis.__nanoUserscriptPoc = { loaded: true, marker: ${JSON.stringify(marker)} }; })();`;
}

function validOrganizeOverlaySource() {
  return `${packagedOrganizeSource()}\n/* overlay-keep-current */`;
}

function eventMockChrome(): { api: UserscriptChromeApi; calls: unknown[] } {
  const calls: unknown[] = [];
  const api: UserscriptChromeApi = {
    scripting: {
      async registerContentScripts() {
        throw new Error('registerContentScripts must not run for overlay inject');
      },
      async unregisterContentScripts() {},
      async executeScript(value) {
        calls.push(value);
        return [];
      },
    },
    userScripts: {
      async register() {
        throw new Error('userScripts.register must not run for overlay inject');
      },
      async unregister() {},
    },
  };
  return { api, calls };
}

describe('rewrite_userscript validation and overlay store', () => {
  it('accepts a valid overlay and does not execute it', async () => {
    const storage = createMemoryOverlayStorage();
    const source = validFixtureOverlaySource();
    const result = await rewriteUserscript(storage, { scriptId: FIXTURE_SCRIPT_ID, source });
    expect(result.ok).toBe(true);
    expect(result.reset).toBe(false);
    expect(result.scriptId).toBe(FIXTURE_SCRIPT_ID);
    expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    const stored = await getOverlayForScript(storage, FIXTURE_SCRIPT_ID);
    expect(stored?.source).toBe(source);
    expect(stored?.sourceHash).toBe(result.sourceHash);
  });

  it('rejects unknown id, empty, oversized, and dangerous source', async () => {
    const storage = createMemoryOverlayStorage();
    await expect(rewriteUserscript(storage, { scriptId: 'chatgpt-export', source: validFixtureOverlaySource() })).rejects.toThrow(
      /Unknown reviewed userscript id/,
    );
    await expect(rewriteUserscript(storage, { scriptId: FIXTURE_SCRIPT_ID, source: '' })).rejects.toThrow(/empty/);
    await expect(rewriteUserscript(storage, { scriptId: FIXTURE_SCRIPT_ID, source: '   ' })).rejects.toThrow(/empty/);
    await expect(rewriteUserscript(storage, { scriptId: FIXTURE_SCRIPT_ID })).rejects.toThrow(/empty/);
    expect(() => validateOverlaySource(FIXTURE_SCRIPT_ID, 'not a userscript and no hook')).toThrow(/IIFE/);
    expect(() =>
      validateOverlaySource(FIXTURE_SCRIPT_ID, `(() => { location.href = "chrome://extensions"; globalThis.__nanoUserscriptPoc = {}; })();`),
    ).toThrow(/chrome:\/\//);
    expect(() =>
      validateOverlaySource(
        FIXTURE_SCRIPT_ID,
        `(() => { location.href = "chrome-extension://abc"; globalThis.__nanoUserscriptPoc = {}; })();`,
      ),
    ).toThrow(/chrome-extension:\/\//);
    expect(() =>
      validateOverlaySource(FIXTURE_SCRIPT_ID, `(() => { location.href = "javascript:alert(1)"; globalThis.__nanoUserscriptPoc = {}; })();`),
    ).toThrow(/javascript:/);
    expect(() =>
      validateOverlaySource(FIXTURE_SCRIPT_ID, `(() => { location.href = "data:text/html,x"; globalThis.__nanoUserscriptPoc = {}; })();`),
    ).toThrow(/data:/);
    expect(() =>
      validateOverlaySource(
        FIXTURE_SCRIPT_ID,
        `(() => { const payload = { data: 1 }; globalThis.__nanoUserscriptPoc = payload; })();`,
      ),
    ).not.toThrow();
    const oversized = `(() => { globalThis.__nanoUserscriptPoc = {}; /* ${'x'.repeat(MAX_OVERLAY_SOURCE_BYTES)} */ })();`;
    expect(() => validateOverlaySource(FIXTURE_SCRIPT_ID, oversized)).toThrow(/exceeds/);
    expect(() => validateOverlaySource(CHATGPT_ORGANIZE_SCRIPT_ID, validFixtureOverlaySource())).toThrow(
      /__nanoChatGptOrganize/,
    );
    const hookOnly = `(() => { globalThis.__nanoOrganizeRun = true; globalThis.__nanoChatGptOrganize = { done: true }; })();`;
    expect(() => validateOverlaySource(CHATGPT_ORGANIZE_SCRIPT_ID, hookOnly)).toThrow(/contract token/);
  });

  it('reset: true deletes the overlay so the packaged seed is used', async () => {
    const storage = createMemoryOverlayStorage();
    await rewriteUserscript(storage, { scriptId: FIXTURE_SCRIPT_ID, source: validFixtureOverlaySource() });
    const reset = await rewriteUserscript(storage, { scriptId: FIXTURE_SCRIPT_ID, reset: true });
    expect(reset.reset).toBe(true);
    expect(reset.sourceHash).toBeNull();
    await expect(getOverlayForScript(storage, FIXTURE_SCRIPT_ID)).resolves.toBeNull();
    expect((await storage.local.get(overlayStorageKeyFor(FIXTURE_SCRIPT_ID)))[overlayStorageKeyFor(FIXTURE_SCRIPT_ID)]).toBeUndefined();
  });

  it('fails closed if a stored overlay record id does not match the lookup id', async () => {
    const storage = createMemoryOverlayStorage({
      [CHATGPT_ORGANIZE_SCRIPT_ID]: {
        scriptId: FIXTURE_SCRIPT_ID,
        source: validFixtureOverlaySource(),
        rewrittenAt: Date.now(),
        sourceHash: 'mismatch',
      },
    });
    await expect(getOverlayForScript(storage, CHATGPT_ORGANIZE_SCRIPT_ID)).rejects.toThrow(
      /does not match selected chatgpt-organize/,
    );
  });

  it('a fixture overlay does not replace the chatgpt-organize seed', async () => {
    const storage = createMemoryOverlayStorage();
    await rewriteUserscript(storage, { scriptId: FIXTURE_SCRIPT_ID, source: validFixtureOverlaySource() });
    await expect(getOverlayForScript(storage, CHATGPT_ORGANIZE_SCRIPT_ID)).resolves.toBeNull();
  });

  it('stores overlays for different ids without clobbering', async () => {
    const storage = createMemoryOverlayStorage();
    await Promise.all([
      rewriteUserscript(storage, { scriptId: FIXTURE_SCRIPT_ID, source: validFixtureOverlaySource('a') }),
      rewriteUserscript(storage, { scriptId: CHATGPT_ORGANIZE_SCRIPT_ID, source: validOrganizeOverlaySource() }),
    ]);
    const fixture = await getOverlayForScript(storage, FIXTURE_SCRIPT_ID);
    const organize = await getOverlayForScript(storage, CHATGPT_ORGANIZE_SCRIPT_ID);
    expect(fixture?.source).toContain('marker: "a"');
    expect(organize?.source).toContain('__nanoChatGptOrganize');
  });
});

describe('run_userscript overlay inject', () => {
  it('injects overlay source via func/args, not the packaged seed files', async () => {
    const { api, calls } = eventMockChrome();
    const source = validFixtureOverlaySource('not-the-seed');
    const stored = await rewriteUserscript(createMemoryOverlayStorage(), { scriptId: FIXTURE_SCRIPT_ID, source });
    const overlay: UserscriptOverlay = {
      scriptId: FIXTURE_SCRIPT_ID,
      source,
      rewrittenAt: Date.now(),
      sourceHash: stored.sourceHash as string,
    };
    const injected = await injectReviewedOverlay(api, 7, overlay, FIXTURE_SCRIPT_ID);
    expect(injected.mode).toBe(OVERLAY_INJECT_MODE);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      target: { tabId: 7 },
      world: 'MAIN',
      injectImmediately: true,
      files: [PACKAGED_MODE_FILE, COMPAT_FILE],
    });
    expect(calls[1]).toMatchObject({
      target: { tabId: 7 },
      world: 'MAIN',
      injectImmediately: true,
      args: [source, []],
    });
    expect(typeof (calls[1] as { func: unknown }).func).toBe('function');
    expect((calls[1] as { func: typeof injectUserscriptSourceInPage }).func).toBe(injectUserscriptSourceInPage);
    expect(JSON.stringify(calls)).not.toContain('userscripts/fixture.user.js');
    expect(String(injectUserscriptSourceInPage)).not.toMatch(/blob:/);
    expect(String(injectUserscriptSourceInPage)).not.toMatch(/createObjectURL/);
  });

  it('clears leftover packaged registrations before overlay inject', async () => {
    const unregisters: unknown[] = [];
    const { api } = eventMockChrome();
    api.userScripts = {
      async register() {
        throw new Error('userScripts.register must not run for overlay inject');
      },
      async unregister(filter) {
        unregisters.push(['user', filter]);
      },
    };
    api.scripting.unregisterContentScripts = async filter => {
      unregisters.push(['content', filter]);
    };
    const source = validFixtureOverlaySource('clear-regs');
    const overlay: UserscriptOverlay = {
      scriptId: FIXTURE_SCRIPT_ID,
      source,
      rewrittenAt: Date.now(),
      sourceHash: 'clear',
    };
    await injectReviewedOverlay(api, 8, overlay, FIXTURE_SCRIPT_ID);
    expect(unregisters).toEqual([
      ['user', { ids: allUserScriptIds() }],
      ['content', { ids: allContentScriptIds() }],
    ]);
  });

  it('injects overlay code via userScripts.execute when available (no page eval)', async () => {
    const executes: unknown[] = [];
    const { api, calls } = eventMockChrome();
    Object.assign(api.userScripts ?? {}, {
      async execute(injection: unknown) {
        executes.push(injection);
        return [];
      },
    });
    const source = validFixtureOverlaySource('csp-safe');
    const overlay: UserscriptOverlay = {
      scriptId: FIXTURE_SCRIPT_ID,
      source,
      rewrittenAt: Date.now(),
      sourceHash: 'csp',
    };
    await injectReviewedOverlay(api, 9, overlay, FIXTURE_SCRIPT_ID);
    expect(executes).toHaveLength(1);
    expect(executes[0]).toMatchObject({
      target: { tabId: 9 },
      world: 'MAIN',
      injectImmediately: true,
    });
    const code = (executes[0] as { js: Array<{ code: string }> }).js[0].code;
    expect(code).toContain(source);
    expect(code).toContain('overlay inject refused');
    expect(code).not.toMatch(/blob:/);
    expect(calls.filter(call => (call as { func?: unknown }).func)).toHaveLength(0);
  });

  it('fails closed if a fixture overlay is used when script_id is chatgpt-organize', async () => {
    const { api, calls } = eventMockChrome();
    const fixtureOverlay: UserscriptOverlay = {
      scriptId: FIXTURE_SCRIPT_ID,
      source: validFixtureOverlaySource(),
      rewrittenAt: Date.now(),
      sourceHash: 'abc',
    };
    await expect(injectReviewedOverlay(api, 3, fixtureOverlay, CHATGPT_ORGANIZE_SCRIPT_ID)).rejects.toThrow(
      /does not match selected chatgpt-organize/,
    );
    await expect(executeChatGptOrganizeOnce(api, 3, fixtureOverlay)).rejects.toThrow(/does not match selected chatgpt-organize/);
    expect(calls).toHaveLength(0);
  });

  it('organize overlay injects stored source, not chatgpt-organize.user.js', async () => {
    const { api, calls } = eventMockChrome();
    const source = validOrganizeOverlaySource();
    expect(() => assertSourceMatchesChatGptOrganizeContract(source)).not.toThrow();
    const overlay: UserscriptOverlay = {
      scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
      source,
      rewrittenAt: Date.now(),
      sourceHash: 'def',
    };
    const injected = await executeChatGptOrganizeOnce(api, 11, overlay);
    expect(injected.mode).toBe(OVERLAY_INJECT_MODE);
    expect(injected.js.some(file => file.includes(CHATGPT_ORGANIZE_FILE))).toBe(false);
    expect(calls[1]).toMatchObject({ args: [source, ['chatgpt.com']], world: 'MAIN' });
    expect(JSON.stringify(calls)).not.toContain(CHATGPT_ORGANIZE_FILE);
  });

  it('organize seed path still injects packaged files when no overlay is set', async () => {
    const { api, calls } = eventMockChrome();
    const injected = await executeChatGptOrganizeOnce(api, 11);
    expect(injected.js).toContain(CHATGPT_ORGANIZE_FILE);
    expect(calls[0]).toMatchObject({
      files: [PACKAGED_MODE_FILE, COMPAT_FILE, CHATGPT_ORGANIZE_FILE],
    });
  });

  it('organize origin lock still holds when an overlay is present', () => {
    expect(() => assertChatGptOrganizeTabAllowed('https://chatgpt.com/c/abc')).not.toThrow();
    expect(() => assertChatGptOrganizeTabAllowed('https://example.com/')).toThrow(URLNotAllowedError);
    expect(() => assertChatGptOrganizeTabAllowed('https://chat.openai.com/c/abc')).toThrow(URLNotAllowedError);
  });

  it('origin-lock wrapper runs the live host check before overlay source', () => {
    const source = validOrganizeOverlaySource();
    const wrapped = wrapOverlaySourceWithOriginLock(source, ['chatgpt.com']);
    expect(wrapped.indexOf('chatgpt.com')).toBeLessThan(wrapped.indexOf(source));
    expect(wrapped).toContain(source);
    expect(wrapped).not.toMatch(/blob:/);
  });

  it('refuses overlay eval when the live page host is not in the allowed list', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { href: 'https://example.com/evil' },
    });
    try {
      expect(() => injectUserscriptSourceInPage(validFixtureOverlaySource(), ['chatgpt.com'])).toThrow(
        /example.com is not allowed/,
      );
    } finally {
      if (previous) {
        Object.defineProperty(globalThis, 'location', previous);
      } else {
        delete (globalThis as { location?: unknown }).location;
      }
    }
  });

  it('does not re-evaluate overlay source if payload execute throws', async () => {
    let sourceCalls = 0;
    const calls: unknown[] = [];
    const api: UserscriptChromeApi = {
      userScripts: {
        async register() {},
        async unregister() {},
      },
      scripting: {
        async registerContentScripts() {},
        async unregisterContentScripts() {},
        async executeScript(value) {
          calls.push(value);
          if ((value as { func?: unknown }).func) {
            sourceCalls += 1;
            throw new Error('payload threw after eval start');
          }
        },
      },
    };
    const overlay: UserscriptOverlay = {
      scriptId: FIXTURE_SCRIPT_ID,
      source: validFixtureOverlaySource(),
      rewrittenAt: Date.now(),
      sourceHash: 'once',
    };
    await expect(injectReviewedOverlay(api, 4, overlay, FIXTURE_SCRIPT_ID)).rejects.toThrow(/payload threw/);
    expect(sourceCalls).toBe(1);
    expect(calls.filter(call => (call as { func?: unknown }).func)).toHaveLength(1);
  });
});

describe('rewrite_userscript action schema and navigator prompt', () => {
  it('is a Navigator-callable action distinct from run_userscript and registerContentScripts', () => {
    expect(REWRITE_USERSCRIPT_ACTION).toBe('rewrite_userscript');
    expect(RUN_USERSCRIPT_ACTION).toBe('run_userscript');
    const parsed = rewriteUserscriptActionSchema.schema.parse({
      intent: 'keep current',
      script_id: CHATGPT_ORGANIZE_SCRIPT_ID,
      source: validOrganizeOverlaySource(),
    });
    expect(parsed.script_id).toBe(CHATGPT_ORGANIZE_SCRIPT_ID);
    expect(rewriteUserscriptActionSchema.schema.parse({ script_id: FIXTURE_SCRIPT_ID, reset: true }).reset).toBe(true);
    expect(() => rewriteUserscriptActionSchema.schema.parse({ script_id: 'not-a-payload', source: 'x' })).toThrow();
    expect(isUserscriptOnlyAction(RUN_USERSCRIPT_ACTION)).toBe(true);
    expect(isUserscriptOnlyAction(REWRITE_USERSCRIPT_ACTION)).toBe(true);
    expect(isUserscriptOnlyAction('click_element')).toBe(false);
    expect(rewriteUserscriptActionSchema.description).toMatch(/does not registerContentScripts/);
    expect(rewriteUserscriptActionSchema.description).toMatch(/Does not execute the source/);
    expect(runUserscriptActionSchema.description).toMatch(/overlay/);
    expect(runUserscriptActionSchema.description).toMatch(/packaged seed/);
    expect(runUserscriptActionSchema.description).not.toMatch(/rewrite is registerContentScripts/i);
  });

  it('tells the navigator overlay vs seed honestly', () => {
    expect(navigatorSystemPromptTemplate).toMatch(/chrome\.storage\.local/);
    expect(navigatorSystemPromptTemplate).toMatch(/does not registerContentScripts/);
    expect(navigatorSystemPromptTemplate).toMatch(/does not execute the new source/);
    expect(navigatorSystemPromptTemplate).toMatch(/rewrite_userscript/);
    expect(navigatorSystemPromptTemplate).toMatch(/userScripts\.execute/);
    expect(navigatorSystemPromptTemplate).toMatch(/"reset": true/);
    expect(navigatorSystemPromptTemplate).toMatch(/KEEP_CURRENT_PAYLOAD/);
    expect(navigatorSystemPromptTemplate).not.toMatch(/catalog hook/);
  });
});
