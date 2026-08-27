import { isReviewedUserscriptId, type ReviewedUserscriptId } from './catalog';

/** chrome.storage.local key. Packaged public/userscripts/*.user.js files stay the reviewed seed. */
export const OVERLAY_STORAGE_KEY = 'nano.userscript.overlays';

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
}

export interface OverlayStorageApi {
  local: OverlayStorageArea;
}

export function chromeOverlayStorage(): OverlayStorageApi {
  const storage = (globalThis as { chrome?: { storage?: OverlayStorageApi } }).chrome?.storage;
  if (!storage?.local) {
    throw new Error('chrome.storage.local is unavailable');
  }
  return storage;
}

export function createMemoryOverlayStorage(initial: OverlayMap = {}): OverlayStorageApi {
  const data: Record<string, unknown> = {
    [OVERLAY_STORAGE_KEY]: { ...initial },
  };
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
    },
  };
}

export async function readOverlayMap(storage: OverlayStorageApi): Promise<OverlayMap> {
  const got = await storage.local.get(OVERLAY_STORAGE_KEY);
  const raw = got[OVERLAY_STORAGE_KEY];
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  return raw as OverlayMap;
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
  const map = await readOverlayMap(storage);
  const overlay = map[scriptId];
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
  const map = { ...(await readOverlayMap(storage)), [overlay.scriptId]: overlay };
  await storage.local.set({ [OVERLAY_STORAGE_KEY]: map });
}

export async function deleteOverlay(storage: OverlayStorageApi, scriptId: string): Promise<void> {
  if (!isReviewedUserscriptId(scriptId)) {
    throw new Error(`Unknown reviewed userscript id: ${scriptId}`);
  }
  const map = { ...(await readOverlayMap(storage)) };
  delete map[scriptId];
  await storage.local.set({ [OVERLAY_STORAGE_KEY]: map });
}
