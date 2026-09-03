import { isFollowerReturnSignal, shouldRunPlanner, type NavigatorControlSignal } from '../routing';
import type { GraphTurnOutcome, GraphTurnState } from './state';

/**
 * Pure ADR-002 router for the graph turn (no browser/LLM/chrome imports).
 *
 * Mirrors Executor.runPlannerNavigatorLoop exactly:
 * - Follower control signal is the primary router input (any return signal
 *   forces an immediate leader handoff, no waiting for the interval).
 * - planningInterval is the backstop cadence (shouldRunPlanner).
 * - maxSteps is the safety valve (loop bound / terminal TASK_FAIL).
 *
 * The route functions are pure so unit tests cover the policy without a
 * compiled graph; builder.ts wires them as conditional edges.
 */

export type GraphRoute = 'leader' | 'follower' | 'end';

export interface RouteInputs {
  nSteps: number;
  planningInterval: number;
  followerSignal: NavigatorControlSignal;
  planDone: boolean;
  step: number;
  maxSteps: number;
  halted: boolean;
}

export function routeTurn(inputs: RouteInputs): GraphRoute {
  if (inputs.halted || inputs.planDone) {
    return 'end';
  }
  if (inputs.step >= inputs.maxSteps) {
    return 'end';
  }
  if (shouldRunPlanner(inputs.nSteps, inputs.planningInterval, inputs.followerSignal)) {
    return 'leader';
  }
  return 'follower';
}

export interface RouterConfig {
  planningInterval: number;
  maxSteps: number;
}

/** START edge: legacy step-0 check (nSteps=0 fires the planner on cadence). */
export function routeEntry(state: GraphTurnState, config: RouterConfig): GraphRoute {
  return routeTurn({
    nSteps: state.nSteps,
    planningInterval: config.planningInterval,
    followerSignal: state.followerSignal,
    planDone: state.planDone,
    step: state.step,
    maxSteps: config.maxSteps,
    halted: state.outcome !== 'pending',
  });
}

/** Leader edge: a completed plan ends the turn, otherwise follow. */
export function routeAfterLeader(state: GraphTurnState, config: RouterConfig): GraphRoute {
  if (state.outcome !== 'pending') {
    return 'end';
  }
  if (state.planDone) {
    return 'end';
  }
  if (state.step >= config.maxSteps) {
    return 'end';
  }
  return 'follower';
}

/** Follower/tools edge: halted/done/valve end the turn, else ADR-002 policy. */
export function routeAfterFollower(state: GraphTurnState, config: RouterConfig): GraphRoute {
  return routeTurn({
    nSteps: state.nSteps,
    planningInterval: config.planningInterval,
    followerSignal: state.followerSignal,
    planDone: state.planDone,
    step: state.step,
    maxSteps: config.maxSteps,
    halted: state.outcome !== 'pending',
  });
}

/**
 * Terminal mapping shared by the graph path. Same precedence as the legacy
 * loop tail: completion first, then the maxSteps valve, then stop, else
 * pause (see Executor.runPlannerNavigatorLoop).
 */
export function deriveOutcome(params: {
  planDone: boolean;
  step: number;
  maxSteps: number;
  stopped: boolean;
}): GraphTurnOutcome {
  if (params.planDone) {
    return 'completed';
  }
  if (params.step >= params.maxSteps) {
    return 'max_steps';
  }
  if (params.stopped) {
    return 'stopped';
  }
  return 'paused';
}

export { isFollowerReturnSignal };
