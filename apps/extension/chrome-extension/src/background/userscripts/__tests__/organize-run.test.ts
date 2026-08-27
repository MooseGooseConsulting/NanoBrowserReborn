import { afterEach, describe, expect, it } from 'vitest';
import {
  CHATGPT_ORGANIZE_FILE,
  CHATGPT_ORGANIZE_SCRIPT_ID,
  contentScriptIdFor,
  FIXTURE_FILE,
  PACKAGED_MODE_FILE,
  COMPAT_FILE,
  userScriptIdFor,
} from '../catalog';
import { URLNotAllowedError } from '@src/background/browser/views';
import type { UserscriptChromeApi } from '../register';
import {
  armChatGptOrganizeRun,
  armOrganizeRunInPage,
  assertChatGptOrganizeTabAllowed,
  assertInjectedFilesMatchScript,
  cancelOrganizeRunInPage,
  executeChatGptOrganizeOnce,
  isChatGptOrganizeScript,
  ORGANIZE_DONE_TIMEOUT_MS,
  organizeActionFailure,
  resetOrganizeTabLocksForTests,
  runExclusiveChatGptOrganize,
  unregisterChatGptOrganize,
  waitForChatGptOrganizeDone,
  waitForOrganizeDoneInPage,
} from '../organize-run';
import { injectUserscriptSourceInPage, OVERLAY_INJECT_MODE } from '../rewrite';
import type { UserscriptOverlay } from '../overlay';

describe('chatgpt-organize action wait helpers', () => {
  afterEach(() => {
    cancelOrganizeRunInPage();
    resetOrganizeTabLocksForTests();
    delete (globalThis as { __nanoOrganizeRun?: boolean }).__nanoOrganizeRun;
    delete (globalThis as { __nanoChatGptOrganize?: unknown }).__nanoChatGptOrganize;
    delete (globalThis as { __nanoOrganizeDeadline?: number }).__nanoOrganizeDeadline;
    delete (globalThis as { __nanoOrganizeCancelled?: boolean }).__nanoOrganizeCancelled;
    delete (globalThis as { __nanoOrganizeAbort?: AbortController }).__nanoOrganizeAbort;
  });

  it('arms the one-shot flag in-page', () => {
    expect(isChatGptOrganizeScript(CHATGPT_ORGANIZE_SCRIPT_ID)).toBe(true);
    expect(isChatGptOrganizeScript('fixture')).toBe(false);
    armOrganizeRunInPage(ORGANIZE_DONE_TIMEOUT_MS);
    expect((globalThis as { __nanoOrganizeRun?: boolean }).__nanoOrganizeRun).toBe(true);
    expect((globalThis as { __nanoOrganizeAbort?: AbortController }).__nanoOrganizeAbort).toBeInstanceOf(AbortController);
  });

  it('rejects disallowed tabs before any MAIN-world arm inject', () => {
    expect(() => assertChatGptOrganizeTabAllowed('https://chatgpt.com/c/abc')).not.toThrow();
    expect(() => assertChatGptOrganizeTabAllowed('https://example.com/')).toThrow(URLNotAllowedError);
    expect(() => assertChatGptOrganizeTabAllowed('chrome://extensions')).toThrow(URLNotAllowedError);
    expect(() => assertChatGptOrganizeTabAllowed('https://www.chatgpt.com/')).toThrow(URLNotAllowedError);
    expect(() => assertChatGptOrganizeTabAllowed('https://chat.openai.com/c/abc')).toThrow(URLNotAllowedError);
  });

  it('arm-then-wait does not resolve from a stale prior done: true', async () => {
    (
      globalThis as { __nanoChatGptOrganize?: { done: boolean; signedIn: boolean; listed: number } }
    ).__nanoChatGptOrganize = {
      done: true,
      signedIn: true,
      listed: 99,
    };
    armOrganizeRunInPage(ORGANIZE_DONE_TIMEOUT_MS);
    expect((globalThis as { __nanoOrganizeRun?: boolean }).__nanoOrganizeRun).toBe(true);
    expect((globalThis as { __nanoChatGptOrganize?: unknown }).__nanoChatGptOrganize).toBeUndefined();

    const wait = waitForOrganizeDoneInPage(400);
    await new Promise(resolve => setTimeout(resolve, 80));
    (
      globalThis as { __nanoChatGptOrganize?: { done: boolean; signedIn: boolean; listed: number } }
    ).__nanoChatGptOrganize = {
      done: true,
      signedIn: true,
      listed: 2,
    };
    const state = await wait;
    expect(state.listed).toBe(2);
    expect(state.listed).not.toBe(99);
  });

  it('waitForOrganizeDoneInPage resolves only after done is set', async () => {
    setTimeout(() => {
      (globalThis as { __nanoChatGptOrganize?: { done: boolean; signedIn: boolean } }).__nanoChatGptOrganize = {
        done: true,
        signedIn: true,
      };
    }, 20);
    const state = await waitForOrganizeDoneInPage(500);
    expect(state.done).toBe(true);
    expect(state.signedIn).toBe(true);
  });

  it('waitForOrganizeDoneInPage throws on timeout', async () => {
    await expect(waitForOrganizeDoneInPage(30)).rejects.toThrow(/timed out waiting for done/);
    expect((globalThis as { __nanoOrganizeCancelled?: boolean }).__nanoOrganizeCancelled).toBe(true);
    expect(String(waitForOrganizeDoneInPage)).not.toContain('cancelOrganizeRunInPage');
  });

  it('treats signed-out, 401, failed PATCH, and missing state as action errors', () => {
    expect(organizeActionFailure(undefined)).toMatch(/did not report/);
    expect(organizeActionFailure({ done: false })).toMatch(/did not finish/);
    expect(organizeActionFailure({ done: true, signedIn: false, error: 'Not signed in. This payload has no login UI.' })).toBe(
      'Not signed in. This payload has no login UI.',
    );
    expect(organizeActionFailure({ done: true, signedIn: false, error: 'session failed: 401 Unauthorized' })).toBe(
      'session failed: 401 Unauthorized',
    );
    expect(
      organizeActionFailure({
        done: true,
        signedIn: true,
        error: null,
        mutations: [{ id: 'scrap-rename', action: 'rename', ok: false, error: 'PATCH failed: 401 Unauthorized' }],
      }),
    ).toBe('PATCH failed: 401 Unauthorized');
    expect(
      organizeActionFailure({
        done: true,
        signedIn: true,
        error: '/conversation/scrap-a failed: 500 Internal Server Error',
        mutations: [],
      }),
    ).toBe('/conversation/scrap-a failed: 500 Internal Server Error');
    expect(organizeActionFailure({ done: true, signedIn: true, error: null, mutations: [{ ok: true }] })).toBeNull();
  });

  it('fails closed if a second organize overlaps on the same tab without aborting the first', async () => {
    const armCalls: number[] = [];
    const api: UserscriptChromeApi = {
      scripting: {
        async registerContentScripts() {},
        async unregisterContentScripts() {},
        async executeScript(injection) {
          const func = (injection as { func?: (timeoutMs: number) => void }).func;
          const args = (injection as { args?: number[] }).args || [];
          if (func === armOrganizeRunInPage) {
            armCalls.push(args[0] ?? ORGANIZE_DONE_TIMEOUT_MS);
            func(args[0] ?? ORGANIZE_DONE_TIMEOUT_MS);
          }
          return [];
        },
      },
    };

    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let firstArmed!: () => void;
    const firstHasArmed = new Promise<void>(resolve => {
      firstArmed = resolve;
    });

    const first = runExclusiveChatGptOrganize(42, async () => {
      await armChatGptOrganizeRun(api, 42);
      (
        globalThis as { __nanoChatGptOrganize?: { done: boolean; listed: number } }
      ).__nanoChatGptOrganize = { done: false, listed: 7 };
      firstArmed();
      await firstMayFinish;
      return 'first-ok';
    });

    await firstHasArmed;
    const firstController = (globalThis as { __nanoOrganizeAbort?: AbortController }).__nanoOrganizeAbort;
    expect(firstController).toBeInstanceOf(AbortController);
    expect(firstController?.signal.aborted).toBe(false);
    expect(armCalls).toHaveLength(1);

    await expect(
      runExclusiveChatGptOrganize(42, async () => {
        await armChatGptOrganizeRun(api, 42);
        return 'second-ok';
      }),
    ).rejects.toThrow(/already in flight on tab 42/);

    expect(armCalls).toHaveLength(1);
    expect(firstController?.signal.aborted).toBe(false);
    expect((globalThis as { __nanoOrganizeRun?: boolean }).__nanoOrganizeRun).toBe(true);
    expect((globalThis as { __nanoChatGptOrganize?: { listed?: number } }).__nanoChatGptOrganize?.listed).toBe(7);

    releaseFirst();
    await expect(first).resolves.toBe('first-ok');
    expect(firstController?.signal.aborted).toBe(false);
  });

  it('allows overlapping organize on different tabs', async () => {
    const held = runExclusiveChatGptOrganize(1, async () => {
      await runExclusiveChatGptOrganize(2, async () => 'other-tab');
      return 'first-tab';
    });
    await expect(held).resolves.toBe('first-tab');
  });

  it('armChatGptOrganizeRun and waitForChatGptOrganizeDone use MAIN-world executeScript', async () => {
    const calls: unknown[] = [];
    const api: UserscriptChromeApi = {
      scripting: {
        async registerContentScripts() {},
        async unregisterContentScripts() {},
        async executeScript(injection) {
          calls.push(injection);
          return [{ result: { done: true, signedIn: true, error: null, listed: 2, mutations: [] } }];
        },
      },
    };
    await armChatGptOrganizeRun(api, 9);
    const state = await waitForChatGptOrganizeDone(api, 9, 1000);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ target: { tabId: 9 }, world: 'MAIN', injectImmediately: true, args: [ORGANIZE_DONE_TIMEOUT_MS] });
    expect(typeof (calls[0] as { func: unknown }).func).toBe('function');
    expect(calls[1]).toMatchObject({ target: { tabId: 9 }, world: 'MAIN', args: [1000] });
    expect(state.signedIn).toBe(true);
  });

  it('unregisters only chatgpt-organize ids after the one-shot', async () => {
    const unregisters: unknown[] = [];
    const api: UserscriptChromeApi = {
      userScripts: {
        async register() {},
        async unregister(filter) {
          unregisters.push(['user', filter]);
        },
      },
      scripting: {
        async registerContentScripts() {},
        async unregisterContentScripts(filter) {
          unregisters.push(['content', filter]);
        },
        async executeScript() {
          return [];
        },
      },
    };
    await unregisterChatGptOrganize(api);
    expect(unregisters).toEqual([
      ['user', { ids: [userScriptIdFor(CHATGPT_ORGANIZE_SCRIPT_ID)] }],
      ['content', { ids: [contentScriptIdFor(CHATGPT_ORGANIZE_SCRIPT_ID)] }],
    ]);
  });

  it('logs unregister failures without throwing', async () => {
    const api: UserscriptChromeApi = {
      userScripts: {
        async register() {},
        async unregister() {
          throw new Error('user unregister boom');
        },
      },
      scripting: {
        async registerContentScripts() {},
        async unregisterContentScripts() {
          throw new Error('content unregister boom');
        },
        async executeScript() {
          return [];
        },
      },
    };
    await expect(unregisterChatGptOrganize(api)).resolves.toBeUndefined();
  });

  it('fails closed when selected id and injected files disagree', () => {
    expect(() =>
      assertInjectedFilesMatchScript(CHATGPT_ORGANIZE_SCRIPT_ID, [PACKAGED_MODE_FILE, COMPAT_FILE, FIXTURE_FILE]),
    ).toThrow(/Refusing inject/);
    expect(() => assertInjectedFilesMatchScript(CHATGPT_ORGANIZE_SCRIPT_ID, [FIXTURE_FILE])).toThrow(/Refusing inject/);
    expect(() =>
      assertInjectedFilesMatchScript(CHATGPT_ORGANIZE_SCRIPT_ID, [
        PACKAGED_MODE_FILE,
        COMPAT_FILE,
        CHATGPT_ORGANIZE_FILE,
      ]),
    ).not.toThrow();
  });

  it('executeScript-only: never registerContentScripts or userScripts.register', async () => {
    const calls: { register: unknown[]; userRegister: unknown[]; execute: unknown[] } = {
      register: [],
      userRegister: [],
      execute: [],
    };
    const api: UserscriptChromeApi = {
      userScripts: {
        async register(scripts) {
          calls.userRegister.push(scripts);
        },
        async unregister() {},
      },
      scripting: {
        async registerContentScripts(scripts) {
          calls.register.push(scripts);
        },
        async unregisterContentScripts() {},
        async executeScript(injection) {
          calls.execute.push(injection);
          return [];
        },
      },
    };
    const injected = await executeChatGptOrganizeOnce(api, 11);
    expect(injected.js).toEqual([PACKAGED_MODE_FILE, COMPAT_FILE, CHATGPT_ORGANIZE_FILE]);
    expect(injected.js).not.toContain(FIXTURE_FILE);
    expect(calls.register).toEqual([]);
    expect(calls.userRegister).toEqual([]);
    expect(calls.execute).toEqual([
      {
        target: { tabId: 11 },
        world: 'MAIN',
        injectImmediately: true,
        files: [PACKAGED_MODE_FILE, COMPAT_FILE, CHATGPT_ORGANIZE_FILE],
      },
    ]);
  });

  it('injects overlay source instead of files and still waits on __nanoChatGptOrganize.done', async () => {
    const overlaySource = `(() => { globalThis.__nanoOrganizeRun; globalThis.__nanoChatGptOrganize = { done: true }; })();`;
    const overlay: UserscriptOverlay = {
      scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
      source: overlaySource,
      rewrittenAt: Date.now(),
      sourceHash: 'overlay-hash',
    };
    const calls: { register: unknown[]; userRegister: unknown[]; execute: unknown[] } = {
      register: [],
      userRegister: [],
      execute: [],
    };
    const api: UserscriptChromeApi = {
      userScripts: {
        async register(scripts) {
          calls.userRegister.push(scripts);
        },
        async unregister() {},
      },
      scripting: {
        async registerContentScripts(scripts) {
          calls.register.push(scripts);
        },
        async unregisterContentScripts() {},
        async executeScript(injection) {
          calls.execute.push(injection);
          return [];
        },
      },
    };
    const injected = await executeChatGptOrganizeOnce(api, 11, overlay);
    expect(injected.mode).toBe(OVERLAY_INJECT_MODE);
    expect(calls.register).toEqual([]);
    expect(calls.userRegister).toEqual([]);
    expect(calls.execute).toHaveLength(2);
    expect(calls.execute[0]).toMatchObject({
      files: [PACKAGED_MODE_FILE, COMPAT_FILE],
    });
    expect(calls.execute[1]).toMatchObject({
      args: [overlaySource],
      world: 'MAIN',
    });
    expect((calls.execute[1] as { func: unknown }).func).toBe(injectUserscriptSourceInPage);
    expect(JSON.stringify(calls.execute)).not.toContain(CHATGPT_ORGANIZE_FILE);
  });
});
