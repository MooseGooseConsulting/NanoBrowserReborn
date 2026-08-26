import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import type { AgentOutput } from './types';
import type { PlannerOutput } from './agents/planner';

export type ExecutionTerminalReason = 'completed' | 'max_steps' | 'max_failures' | 'stopped' | null;

export const ExecutionGraphState = Annotation.Root({
  iteration: Annotation<number>(),
  navigationSteps: Annotation<number>(),
  latestPlanOutput: Annotation<AgentOutput<PlannerOutput> | null>(),
  navigatorDone: Annotation<boolean>(),
  terminalReason: Annotation<ExecutionTerminalReason>(),
});

export type ExecutionGraphStateValue = typeof ExecutionGraphState.State;
export type ExecutionGraphStateUpdate = typeof ExecutionGraphState.Update;

export interface ExecutionGraphHandlers {
  guard: (state: ExecutionGraphStateValue) => Promise<ExecutionGraphStateUpdate>;
  planner: (state: ExecutionGraphStateValue) => Promise<ExecutionGraphStateUpdate>;
  navigator: (state: ExecutionGraphStateValue) => Promise<ExecutionGraphStateUpdate>;
}

export interface ExecutionGraphOptions {
  planningInterval: number;
}

export type GuardRoute = 'planner' | 'navigator' | typeof END;
export type PlannerRoute = 'navigator' | typeof END;

export function routeAfterGuard(state: ExecutionGraphStateValue, options: ExecutionGraphOptions): GuardRoute {
  if (state.terminalReason) return END;

  const planningInterval = Math.max(1, options.planningInterval);
  if (state.navigatorDone || state.navigationSteps % planningInterval === 0) {
    return 'planner';
  }

  return 'navigator';
}

export function routeAfterPlanner(state: ExecutionGraphStateValue): PlannerRoute {
  return state.terminalReason ? END : 'navigator';
}

/**
 * LangGraph counts graph transitions, not Nano Browser navigation steps.
 * A navigation iteration can traverse guard -> planner -> navigator -> guard,
 * so derive a recursion budget from maxSteps rather than using the generic default.
 */
export function calculateRecursionLimit(maxSteps: number): number {
  return Math.max(25, maxSteps * 4 + 8);
}

export function createExecutionGraph(handlers: ExecutionGraphHandlers, options: ExecutionGraphOptions) {
  return new StateGraph(ExecutionGraphState)
    .addNode('guard', handlers.guard)
    .addNode('planner', handlers.planner)
    .addNode('navigator', handlers.navigator)
    .addEdge(START, 'guard')
    .addConditionalEdges('guard', state => routeAfterGuard(state, options), {
      planner: 'planner',
      navigator: 'navigator',
      [END]: END,
    })
    .addConditionalEdges('planner', routeAfterPlanner, {
      navigator: 'navigator',
      [END]: END,
    })
    .addEdge('navigator', 'guard')
    .compile();
}
