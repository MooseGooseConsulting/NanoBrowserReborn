import { describe, expect, it } from 'vitest';
import {
  formatHyperagentObserveHandoff,
  HYPERAGENT_OBSERVE_HANDOFF_TIMEOUT_MS,
  waitForHyperagentObserveHandoff,
} from '../hyperagent-observe-run';
import type { UserscriptChromeApi } from '../register';

describe('Hyperagent observe action handoff', () => {
  it('reads the MAIN-world result and returns rows as machine-readable action content', async () => {
    const calls: unknown[] = [];
    const api: UserscriptChromeApi = {
      scripting: {
        registerContentScripts: async () => {},
        unregisterContentScripts: async () => {},
        executeScript: async injection => {
          calls.push(injection);
          return [
            {
              result: {
                loaded: true,
                scriptId: 'hyperagent-observe',
                origin: 'https://hyperagent.com',
                threadId: 'thr_1',
                signedIn: true,
                rows: [{ n: 1, threadId: 'thr_1', costDelta: 0.12 }],
                latest: { running: false, phase: { k: 'waiting' } },
                streamEvents: 2,
                streamUp: true,
                fetches: [],
                mutatingCalls: [],
                error: null,
              },
            },
          ];
        },
      },
    };

    const result = await waitForHyperagentObserveHandoff(api, 77);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      target: { tabId: 77 },
      world: 'MAIN',
      injectImmediately: true,
      args: [HYPERAGENT_OBSERVE_HANDOFF_TIMEOUT_MS],
    });
    expect(typeof (calls[0] as { func?: unknown }).func).toBe('function');

    const content = JSON.parse(formatHyperagentObserveHandoff(result));
    expect(content).toMatchObject({
      script_id: 'hyperagent-observe',
      thread_id: 'thr_1',
      signed_in: true,
      rows: [{ n: 1, costDelta: 0.12 }],
    });
  });

  it('rejects an absent or wrong page-global observer result', async () => {
    const api: UserscriptChromeApi = {
      scripting: {
        registerContentScripts: async () => {},
        unregisterContentScripts: async () => {},
        executeScript: async () => [{ result: null }],
      },
    };

    await expect(waitForHyperagentObserveHandoff(api, 1, 1)).rejects.toThrow(/timed out waiting for an observation handoff/);
  });
});
