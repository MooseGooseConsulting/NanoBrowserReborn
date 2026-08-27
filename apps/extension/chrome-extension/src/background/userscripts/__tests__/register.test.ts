import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  allContentScriptIds,
  allUserScriptIds,
  CHATGPT_ORGANIZE_FILE,
  CHATGPT_ORGANIZE_SCRIPT_ID,
  COMPAT_FILE,
  filesForMode,
  FIXTURE_FILE,
  FIXTURE_SCRIPT_ID,
  PACKAGED_MODE_FILE,
  REVIEWED_USERSCRIPT_HOSTS,
  USER_SCRIPTS_MODE_FILE,
} from '../catalog';
import { matchesForUrl, registerAndRunReviewedUserscript, RUN_AT, WORLD, type UserscriptChromeApi } from '../register';
import { URLNotAllowedError } from '@src/background/browser/views';
import { RUN_USERSCRIPT_ACTION, runUserscriptActionSchema } from '../../agent/actions/schemas';
import { navigatorSystemPromptTemplate } from '../../agent/prompts/templates/navigator';

interface CallLog {
  userRegister: unknown[];
  userUnregister: unknown[];
  contentRegister: unknown[];
  contentUnregister: unknown[];
  executeScript: unknown[];
}

function firstScript(value: unknown): Record<string, unknown> {
  const list = value as unknown[];
  return list[0] as Record<string, unknown>;
}

function eventMockChrome(options: {
  nativeUserScripts: boolean;
  packagedThrows?: boolean;
  executeThrows?: boolean;
}): { api: UserscriptChromeApi; calls: CallLog } {
  const calls: CallLog = {
    userRegister: [],
    userUnregister: [],
    contentRegister: [],
    contentUnregister: [],
    executeScript: [],
  };

  const api: UserscriptChromeApi = {
    scripting: {
      async registerContentScripts(value) {
        calls.contentRegister.push(value);
        if (options.packagedThrows) {
          throw new Error('registerContentScripts unavailable in this scenario');
        }
      },
      async unregisterContentScripts(value) {
        calls.contentUnregister.push(value);
      },
      async executeScript(value) {
        calls.executeScript.push(value);
        if (options.executeThrows) {
          throw new Error('tab closed during executeScript');
        }
      },
    },
  };

  if (options.nativeUserScripts) {
    api.userScripts = {
      async register(value) {
        calls.userRegister.push(value);
      },
      async unregister(value) {
        calls.userUnregister.push(value);
      },
    };
  }

  return { api, calls };
}

const fixtureTarget = {
  scriptId: 'fixture',
  tabId: 42,
  tabUrl: 'https://example.com/chat',
};

describe('userscript registration helper', () => {
  it('prefers packaged registerContentScripts even when userScripts is available', async () => {
    const { api, calls } = eventMockChrome({ nativeUserScripts: true });
    const result = await registerAndRunReviewedUserscript(api, fixtureTarget);

    expect(result.mode).toBe('chrome.scripting.registerContentScripts');
    expect(calls.contentRegister).toHaveLength(1);
    expect(calls.userRegister).toHaveLength(0);

    const registered = firstScript(calls.contentRegister[0]) as {
      world: string;
      runAt: string;
      persistAcrossSessions: boolean;
      js: string[];
      matches: string[];
    };
    expect(registered.world).toBe(WORLD);
    expect(registered.runAt).toBe(RUN_AT);
    expect(registered.persistAcrossSessions).toBe(false);
    expect(registered.matches).toEqual(['https://example.com/*']);
    expect(registered.js).toEqual([PACKAGED_MODE_FILE, COMPAT_FILE, FIXTURE_FILE]);
    expect(calls.executeScript).toHaveLength(1);
    expect(calls.executeScript[0]).toMatchObject({
      target: { tabId: 42 },
      world: WORLD,
      injectImmediately: true,
      files: [PACKAGED_MODE_FILE, COMPAT_FILE, FIXTURE_FILE],
    });
  });

  it('falls back to chrome.userScripts when packaged registration fails', async () => {
    const { api, calls } = eventMockChrome({ nativeUserScripts: true, packagedThrows: true });
    const result = await registerAndRunReviewedUserscript(api, fixtureTarget);

    expect(result.mode).toBe('chrome.userScripts');
    expect(calls.contentRegister).toHaveLength(1);
    expect(calls.userRegister).toHaveLength(1);
    const nativeScript = firstScript(calls.userRegister[0]) as {
      world: string;
      runAt: string;
      persistAcrossSessions?: boolean;
      js: { file: string }[];
    };
    expect(nativeScript.world).toBe(WORLD);
    expect(nativeScript.runAt).toBe(RUN_AT);
    expect(nativeScript.persistAcrossSessions).toBe(false);
    expect(nativeScript.js.map(x => x.file)).toEqual([USER_SCRIPTS_MODE_FILE, COMPAT_FILE, FIXTURE_FILE]);
    expect(result.packagedError).toContain('registerContentScripts unavailable');
    expect(calls.executeScript).toHaveLength(1);
    expect(calls.executeScript[0]).toMatchObject({
      files: [USER_SCRIPTS_MODE_FILE, COMPAT_FILE, FIXTURE_FILE],
    });
  });

  it('clears the userScripts registration when runOnTab fails after fallback register', async () => {
    const { api, calls } = eventMockChrome({
      nativeUserScripts: true,
      packagedThrows: true,
      executeThrows: true,
    });
    await expect(registerAndRunReviewedUserscript(api, fixtureTarget)).rejects.toThrow(
      /tab closed during executeScript/,
    );
    expect(calls.userRegister).toHaveLength(1);
    expect(calls.userUnregister.length).toBeGreaterThanOrEqual(2);
    expect(calls.contentUnregister.length).toBeGreaterThanOrEqual(2);
  });

  it('does not fall back to userScripts when packaged registration succeeds but runOnTab fails', async () => {
    const { api, calls } = eventMockChrome({
      nativeUserScripts: true,
      executeThrows: true,
    });
    await expect(registerAndRunReviewedUserscript(api, fixtureTarget)).rejects.toThrow(
      /tab closed during executeScript/,
    );
    expect(calls.contentRegister).toHaveLength(1);
    expect(calls.userRegister).toHaveLength(0);
    expect(calls.contentUnregister.length).toBeGreaterThanOrEqual(2);
  });

  it('throws when packaged registration fails and userScripts is missing', async () => {
    const { api } = eventMockChrome({ nativeUserScripts: false, packagedThrows: true });
    await expect(registerAndRunReviewedUserscript(api, fixtureTarget)).rejects.toThrow(
      /registerContentScripts unavailable/,
    );
  });

  it('unregisters every reviewed id before registering, not only the current script', async () => {
    const { api, calls } = eventMockChrome({ nativeUserScripts: true });
    await registerAndRunReviewedUserscript(api, fixtureTarget);
    expect(calls.userUnregister[0]).toEqual({ ids: allUserScriptIds() });
    expect(calls.contentUnregister[0]).toEqual({ ids: allContentScriptIds() });
    expect(allUserScriptIds()).toEqual([
      'nano-userscript-fixture',
      'nano-userscript-chatgpt-organize',
    ]);
  });

  it('injects chatgpt-organize.user.js, not fixture, when scriptId is chatgpt-organize with no prior select', async () => {
    const { api, calls } = eventMockChrome({ nativeUserScripts: true });
    const result = await registerAndRunReviewedUserscript(api, {
      scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
      tabId: 7,
      tabUrl: 'https://chatgpt.com/c/abc',
    });

    expect(result.scriptId).toBe(CHATGPT_ORGANIZE_SCRIPT_ID);
    expect(result.js).toEqual([PACKAGED_MODE_FILE, COMPAT_FILE, CHATGPT_ORGANIZE_FILE]);
    expect(result.js).not.toContain(FIXTURE_FILE);
    expect(firstScript(calls.contentRegister[0]).js).toEqual([
      PACKAGED_MODE_FILE,
      COMPAT_FILE,
      CHATGPT_ORGANIZE_FILE,
    ]);
    expect(calls.executeScript[0]).toMatchObject({
      files: [PACKAGED_MODE_FILE, COMPAT_FILE, CHATGPT_ORGANIZE_FILE],
    });
    expect(JSON.stringify(calls)).not.toContain(FIXTURE_FILE);
  });

  it('does not leave fixture registered after a later chatgpt-organize run', async () => {
    const { api, calls } = eventMockChrome({ nativeUserScripts: true });
    await registerAndRunReviewedUserscript(api, fixtureTarget);
    await registerAndRunReviewedUserscript(api, {
      scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
      tabId: 7,
      tabUrl: 'https://chatgpt.com/',
    });
    expect(calls.contentUnregister[1]).toEqual({ ids: allContentScriptIds() });
    expect(firstScript(calls.contentRegister[1]).id).toBe('nano-userscript-packaged-chatgpt-organize');
    expect(firstScript(calls.contentRegister[1]).js).not.toContain(FIXTURE_FILE);
  });

  it('rejects chatgpt-organize off chatgpt.com inside the helper', async () => {
    const { api, calls } = eventMockChrome({ nativeUserScripts: true });
    await expect(
      registerAndRunReviewedUserscript(api, {
        scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
        tabId: 7,
        tabUrl: 'https://example.com/chat',
      }),
    ).rejects.toBeInstanceOf(URLNotAllowedError);
    expect(calls.contentRegister).toHaveLength(0);
    expect(calls.executeScript).toHaveLength(0);
  });

  it('allows chatgpt-organize on chat.openai.com and rejects www.chatgpt.com', async () => {
    const { api, calls } = eventMockChrome({ nativeUserScripts: true });
    await registerAndRunReviewedUserscript(api, {
      scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
      tabId: 7,
      tabUrl: 'https://chat.openai.com/c/abc',
    });
    expect(calls.contentRegister).toHaveLength(1);
    await expect(
      registerAndRunReviewedUserscript(api, {
        scriptId: CHATGPT_ORGANIZE_SCRIPT_ID,
        tabId: 7,
        tabUrl: 'https://www.chatgpt.com/',
      }),
    ).rejects.toBeInstanceOf(URLNotAllowedError);
    expect(REVIEWED_USERSCRIPT_HOSTS[CHATGPT_ORGANIZE_SCRIPT_ID]).toEqual(['chatgpt.com', 'chat.openai.com']);
  });

  it('keys filesForMode by scriptId, not a module global', () => {
    expect(filesForMode('chrome.scripting.registerContentScripts', FIXTURE_SCRIPT_ID)).toEqual([
      PACKAGED_MODE_FILE,
      COMPAT_FILE,
      FIXTURE_FILE,
    ]);
    expect(filesForMode('chrome.scripting.registerContentScripts', CHATGPT_ORGANIZE_SCRIPT_ID)).toEqual([
      PACKAGED_MODE_FILE,
      COMPAT_FILE,
      CHATGPT_ORGANIZE_FILE,
    ]);
    expect(filesForMode('chrome.userScripts', CHATGPT_ORGANIZE_SCRIPT_ID)).toEqual([
      USER_SCRIPTS_MODE_FILE,
      COMPAT_FILE,
      CHATGPT_ORGANIZE_FILE,
    ]);
    expect(() => filesForMode('chrome.scripting.registerContentScripts', 'chatgpt-export')).toThrow(
      /Unknown reviewed userscript id/,
    );
  });

  it('blocks chrome:// and other non-injectable URLs before registration', async () => {
    const { api, calls } = eventMockChrome({ nativeUserScripts: true });
    await expect(
      registerAndRunReviewedUserscript(api, { ...fixtureTarget, tabUrl: 'chrome://extensions' }),
    ).rejects.toBeInstanceOf(URLNotAllowedError);
    expect(calls.contentRegister).toHaveLength(0);
    expect(calls.userRegister).toHaveLength(0);
    expect(calls.executeScript).toHaveLength(0);
  });

  it('rejects about:blank and ftp before any registration (no all-sites fallback)', async () => {
    const { api, calls } = eventMockChrome({ nativeUserScripts: true });
    await expect(
      registerAndRunReviewedUserscript(api, { ...fixtureTarget, tabUrl: 'about:blank' }),
    ).rejects.toBeInstanceOf(URLNotAllowedError);
    await expect(
      registerAndRunReviewedUserscript(api, { ...fixtureTarget, tabUrl: 'ftp://files.example/dir' }),
    ).rejects.toBeInstanceOf(URLNotAllowedError);
    expect(calls.contentRegister).toHaveLength(0);
    expect(() => matchesForUrl('about:blank')).toThrow(URLNotAllowedError);
  });

  it('rejects model-wide match globs and keeps origin-only registration', async () => {
    const { api, calls } = eventMockChrome({ nativeUserScripts: true });
    await expect(
      registerAndRunReviewedUserscript(api, { ...fixtureTarget, matches: ['*://*/*'] }),
    ).rejects.toBeInstanceOf(URLNotAllowedError);
    await expect(
      registerAndRunReviewedUserscript(api, { ...fixtureTarget, matches: ['https://*/*'] }),
    ).rejects.toBeInstanceOf(URLNotAllowedError);
    expect(calls.contentRegister).toHaveLength(0);

    const ok = await registerAndRunReviewedUserscript(api, fixtureTarget);
    expect(ok.matches).toEqual(['https://example.com/*']);
    expect(firstScript(calls.contentRegister[0]).matches).toEqual(['https://example.com/*']);
  });

  it('strips ports from match patterns', () => {
    expect(matchesForUrl('http://localhost:3000/app')).toEqual(['http://localhost/*']);
    expect(matchesForUrl('https://example.com:8443/chat')).toEqual(['https://example.com/*']);
  });

  it('applies existing firewall allow/deny lists to the tab URL', async () => {
    const { api, calls } = eventMockChrome({ nativeUserScripts: true });
    await expect(
      registerAndRunReviewedUserscript(api, {
        ...fixtureTarget,
        denyList: ['example.com'],
      }),
    ).rejects.toBeInstanceOf(URLNotAllowedError);
    expect(calls.contentRegister).toHaveLength(0);
  });

  it('rejects unknown script ids without touching Chrome APIs', async () => {
    const { api, calls } = eventMockChrome({ nativeUserScripts: true });
    await expect(
      registerAndRunReviewedUserscript(api, { ...fixtureTarget, scriptId: 'chatgpt-export' }),
    ).rejects.toThrow(/Unknown reviewed userscript id/);
    expect(calls.contentRegister).toHaveLength(0);
  });

  it('blocks javascript: and data: URLs', async () => {
    const { api, calls } = eventMockChrome({ nativeUserScripts: true });
    await expect(
      registerAndRunReviewedUserscript(api, { ...fixtureTarget, tabUrl: 'javascript:alert(1)' }),
    ).rejects.toBeInstanceOf(URLNotAllowedError);
    await expect(
      registerAndRunReviewedUserscript(api, { ...fixtureTarget, tabUrl: 'data:text/html,hi' }),
    ).rejects.toBeInstanceOf(URLNotAllowedError);
    expect(calls.contentRegister).toHaveLength(0);
  });

  it('scopes default matches to the current origin', () => {
    expect(matchesForUrl('https://chatgpt.com/c/abc')).toEqual(['https://chatgpt.com/*']);
  });
});

describe('run_userscript action schema', () => {
  it('defaults script_id to fixture, uses the reviewed-id enum, and does not accept model matches', () => {
    expect(RUN_USERSCRIPT_ACTION).toBe('run_userscript');
    const parsed = runUserscriptActionSchema.schema.parse({ intent: 'inject proof' });
    expect(parsed).toMatchObject({ intent: 'inject proof', script_id: FIXTURE_SCRIPT_ID });
    expect(parsed).not.toHaveProperty('matches');
    expect(runUserscriptActionSchema.schema.parse({ intent: 'x', matches: ['*://*/*'] })).not.toHaveProperty('matches');
    expect(runUserscriptActionSchema.schema.parse({ script_id: CHATGPT_ORGANIZE_SCRIPT_ID }).script_id).toBe(
      CHATGPT_ORGANIZE_SCRIPT_ID,
    );
    expect(() => runUserscriptActionSchema.schema.parse({ script_id: 'not-a-payload' })).toThrow();
    expect(() => runUserscriptActionSchema.schema.parse({ script_id: 'chatgpt-export' })).toThrow();
  });
});

describe('navigator userscript prompt', () => {
  it('tells the navigator chatgpt-organize is the real organize job on allowed origins', () => {
    expect(navigatorSystemPromptTemplate).toContain('script_id "fixture"');
    expect(navigatorSystemPromptTemplate).toMatch(/same-origin fetch/);
    expect(navigatorSystemPromptTemplate).toMatch(/PATCH titles on scrap/);
    expect(navigatorSystemPromptTemplate).not.toMatch(/catalog hook/);
    expect(navigatorSystemPromptTemplate).not.toMatch(/does not organize or export chats/);
  });
});

describe('fixture banner', () => {
  it('updates an existing banner on repeated SPA runs instead of returning early', () => {
    const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '../../../../public/userscripts/fixture.user.js');
    const source = readFileSync(fixturePath, 'utf8');
    expect(source).toContain("document.querySelector('#nano-userscript-poc')");
    expect(source).toContain('banner.dataset.runs = String(runs)');
    expect(source).toContain('banner.textContent = `Nano Reborn userscript fixture loaded via');
    expect(source).not.toMatch(/if\s*\(\s*banner\s*\)\s*return/);
  });
});
