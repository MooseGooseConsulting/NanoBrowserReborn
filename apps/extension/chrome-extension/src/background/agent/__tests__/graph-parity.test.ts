import { describe, expect, it } from 'vitest';
import { shouldRunPlanner, type NavigatorControlSignal } from '../routing';
import { runTurnWithGraph, type GraphTurnResult } from '../graph';

/**
 * Parity: the same scripted scenario passes on both the legacy turn-driving
 * loop and the StateGraph path with identical traces.
 *
 * driveLegacyTurn mirrors Executor.runPlannerNavigatorLoop's for-loop
 * (shouldStop top-check, shouldRunPlanner router, planner-then-navigate
 * order, completion break, completion > valve > stop > pause mapping) while
 * runTurnWithGraph drives the same script through the compiled graph. Both
 * sides share shouldRunPlanner and the same callback shapes the Executor
 * binds to its private runPlanner()/navigate()/shouldStop().
 */

interface ScriptFlags {
  paused: boolean;
  stopped: boolean;
}

interface ScriptedTurn {
  flags: ScriptFlags;
  calls: { leader: number; follower: number };
  nSteps: number;
  leaderPlan: boolean[];
  followerPlan: { done: boolean; control: NavigatorControlSignal }[];
  runLeader: () => Promise<{ planDone: boolean; finalAnswer: string | null }>;
  runFollower: () => Promise<{ done: boolean; control: NavigatorControlSignal; nSteps: number }>;
  shouldStop: () => Promise<boolean>;
  isStopped: () => boolean;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function makeScript(params: {
  leaderPlan: boolean[];
  followerPlan: { done: boolean; control: NavigatorControlSignal }[];
  flags?: Partial<ScriptFlags>;
}): ScriptedTurn {
  const flags: ScriptFlags = { paused: false, stopped: false, ...params.flags };
  const script: ScriptedTurn = {
    flags,
    calls: { leader: 0, follower: 0 },
    nSteps: 0,
    leaderPlan: params.leaderPlan,
    followerPlan: params.followerPlan,
    runLeader: async () => {
      const planDone = params.leaderPlan[script.calls.leader] ?? false;
      script.calls.leader++;
      return { planDone, finalAnswer: planDone ? 'final' : null };
    },
    runFollower: async () => {
      script.calls.follower++;
      // Mirrors navigate(): paused/stopped early-return consumes the loop
      // step but leaves nSteps untouched.
      if (flags.paused || flags.stopped) {
        return { done: false, control: 'CONTINUE' as NavigatorControlSignal, nSteps: script.nSteps };
      }
      const next = params.followerPlan[script.calls.follower - 1] ?? {
        done: false,
        control: 'CONTINUE' as NavigatorControlSignal,
      };
      script.nSteps++;
      return { ...next, nSteps: script.nSteps };
    },
    // Mirrors Executor.shouldStop: true on stop, spin-wait while paused
    // (consecutiveFailures branch omitted — scripted steps never fail).
    shouldStop: async () => {
      if (flags.stopped) {
        return true;
      }
      while (flags.paused) {
        await sleep(5);
        if (flags.stopped) {
          return true;
        }
      }
      return false;
    },
    isStopped: () => flags.stopped,
  };
  return script;
}

interface TurnTrace {
  outcome: string;
  leaderCalls: number;
  followerCalls: number;
  stepsConsumed: number;
  nSteps: number;
}

async function driveLegacyTurn(
  script: ScriptedTurn,
  opts: { planningInterval: number; maxSteps: number },
): Promise<TurnTrace> {
  let step = 0;
  let planDone = false;
  let nSteps = 0;
  let followerSignal: NavigatorControlSignal = 'CONTINUE';

  for (step = 0; step < opts.maxSteps; step++) {
    if (await script.shouldStop()) {
      break;
    }
    if (shouldRunPlanner(nSteps, opts.planningInterval, followerSignal)) {
      followerSignal = 'CONTINUE';
      const result = await script.runLeader();
      if (result.planDone) {
        planDone = true;
        break;
      }
    }
    const nav = await script.runFollower();
    nSteps = nav.nSteps;
    followerSignal = nav.control;
  }

  const outcome = planDone
    ? 'completed'
    : step >= opts.maxSteps
      ? 'max_steps'
      : script.isStopped()
        ? 'stopped'
        : 'paused';
  return { outcome, leaderCalls: script.calls.leader, followerCalls: script.calls.follower, stepsConsumed: step, nSteps };
}

async function driveGraphTurn(
  script: ScriptedTurn,
  opts: { planningInterval: number; maxSteps: number },
): Promise<TurnTrace> {
  const result: GraphTurnResult = await runTurnWithGraph({
    runId: `parity-${Date.now()}-${Math.random()}`,
    task: 'parity task',
    planningInterval: opts.planningInterval,
    maxSteps: opts.maxSteps,
    initialNSteps: 0,
    runLeader: script.runLeader,
    runFollower: script.runFollower,
    shouldStop: script.shouldStop,
    isStopped: script.isStopped,
  });
  return {
    outcome: result.outcome,
    leaderCalls: script.calls.leader,
    followerCalls: script.calls.follower,
    stepsConsumed: result.stepsConsumed,
    nSteps: result.nSteps,
  };
}

async function expectParity(params: {
  leaderPlan: boolean[];
  followerPlan: { done: boolean; control: NavigatorControlSignal }[];
  planningInterval: number;
  maxSteps: number;
  flags?: Partial<ScriptFlags>;
  onFlags?: (flags: ScriptFlags) => void;
}): Promise<{ legacy: TurnTrace; graph: TurnTrace }> {
  const legacyScript = makeScript(params);
  const graphScript = makeScript(params);
  params.onFlags?.(legacyScript.flags);
  params.onFlags?.(graphScript.flags);
  const [legacy, graph] = await Promise.all([
    driveLegacyTurn(legacyScript, params),
    driveGraphTurn(graphScript, params),
  ]);
  expect(graph).toEqual(legacy);
  return { legacy, graph };
}

describe('leader/follower parity: legacy loop vs StateGraph', () => {
  it('completes after 2 follower actions with an early follower return', async () => {
    const { legacy } = await expectParity({
      planningInterval: 10,
      maxSteps: 10,
      leaderPlan: [false, true],
      followerPlan: [
        { done: false, control: 'CONTINUE' },
        { done: true, control: 'SUBGOAL_COMPLETE' },
      ],
    });
    expect(legacy.outcome).toBe('completed');
    expect(legacy.leaderCalls).toBe(2);
    expect(legacy.followerCalls).toBe(2);
  });

  it('uses planningInterval as the backstop cadence until the maxSteps valve', async () => {
    const { legacy } = await expectParity({
      planningInterval: 2,
      maxSteps: 3,
      leaderPlan: [false, false],
      followerPlan: [],
    });
    // step0 leader (cadence 0%2) + follower, step1 follower only,
    // step2 leader (cadence 2%2) + follower, then the valve trips.
    expect(legacy.outcome).toBe('max_steps');
    expect(legacy.leaderCalls).toBe(2);
    expect(legacy.followerCalls).toBe(3);
    expect(legacy.stepsConsumed).toBe(3);
  });

  it('cancels without any leader/follower work when stopped', async () => {
    const { legacy } = await expectParity({
      planningInterval: 3,
      maxSteps: 5,
      leaderPlan: [true],
      followerPlan: [{ done: false, control: 'CONTINUE' }],
      flags: { stopped: true },
    });
    expect(legacy.outcome).toBe('stopped');
    expect(legacy.leaderCalls).toBe(0);
    expect(legacy.followerCalls).toBe(0);
  });

  it('pauses then resumes to the same completion as the legacy loop', async () => {
    const { legacy } = await expectParity({
      planningInterval: 10,
      maxSteps: 10,
      leaderPlan: [false, true],
      followerPlan: [
        { done: false, control: 'CONTINUE' },
        { done: true, control: 'SUBGOAL_COMPLETE' },
      ],
      flags: { paused: true },
      onFlags: flags => {
        setTimeout(() => {
          flags.paused = false;
        }, 30);
      },
    });
    expect(legacy.outcome).toBe('completed');
    expect(legacy.leaderCalls).toBe(2);
    expect(legacy.followerCalls).toBe(2);
  });
});
