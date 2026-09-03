/**
 * Deterministic-scaling router helpers (ADR-002).
 *
 * Lightweight on purpose: no browser/LLM/chrome imports so unit tests can
 * cover the routing policy without pulling the full Executor/Navigator chain.
 *
 * Policy: the Follower control signal is the primary router input —
 * SUBGOAL_COMPLETE / RETURN_TO_LEADER / BLOCKED force an immediate planner
 * handoff. `planningInterval` remains the backstop cadence and `maxSteps`
 * the safety valve. The event contract (TASK_*, RUN_UPDATE) is unchanged.
 */

/** Typed Follower-initiated return signal from the Navigator. */
export type NavigatorControlSignal = 'CONTINUE' | 'SUBGOAL_COMPLETE' | 'RETURN_TO_LEADER' | 'BLOCKED';

export const FOLLOWER_RETURN_SIGNALS: readonly NavigatorControlSignal[] = [
  'SUBGOAL_COMPLETE',
  'RETURN_TO_LEADER',
  'BLOCKED',
] as const;

export function isFollowerReturnSignal(signal: NavigatorControlSignal | undefined): boolean {
  return signal !== undefined && (FOLLOWER_RETURN_SIGNALS as readonly string[]).includes(signal);
}

export function deriveNavigatorControl(params: {
  done: boolean;
  success?: boolean;
  hasError: boolean;
}): NavigatorControlSignal {
  if (params.done) {
    // `done` with success=false means the Follower could not finish the
    // subgoal on its own — return to the Leader for a fresh plan.
    return params.success === false ? 'RETURN_TO_LEADER' : 'SUBGOAL_COMPLETE';
  }
  if (params.hasError) {
    return 'BLOCKED';
  }
  return 'CONTINUE';
}

/**
 * Server-side enforcement of maxActionsPerStep (ADR-002: enforce-or-remove,
 * enforcement chosen). Pure helper so the truncation policy is unit-testable;
 * callers emit a notice event when `truncated > 0`.
 */
export function truncateActionsForStep<T>(
  actions: T[],
  maxActionsPerStep: number,
): { actions: T[]; truncated: number } {
  if (!Number.isFinite(maxActionsPerStep) || maxActionsPerStep < 1) {
    return { actions, truncated: 0 };
  }
  const max = Math.floor(maxActionsPerStep);
  if (actions.length <= max) {
    return { actions, truncated: 0 };
  }
  return { actions: actions.slice(0, max), truncated: actions.length - max };
}

/**
 * Primary router predicate. Any Follower return signal forces a planner
 * handoff without waiting for the interval turn.
 */
export function shouldRunPlanner(
  nSteps: number,
  planningInterval: number,
  followerSignal: NavigatorControlSignal,
): boolean {
  if (isFollowerReturnSignal(followerSignal)) {
    return true;
  }
  if (!Number.isFinite(planningInterval) || planningInterval <= 0) {
    return true;
  }
  return nSteps % Math.floor(planningInterval) === 0;
}

/**
 * Resume predicate for the pause-between-turns strand.
 * The turn stays marked running across a TASK_PAUSE (no complete/cancel),
 * so resume must restart the drain loop whenever a turn is still active —
 * not only when the pending queue is non-empty.
 */
export function shouldResumeDrainLoop(
  snapshot: { pendingQueue: unknown[]; running: boolean },
  hasExecuteLoop: boolean,
): boolean {
  if (hasExecuteLoop) {
    return false;
  }
  return snapshot.pendingQueue.length > 0 || snapshot.running;
}
