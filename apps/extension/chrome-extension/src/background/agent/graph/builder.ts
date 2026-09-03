import { END, START, StateGraph } from '@langchain/langgraph/web';
import type { NavigatorControlSignal } from '../routing';
import { GraphTurnAnnotation, type GraphTurnState } from './state';
import { routeAfterFollower, routeAfterLeader, routeEntry, type RouterConfig } from './router';
import { createTurnCheckpointer } from './checkpointer';

/**
 * Step callbacks the graph drives. In production the Executor binds these
 * to its private runPlanner()/navigate()/shouldStop() so both paths execute
 * the same methods and emit the same events; tests bind scripted fakes.
 */
export interface TurnCallbacks {
  /**
   * One Leader pass. Returns whether the planner confirmed completion
   * (Executor: runPlanner + checkTaskCompletion) plus the final answer.
   */
  runLeader: () => Promise<{ planDone: boolean; finalAnswer: string | null }>;
  /**
   * One Follower pass. nSteps is the post-run navigator-step counter
   * (Executor: context.nSteps — paused early-returns don't increment it).
   */
  runFollower: () => Promise<{ done: boolean; control: NavigatorControlSignal; nSteps: number }>;
  /**
   * Mirrors Executor.shouldStop: resolves true when the turn must stop,
   * spin-waits while paused (resume continues the turn in place).
   */
  shouldStop: () => Promise<boolean>;
  /** True when the context is stopped (for the terminal mapping). */
  isStopped: () => boolean;
  /** Optional per-iteration hook (Executor: refresh context.stepInfo). */
  onIteration?: (state: GraphTurnState) => void;
}

export interface TurnGraphConfig extends RouterConfig {
  runId: string;
}

const ROUTE_TARGETS = {
  leader: 'leader',
  follower: 'follower',
  end: END,
} as const;

/**
 * Thin StateGraph rebase of the Leader/Follower loop.
 *
 * Topology:
 *   START -> [router] -> leader -> follower -> tools -+
 *                    ^                                |
 *                    +----------- [router] <----------+
 *                    |
 *                    +--> END (completion / halt)
 * driven by the follower control signal (primary), planningInterval
 * backstop cadence, and the maxSteps valve (ADR-002).
 *
 * Nodes:
 * - leader: one planner run + completion check.
 * - follower: one navigator run; consumes one loop `step` per visit,
 *   exactly like one Executor for-iteration (a paused early-return still
 *   consumes the step but leaves nSteps untouched — that accounting lives
 *   inside navigate(), shared by both paths).
 * - tools: passthrough documenting where tool execution lives (inside the
 *   follower's navigate()/doMultiAction, unchanged). Exists so the
 *   topology matches the Leader -> Follower -> Tools mental model and a
 *   future tools-node split needs no rewiring.
 */
export function buildTurnGraph(callbacks: TurnCallbacks, config: TurnGraphConfig) {
  const routerConfig: RouterConfig = {
    planningInterval: config.planningInterval,
    maxSteps: config.maxSteps,
  };

  const notify = (state: GraphTurnState) => {
    callbacks.onIteration?.(state);
  };

  const graph = new StateGraph(GraphTurnAnnotation)
    .addNode('leader', async state => {
      notify(state);
      if (await callbacks.shouldStop()) {
        return { outcome: 'stopped' as const };
      }
      const result = await callbacks.runLeader();
      if (result.planDone) {
        return {
          planDone: true,
          finalAnswer: result.finalAnswer,
          followerSignal: 'CONTINUE' as NavigatorControlSignal,
          navigatorDone: false,
          outcome: 'completed' as const,
        };
      }
      return {
        followerSignal: 'CONTINUE' as NavigatorControlSignal,
        navigatorDone: false,
      };
    })
    .addNode('follower', async state => {
      notify(state);
      if (await callbacks.shouldStop()) {
        return { outcome: 'stopped' as const };
      }
      const result = await callbacks.runFollower();
      return {
        step: state.step + 1,
        nSteps: result.nSteps,
        navigatorDone: result.done,
        followerSignal: result.control,
      };
    })
    .addNode('tools', async state => {
      // Passthrough: tool execution lives inside the follower node.
      notify(state);
      return {};
    })
    .addConditionalEdges(START, state => routeEntry(state, routerConfig), ROUTE_TARGETS)
    .addConditionalEdges('leader', state => routeAfterLeader(state, routerConfig), ROUTE_TARGETS)
    .addEdge('follower', 'tools')
    .addConditionalEdges('tools', state => routeAfterFollower(state, routerConfig), ROUTE_TARGETS)
    .compile({ checkpointer: createTurnCheckpointer() });

  return graph;
}

export type TurnGraph = ReturnType<typeof buildTurnGraph>;
