import {
  helperFilesForMode,
  isReviewedUserscriptId,
  PAYLOAD_IDENTITY_HOOKS,
  type ReviewedUserscriptId,
  type UserscriptRegistrationMode,
} from './catalog';
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

const DANGEROUS_SOURCE_MARKERS = ['chrome://', 'chrome-extension://', 'javascript:', 'data:'] as const;

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
  const lowered = source.toLowerCase();
  for (const marker of DANGEROUS_SOURCE_MARKERS) {
    if (lowered.includes(marker)) {
      throw new Error(`rewrite_userscript source contains forbidden ${marker} injection trick`);
    }
  }
  if (!looksLikeUserscript(source)) {
    throw new Error('rewrite_userscript source must look like a userscript IIFE');
  }
  for (const hook of PAYLOAD_IDENTITY_HOOKS[scriptId]) {
    if (!source.includes(hook)) {
      throw new Error(`rewrite_userscript source for ${scriptId} must include ${hook}`);
    }
  }
}

/**
 * Serialized into the tab MAIN world. Do not close over module locals.
 * Evaluates overlay bytes in-page so they never travel through a blob:/data: URL.
 */
export function injectUserscriptSourceInPage(source: string): void {
  if (typeof source !== 'string' || !source) {
    throw new Error('overlay source is empty');
  }
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
 * One-shot MAIN-world inject of helper files + overlay source via func/args.
 * Does not registerContentScripts (packaged seed registration would re-inject the seed).
 * Does not pass source through a page URL.
 */
export async function injectReviewedOverlay(
  api: UserscriptChromeApi,
  tabId: number,
  overlay: UserscriptOverlay,
  scriptId: string,
): Promise<OverlayInjectResult> {
  if (!isReviewedUserscriptId(scriptId)) {
    throw new Error(`Unknown reviewed userscript id: ${scriptId}`);
  }
  assertOverlayMatchesScript(overlay, scriptId);

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
      await api.scripting.executeScript({
        target: { tabId },
        world: WORLD,
        injectImmediately: true,
        args: [overlay.source],
        func: injectUserscriptSourceInPage,
      });
      return {
        mode: OVERLAY_INJECT_MODE,
        scriptId,
        js: [...helpers, `overlay:${overlay.scriptId}:${overlay.sourceHash}`],
        sourceHash: overlay.sourceHash,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError || 'overlay executeScript failed'));
}
