import { Annotation } from '@langchain/langgraph/web';
import type { NavigatorControlSignal } from '../routing';

/**
 * Terminal outcome of one Planner/Navigator turn.
 *
 * Mirrors the terminal branches of Executor.runPlannerNavigatorLoop:
 * completed  -> TASK_OK    (planner confirms done)
 * max_steps  -> TASK_FAIL   (maxSteps safety valve tripped)
 * stopped    -> TASK_CANCEL (shouldStop observed a stop)
 * paused     -> TASK_PAUSE  (loop exited without a terminal state)
 * pending    -> turn still driving (never returned to the caller)
 */
export type GraphTurnOutcome = 'pending' | 'completed' | 'max_steps' | 'stopped' | 'paused';

/**
 * Typed LangGraph state for one Leader/Follower turn.
 *
 * Identity: runId/task pin the turn (checkpointer thread_id = runId).
 * Progress: step counts consumed for-loop iterations (one per follower
 * visit, exactly like Executor's `step`), nSteps mirrors context.nSteps
 * (navigator executions only — paused early-returns don't increment it).
 * Router inputs: followerSignal (+ planningInterval/maxSteps supplied as
 * graph config, not state) drive the ADR-002 policy in ./router.
 * Completion: planDone/finalAnswer mirror latestPlanOutput handling.
 */
export const GraphTurnAnnotation = Annotation.Root({
  runId: Annotation<string>,
  task: Annotation<string>,
  step: Annotation<number>,
  nSteps: Annotation<number>,
  followerSignal: Annotation<NavigatorControlSignal>,
  navigatorDone: Annotation<boolean>,
  planDone: Annotation<boolean>,
  finalAnswer: Annotation<string | null>,
  outcome: Annotation<GraphTurnOutcome>,
});

export type GraphTurnState = typeof GraphTurnAnnotation.State;

export function createInitialTurnState(params: { runId: string; task: string; nSteps?: number }): GraphTurnState {
  return {
    runId: params.runId,
    task: params.task,
    step: 0,
    nSteps: params.nSteps ?? 0,
    followerSignal: 'CONTINUE',
    navigatorDone: false,
    planDone: false,
    finalAnswer: null,
    outcome: 'pending',
  };
}
