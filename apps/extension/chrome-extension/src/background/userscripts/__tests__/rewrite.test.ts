import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHATGPT_ORGANIZE_FILE,
  CHATGPT_ORGANIZE_SCRIPT_ID,
  COMPAT_FILE,
  FIXTURE_SCRIPT_ID,
  PACKAGED_MODE_FILE,
} from '../catalog';
import { createMemoryOverlayStorage, getOverlayForScript, type UserscriptOverlay } from '../overlay';
import {
  injectReviewedOverlay,
  injectUserscriptSourceInPage,
  MAX_OVERLAY_SOURCE_BYTES,
  OVERLAY_INJECT_MODE,
  rewriteUserscript,
  validateOverlaySource,
} from '../rewrite';
import { executeChatGptOrganizeOnce } from '../organize-run';
import { URLNotAllowedError } from '@src/background/browser/views';
import { assertChatGptOrganizeTabAllowed } from '../organize-run';
import type { UserscriptChromeApi } from '../register';
import {
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
    const overlay = (await storage.local.get('nano.userscript.overlays'))['nano.userscript.overlays'] as Record<
      string,
      UserscriptOverlay
    >;
    expect(overlay[FIXTURE_SCRIPT_ID]?.source).toBe(source);
    expect(overlay[FIXTURE_SCRIPT_ID]?.sourceHash).toBe(result.sourceHash);
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
    const oversized = `(() => { globalThis.__nanoUserscriptPoc = {}; /* ${'x'.repeat(MAX_OVERLAY_SOURCE_BYTES)} */ })();`;
    expect(() => validateOverlaySource(FIXTURE_SCRIPT_ID, oversized)).toThrow(/exceeds/);
    expect(() => validateOverlaySource(CHATGPT_ORGANIZE_SCRIPT_ID, validFixtureOverlaySource())).toThrow(
      /__nanoChatGptOrganize/,
    );
  });

  it('reset: true deletes the overlay so the packaged seed is used', async () => {
    const storage = createMemoryOverlayStorage();
    await rewriteUserscript(storage, { scriptId: FIXTURE_SCRIPT_ID, source: validFixtureOverlaySource() });
    const reset = await rewriteUserscript(storage, { scriptId: FIXTURE_SCRIPT_ID, reset: true });
    expect(reset.reset).toBe(true);
    expect(reset.sourceHash).toBeNull();
    const overlay = (await storage.local.get('nano.userscript.overlays'))['nano.userscript.overlays'] as Record<
      string,
      UserscriptOverlay
    >;
    expect(overlay[FIXTURE_SCRIPT_ID]).toBeUndefined();
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
      args: [source],
    });
    expect(typeof (calls[1] as { func: unknown }).func).toBe('function');
    expect((calls[1] as { func: typeof injectUserscriptSourceInPage }).func).toBe(injectUserscriptSourceInPage);
    expect(JSON.stringify(calls)).not.toContain('userscripts/fixture.user.js');
    expect(String(injectUserscriptSourceInPage)).not.toMatch(/blob:/);
    expect(String(injectUserscriptSourceInPage)).not.toMatch(/createObjectURL/);
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
    expect(calls[1]).toMatchObject({ args: [source], world: 'MAIN' });
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
    expect(navigatorSystemPromptTemplate).toMatch(/"reset": true/);
    expect(navigatorSystemPromptTemplate).not.toMatch(/catalog hook/);
  });
});
