import { describe, expect, it } from 'vitest';
import {
  applyObserveSnapshot,
  emptyObserveState,
  handleSseData,
  normalizeBillingUsage,
  type ObserveSnapshot,
  type TokenSplit,
} from '../hyperagent-observe';

const THREAD_ID = 'thr_ledger';
const MODEL = 'deepseek/deepseek-v4-flash';

function phase(running = true): ObserveSnapshot['phase'] {
  return {
    k: running ? 'running' : 'waiting',
    label: running ? 'running (chat)' : 'waiting for you',
    queued: 0,
    since: running ? 1000 : 2000,
    source: 'chat',
  };
}

function snap(options: {
  t: number;
  running?: boolean;
  capture?: TokenSplit | null;
  indicator?: TokenSplit | null;
  cost?: number;
  items?: Record<string, { qty: number; cost: number }>;
}): ObserveSnapshot {
  const running = options.running ?? true;
  return {
    t: options.t,
    model: MODEL,
    messages: 10,
    phase: phase(running),
    running,
    enqueuedAt: 1000,
    completeAt: running ? 0 : 2000,
    capture: options.capture ?? null,
    indicator: options.indicator ?? null,
    cost: options.cost ?? 0,
    items: options.items ?? {},
    byok: {},
  };
}

const CAPTURE_A: TokenSplit = { input: 100, output: 20, cacheRead: 10, cacheCreate: 0 };
const CAPTURE_B: TokenSplit = { input: 120, output: 30, cacheRead: 15, cacheCreate: 0 };

describe('hyperagent observe v6 accounting ledger', () => {
  it('treats lastCapture as the main-call signal and does not double-count lastContextIndicator', () => {
    const state = emptyObserveState(THREAD_ID);
    applyObserveSnapshot(
      state,
      snap({
        t: 1,
        capture: CAPTURE_A,
        indicator: { input: 999, output: 999, cacheRead: 999, cacheCreate: 999 },
        items: { 'deepseek-v4-flash Tokens': { qty: 100, cost: 0.01 } },
      }),
    );

    expect(state.captures).toHaveLength(1);
    expect(state.open?.caps).toHaveLength(1);
    expect(state.captures[0]).toMatchObject({ source: 'capture', ...CAPTURE_A });
  });

  it('attributes main, non-main subagent, and same-model ambiguous windows without inventing per-call certainty', () => {
    const state = emptyObserveState(THREAD_ID);

    applyObserveSnapshot(
      state,
      snap({
        t: 1,
        capture: CAPTURE_A,
        cost: 0.01,
        items: { 'deepseek-v4-flash Tokens': { qty: 100, cost: 0.01 } },
      }),
    );

    expect(handleSseData(state, JSON.stringify({ type: 'cost-updated', costDeltaUsd: 0.02 }))).toBe('refresh');
    applyObserveSnapshot(
      state,
      snap({
        t: 2,
        capture: CAPTURE_B,
        cost: 0.03,
        items: { 'deepseek-v4-flash Tokens': { qty: 300, cost: 0.03 } },
      }),
    );

    expect(state.ledger[0]).toMatchObject({
      eventCount: 1,
      attribution: 'main',
      confidence: 'high',
      tokenDelta: 200,
    });
    expect(state.ledger[0].accountingCostDeltaUsd).toBeCloseTo(0.02);

    expect(handleSseData(state, JSON.stringify({ type: 'cost-updated', costDeltaUsd: 0.04 }))).toBe('refresh');
    applyObserveSnapshot(
      state,
      snap({
        t: 3,
        capture: CAPTURE_B,
        cost: 0.07,
        items: {
          'deepseek-v4-flash Tokens': { qty: 300, cost: 0.03 },
          'gpt-5 Tokens': { qty: 500, cost: 0.04 },
        },
      }),
    );

    expect(state.ledger[1]).toMatchObject({
      eventCount: 1,
      attribution: 'subagent',
      confidence: 'high',
      tokenDelta: 500,
    });

    expect(handleSseData(state, JSON.stringify({ type: 'cost-updated', costDeltaUsd: 0.01 }))).toBe('refresh');
    applyObserveSnapshot(
      state,
      snap({
        t: 4,
        capture: CAPTURE_B,
        cost: 0.08,
        items: {
          'deepseek-v4-flash Tokens': { qty: 400, cost: 0.04 },
          'gpt-5 Tokens': { qty: 500, cost: 0.04 },
        },
      }),
    );

    expect(state.ledger[2]).toMatchObject({
      eventCount: 1,
      attribution: 'unknown',
      confidence: 'low',
      tokenDelta: 100,
    });
    expect(state.ledger[2].rationale).toMatch(/same-model subagents/i);

    const closed = applyObserveSnapshot(
      state,
      snap({
        t: 5,
        running: false,
        capture: CAPTURE_B,
        cost: 0.08,
        items: {
          'deepseek-v4-flash Tokens': { qty: 400, cost: 0.04 },
          'gpt-5 Tokens': { qty: 500, cost: 0.04 },
        },
      }),
    );

    expect(closed?.split?.tokens).toEqual({ main: 200, subagent: 500, mixed: 0, unknown: 100 });
    expect(closed?.split?.events).toEqual({ main: 1, subagent: 1, mixed: 0, unknown: 1 });
  });

  it('coalesces multiple SSE completions into one accounting window instead of fabricating calls', () => {
    const state = emptyObserveState(THREAD_ID);
    applyObserveSnapshot(
      state,
      snap({
        t: 1,
        capture: CAPTURE_A,
        items: { 'deepseek-v4-flash Tokens': { qty: 100, cost: 0.01 } },
      }),
    );

    handleSseData(state, JSON.stringify({ type: 'cost-updated', costDeltaUsd: 0.01 }));
    handleSseData(state, JSON.stringify({ type: 'cost-updated', costDeltaUsd: 0.02 }));
    applyObserveSnapshot(
      state,
      snap({
        t: 2,
        capture: CAPTURE_B,
        cost: 0.03,
        items: { 'deepseek-v4-flash Tokens': { qty: 300, cost: 0.03 } },
      }),
    );

    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]).toMatchObject({
      eventCount: 2,
      attribution: 'main',
      confidence: 'medium',
    });
    expect(state.ledger[0].sseCostUsd).toBeCloseTo(0.03);
  });

  it('derives exact Orb token rates when quantity and total are available and keeps pass-through lines distinct', () => {
    const card = normalizeBillingUsage(
      {
        billing: {
          perPriceCosts: {
            opus_output: { priceName: 'Claude Opus Output Tokens', quantity: 2_000_000, costUsd: 50 },
            other: { priceName: 'Other Usage', quantity: 0, costUsd: 3.25 },
          },
        },
      },
      1234,
    );

    expect(card.fetchedAt).toBe(1234);
    expect(card.lines).toHaveLength(2);
    expect(card.lines[0]).toMatchObject({
      name: 'Claude Opus Output Tokens',
      ratePerMillion: 25,
      passThrough: false,
    });
    expect(card.lines[1]).toMatchObject({ name: 'Other Usage', passThrough: true });
    expect(card.totalUsd).toBeCloseTo(53.25);
  });
});
