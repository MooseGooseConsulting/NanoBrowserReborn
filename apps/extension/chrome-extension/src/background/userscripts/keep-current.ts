import { CHATGPT_ORGANIZE_SCRIPT_ID, isReviewedUserscriptId, payloadFileFor } from './catalog';
import { getOverlayForScript, type OverlayStorageApi, type UserscriptOverlay } from './overlay';
import { hashSource } from './rewrite';

export type KeepCurrentActionResult = {
  error: string;
  extractedContent: string | null;
  includeInMemory: true;
};

/** Navigator memory uses error.split('\\n').pop() — keep this marker on one line. */
export const KEEP_CURRENT_ERROR_PREFIX = 'KEEP_CURRENT';
export const KEEP_CURRENT_PAYLOAD_HEADER = 'KEEP_CURRENT_PAYLOAD';
export const USERSCRIPT_BEGIN = '-----BEGIN USERSCRIPT-----';
export const USERSCRIPT_END = '-----END USERSCRIPT-----';

export type KeepCurrentEligibleKind = 'timeout_waiting_for_done' | 'contract_or_action_drift';
export type KeepCurrentKind = KeepCurrentEligibleKind | 'already_retried' | 'not_eligible';
export type KeepCurrentSourceKind = 'overlay' | 'seed' | 'unavailable';

export type KeepCurrentPayload = {
  source: string;
  kind: 'overlay' | 'seed';
  sourceHash: string;
};

type PackagedSeedLoader = (file: string) => Promise<string>;

let packagedSeedLoaderForTests: PackagedSeedLoader | null = null;

export function setPackagedSeedLoaderForTests(loader: PackagedSeedLoader | null): void {
  packagedSeedLoaderForTests = loader;
}

function oneLine(text: string): string {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function isAuthOrRateLimitFailure(reason: string): boolean {
  return /not signed in/i.test(reason) || /\b(401|403|429)\b/.test(reason);
}

function isOriginOrSerializeFailure(reason: string): boolean {
  return (
    /already in flight/i.test(reason) ||
    /is not allowed/i.test(reason) ||
    /only allowed on chatgpt\.com/i.test(reason) ||
    /overlay inject refused/i.test(reason) ||
    /URL: .* is not allowed/i.test(reason)
  );
}

function isRunnerInfrastructureFailure(reason: string): boolean {
  return (
    /one-shot only/i.test(reason) ||
    /executeScript failed/i.test(reason) ||
    /userScripts\.execute/i.test(reason) ||
    /chrome\.storage\.local is unavailable/i.test(reason) ||
    /Unknown reviewed userscript/i.test(reason) ||
    /forbidden .* injection trick/i.test(reason)
  );
}

/**
 * Keep-current is for seed/API drift on chatgpt-organize, not login or origin lock.
 * Timeout waiting for `__nanoChatGptOrganize.done` and contract/action errors are eligible.
 */
export function classifyOrganizeKeepCurrentFailure(
  reason: string,
): { eligible: true; kind: KeepCurrentEligibleKind } | { eligible: false; kind: 'not_eligible' } {
  const text = String(reason || '');
  if (!text) {
    return { eligible: false, kind: 'not_eligible' };
  }
  if (isAuthOrRateLimitFailure(text) || isOriginOrSerializeFailure(text) || isRunnerInfrastructureFailure(text)) {
    return { eligible: false, kind: 'not_eligible' };
  }
  if (/timed out waiting for done/i.test(text) || /did not (report a result|finish)/i.test(text) || /chatgpt-organize timed out/i.test(text)) {
    return { eligible: true, kind: 'timeout_waiting_for_done' };
  }
  if (
    /missing contract token/i.test(text) ||
    /rename failed/i.test(text) ||
    /rejected: success\s*=\s*false/i.test(text) ||
    /conversation fetch failed/i.test(text) ||
    /failed: (?:404|410|422)/i.test(text)
  ) {
    return { eligible: true, kind: 'contract_or_action_drift' };
  }
  if (/chatgpt-organize/i.test(text) && !/rewrite_userscript/i.test(text)) {
    return { eligible: true, kind: 'contract_or_action_drift' };
  }
  return { eligible: false, kind: 'not_eligible' };
}

export function formatKeepCurrentErrorLine(input: {
  kind: Exclude<KeepCurrentKind, 'not_eligible'>;
  reason: string;
  sourceKind?: KeepCurrentSourceKind;
}): string {
  const reason = oneLine(input.reason);
  if (input.kind === 'already_retried') {
    return oneLine(
      `${KEEP_CURRENT_ERROR_PREFIX} already_retried: ${reason} after rewrite_userscript this task. Do not rewrite again.`,
    );
  }
  const sourceKind = input.sourceKind || 'unavailable';
  return oneLine(
    `${KEEP_CURRENT_ERROR_PREFIX} ${input.kind} source_kind=${sourceKind}: ${reason}. Call rewrite_userscript with a repaired overlay that keeps the same contract tokens and same-origin fetch title PATCH semantics, then run_userscript once. Do not rewrite for signed-out, 401, origin lock, or overlapping organize.`,
  );
}

export function formatKeepCurrentPayloadContent(payload: KeepCurrentPayload & { scriptId: string }): string {
  return [
    `${KEEP_CURRENT_PAYLOAD_HEADER} script_id=${payload.scriptId} source_kind=${payload.kind} source_hash=${payload.sourceHash}`,
    USERSCRIPT_BEGIN,
    payload.source,
    USERSCRIPT_END,
  ].join('\n');
}

/** Round-trip the fenced bytes Chrome would run (overlay source or packaged seed). */
export function extractKeepCurrentPayloadSource(extractedContent: string): string {
  const beginAt = extractedContent.indexOf(USERSCRIPT_BEGIN);
  if (beginAt < 0) {
    throw new Error('KEEP_CURRENT_PAYLOAD missing userscript fences');
  }
  const sourceStart = beginAt + USERSCRIPT_BEGIN.length + 1;
  const endNeedle = `\n${USERSCRIPT_END}`;
  const endAt = extractedContent.lastIndexOf(endNeedle);
  if (endAt < sourceStart) {
    throw new Error('KEEP_CURRENT_PAYLOAD missing userscript fences');
  }
  return extractedContent.slice(sourceStart, endAt);
}

export async function loadPackagedSeedSource(scriptId: string): Promise<string> {
  if (!isReviewedUserscriptId(scriptId)) {
    throw new Error(`Unknown reviewed userscript id: ${scriptId}`);
  }
  const file = payloadFileFor(scriptId);
  if (packagedSeedLoaderForTests) {
    return packagedSeedLoaderForTests(file);
  }
  const getURL = (globalThis as { chrome?: { runtime?: { getURL?: (path: string) => string } } }).chrome?.runtime
    ?.getURL;
  if (typeof getURL !== 'function') {
    throw new Error('chrome.runtime.getURL is unavailable');
  }
  const response = await fetch(getURL(file));
  if (!response.ok) {
    throw new Error(`Failed to load packaged seed ${file}: ${response.status}`);
  }
  return response.text();
}

export async function loadCurrentKeepCurrentPayload(
  storage: OverlayStorageApi,
  scriptId: string,
): Promise<KeepCurrentPayload> {
  const overlay = await getOverlayForScript(storage, scriptId);
  if (overlay) {
    return { source: overlay.source, kind: 'overlay', sourceHash: overlay.sourceHash };
  }
  const source = await loadPackagedSeedSource(scriptId);
  return { source, kind: 'seed', sourceHash: await hashSource(source) };
}

/**
 * Surface keep-current classification in ActionResult so Navigator memory sees it.
 * extractedContent is the same overlay/seed bytes Chrome would inject; error is one line.
 */
export async function buildKeepCurrentActionResult(options: {
  reason: string;
  scriptId?: string;
  storage: OverlayStorageApi;
  alreadyRewritten: boolean;
  /** Overlay/seed snapshot actually injected this run. Omit in tests to load from storage. */
  injected?: { kind: 'overlay'; overlay: UserscriptOverlay } | { kind: 'seed' };
}): Promise<KeepCurrentActionResult> {
  const scriptId = options.scriptId || CHATGPT_ORGANIZE_SCRIPT_ID;
  const classified = classifyOrganizeKeepCurrentFailure(options.reason);
  if (!classified.eligible) {
    return { error: options.reason, extractedContent: null, includeInMemory: true };
  }
  if (options.alreadyRewritten) {
    return {
      error: formatKeepCurrentErrorLine({ kind: 'already_retried', reason: options.reason }),
      extractedContent: null,
      includeInMemory: true,
    };
  }
  let payload: KeepCurrentPayload | null = null;
  try {
    if (options.injected?.kind === 'overlay') {
      payload = {
        source: options.injected.overlay.source,
        kind: 'overlay',
        sourceHash: options.injected.overlay.sourceHash,
      };
    } else if (options.injected?.kind === 'seed') {
      const source = await loadPackagedSeedSource(scriptId);
      payload = { source, kind: 'seed', sourceHash: await hashSource(source) };
    } else {
      payload = await loadCurrentKeepCurrentPayload(options.storage, scriptId);
    }
  } catch {
    payload = null;
  }
  return {
    error: formatKeepCurrentErrorLine({
      kind: classified.kind,
      reason: options.reason,
      sourceKind: payload?.kind ?? 'unavailable',
    }),
    extractedContent: payload ? formatKeepCurrentPayloadContent({ scriptId, ...payload }) : null,
    includeInMemory: true,
  };
}
