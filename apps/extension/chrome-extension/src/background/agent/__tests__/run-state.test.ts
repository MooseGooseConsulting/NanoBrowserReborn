import { describe, expect, it } from 'vitest';
import {
  RunSession,
  beginTurn,
  collectCompletion,
  completeTurn,
  createRunClock,
  deriveRunPhase,
  enqueueRun,
  isBusyWith,
  isQueued,
  isRunning,
  snapshotRun,
} from '../run-state';

describe('four-state run model', () => {
  it('is waiting when idle after an assistant turn and the queue is empty', () => {
    const clock = createRunClock();
    const item = enqueueRun(clock, 'first', 'user', 100);
    clock.pendingQueue.shift();
    beginTurn(clock, item);
    completeTurn(clock, { output: 'done', now: 200 });

    expect(isRunning(clock)).toBe(false);
    expect(isQueued(clock)).toBe(false);
    expect(clock.lastRunMessageRole).toBe('assistant');
    expect(deriveRunPhase(clock)).toBe('waiting');
  });

  it('is running when lastEnqueuedAt > turnCompleteAt and names the trigger', () => {
    const clock = createRunClock();
    const item = enqueueRun(clock, 'user task', 'user', 100);
    // dequeue so pendingQueue is empty — this is in-flight user work
    clock.pendingQueue.shift();
    beginTurn(clock, item);

    expect(clock.lastEnqueuedAt).toBe(100);
    expect(clock.turnCompleteAt).toBeNull();
    expect(clock.lastEnqueuedAt! > (clock.turnCompleteAt ?? 0)).toBe(true);
    expect(clock.runningTurnSource).toBe('user');
    expect(deriveRunPhase(clock)).toBe('running');
    expect(snapshotRun(clock).queued).toBe(false);
  });

  it('is queued when work has been enqueued but has not started', () => {
    const clock = createRunClock();
    enqueueRun(clock, 'follow-up', 'user', 300);

    expect(isRunning(clock)).toBe(false);
    expect(clock.pendingQueue).toHaveLength(1);
    expect(deriveRunPhase(clock)).toBe('queued');
  });

  it('is error when lastMessageIsError after the turn completes', () => {
    const clock = createRunClock();
    const item = enqueueRun(clock, 'failing', 'user', 100);
    clock.pendingQueue.shift();
    beginTurn(clock, item);
    completeTurn(clock, { error: true, output: 'boom', now: 200 });

    expect(clock.lastMessageIsError).toBe(true);
    expect(isRunning(clock)).toBe(false);
    expect(isQueued(clock)).toBe(false);
    expect(deriveRunPhase(clock)).toBe('error');
  });
});

describe('trap: running is not busy with your work', () => {
  it('does not treat a replay-held thread as the user being busy', () => {
    const clock = createRunClock();
    const replay = enqueueRun(clock, 'replay session', 'replay', 50);
    clock.pendingQueue.shift();
    beginTurn(clock, replay);

    expect(deriveRunPhase(clock)).toBe('running');
    expect(clock.runningTurnSource).toBe('replay');
    expect(isBusyWith(clock, 'user')).toBe(false);
    expect(isBusyWith(clock, 'replay')).toBe(true);
  });

  it('does not treat planner/system-held running as the queued user turn', () => {
    const session = new RunSession();
    session.begin({ id: 'sys-1', task: 'planner loop', enqueuedAt: 10, source: 'planner' });
    session.enqueue('user follow-up', 'user', 20);

    expect(session.phase()).toBe('running');
    expect(session.isBusyWith('user')).toBe(false);
    expect(session.snapshot().queued).toBe(true);
    expect(session.snapshot().runningTurnSource).toBe('planner');
  });
});

describe('trap: queued while running collects the previous run', () => {
  it('returns previous_run for a completion check while user work is still queued', () => {
    const clock = createRunClock();
    const previous = enqueueRun(clock, 'first turn', 'user', 100);
    clock.pendingQueue.shift();
    beginTurn(clock, previous);
    completeTurn(clock, { output: 'first answer', now: 200 });

    const held = enqueueRun(clock, 'cron/webhook hold', 'system', 300);
    clock.pendingQueue.shift();
    beginTurn(clock, held);
    enqueueRun(clock, 'your next prompt', 'user', 400);

    expect(isRunning(clock)).toBe(true);
    expect(isQueued(clock)).toBe(true);
    expect(deriveRunPhase(clock)).toBe('running');

    const collected = collectCompletion(clock);
    expect(collected.kind).toBe('previous_run');
    if (collected.kind !== 'previous_run') {
      return;
    }
    expect(collected.turnId).toBe(held.id);
    expect(collected.source).toBe('system');
    expect(collected.output).toBe('first answer');
    expect(collected.queuedTurnIds).toHaveLength(1);
    expect(collected.queuedTurnIds[0]).not.toBe(held.id);
  });

  it('does not report queued work as complete until it has started', () => {
    const session = new RunSession();
    session.begin({ id: 'prev', task: 'running now', enqueuedAt: 1, source: 'replay' });
    const queued = session.enqueue('not started', 'user', 2);
    const collected = session.collectCompletion();

    expect(collected.kind).toBe('previous_run');
    expect(session.snapshot().pendingQueue.map(item => item.id)).toContain(queued.id);
    expect(collected.turnId).toBe('prev');
  });
});
