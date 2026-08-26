import { describe, expect, it } from 'vitest';
import { END } from '@langchain/langgraph/web';
import {
  calculateRecursionLimit,
  routeAfterGuard,
  routeAfterPlanner,
  type ExecutionGraphStateValue,
} from '../execution-graph';

function state(overrides: Partial<ExecutionGraphStateValue> = {}): ExecutionGraphStateValue {
  return {
    iteration: 0,
    navigationSteps: 0,
    latestPlanOutput: null,
    navigatorDone: false,
    terminalReason: null,
    ...overrides,
  };
}

describe('execution graph routing', () => {
  it('runs the planner before the first navigation step', () => {
    expect(routeAfterGuard(state(), { planningInterval: 3 })).toBe('planner');
  });

  it('runs navigator between planning intervals', () => {
    expect(routeAfterGuard(state({ navigationSteps: 1 }), { planningInterval: 3 })).toBe('navigator');
  });

  it('runs planner at the configured interval', () => {
    expect(routeAfterGuard(state({ navigationSteps: 3 }), { planningInterval: 3 })).toBe('planner');
  });

  it('validates navigator completion immediately with the planner', () => {
    expect(routeAfterGuard(state({ navigationSteps: 1, navigatorDone: true }), { planningInterval: 3 })).toBe(
      'planner',
    );
  });

  for (const terminalReason of ['completed', 'max_steps', 'max_failures', 'stopped'] as const) {
    it(`ends from guard on ${terminalReason}`, () => {
      expect(routeAfterGuard(state({ terminalReason }), { planningInterval: 3 })).toBe(END);
    });
  }

  it('ends after planner completion', () => {
    expect(routeAfterPlanner(state({ terminalReason: 'completed' }))).toBe(END);
  });

  it('continues to navigator after nonterminal planning', () => {
    expect(routeAfterPlanner(state())).toBe('navigator');
  });

  it('allocates enough graph recursion headroom for planner + navigator transitions', () => {
    expect(calculateRecursionLimit(100)).toBeGreaterThan(400);
    expect(calculateRecursionLimit(1)).toBeGreaterThanOrEqual(25);
  });
});
