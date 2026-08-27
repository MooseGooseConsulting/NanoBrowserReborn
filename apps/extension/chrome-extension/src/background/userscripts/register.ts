import { isUrlAllowed } from '@src/background/browser/util';
import { URLNotAllowedError } from '@src/background/browser/views';
import { createLogger } from '@src/background/log';
import {
  allContentScriptIds,
  allUserScriptIds,
  contentScriptIdFor,
  filesForMode,
  isReviewedUserscriptId,
  REVIEWED_USERSCRIPT_HOSTS,
  type ReviewedUserscriptId,
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
 *
 * Matches are origin-scoped (no ports, no all-sites fallback). Fallback to
 * chrome.userScripts happens only when packaged *registration* fails — not when
 * immediate runOnTab fails after a successful register.
 */

const logger = createLogger('Userscripts');

export const RUN_AT = 'document_end' as const;
export const WORLD = 'MAIN' as const;

export interface UserscriptChromeApi {
  userScripts?: {
    register: (scripts: unknown[]) => Promise<void>;
    unregister: (filter: { ids: string[] }) => Promise<void>;
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
  allowList?: string[];
  denyList?: string[];
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

export function isInjectableHttpUrl(url: string, allowList: string[] = [], denyList: string[] = []): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
  } catch {
    return false;
  }
  return isUrlAllowed(url, allowList, denyList);
}

/** @deprecated use isInjectableHttpUrl — kept for call sites that still import the old name */
export function isInjectableUrl(url: string, allowList: string[] = [], denyList: string[] = []): boolean {
  return isInjectableHttpUrl(url, allowList, denyList);
}

export function originMatchPattern(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new URLNotAllowedError(`URL: ${url} is not allowed`);
  }
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export function matchesForUrl(url: string): string[] {
  return [originMatchPattern(url)];
}

export function isSameOriginMatchPattern(pattern: string, tabUrl: string): boolean {
  let parsedTab: URL;
  try {
    parsedTab = new URL(tabUrl);
  } catch {
    return false;
  }
  if (parsedTab.protocol !== 'http:' && parsedTab.protocol !== 'https:') {
    return false;
  }
  const host = parsedTab.hostname;
  const originPrefix = `${parsedTab.protocol}//${host}/`;
  const trimmed = pattern.trim();
  if (trimmed === `${parsedTab.protocol}//${host}/*`) {
    return true;
  }
  return trimmed.startsWith(originPrefix) && !trimmed.includes('://*') && !trimmed.startsWith('*://');
}

function representativeUrlFromMatch(pattern: string): string | null {
  const match = pattern.trim().match(/^(https?):\/\/([^*/]+)(\/.*)?$/i);
  if (!match) {
    return null;
  }
  return `${match[1].toLowerCase()}://${match[2]}/`;
}

export function resolveRegistrationMatches(
  tabUrl: string,
  requested: string[] | undefined,
  allowList: string[] = [],
  denyList: string[] = [],
): string[] {
  if (!isInjectableHttpUrl(tabUrl, allowList, denyList)) {
    throw new URLNotAllowedError(`URL: ${tabUrl} is not allowed`);
  }

  const originOnly = matchesForUrl(tabUrl);
  const candidates = requested?.length ? requested : originOnly;

  for (const pattern of candidates) {
    if (!isSameOriginMatchPattern(pattern, tabUrl)) {
      throw new URLNotAllowedError(`Match pattern is not a same-origin subset of the current tab: ${pattern}`);
    }
    const representative = representativeUrlFromMatch(pattern);
    if (!representative || !isUrlAllowed(representative, allowList, denyList)) {
      throw new URLNotAllowedError(`Match pattern is not allowed: ${pattern}`);
    }
  }

  return candidates;
}

/**
 * Drop every reviewed registration, not only the id about to run. Sticky leftover
 * scripts from a previous id (fixture then organize) must not stay on the origin.
 */
async function clearRegistrations(api: UserscriptChromeApi): Promise<void> {
  try {
    if (api.userScripts) {
      await api.userScripts.unregister({ ids: allUserScriptIds() });
    }
  } catch (error) {
    logger.warning('unregister userScripts failed', error);
  }
  try {
    await api.scripting.unregisterContentScripts({ ids: allContentScriptIds() });
  } catch (error) {
    logger.warning('unregisterContentScripts failed', error);
  }
}

async function runOnTab(
  api: UserscriptChromeApi,
  tabId: number,
  mode: UserscriptRegistrationMode,
  scriptId: string,
): Promise<void> {
  // Immediate inject always uses chrome.scripting.executeScript (works without Chrome 135+
  // userScripts.execute). Registration may still use chrome.userScripts.register as fallback.
  await api.scripting.executeScript({
    target: { tabId },
    world: WORLD,
    injectImmediately: true,
    files: filesForMode(mode, scriptId),
  });
}

function successResult(
  options: RegisterAndRunOptions,
  mode: UserscriptRegistrationMode,
  matches: string[],
  packagedError?: string,
): RegisterAndRunResult {
  return {
    ok: true,
    mode,
    scriptId: options.scriptId,
    contentScriptId: contentScriptIdFor(options.scriptId),
    userScriptId: userScriptIdFor(options.scriptId),
    matches,
    js: filesForMode(mode, options.scriptId),
    ran: true,
    packagedError,
  };
}

export function assertUserscriptOrigin(scriptId: ReviewedUserscriptId, tabUrl: string): void {
  const hosts = REVIEWED_USERSCRIPT_HOSTS[scriptId];
  if (!hosts.length) {
    return;
  }
  let hostname: string;
  try {
    hostname = new URL(tabUrl).hostname;
  } catch {
    throw new URLNotAllowedError(`URL: ${tabUrl} is not allowed`);
  }
  if (!hosts.includes(hostname)) {
    throw new URLNotAllowedError(`Userscript ${scriptId} is not allowed on ${hostname}`);
  }
}

export async function registerAndRunReviewedUserscript(
  api: UserscriptChromeApi,
  options: RegisterAndRunOptions,
): Promise<RegisterAndRunResult> {
  const { scriptId, tabId, tabUrl } = options;
  const allowList = options.allowList ?? [];
  const denyList = options.denyList ?? [];

  if (!isReviewedUserscriptId(scriptId)) {
    throw new Error(`Unknown reviewed userscript id: ${scriptId}`);
  }

  assertUserscriptOrigin(scriptId, tabUrl);

  const matches = resolveRegistrationMatches(tabUrl, options.matches, allowList, denyList);
  const contentScriptId = contentScriptIdFor(scriptId);
  const userScriptId = userScriptIdFor(scriptId);
  await clearRegistrations(api);

  let packagedError: string | undefined;
  let packagedRegistered = false;
  try {
    await api.scripting.registerContentScripts([
      {
        id: contentScriptId,
        matches,
        runAt: RUN_AT,
        world: WORLD,
        persistAcrossSessions: false,
        js: filesForMode('chrome.scripting.registerContentScripts', scriptId),
      },
    ]);
    packagedRegistered = true;
  } catch (error) {
    packagedError = String(error instanceof Error ? error.message : error);
  }

  if (packagedRegistered) {
    try {
      await runOnTab(api, tabId, 'chrome.scripting.registerContentScripts', scriptId);
      return successResult(options, 'chrome.scripting.registerContentScripts', matches);
    } catch (error) {
      await clearRegistrations(api);
      throw error;
    }
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
      persistAcrossSessions: false,
      js: filesForMode('chrome.userScripts', scriptId).map(file => ({ file })),
    },
  ]);

  try {
    await runOnTab(api, tabId, 'chrome.userScripts', scriptId);
    return successResult(options, 'chrome.userScripts', matches, packagedError);
  } catch (error) {
    await clearRegistrations(api);
    throw error;
  }
}
