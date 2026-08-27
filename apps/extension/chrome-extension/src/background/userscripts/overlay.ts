import { isReviewedUserscriptId, type ReviewedUserscriptId } from './catalog';

/** Per-script chrome.storage.local key. Packaged public/userscripts/*.user.js files stay the reviewed seed. */
export const OVERLAY_STORAGE_KEY_PREFIX = 'nano.userscript.overlay.';

export type UserscriptOverlay = {
  scriptId: ReviewedUserscriptId;
  source: string;
  rewrittenAt: number;
  sourceHash: string;
};

export type OverlayMap = Partial<Record<ReviewedUserscriptId, UserscriptOverlay>>;

export interface OverlayStorageArea {
  get: (keys: string | string[]) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (keys: string | string[]) => Promise<void>;
}

export interface OverlayStorageApi {
  local: OverlayStorageArea;
}

export function overlayStorageKeyFor(scriptId: string): string {
  return `${OVERLAY_STORAGE_KEY_PREFIX}${scriptId}`;
}

export function chromeOverlayStorage(): OverlayStorageApi {
  const storage = (globalThis as { chrome?: { storage?: OverlayStorageApi } }).chrome?.storage;
  if (!storage?.local) {
    throw new Error('chrome.storage.local is unavailable');
  }
  return storage;
}

export function createMemoryOverlayStorage(initial: OverlayMap = {}): OverlayStorageApi {
  const data: Record<string, unknown> = {};
  for (const [scriptId, overlay] of Object.entries(initial)) {
    data[overlayStorageKeyFor(scriptId)] = overlay;
  }
  return {
    local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const key of list) {
          if (key in data) {
            out[key] = data[key];
          }
        }
        return out;
      },
      async set(items) {
        Object.assign(data, items);
      },
      async remove(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const key of list) {
          delete data[key];
        }
      },
    },
  };
}

/**
 * Overlay for this reviewed id, or null if the packaged seed should run.
 * Fail-closed if a stored record's scriptId does not match the lookup id.
 */
export async function getOverlayForScript(
  storage: OverlayStorageApi,
  scriptId: string,
): Promise<UserscriptOverlay | null> {
  if (!isReviewedUserscriptId(scriptId)) {
    throw new Error(`Unknown reviewed userscript id: ${scriptId}`);
  }
  const key = overlayStorageKeyFor(scriptId);
  const got = await storage.local.get(key);
  const overlay = got[key] as UserscriptOverlay | undefined;
  if (!overlay) {
    return null;
  }
  assertOverlayMatchesScript(overlay, scriptId);
  return overlay;
}

export function assertOverlayMatchesScript(overlay: UserscriptOverlay, scriptId: string): void {
  if (!overlay || typeof overlay !== 'object') {
    throw new Error('Refusing inject: overlay is missing');
  }
  if (overlay.scriptId !== scriptId) {
    throw new Error(
      `Refusing inject: overlay scriptId ${overlay.scriptId} does not match selected ${scriptId}`,
    );
  }
}

export async function putOverlay(storage: OverlayStorageApi, overlay: UserscriptOverlay): Promise<void> {
  assertOverlayMatchesScript(overlay, overlay.scriptId);
  await storage.local.set({ [overlayStorageKeyFor(overlay.scriptId)]: overlay });
}

export async function deleteOverlay(storage: OverlayStorageApi, scriptId: string): Promise<void> {
  if (!isReviewedUserscriptId(scriptId)) {
    throw new Error(`Unknown reviewed userscript id: ${scriptId}`);
  }
  await storage.local.remove(overlayStorageKeyFor(scriptId));
}
