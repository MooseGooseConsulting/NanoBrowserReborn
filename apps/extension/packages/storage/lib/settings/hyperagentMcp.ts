import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

export interface HyperagentMcpSessionConfig {
  accessToken: string;
}

export type HyperagentMcpSessionStorage = BaseStorage<HyperagentMcpSessionConfig> & {
  setAccessToken: (accessToken: string) => Promise<void>;
  getAccessToken: () => Promise<string>;
  hasAccessToken: () => Promise<boolean>;
  clearAccessToken: () => Promise<void>;
};

const EMPTY_CONFIG: HyperagentMcpSessionConfig = { accessToken: '' };

// A bearer credential must not be available to page scripts or persisted on disk.
// Chrome clears storage.session when the browser restarts and keeps it extension-only
// unless explicitly exposed to content scripts (which this store never does).
const storage = createStorage<HyperagentMcpSessionConfig>('hyperagent-mcp-session', EMPTY_CONFIG, {
  storageEnum: StorageEnum.Session,
  liveUpdate: true,
});

export const hyperagentMcpStore: HyperagentMcpSessionStorage = {
  ...storage,
  async setAccessToken(accessToken: string) {
    const normalized = accessToken.trim();
    if (!normalized) {
      throw new Error('Hyperagent MCP access token cannot be empty');
    }
    await storage.set({ accessToken: normalized });
  },
  async getAccessToken() {
    return (await storage.get()).accessToken.trim();
  },
  async hasAccessToken() {
    return Boolean((await storage.get()).accessToken.trim());
  },
  async clearAccessToken() {
    await storage.set(EMPTY_CONFIG);
  },
};
