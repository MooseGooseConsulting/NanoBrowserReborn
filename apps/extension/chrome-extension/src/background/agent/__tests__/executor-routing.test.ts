import { describe, expect, it } from 'vitest';
import {
  deriveNavigatorControl,
  isFollowerReturnSignal,
  shouldResumeDrainLoop,
  shouldRunPlanner,
  truncateActionsForStep,
} from '../routing';

describe('ADR-002 follower-initiated return (primary router)', () => {
  it('triggers an immediate planner handoff without waiting for the interval', () => {
    // nSteps=1 with planningInterval=3 would not fire on cadence alone.
    expect(shouldRunPlanner(1, 3, 'SUBGOAL_COMPLETE')).toBe(true);
    expect(shouldRunPlanner(1, 3, 'RETURN_TO_LEADER')).toBe(true);
    expect(shouldRunPlanner(1, 3, 'BLOCKED')).toBe(true);
    expect(shouldRunPlanner(2, 5, 'SUBGOAL_COMPLETE')).toBe(true);
  });

  it('keeps planningInterval as the backstop cadence', () => {
    expect(shouldRunPlanner(0, 3, 'CONTINUE')).toBe(true);
    expect(shouldRunPlanner(3, 3, 'CONTINUE')).toBe(true);
    expect(shouldRunPlanner(6, 3, 'CONTINUE')).toBe(true);
    expect(shouldRunPlanner(1, 3, 'CONTINUE')).toBe(false);
    expect(shouldRunPlanner(2, 3, 'CONTINUE')).toBe(false);
    expect(shouldRunPlanner(4, 3, 'CONTINUE')).toBe(false);
  });

  it('classifies only non-CONTINUE signals as follower returns', () => {
    expect(isFollowerReturnSignal('SUBGOAL_COMPLETE')).toBe(true);
    expect(isFollowerReturnSignal('RETURN_TO_LEADER')).toBe(true);
    expect(isFollowerReturnSignal('BLOCKED')).toBe(true);
    expect(isFollowerReturnSignal('CONTINUE')).toBe(false);
    expect(isFollowerReturnSignal(undefined)).toBe(false);
  });

  it('derives the control signal from done/success/error', () => {
    expect(deriveNavigatorControl({ done: true, success: true, hasError: false })).toBe('SUBGOAL_COMPLETE');
    // `done` without an explicit success stays backwards-compatible.
    expect(deriveNavigatorControl({ done: true, success: undefined, hasError: false })).toBe('SUBGOAL_COMPLETE');
    expect(deriveNavigatorControl({ done: true, success: false, hasError: false })).toBe('RETURN_TO_LEADER');
    expect(deriveNavigatorControl({ done: false, hasError: true })).toBe('BLOCKED');
    expect(deriveNavigatorControl({ done: false, hasError: false })).toBe('CONTINUE');
  });
});

describe('ADR-002 maxActionsPerStep enforcement (truncate + notice)', () => {
  it('truncates over-limit action lists to the cap', () => {
    const actions = Array.from({ length: 8 }, (_, i) => ({ click_element: { index: i } }));
    const { actions: kept, truncated } = truncateActionsForStep(actions, 3);
    expect(kept).toHaveLength(3);
    expect(truncated).toBe(5);
    // Order preserved: first N win.
    expect(kept[0]).toEqual({ click_element: { index: 0 } });
    expect(kept[2]).toEqual({ click_element: { index: 2 } });
  });

  it('passes through lists within the cap untouched', () => {
    const actions = [{ go_to_url: { url: 'https://example.com' } }];
    const result = truncateActionsForStep(actions, 10);
    expect(result.actions).toHaveLength(1);
    expect(result.truncated).toBe(0);
  });

  it('ignores non-positive caps instead of dropping everything', () => {
    const actions = [{ a: 1 }, { b: 2 }];
    expect(truncateActionsForStep(actions, 0).truncated).toBe(0);
    expect(truncateActionsForStep(actions, 0).actions).toHaveLength(2);
  });
});

describe('pause-between-turns resume strand', () => {
  it('restarts the drain loop when a turn is still active with an empty queue', () => {
    // The TASK_PAUSE path leaves runningTurnId set with no queued work.
    expect(shouldResumeDrainLoop({ pendingQueue: [], running: true }, false)).toBe(true);
  });

  it('stays idle when nothing is running and the queue is empty', () => {
    expect(shouldResumeDrainLoop({ pendingQueue: [], running: false }, false)).toBe(false);
  });

  it('still resumes for queued work when idle', () => {
    expect(shouldResumeDrainLoop({ pendingQueue: [{ id: 'run-1' }], running: false }, false)).toBe(true);
  });

  it('never double-starts while a drain loop is already in flight', () => {
    expect(shouldResumeDrainLoop({ pendingQueue: [{ id: 'run-1' }], running: true }, true)).toBe(false);
    expect(shouldResumeDrainLoop({ pendingQueue: [], running: true }, true)).toBe(false);
  });
});
