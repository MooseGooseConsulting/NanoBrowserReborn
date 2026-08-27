import { createLogger } from '@src/background/log';
import {
  CHATGPT_ORGANIZE_SCRIPT_ID,
  contentScriptIdFor,
  userScriptIdFor,
} from './catalog';
import { WORLD, type UserscriptChromeApi } from './register';

const logger = createLogger('Userscripts');

/**
 * ChatGPT organize is async after inject. Chrome waits on executeScript when
 * `func` returns a Promise; we poll `__nanoChatGptOrganize.done` so the action
 * does not report OK before session / list / PATCH finish.
 */
export const ORGANIZE_DONE_TIMEOUT_MS = 60_000;

export type ChatGptOrganizePageState = {
  done?: boolean;
  signedIn?: boolean;
  error?: string | null;
  listed?: number;
  mutations?: unknown[];
};

type InjectionResult = { result?: ChatGptOrganizePageState };

export function isChatGptOrganizeScript(scriptId: string): boolean {
  return scriptId === CHATGPT_ORGANIZE_SCRIPT_ID;
}

/** Serialized into the tab MAIN world. Do not close over module locals. */
export function armOrganizeRunInPage(): void {
  const g = globalThis as {
    __nanoOrganizeRun?: boolean;
    __nanoChatGptOrganize?: ChatGptOrganizePageState;
  };
  g.__nanoOrganizeRun = true;
  delete g.__nanoChatGptOrganize;
}

/** Serialized into the tab MAIN world. Chrome awaits this Promise. */
export async function waitForOrganizeDoneInPage(timeoutMs: number): Promise<ChatGptOrganizePageState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = (globalThis as { __nanoChatGptOrganize?: ChatGptOrganizePageState }).__nanoChatGptOrganize;
    if (state && state.done) {
      return state;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
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
  if (!state.signedIn) {
    return 'Not signed in. This payload has no login UI.';
  }
  return null;
}

export async function armChatGptOrganizeRun(api: UserscriptChromeApi, tabId: number): Promise<void> {
  await api.scripting.executeScript({
    target: { tabId },
    world: WORLD,
    injectImmediately: true,
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
