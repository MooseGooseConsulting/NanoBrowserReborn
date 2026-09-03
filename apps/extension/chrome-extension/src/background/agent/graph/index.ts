import type { NavigatorControlSignal } from '../routing';
import { buildTurnGraph, type TurnCallbacks } from './builder';
import { deriveOutcome } from './router';
import { createInitialTurnState, type GraphTurnOutcome, type GraphTurnState } from './state';

/**
 * Feature flag for the LangGraph StateGraph rebase of the Leader/Follower
 * loop. Default OFF: the Executor keeps byte-identical legacy behavior and
 * only delegates turn-driving to the graph when this is flipped on (or a
 * `useGraphExecutor` opt-in is present on generalSettings — see
 * shouldUseGraphExecutor).
 */
export const USE_GRAPH_EXECUTOR = false;

export interface GraphExecutorSettings {
  useGraphExecutor?: boolean;
}

export function shouldUseGraphExecutor(generalSettings?: GraphExecutorSettings | null): boolean {
  return generalSettings?.useGraphExecutor ?? USE_GRAPH_EXECUTOR;
}

export interface GraphTurnRequest {
  runId: string;
  task: string;
  planningInterval: number;
  maxSteps: number;
  initialNSteps?: number;
  runLeader: TurnCallbacks['runLeader'];
  runFollower: TurnCallbacks['runFollower'];
  shouldStop: TurnCallbacks['shouldStop'];
  isStopped: TurnCallbacks['isStopped'];
  onIteration?: TurnCallbacks['onIteration'];
}

export interface GraphTurnResult {
  state: GraphTurnState;
  outcome: GraphTurnOutcome;
  planDone: boolean;
  finalAnswer: string | null;
  stepsConsumed: number;
  nSteps: number;
  followerSignal: NavigatorControlSignal;
}

/**
 * Drive one Planner/Navigator turn through the compiled StateGraph.
 * The checkpointer is keyed by run id (thread_id); recursion headroom
 * scales with maxSteps (each consumed step spans follower+tools, plus
 * occasional leader passes).
 */
export async function runTurnWithGraph(request: GraphTurnRequest): Promise<GraphTurnResult> {
  const graph = buildTurnGraph(
    {
      runLeader: request.runLeader,
      runFollower: request.runFollower,
      shouldStop: request.shouldStop,
      isStopped: request.isStopped,
      onIteration: request.onIteration,
    },
    {
      runId: request.runId,
      planningInterval: request.planningInterval,
      maxSteps: request.maxSteps,
    },
  );

  const initial = createInitialTurnState({
    runId: request.runId,
    task: request.task,
    nSteps: request.initialNSteps ?? 0,
  });

  const finalState = (await graph.invoke(initial, {
    configurable: { thread_id: request.runId },
    recursionLimit: Math.max(25, request.maxSteps * 4 + 10),
  })) as GraphTurnState;

  // Belt-and-braces: nodes always set a terminal outcome, but a router-ended
  // turn (e.g. maxSteps: 0, entry straight to END) still needs the legacy
  // terminal mapping applied.
  let outcome = finalState.outcome;
  if (outcome === 'pending') {
    outcome = deriveOutcome({
      planDone: finalState.planDone,
      step: finalState.step,
      maxSteps: request.maxSteps,
      stopped: request.isStopped(),
    });
  }

  return {
    state: { ...finalState, outcome },
    outcome,
    planDone: finalState.planDone,
    finalAnswer: finalState.finalAnswer,
    stepsConsumed: finalState.step,
    nSteps: finalState.nSteps,
    followerSignal: finalState.followerSignal,
  };
}

export { buildTurnGraph } from './builder';
export type { TurnCallbacks, TurnGraphConfig } from './builder';
export { createTurnCheckpointer } from './checkpointer';
export { deriveOutcome, routeAfterFollower, routeAfterLeader, routeEntry, routeTurn } from './router';
export type { GraphRoute, RouteInputs, RouterConfig } from './router';
export { createInitialTurnState, GraphTurnAnnotation } from './state';
export type { GraphTurnOutcome, GraphTurnState } from './state';
