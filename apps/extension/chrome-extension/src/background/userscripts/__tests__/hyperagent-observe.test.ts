import { describe, expect, it } from 'vitest';
import {
  applyObserveSnapshot,
  classifyRunPhase,
  emptyObserveState,
  handleSseData,
  observeJsonResponse,
  runHyperagentObservePass,
  snapshotFromApis,
  threadIdFromPath,
  type ObserveSnapshot,
  type ThreadPayload,
  type ThreadStatusPayload,
  type UsageBreakdownPayload,
  type UsagePayload,
} from '../hyperagent-observe';

const THREAD_ID = 'thr_live_1';

function statusRunning(): ThreadStatusPayload {
  return {
    lastEnqueuedAt: '2026-08-27T12:05:56.063Z',
    turnCompleteAt: '2026-08-27T11:30:24.114Z',
    pendingQueue: [],
    runningTurnSource: 'chat',
    lastRunMessageRole: 'user',
  };
}

function statusWaiting(): ThreadStatusPayload {
  return {
    lastEnqueuedAt: '2026-08-27T12:05:56.063Z',
    turnCompleteAt: '2026-08-27T12:30:24.114Z',
    pendingQueue: [],
    runningTurnSource: 'chat',
    lastRunMessageRole: 'assistant',
  };
}

function threadBody(overrides: Partial<ThreadPayload> = {}): ThreadPayload {
  return {
    modelId: 'deepseek/deepseek-v4-flash',
    messageCount: 12,
    lastMessageIsError: false,
    lastContextIndicator: {
      input_tokens: 2244,
      output_tokens: 1001,
      cache_read_tokens: 81937,
      cache_create_tokens: 0,
    },
    ...overrides,
  };
}

function usageBody(cost: number, capture: UsagePayload['lastCapture']): UsagePayload {
  return {
    lastCapture: capture,
    totals: { total_cost_usd: cost },
  };
}

function breakdownBody(qty: number): UsageBreakdownPayload {
  return {
    items: [
      { name: 'deepseek-v4-flash Tokens', quantity: qty, costUsd: 0.12 },
      { name: 'browserbase', quantity: 2, costUsd: 0.01 },
    ],
    byokTokenUsage: [
      {
        model: 'openai/gpt-5',
        inputTokens: qty > 14_650_000 ? 800 : 100,
        outputTokens: 40,
        cacheReadTokens: 20,
        cacheCreateTokens: 0,
      },
    ],
  };
}

function snap(status: ThreadStatusPayload, usage: UsagePayload, breakdown: UsageBreakdownPayload, at: number): ObserveSnapshot {
  return snapshotFromApis(status, threadBody(), usage, breakdown, at);
}

describe('hyperagent observe reducer', () => {
  it('parses /thread/{id} and classifies the four live run states', () => {
    expect(threadIdFromPath('/thread/abc-123?tab=usage')).toBe('abc-123');
    expect(threadIdFromPath('/agents/x')).toBeNull();

    expect(classifyRunPhase(statusRunning(), threadBody()).k).toBe('running');
    expect(classifyRunPhase(statusRunning(), threadBody()).source).toBe('chat');
    expect(
      classifyRunPhase(
        { ...statusWaiting(), pendingQueue: [{ id: 'next' }], lastEnqueuedAt: statusWaiting().turnCompleteAt },
        threadBody(),
      ).k,
    ).toBe('queued');
    expect(classifyRunPhase(statusWaiting(), threadBody()).k).toBe('waiting');
    expect(classifyRunPhase(statusWaiting(), threadBody({ lastMessageIsError: true })).k).toBe('error');
  });

  it('keeps running when a queue is stacked behind an in-flight turn', () => {
    const phase = classifyRunPhase({ ...statusRunning(), pendingQueue: [{ id: 'yours' }] }, threadBody());
    expect(phase.k).toBe('running');
    expect(phase.queued).toBe(1);
  });

  it('closes exactly one row per lastEnqueuedAt → turnCompleteAt cycle', () => {
    const state = emptyObserveState(THREAD_ID);
    const captureA = {
      input_tokens: 657,
      output_tokens: 433,
      cache_read_tokens: 106636,
      cache_create_tokens: 12,
    };
    const open = applyObserveSnapshot(
      state,
      snap(
        statusRunning(),
        usageBody(0.4, captureA),
        breakdownBody(14_650_000),
        Date.parse('2026-08-27T12:06:00.000Z'),
      ),
    );
    expect(open).toBeNull();
    expect(state.open).not.toBeNull();
    expect(state.turns).toHaveLength(0);

    const stillRunning = applyObserveSnapshot(
      state,
      snap(
        statusRunning(),
        usageBody(0.41, { ...captureA, output_tokens: 500 }),
        breakdownBody(14_800_000),
        Date.parse('2026-08-27T12:10:00.000Z'),
      ),
    );
    expect(stillRunning).toBeNull();
    expect(state.turns).toHaveLength(0);

    const closed = applyObserveSnapshot(
      state,
      snap(
        statusWaiting(),
        usageBody(0.4785, {
          input_tokens: 900,
          output_tokens: 700,
          cache_read_tokens: 110000,
          cache_create_tokens: 12,
        }),
        breakdownBody(15_080_000),
        Date.parse('2026-08-27T12:30:24.114Z'),
      ),
    );
    expect(closed).not.toBeNull();
    expect(state.turns).toHaveLength(1);
    expect(closed?.n).toBe(1);
    expect(closed?.threadId).toBe(THREAD_ID);
    expect(closed?.burn).toBe(430_000);
    expect(closed?.phaseAtClose).toBe('waiting');
    expect(closed?.source).toBe('chat');
    expect(closed?.byok['openai/gpt-5']?.input).toBe(700);
    expect(closed?.calls).toBeGreaterThan(0);
  });

  it('emits one row when a run starts and finishes between snapshots', () => {
    const state = emptyObserveState(THREAD_ID);
    const prior = applyObserveSnapshot(
      state,
      snap(
        {
          lastEnqueuedAt: '2026-08-27T11:00:00.000Z',
          turnCompleteAt: '2026-08-27T11:05:00.000Z',
          pendingQueue: [],
          runningTurnSource: 'chat',
          lastRunMessageRole: 'assistant',
        },
        usageBody(0.2, {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_tokens: 10,
          cache_create_tokens: 0,
        }),
        breakdownBody(14_000_000),
        Date.parse('2026-08-27T11:06:00.000Z'),
      ),
    );
    expect(prior).toBeNull();
    expect(state.turns).toHaveLength(0);

    const missed = applyObserveSnapshot(
      state,
      snap(
        statusWaiting(),
        usageBody(0.4785, {
          input_tokens: 900,
          output_tokens: 700,
          cache_read_tokens: 110000,
          cache_create_tokens: 12,
        }),
        breakdownBody(15_080_000),
        Date.parse('2026-08-27T12:30:24.114Z'),
      ),
    );
    expect(missed).not.toBeNull();
    expect(state.turns).toHaveLength(1);
    expect(missed?.n).toBe(1);
    expect(missed?.startedAt).toBe(Date.parse('2026-08-27T12:05:56.063Z'));
    expect(missed?.endedAt).toBe(Date.parse('2026-08-27T12:30:24.114Z'));
    expect(missed?.burn).toBe(1_080_000);

    const again = applyObserveSnapshot(
      state,
      snap(
        statusWaiting(),
        usageBody(0.4785, {
          input_tokens: 900,
          output_tokens: 700,
          cache_read_tokens: 110000,
          cache_create_tokens: 12,
        }),
        breakdownBody(15_080_000),
        Date.parse('2026-08-27T12:31:00.000Z'),
      ),
    );
    expect(again).toBeNull();
    expect(state.turns).toHaveLength(1);
  });

  it('does not invent a historical row from the first already-complete snapshot', () => {
    const state = emptyObserveState(THREAD_ID);
    const first = applyObserveSnapshot(
      state,
      snap(statusWaiting(), usageBody(0.4785, null), breakdownBody(15_080_000), Date.parse('2026-08-27T12:31:00.000Z')),
    );
    expect(first).toBeNull();
    expect(state.turns).toHaveLength(0);
  });

  it('records equal captures on a later run after resetting seen', () => {
    const state = emptyObserveState(THREAD_ID);
    const capture = {
      input_tokens: 657,
      output_tokens: 433,
      cache_read_tokens: 106636,
      cache_create_tokens: 12,
    };
    applyObserveSnapshot(
      state,
      snap(statusRunning(), usageBody(0.4, capture), breakdownBody(14_650_000), Date.parse('2026-08-27T12:06:00.000Z')),
    );
    applyObserveSnapshot(
      state,
      snap(statusWaiting(), usageBody(0.4785, capture), breakdownBody(15_080_000), Date.parse('2026-08-27T12:30:24.114Z')),
    );
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0].calls).toBeGreaterThan(0);

    applyObserveSnapshot(
      state,
      snap(
        {
          lastEnqueuedAt: '2026-08-27T13:00:00.000Z',
          turnCompleteAt: '2026-08-27T12:30:24.114Z',
          pendingQueue: [],
          runningTurnSource: 'chat',
          lastRunMessageRole: 'user',
        },
        usageBody(0.5, capture),
        breakdownBody(15_080_000),
        Date.parse('2026-08-27T13:00:01.000Z'),
      ),
    );
    const second = applyObserveSnapshot(
      state,
      snap(
        {
          lastEnqueuedAt: '2026-08-27T13:00:00.000Z',
          turnCompleteAt: '2026-08-27T13:04:00.000Z',
          pendingQueue: [],
          runningTurnSource: 'chat',
          lastRunMessageRole: 'assistant',
        },
        usageBody(0.52, capture),
        breakdownBody(15_200_000),
        Date.parse('2026-08-27T13:04:00.000Z'),
      ),
    );
    expect(second).not.toBeNull();
    expect(state.turns).toHaveLength(2);
    expect(second?.n).toBe(2);
    expect(second?.calls).toBeGreaterThan(0);
  });

  it('keeps newest-first numbering after restored history', () => {
    const state = emptyObserveState(THREAD_ID);
    state.turns = [
      {
        n: 50,
        threadId: THREAD_ID,
        startedAt: 1,
        endedAt: 2,
        ms: 1,
        seconds: 0,
        model: null,
        source: 'chat',
        metered: {},
        burn: 0,
        byok: {},
        calls: 0,
        sampled: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, peak: 0 },
        costDelta: 0,
        phaseAtClose: 'waiting',
      },
      {
        n: 49,
        threadId: THREAD_ID,
        startedAt: 1,
        endedAt: 2,
        ms: 1,
        seconds: 0,
        model: null,
        source: 'chat',
        metered: {},
        burn: 0,
        byok: {},
        calls: 0,
        sampled: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, peak: 0 },
        costDelta: 0,
        phaseAtClose: 'waiting',
      },
    ];
    applyObserveSnapshot(
      state,
      snap(statusRunning(), usageBody(0.4, null), breakdownBody(14_650_000), Date.parse('2026-08-27T12:06:00.000Z')),
    );
    const closed = applyObserveSnapshot(
      state,
      snap(statusWaiting(), usageBody(0.4785, null), breakdownBody(15_080_000), Date.parse('2026-08-27T12:30:24.114Z')),
    );
    expect(closed?.n).toBe(51);
    expect(state.turns[0].n).toBe(51);
  });

  it('treats cost-updated SSE as a refresh cue and accumulates stream cost on the open run', () => {
    const state = emptyObserveState(THREAD_ID);
    applyObserveSnapshot(
      state,
      snap(statusRunning(), usageBody(0.4, null), breakdownBody(100), Date.parse('2026-08-27T12:06:00.000Z')),
    );
    expect(handleSseData(state, '{"type":"heartbeat"}')).toBe('ignore');
    expect(handleSseData(state, '{"type":"connected"}')).toBe('ignore');
    expect(handleSseData(state, '{"type":"cost-updated","costDeltaUsd":0.0028}')).toBe('refresh');
    expect(state.streamEvents).toBe(1);
    expect(state.open?.streamCost).toBeCloseTo(0.0028);
    applyObserveSnapshot(
      state,
      snap(statusWaiting(), usageBody(0.4785, null), breakdownBody(15_080_000), Date.parse('2026-08-27T12:30:24.114Z')),
    );
    expect(state.turns[0].costDelta).toBeCloseTo(0.0785);
  });

  it('falls back to SSE cost only when the usage totals did not move', () => {
    const state = emptyObserveState(THREAD_ID);
    applyObserveSnapshot(
      state,
      snap(statusRunning(), usageBody(0.4, null), breakdownBody(100), Date.parse('2026-08-27T12:06:00.000Z')),
    );
    handleSseData(state, '{"type":"cost-updated","costDeltaUsd":0.01}');
    applyObserveSnapshot(
      state,
      snap(statusWaiting(), usageBody(0.4, null), breakdownBody(100), Date.parse('2026-08-27T12:30:24.114Z')),
    );
    expect(state.turns[0].costDelta).toBeCloseTo(0.01);
  });
});

describe('hyperagent observe fetch + SSE pass (mocked)', () => {
  it('GETs status/usage/breakdown/thread, follows SSE, and emits one row with no writes', async () => {
    let statusCalls = 0;
    const calls: { url: string; method: string; body?: string }[] = [];
    const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method || 'GET';
      calls.push({ url, method, body: init?.body });
      if (url.endsWith('/status')) {
        statusCalls += 1;
      }
      const running = statusCalls <= 1;
      if (url.endsWith('/status')) {
        return observeJsonResponse(200, running ? statusRunning() : statusWaiting());
      }
      if (url.endsWith(`/${THREAD_ID}`) && !url.includes('/status') && !url.includes('/usage')) {
        return observeJsonResponse(200, threadBody());
      }
      if (url.endsWith('/usage') && !url.endsWith('/usage-breakdown')) {
        return observeJsonResponse(
          200,
          usageBody(
            running ? 0.4 : 0.4785,
            running
              ? { input_tokens: 657, output_tokens: 433, cache_read_tokens: 106636, cache_create_tokens: 12 }
              : { input_tokens: 900, output_tokens: 700, cache_read_tokens: 110000, cache_create_tokens: 12 },
          ),
        );
      }
      if (url.endsWith('/usage-breakdown')) {
        return observeJsonResponse(200, breakdownBody(running ? 14_650_000 : 15_080_000));
      }
      return observeJsonResponse(404, {}, 'Not Found');
    };

    const sseUrls: string[] = [];
    const result = await runHyperagentObservePass({
      origin: 'https://hyperagent.com',
      pathname: `/thread/${THREAD_ID}`,
      fetchImpl,
      now: () => Date.parse(statusCalls <= 1 ? '2026-08-27T12:06:00.000Z' : '2026-08-27T12:30:24.114Z'),
      openEventSource: (url, handlers) => {
        sseUrls.push(url);
        handlers.onopen?.();
        handlers.onmessage?.({ data: JSON.stringify({ type: 'cost-updated', costDeltaUsd: 0.01 }) });
        return { close() {} };
      },
    });

    expect(result.error).toBeNull();
    expect(result.signedIn).toBe(true);
    expect(result.threadId).toBe(THREAD_ID);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].burn).toBe(430_000);
    expect(result.rows[0].costDelta).toBeCloseTo(0.0785);
    expect(result.streamEvents).toBe(1);
    expect(result.streamUp).toBe(true);
    expect(sseUrls).toEqual([`https://hyperagent.com/api/events/stream?threadId=${THREAD_ID}`]);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect(result.mutatingCalls).toEqual([]);
    expect(calls.some(call => call.url.endsWith(`/api/threads/${THREAD_ID}/status`))).toBe(true);
    expect(calls.some(call => call.url.endsWith(`/api/threads/${THREAD_ID}/usage`))).toBe(true);
    expect(calls.some(call => call.url.endsWith(`/api/threads/${THREAD_ID}/usage-breakdown`))).toBe(true);
    expect(calls.some(call => call.url.endsWith(`/api/threads/${THREAD_ID}`))).toBe(true);
    expect(calls.every(call => !call.body)).toBe(true);
    expect(calls.every(call => !call.url.includes('example.com'))).toBe(true);
  });

  it('refuses the fetch pass off hyperagent.com', async () => {
    const result = await runHyperagentObservePass({
      origin: 'https://example.com',
      pathname: `/thread/${THREAD_ID}`,
      fetchImpl: async () => {
        throw new Error('fetch should not run');
      },
    });
    expect(result.error).toMatch(/hyperagent\.com/);
    expect(result.rows).toEqual([]);
    expect(result.fetches).toEqual([]);
  });

  it('returns result.error instead of throwing when a GET fails', async () => {
    const result = await runHyperagentObservePass({
      origin: 'https://hyperagent.com',
      pathname: `/thread/${THREAD_ID}`,
      fetchImpl: async () => observeJsonResponse(401, { error: 'unauthorized' }, 'Unauthorized'),
    });
    expect(result.error).toMatch(/401/);
    expect(result.rows).toEqual([]);
    expect(result.mutatingCalls).toEqual([]);
    expect(result.fetches.some(call => call.url.endsWith(`/api/threads/${THREAD_ID}/status`))).toBe(true);
  });

  it('drains a delayed SSE cost-updated refresh before closing the handle', async () => {
    let statusCalls = 0;
    const result = await runHyperagentObservePass({
      origin: 'https://hyperagent.com',
      pathname: `/thread/${THREAD_ID}`,
      fetchImpl: async url => {
        if (url.endsWith('/status')) {
          statusCalls += 1;
          return observeJsonResponse(200, statusCalls === 1 ? statusRunning() : statusWaiting());
        }
        if (url.endsWith(`/${THREAD_ID}`) && !url.includes('/status') && !url.includes('/usage')) {
          return observeJsonResponse(200, threadBody());
        }
        if (url.endsWith('/usage') && !url.endsWith('/usage-breakdown')) {
          return observeJsonResponse(
            200,
            usageBody(statusCalls === 1 ? 0.4 : 0.4785, {
              input_tokens: 657,
              output_tokens: 433,
              cache_read_tokens: 106636,
              cache_create_tokens: 12,
            }),
          );
        }
        if (url.endsWith('/usage-breakdown')) {
          return observeJsonResponse(200, breakdownBody(statusCalls === 1 ? 14_650_000 : 15_080_000));
        }
        return observeJsonResponse(404, {}, 'Not Found');
      },
      now: () => Date.parse(statusCalls <= 1 ? '2026-08-27T12:06:00.000Z' : '2026-08-27T12:30:24.114Z'),
      openEventSource: (_url, handlers) => {
        queueMicrotask(() => {
          handlers.onmessage?.({ data: JSON.stringify({ type: 'cost-updated', costDeltaUsd: 0.01 }) });
        });
        return { close() {} };
      },
    });
    expect(result.error).toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(result.streamEvents).toBe(1);
  });

  it('does not invent MCP OAuth or write when there is no thread id', async () => {
    const result = await runHyperagentObservePass({
      origin: 'https://hyperagent.com',
      pathname: '/agents',
      fetchImpl: async () => {
        throw new Error('fetch should not run');
      },
    });
    expect(result.threadId).toBeNull();
    expect(result.error).toMatch(/thread id/i);
    expect(result.fetches).toEqual([]);
    expect(result.mutatingCalls).toEqual([]);
  });
});
