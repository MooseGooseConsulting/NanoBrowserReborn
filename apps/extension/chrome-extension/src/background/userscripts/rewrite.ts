import {
  allContentScriptIds,
  allUserScriptIds,
  CHATGPT_ORGANIZE_SCRIPT_ID,
  helperFilesForMode,
  isReviewedUserscriptId,
  PAYLOAD_IDENTITY_HOOKS,
  REVIEWED_USERSCRIPT_HOSTS,
  type ReviewedUserscriptId,
  type UserscriptRegistrationMode,
} from './catalog';
import { assertSourceMatchesChatGptOrganizeContract } from './chatgpt-organize-contract';
import {
  assertOverlayMatchesScript,
  deleteOverlay,
  getOverlayForScript,
  putOverlay,
  type OverlayStorageApi,
  type UserscriptOverlay,
} from './overlay';
import { WORLD, type UserscriptChromeApi } from './register';

export const OVERLAY_INJECT_MODE = 'overlay' as const;

/** Chrome executeScript args have an IPC budget; keep rewritten payloads bounded. */
export const MAX_OVERLAY_SOURCE_BYTES = 256 * 1024;

const DANGEROUS_SCHEME_MARKERS = ['chrome://', 'chrome-extension://', 'javascript:'] as const;

/** `userScripts.execute` is Chrome 135+ and is not on the register.ts surface. */
type OverlayChromeApi = UserscriptChromeApi & {
  userScripts?: UserscriptChromeApi['userScripts'] & {
    execute?: (injection: {
      target: { tabId: number };
      world: typeof WORLD;
      injectImmediately: boolean;
      js: Array<{ code: string }>;
    }) => Promise<unknown>;
  };
};

export type OverlayInjectResult = {
  mode: typeof OVERLAY_INJECT_MODE;
  scriptId: ReviewedUserscriptId;
  js: string[];
  sourceHash: string;
};

function sourceByteLength(source: string): number {
  return new TextEncoder().encode(source).byteLength;
}

export async function hashSource(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function looksLikeUserscript(source: string): boolean {
  return /\(\s*(?:async\s*)?(?:function\s*\(|\(\s*\)\s*=>)/.test(source);
}

function forbiddenInjectionTrick(source: string): string | null {
  const lowered = source.toLowerCase();
  for (const marker of DANGEROUS_SCHEME_MARKERS) {
    if (lowered.includes(marker)) {
      return marker;
    }
  }
  // Require a data-URL shape so `{ data: value }` object literals are not rejected.
  if (/data:(?:[a-z0-9.+-]+\/[a-z0-9.+-]+|;|,)/i.test(source)) {
    return 'data:';
  }
  return null;
}

export function validateOverlaySource(scriptId: string, source: unknown): asserts source is string {
  if (!isReviewedUserscriptId(scriptId)) {
    throw new Error(`Unknown reviewed userscript id: ${scriptId}`);
  }
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error('rewrite_userscript source is empty; pass reset: true to restore the packaged seed');
  }
  if (sourceByteLength(source) > MAX_OVERLAY_SOURCE_BYTES) {
    throw new Error(`rewrite_userscript source exceeds ${MAX_OVERLAY_SOURCE_BYTES} bytes`);
  }
  const trick = forbiddenInjectionTrick(source);
  if (trick) {
    throw new Error(`rewrite_userscript source contains forbidden ${trick} injection trick`);
  }
  if (!looksLikeUserscript(source)) {
    throw new Error('rewrite_userscript source must look like a userscript IIFE');
  }
  for (const hook of PAYLOAD_IDENTITY_HOOKS[scriptId]) {
    if (!source.includes(hook)) {
      throw new Error(`rewrite_userscript source for ${scriptId} must include ${hook}`);
    }
  }
  if (scriptId === CHATGPT_ORGANIZE_SCRIPT_ID) {
    assertSourceMatchesChatGptOrganizeContract(source);
  }
}

/**
 * Serialized into the tab MAIN world. Do not close over module locals.
 * Live location is checked in the same invocation that runs overlay source.
 */
export function assertInjectablePageLocation(allowedHosts: readonly string[] = []): void {
  let href = '';
  try {
    href = String((globalThis as { location?: { href?: string } }).location?.href || '');
  } catch {
    href = '';
  }
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    throw new Error('overlay inject refused: page URL is not injectable');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`overlay inject refused: ${parsed.protocol} is not allowed`);
  }
  const hosts = Array.isArray(allowedHosts) ? allowedHosts : [];
  if (hosts.length && !hosts.includes(parsed.hostname)) {
    throw new Error(`overlay inject refused: ${parsed.hostname} is not allowed`);
  }
}

export function wrapOverlaySourceWithOriginLock(source: string, allowedHosts: readonly string[] = []): string {
  if (typeof source !== 'string' || !source) {
    throw new Error('overlay source is empty');
  }
  return `(${assertInjectablePageLocation.toString()})(${JSON.stringify([...allowedHosts])});\n${source}`;
}

/**
 * Serialized into the tab MAIN world. Do not close over module locals.
 * Fallback path when chrome.userScripts.execute is unavailable (Chrome < 135).
 * Live location is checked in this same invocation so a tab navigation cannot
 * bypass the origin lock between helper inject and source eval.
 */
export function injectUserscriptSourceInPage(source: string, allowedHosts: readonly string[] = []): void {
  if (typeof source !== 'string' || !source) {
    throw new Error('overlay source is empty');
  }
  assertInjectablePageLocation(allowedHosts);
  const run = globalThis.eval;
  run(source);
}

export async function rewriteUserscript(
  storage: OverlayStorageApi,
  options: { scriptId: string; source?: string | null; reset?: boolean },
): Promise<{ ok: true; scriptId: ReviewedUserscriptId; sourceHash: string | null; reset: boolean }> {
  const { scriptId } = options;
  if (!isReviewedUserscriptId(scriptId)) {
    throw new Error(`Unknown reviewed userscript id: ${scriptId}`);
  }

  if (options.reset === true) {
    await deleteOverlay(storage, scriptId);
    return { ok: true, scriptId, sourceHash: null, reset: true };
  }

  validateOverlaySource(scriptId, options.source);
  const sourceHash = await hashSource(options.source);
  const overlay: UserscriptOverlay = {
    scriptId,
    source: options.source,
    rewrittenAt: Date.now(),
    sourceHash,
  };
  await putOverlay(storage, overlay);
  return { ok: true, scriptId, sourceHash, reset: false };
}

export async function resolveRunSource(
  storage: OverlayStorageApi,
  scriptId: string,
): Promise<UserscriptOverlay | null> {
  return getOverlayForScript(storage, scriptId);
}

/**
 * Drop leftover packaged registrations so a previous seed run cannot auto-inject
 * beside or after this overlay on later same-origin navigations.
 */
async function clearReviewedRegistrations(api: OverlayChromeApi): Promise<void> {
  try {
    if (api.userScripts) {
      await api.userScripts.unregister({ ids: allUserScriptIds() });
    }
  } catch {
    // ids may not be registered
  }
  try {
    await api.scripting.unregisterContentScripts({ ids: allContentScriptIds() });
  } catch {
    // ids may not be registered
  }
}

async function injectHelperFiles(api: OverlayChromeApi, tabId: number): Promise<string[]> {
  const attempts: UserscriptRegistrationMode[] = [
    'chrome.scripting.registerContentScripts',
    'chrome.userScripts',
  ];
  let lastError: unknown;
  for (const mode of attempts) {
    const helpers = helperFilesForMode(mode);
    try {
      await api.scripting.executeScript({
        target: { tabId },
        world: WORLD,
        injectImmediately: true,
        files: helpers,
      });
      return helpers;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError || 'overlay helper executeScript failed'));
}

async function injectOverlaySource(
  api: OverlayChromeApi,
  tabId: number,
  source: string,
  allowedHosts: readonly string[],
): Promise<void> {
  const execute = api.userScripts?.execute;
  if (typeof execute === 'function') {
    await execute({
      target: { tabId },
      world: WORLD,
      injectImmediately: true,
      js: [{ code: wrapOverlaySourceWithOriginLock(source, allowedHosts) }],
    });
    return;
  }
  await api.scripting.executeScript({
    target: { tabId },
    world: WORLD,
    injectImmediately: true,
    args: [source, allowedHosts],
    func: injectUserscriptSourceInPage,
  });
}

/**
 * One-shot MAIN-world inject of helper files + overlay source.
 * Prefers chrome.userScripts.execute({ code }) so page CSP cannot block the overlay.
 * Falls back to executeScript func/args eval when execute is unavailable.
 * Does not registerContentScripts (packaged seed registration would re-inject the seed).
 * Does not pass source through a page URL.
 * Helper-file fallback happens before source evaluation; the overlay is never eval'd twice.
 */
export async function injectReviewedOverlay(
  api: OverlayChromeApi,
  tabId: number,
  overlay: UserscriptOverlay,
  scriptId: string,
): Promise<OverlayInjectResult> {
  if (!isReviewedUserscriptId(scriptId)) {
    throw new Error(`Unknown reviewed userscript id: ${scriptId}`);
  }
  assertOverlayMatchesScript(overlay, scriptId);
  await clearReviewedRegistrations(api);

  const helpers = await injectHelperFiles(api, tabId);
  const allowedHosts = [...REVIEWED_USERSCRIPT_HOSTS[scriptId]];
  await injectOverlaySource(api, tabId, overlay.source, allowedHosts);
  return {
    mode: OVERLAY_INJECT_MODE,
    scriptId,
    js: [...helpers, `overlay:${overlay.scriptId}:${overlay.sourceHash}`],
    sourceHash: overlay.sourceHash,
  };
}
