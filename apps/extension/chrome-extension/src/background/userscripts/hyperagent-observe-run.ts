import { WORLD, type UserscriptChromeApi } from './register';

export const HYPERAGENT_OBSERVE_HANDOFF_TIMEOUT_MS = 60_000;

export interface HyperagentObservePageResult {
  loaded: boolean;
  scriptId: 'hyperagent-observe';
  origin: string;
  threadId: string | null;
  signedIn: boolean;
  rows: unknown[];
  ledger?: unknown[];
  latest: { running?: boolean; phase?: { k?: string } } | null;
  billing?: unknown | null;
  billingError?: string | null;
  streamEvents: number;
  streamUp: boolean | null;
  fetches: unknown[];
  mutatingCalls: unknown[];
  error: string | null;
  timedOut?: boolean;
}

type InjectionResult = { result?: HyperagentObservePageResult };

/**
 * Runs in the page MAIN world. The observer itself is intentionally long-lived;
 * this function hands the action an initial idle/error snapshot or the first
 * completed row for an active run, rather than claiming injection is telemetry.
 */
export function waitForHyperagentObserveHandoffInPage(timeoutMs: number): Promise<HyperagentObservePageResult | null> {
  const deadline = Date.now() + timeoutMs;
  const pollMs = 50;
  const expectedThreadId = location.pathname.match(/\/thread\/([^/?#]+)/)?.[1] || null;
  const expectedOrigin = location.origin;

  return new Promise(resolve => {
    const inspect = () => {
      const result = (globalThis as { __nanoHyperagentObserve?: HyperagentObservePageResult }).__nanoHyperagentObserve;
      if (!result) {
        if (Date.now() >= deadline) { resolve(null); return; }
        setTimeout(inspect, pollMs);
        return;
      }

      if (result.origin !== expectedOrigin || result.threadId !== expectedThreadId) {
        if (Date.now() >= deadline) { resolve(null); return; }
        setTimeout(inspect, pollMs);
        return;
      }

      const rows = Array.isArray(result.rows) ? result.rows : [];
      const ledger = Array.isArray(result.ledger) ? result.ledger : [];
      const running = Boolean(result.latest?.running);
      if (result.error || rows.length > 0 || (result.latest && !running) || Date.now() >= deadline) {
        resolve({
          loaded: result.loaded === true,
          scriptId: 'hyperagent-observe',
          origin: typeof result.origin === 'string' ? result.origin : '',
          threadId: typeof result.threadId === 'string' ? result.threadId : null,
          signedIn: result.signedIn === true,
          rows: rows.slice(0, 300),
          ledger: ledger.slice(-2500),
          latest: result.latest || null,
          billing: result.billing || null,
          billingError: typeof result.billingError === 'string' ? result.billingError : null,
          streamEvents: typeof result.streamEvents === 'number' ? result.streamEvents : 0,
          streamUp: typeof result.streamUp === 'boolean' ? result.streamUp : null,
          fetches: Array.isArray(result.fetches) ? result.fetches.slice(0, 40) : [],
          mutatingCalls: Array.isArray(result.mutatingCalls) ? result.mutatingCalls : [],
          error: typeof result.error === 'string' ? result.error : null,
          timedOut: running && !rows.length && Date.now() >= deadline,
        });
        return;
      }
      setTimeout(inspect, pollMs);
    };
    inspect();
  });
}

export async function waitForHyperagentObserveHandoff(
  api: UserscriptChromeApi,
  tabId: number,
  timeoutMs = HYPERAGENT_OBSERVE_HANDOFF_TIMEOUT_MS,
): Promise<HyperagentObservePageResult> {
  const injection = (await api.scripting.executeScript({
    target: { tabId },
    world: WORLD,
    injectImmediately: true,
    args: [timeoutMs],
    func: waitForHyperagentObserveHandoffInPage,
  })) as InjectionResult[] | undefined;
  const result = Array.isArray(injection) ? injection[0]?.result : undefined;
  if (!result || result.scriptId !== 'hyperagent-observe') {
    throw new Error('hyperagent-observe timed out waiting for an observation handoff');
  }
  return result;
}

export function formatHyperagentObserveHandoff(result: HyperagentObservePageResult): string {
  return JSON.stringify({
    script_id: result.scriptId,
    origin: result.origin,
    thread_id: result.threadId,
    signed_in: result.signedIn,
    rows: result.rows,
    ledger: result.ledger || [],
    latest: result.latest,
    billing: result.billing || null,
    billing_error: result.billingError || null,
    stream_events: result.streamEvents,
    stream_up: result.streamUp,
    timed_out: result.timedOut === true,
    error: result.error,
  });
}
