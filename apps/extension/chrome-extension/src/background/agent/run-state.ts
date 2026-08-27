/**
 * Four-state run model for Leader/Follower completion.
 *
 * Mirrors Hyperagent GET /api/threads/{id}/status (issue #1): run state is
 * running / queued / waiting / error, not a boolean.
 *
 * running  — lastEnqueuedAt > turnCompleteAt; runningTurnSource names the trigger
 * queued   — pendingQueue.length > 0; that work has not started
 * waiting  — not running, queue empty, lastRunMessageRole === 'assistant'
 * error    — lastMessageIsError
 *
 * Traps:
 * 1. running is not "busy with your work" (planner, replay, or another source can hold the turn)
 * 2. queued while running means a completion check collects the previous run
 */

export type RunPhase = 'running' | 'queued' | 'waiting' | 'error';

export type RunTurnSource = 'user' | 'planner' | 'navigator' | 'replay' | 'system';

export type RunMessageRole = 'user' | 'assistant';

export interface QueuedRun {
  id: string;
  task: string;
  enqueuedAt: number;
  source: RunTurnSource;
  preapplied?: boolean;
}

export interface RunClock {
  lastEnqueuedAt: number | null;
  turnCompleteAt: number | null;
  pendingQueue: QueuedRun[];
  runningTurnSource: RunTurnSource | null;
  runningTurnId: string | null;
  lastRunMessageRole: RunMessageRole | null;
  lastMessageIsError: boolean;
  lastCompletedTurnId: string | null;
  lastCompletedOutput: string | null;
  lastCompletedSource: RunTurnSource | null;
}

export interface RunSnapshot {
  phase: RunPhase;
  running: boolean;
  queued: boolean;
  runningTurnSource: RunTurnSource | null;
  runningTurnId: string | null;
  pendingQueue: QueuedRun[];
  lastRunMessageRole: RunMessageRole | null;
  lastMessageIsError: boolean;
  lastCompletedTurnId: string | null;
  lastCompletedOutput: string | null;
  lastCompletedSource: RunTurnSource | null;
}

export type CompletionCollection =
  | {
      kind: 'previous_run';
      turnId: string | null;
      source: RunTurnSource | null;
      output: string | null;
      queuedTurnIds: string[];
    }
  | {
      kind: 'in_flight';
      turnId: string | null;
      source: RunTurnSource | null;
      output: null;
    }
  | {
      kind: 'idle';
      turnId: string | null;
      source: RunTurnSource | null;
      output: string | null;
      error: boolean;
    };

let turnSeq = 0;

export function createRunClock(): RunClock {
  return {
    lastEnqueuedAt: null,
    turnCompleteAt: null,
    pendingQueue: [],
    runningTurnSource: null,
    runningTurnId: null,
    lastRunMessageRole: null,
    lastMessageIsError: false,
    lastCompletedTurnId: null,
    lastCompletedOutput: null,
    lastCompletedSource: null,
  };
}

export function isRunning(clock: RunClock): boolean {
  return clock.runningTurnId != null;
}

export function isQueued(clock: RunClock): boolean {
  return clock.pendingQueue.length > 0;
}

/**
 * Primary phase. `running` wins over `queued` so a thread held by another
 * source still reports running; callers must also read `queued`.
 */
export function deriveRunPhase(clock: RunClock): RunPhase {
  if (isRunning(clock)) {
    return 'running';
  }
  if (clock.lastMessageIsError) {
    return 'error';
  }
  if (isQueued(clock)) {
    return 'queued';
  }
  return 'waiting';
}

/** Trap 1: running does not mean this source's work is in flight. */
export function isBusyWith(clock: RunClock, source: RunTurnSource, turnId?: string): boolean {
  if (!isRunning(clock) || clock.runningTurnSource !== source) {
    return false;
  }
  if (turnId == null) {
    return true;
  }
  return clock.runningTurnId === turnId;
}

/**
 * Trap 2: queued while running → a completion check collects the previous run
 * (the in-flight turn), not the queued work that has not started.
 */
export function collectCompletion(clock: RunClock): CompletionCollection {
  const queuedTurnIds = clock.pendingQueue.map(item => item.id);

  if (isRunning(clock) && isQueued(clock)) {
    return {
      kind: 'previous_run',
      turnId: clock.runningTurnId,
      source: clock.runningTurnSource,
      output: clock.lastCompletedOutput,
      queuedTurnIds,
    };
  }

  if (isRunning(clock)) {
    return {
      kind: 'in_flight',
      turnId: clock.runningTurnId,
      source: clock.runningTurnSource,
      output: null,
    };
  }

  return {
    kind: 'idle',
    turnId: clock.lastCompletedTurnId,
    source: clock.lastCompletedSource,
    output: clock.lastCompletedOutput,
    error: clock.lastMessageIsError,
  };
}

export function snapshotRun(clock: RunClock): RunSnapshot {
  return {
    phase: deriveRunPhase(clock),
    running: isRunning(clock),
    queued: isQueued(clock),
    runningTurnSource: clock.runningTurnSource,
    runningTurnId: clock.runningTurnId,
    pendingQueue: clock.pendingQueue.map(item => ({ ...item })),
    lastRunMessageRole: clock.lastRunMessageRole,
    lastMessageIsError: clock.lastMessageIsError,
    lastCompletedTurnId: clock.lastCompletedTurnId,
    lastCompletedOutput: clock.lastCompletedOutput,
    lastCompletedSource: clock.lastCompletedSource,
  };
}

export function enqueueRun(clock: RunClock, task: string, source: RunTurnSource, now = Date.now()): QueuedRun {
  const item: QueuedRun = {
    id: `run-${++turnSeq}-${now}`,
    task,
    enqueuedAt: now,
    source,
  };
  clock.pendingQueue.push(item);
  return item;
}

export function beginTurn(clock: RunClock, item: QueuedRun, now = Date.now()): void {
  // lastEnqueuedAt is the turn-start marker, not the original queue timestamp.
  clock.lastEnqueuedAt = now;
  clock.runningTurnSource = item.source;
  clock.runningTurnId = item.id;
  clock.lastMessageIsError = false;
}

export function dequeueAndBegin(clock: RunClock, now = Date.now()): QueuedRun | null {
  const item = clock.pendingQueue.shift();
  if (!item) {
    return null;
  }
  beginTurn(clock, item, now);
  return item;
}

export function completeTurn(
  clock: RunClock,
  options: { output?: string | null; error?: boolean; now?: number } = {},
): void {
  const now = options.now ?? Date.now();
  clock.turnCompleteAt = now;
  clock.lastCompletedTurnId = clock.runningTurnId;
  clock.lastCompletedSource = clock.runningTurnSource;
  clock.lastCompletedOutput = options.output ?? null;
  clock.lastMessageIsError = options.error === true;
  clock.lastRunMessageRole = 'assistant';
  clock.runningTurnSource = null;
  clock.runningTurnId = null;
}

export function clearQueue(clock: RunClock): void {
  clock.pendingQueue = [];
}

export function discardPreappliedQueue(clock: RunClock): void {
  clock.pendingQueue = clock.pendingQueue.filter(item => !item.preapplied);
}

export class RunSession {
  private readonly clock: RunClock;

  constructor(clock: RunClock = createRunClock()) {
    this.clock = clock;
  }

  getClock(): RunClock {
    return this.clock;
  }

  snapshot(): RunSnapshot {
    return snapshotRun(this.clock);
  }

  enqueue(task: string, source: RunTurnSource, now?: number): QueuedRun {
    return enqueueRun(this.clock, task, source, now);
  }

  beginQueued(now?: number): QueuedRun | null {
    return dequeueAndBegin(this.clock, now);
  }

  begin(item: QueuedRun, now?: number): void {
    beginTurn(this.clock, item, now);
  }

  complete(options?: { output?: string | null; error?: boolean; now?: number }): void {
    completeTurn(this.clock, options);
  }

  cancel(now?: number): void {
    clearQueue(this.clock);
    if (isRunning(this.clock)) {
      completeTurn(this.clock, { error: false, output: null, now });
    }
  }

  discardPreappliedQueue(): void {
    discardPreappliedQueue(this.clock);
  }

  phase(): RunPhase {
    return deriveRunPhase(this.clock);
  }

  isBusyWith(source: RunTurnSource, turnId?: string): boolean {
    return isBusyWith(this.clock, source, turnId);
  }

  collectCompletion(): CompletionCollection {
    return collectCompletion(this.clock);
  }
}
