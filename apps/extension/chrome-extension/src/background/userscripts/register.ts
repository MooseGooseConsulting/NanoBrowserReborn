import { isUrlAllowed } from '@src/background/browser/util';
import { URLNotAllowedError } from '@src/background/browser/views';
import {
  contentScriptIdFor,
  filesForMode,
  isReviewedUserscriptId,
  type UserscriptRegistrationMode,
  userScriptIdFor,
} from './catalog';

/**
 * Live registration helper for reviewed userscript payloads.
 *
 * drop/chatgpt-exporter-test/nanobrowser-poc already proved both Chrome APIs, but that
 * tree is historical vanilla JS outside the extension tsconfig/vite graph. This module
 * is a TypeScript port (packaged registerContentScripts first, userScripts fallback)
 * rather than a cross-import from drop/.
 */

export const RUN_AT = 'document_end' as const;
export const WORLD = 'MAIN' as const;

export interface UserscriptChromeApi {
  userScripts?: {
    register: (scripts: unknown[]) => Promise<void>;
    unregister: (filter: { ids: string[] }) => Promise<void>;
    execute?: (injection: unknown) => Promise<unknown>;
  };
  scripting: {
    registerContentScripts: (scripts: unknown[]) => Promise<void>;
    unregisterContentScripts: (filter: { ids: string[] }) => Promise<void>;
    executeScript: (injection: unknown) => Promise<unknown>;
  };
}

export interface RegisterAndRunOptions {
  scriptId: string;
  tabId: number;
  tabUrl: string;
  matches?: string[];
}

export interface RegisterAndRunResult {
  ok: true;
  mode: UserscriptRegistrationMode;
  scriptId: string;
  contentScriptId: string;
  userScriptId: string;
  matches: string[];
  js: string[];
  ran: boolean;
  packagedError?: string;
}

export function isInjectableUrl(url: string): boolean {
  return isUrlAllowed(url, [], []);
}

export function matchesForUrl(url: string): string[] {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return [`${parsed.origin}/*`];
    }
  } catch {
    // fall through to broad http(s) matches
  }
  return ['http://*/*', 'https://*/*'];
}

export function assertMatchesSafe(matches: string[]): void {
  for (const pattern of matches) {
    const lower = pattern.trim().toLowerCase();
    if (
      lower.startsWith('chrome://') ||
      lower.startsWith('chrome-extension://') ||
      lower.startsWith('javascript:') ||
      lower.startsWith('data:') ||
      lower.startsWith('file:') ||
      lower.startsWith('vbscript:')
    ) {
      throw new URLNotAllowedError(`Match pattern is not allowed: ${pattern}`);
    }
  }
}

async function clearRegistrations(
  api: UserscriptChromeApi,
  contentScriptId: string,
  userScriptId: string,
): Promise<void> {
  try {
    if (api.userScripts) {
      await api.userScripts.unregister({ ids: [userScriptId] });
    }
  } catch {
    // already unregistered
  }
  try {
    await api.scripting.unregisterContentScripts({ ids: [contentScriptId] });
  } catch {
    // already unregistered
  }
}

async function runOnTab(api: UserscriptChromeApi, tabId: number, mode: UserscriptRegistrationMode): Promise<void> {
  const files = filesForMode(mode);
  if (mode === 'chrome.userScripts' && api.userScripts?.execute) {
    await api.userScripts.execute({
      target: { tabId },
      injectImmediately: true,
      world: WORLD,
      js: files.map(file => ({ file })),
    });
    return;
  }

  await api.scripting.executeScript({
    target: { tabId },
    world: WORLD,
    injectImmediately: true,
    files,
  });
}

export async function registerAndRunReviewedUserscript(
  api: UserscriptChromeApi,
  options: RegisterAndRunOptions,
): Promise<RegisterAndRunResult> {
  const { scriptId, tabId, tabUrl } = options;
  if (!isReviewedUserscriptId(scriptId)) {
    throw new Error(`Unknown reviewed userscript id: ${scriptId}`);
  }
  if (!isInjectableUrl(tabUrl)) {
    throw new URLNotAllowedError(`URL: ${tabUrl} is not allowed`);
  }

  const matches = options.matches?.length ? options.matches : matchesForUrl(tabUrl);
  assertMatchesSafe(matches);

  const contentScriptId = contentScriptIdFor(scriptId);
  const userScriptId = userScriptIdFor(scriptId);
  await clearRegistrations(api, contentScriptId, userScriptId);

  let packagedError: string | undefined;
  try {
    await api.scripting.registerContentScripts([
      {
        id: contentScriptId,
        matches,
        runAt: RUN_AT,
        world: WORLD,
        persistAcrossSessions: true,
        js: filesForMode('chrome.scripting.registerContentScripts'),
      },
    ]);
    const mode: UserscriptRegistrationMode = 'chrome.scripting.registerContentScripts';
    await runOnTab(api, tabId, mode);
    return {
      ok: true,
      mode,
      scriptId,
      contentScriptId,
      userScriptId,
      matches,
      js: filesForMode(mode),
      ran: true,
    };
  } catch (error) {
    packagedError = String(error instanceof Error ? error.message : error);
  }

  if (!api.userScripts) {
    throw new Error(
      packagedError || 'chrome.scripting.registerContentScripts failed and chrome.userScripts is unavailable',
    );
  }

  await api.userScripts.register([
    {
      id: userScriptId,
      matches,
      runAt: RUN_AT,
      world: WORLD,
      js: filesForMode('chrome.userScripts').map(file => ({ file })),
    },
  ]);
  const mode: UserscriptRegistrationMode = 'chrome.userScripts';
  await runOnTab(api, tabId, mode);
  return {
    ok: true,
    mode,
    scriptId,
    contentScriptId,
    userScriptId,
    matches,
    js: filesForMode(mode),
    ran: true,
    packagedError,
  };
}
