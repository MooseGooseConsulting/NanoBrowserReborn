import { createLogger } from '@src/background/log';
import { URLNotAllowedError } from '@src/background/browser/views';
import {
  CHATGPT_ORGANIZE_SCRIPT_ID,
  contentScriptIdFor,
  filesForMode,
  FIXTURE_FILE,
  isReviewedUserscriptId,
  payloadFileFor,
  userScriptIdFor,
  type UserscriptRegistrationMode,
} from './catalog';
import { assertUserscriptOrigin, isInjectableHttpUrl, WORLD, type UserscriptChromeApi } from './register';

const logger = createLogger('Userscripts');

/**
 * ChatGPT organize is async after inject. Chrome waits on executeScript when
 * `func` returns a Promise; we poll `__nanoChatGptOrganize.done` so the action
 * does not report OK before session / list / PATCH finish.
 */
export const ORGANIZE_DONE_TIMEOUT_MS = 60_000;

export type ChatGptOrganizeMutation = {
  ok?: boolean;
  error?: string;
  id?: string;
  action?: string;
};

export type ChatGptOrganizePageState = {
  done?: boolean;
  signedIn?: boolean;
  error?: string | null;
  listed?: number;
  mutations?: ChatGptOrganizeMutation[];
};

type OrganizePageGlobals = {
  __nanoOrganizeRun?: boolean;
  __nanoChatGptOrganize?: ChatGptOrganizePageState;
  __nanoOrganizeDeadline?: number;
  __nanoOrganizeCancelled?: boolean;
  __nanoOrganizeAbort?: AbortController;
};

type InjectionResult = { result?: ChatGptOrganizePageState };

export function isChatGptOrganizeScript(scriptId: string): boolean {
  return scriptId === CHATGPT_ORGANIZE_SCRIPT_ID;
}

/**
 * Fail closed if the selected id and the files about to be injected disagree.
 * register.ts is the PR #2 blob (cannot edit here). #2 already keys
 * filesForMode(mode, scriptId); this check still refuses a fixture leak.
 */
export function assertInjectedFilesMatchScript(scriptId: string, files: readonly string[]): void {
  if (!isReviewedUserscriptId(scriptId)) {
    throw new Error(`Unknown reviewed userscript id: ${scriptId}`);
  }
  const expected = payloadFileFor(scriptId);
  if (!files.includes(expected)) {
    throw new Error(`Refusing inject: selected ${scriptId} but files do not include ${expected} (${files.join(', ')})`);
  }
  if (isChatGptOrganizeScript(scriptId) && files.includes(FIXTURE_FILE)) {
    throw new Error('Refusing inject: chatgpt-organize file list includes fixture.user.js');
  }
  const packaged = filesForMode('chrome.scripting.registerContentScripts', scriptId);
  const native = filesForMode('chrome.userScripts', scriptId);
  const sameAs = (wanted: string[]) => wanted.length === files.length && wanted.every((file, index) => file === files[index]);
  if (!sameAs(packaged) && !sameAs(native)) {
    throw new Error(`Refusing inject: file list for ${scriptId} is not a filesForMode result`);
  }
}

/**
 * One-shot MAIN-world inject. Does not registerContentScripts / userScripts.register
 * (register.ts still uses persistAcrossSessions: false for fixture; organize must
 * not leave a sticky content script on chatgpt.com).
 */
export async function executeChatGptOrganizeOnce(
  api: UserscriptChromeApi,
  tabId: number,
): Promise<{ mode: UserscriptRegistrationMode; js: string[] }> {
  const attempts: UserscriptRegistrationMode[] = [
    'chrome.scripting.registerContentScripts',
    'chrome.userScripts',
  ];
  let lastError: unknown;
  for (const mode of attempts) {
    const files = filesForMode(mode, CHATGPT_ORGANIZE_SCRIPT_ID);
    assertInjectedFilesMatchScript(CHATGPT_ORGANIZE_SCRIPT_ID, files);
    try {
      await api.scripting.executeScript({
        target: { tabId },
        world: WORLD,
        injectImmediately: true,
        files,
      });
      return { mode, js: files };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'chatgpt-organize executeScript failed'));
}

/** Origin / firewall gate before any MAIN-world inject. Does not edit register.ts. */
export function assertChatGptOrganizeTabAllowed(
  tabUrl: string,
  allowList: string[] = [],
  denyList: string[] = [],
): void {
  if (!isInjectableHttpUrl(tabUrl, allowList, denyList)) {
    throw new URLNotAllowedError(`URL: ${tabUrl} is not allowed`);
  }
  assertUserscriptOrigin(CHATGPT_ORGANIZE_SCRIPT_ID, tabUrl);
}

/** Serialized into the tab MAIN world. Do not close over module locals. */
export function cancelOrganizeRunInPage(): void {
  const g = globalThis as OrganizePageGlobals;
  g.__nanoOrganizeCancelled = true;
  try {
    g.__nanoOrganizeAbort?.abort();
  } catch {
    // already aborted
  }
}

/** Serialized into the tab MAIN world. Do not close over module locals. */
export function armOrganizeRunInPage(timeoutMs: number): void {
  const g = globalThis as OrganizePageGlobals;
  g.__nanoOrganizeRun = true;
  delete g.__nanoChatGptOrganize;
  g.__nanoOrganizeCancelled = false;
  g.__nanoOrganizeDeadline = Date.now() + timeoutMs;
  try {
    g.__nanoOrganizeAbort?.abort();
  } catch {
    // previous controller already aborted
  }
  g.__nanoOrganizeAbort = new AbortController();
}

/** Serialized into the tab MAIN world. Chrome awaits this Promise. Do not call other module functions from here. */
export async function waitForOrganizeDoneInPage(timeoutMs: number): Promise<ChatGptOrganizePageState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = (globalThis as OrganizePageGlobals).__nanoChatGptOrganize;
    if (state && state.done) {
      return state;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const g = globalThis as OrganizePageGlobals;
  g.__nanoOrganizeCancelled = true;
  try {
    g.__nanoOrganizeAbort?.abort();
  } catch {
    // already aborted
  }
  throw new Error('chatgpt-organize timed out waiting for done');
}

export function organizeActionFailure(state: ChatGptOrganizePageState | null | undefined): string | null {
  if (!state) {
    return 'chatgpt-organize did not report a result';
  }
  if (!state.done) {
    return 'chatgpt-organize did not finish';
  }
  if (state.error) {
    return String(state.error);
  }
  const failed = (state.mutations || []).filter(item => item && item.ok === false);
  if (failed.length) {
    return String(failed[0].error || `chatgpt-organize rename failed for ${failed.length} chat(s)`);
  }
  if (!state.signedIn) {
    return 'Not signed in. This payload has no login UI.';
  }
  return null;
}

export async function armChatGptOrganizeRun(
  api: UserscriptChromeApi,
  tabId: number,
  timeoutMs = ORGANIZE_DONE_TIMEOUT_MS,
): Promise<void> {
  await api.scripting.executeScript({
    target: { tabId },
    world: WORLD,
    injectImmediately: true,
    args: [timeoutMs],
    func: armOrganizeRunInPage,
  });
}

export async function waitForChatGptOrganizeDone(
  api: UserscriptChromeApi,
  tabId: number,
  timeoutMs = ORGANIZE_DONE_TIMEOUT_MS,
): Promise<ChatGptOrganizePageState> {
  const injection = (await api.scripting.executeScript({
    target: { tabId },
    world: WORLD,
    injectImmediately: true,
    args: [timeoutMs],
    func: waitForOrganizeDoneInPage,
  })) as InjectionResult[] | undefined;
  const state = Array.isArray(injection) ? injection[0]?.result : undefined;
  if (!state) {
    throw new Error('chatgpt-organize timed out waiting for done');
  }
  return state;
}

/**
 * Session-sticky register can still re-inject on later chatgpt.com navigations
 * even with persistAcrossSessions: false. Drop organize ids after the one-shot.
 */
export async function unregisterChatGptOrganize(api: UserscriptChromeApi): Promise<void> {
  try {
    if (api.userScripts) {
      await api.userScripts.unregister({ ids: [userScriptIdFor(CHATGPT_ORGANIZE_SCRIPT_ID)] });
    }
  } catch (error) {
    logger.warning('unregister userScripts failed', error);
  }
  try {
    await api.scripting.unregisterContentScripts({ ids: [contentScriptIdFor(CHATGPT_ORGANIZE_SCRIPT_ID)] });
  } catch (error) {
    logger.warning('unregisterContentScripts failed', error);
  }
}
