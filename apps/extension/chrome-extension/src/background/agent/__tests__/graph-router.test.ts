import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph/web';
import {
  USE_GRAPH_EXECUTOR,
  createTurnCheckpointer,
  deriveOutcome,
  routeAfterFollower,
  routeAfterLeader,
  routeEntry,
  routeTurn,
  shouldUseGraphExecutor,
} from '../graph';

describe('graph router (ADR-002 policy, pure)', () => {
  it('forces a leader handoff on any follower return signal', () => {
    for (const signal of ['SUBGOAL_COMPLETE', 'RETURN_TO_LEADER', 'BLOCKED'] as const) {
      expect(routeTurn({ nSteps: 1, planningInterval: 3, followerSignal: signal, planDone: false, step: 1, maxSteps: 10, halted: false })).toBe('leader');
    }
  });

  it('keeps planningInterval as the backstop cadence for CONTINUE', () => {
    expect(routeTurn({ nSteps: 0, planningInterval: 3, followerSignal: 'CONTINUE', planDone: false, step: 0, maxSteps: 10, halted: false })).toBe('leader');
    expect(routeTurn({ nSteps: 3, planningInterval: 3, followerSignal: 'CONTINUE', planDone: false, step: 2, maxSteps: 10, halted: false })).toBe('leader');
    expect(routeTurn({ nSteps: 1, planningInterval: 3, followerSignal: 'CONTINUE', planDone: false, step: 1, maxSteps: 10, halted: false })).toBe('follower');
  });

  it('treats maxSteps as the valve and halted/planDone as terminal', () => {
    const base = { nSteps: 1, planningInterval: 3, followerSignal: 'CONTINUE' as const, planDone: false, maxSteps: 3, halted: false };
    expect(routeTurn({ ...base, step: 3 })).toBe('end');
    expect(routeTurn({ ...base, step: 2 })).toBe('follower');
    expect(routeTurn({ ...base, step: 1, halted: true })).toBe('end');
    expect(routeTurn({ ...base, step: 1, planDone: true })).toBe('end');
  });

  it('routes entry like the legacy step-0 check and leader/follower edges consistently', () => {
    expect(
      routeEntry(
        { runId: 'r', task: 't', step: 0, nSteps: 0, followerSignal: 'CONTINUE', navigatorDone: false, planDone: false, finalAnswer: null, outcome: 'pending' },
        { planningInterval: 3, maxSteps: 10 },
      ),
    ).toBe('leader');
    expect(
      routeAfterLeader(
        { runId: 'r', task: 't', step: 1, nSteps: 1, followerSignal: 'CONTINUE', navigatorDone: false, planDone: true, finalAnswer: 'done', outcome: 'completed' },
        { planningInterval: 3, maxSteps: 10 },
      ),
    ).toBe('end');
    expect(
      routeAfterFollower(
        { runId: 'r', task: 't', step: 1, nSteps: 1, followerSignal: 'SUBGOAL_COMPLETE', navigatorDone: true, planDone: false, finalAnswer: null, outcome: 'pending' },
        { planningInterval: 3, maxSteps: 10 },
      ),
    ).toBe('leader');
  });

  it('maps terminal outcomes with completion > valve > stop > pause precedence', () => {
    expect(deriveOutcome({ planDone: true, step: 10, maxSteps: 10, stopped: true })).toBe('completed');
    expect(deriveOutcome({ planDone: false, step: 10, maxSteps: 10, stopped: false })).toBe('max_steps');
    expect(deriveOutcome({ planDone: false, step: 2, maxSteps: 10, stopped: true })).toBe('stopped');
    expect(deriveOutcome({ planDone: false, step: 2, maxSteps: 10, stopped: false })).toBe('paused');
  });
});

describe('graph executor flag (default off)', () => {
  it('ships disabled so the legacy Executor path stays default', () => {
    expect(USE_GRAPH_EXECUTOR).toBe(false);
    expect(shouldUseGraphExecutor(undefined)).toBe(false);
    expect(shouldUseGraphExecutor(null)).toBe(false);
    expect(shouldUseGraphExecutor({})).toBe(false);
  });

  it('opts in only via an explicit useGraphExecutor setting', () => {
    expect(shouldUseGraphExecutor({ useGraphExecutor: true })).toBe(true);
    expect(shouldUseGraphExecutor({ useGraphExecutor: false })).toBe(false);
  });
});

describe('graph checkpointer (MV3-safe)', () => {
  it('uses in-memory checkpointing with no Node APIs', () => {
    // MemorySaver is pure memory; checkpoint-sqlite (better-sqlite3 native
    // bindings) cannot load in MV3 service workers — see checkpointer.ts.
    expect(createTurnCheckpointer()).toBeInstanceOf(MemorySaver);
  });
});
