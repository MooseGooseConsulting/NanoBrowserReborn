import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendRunLogEntry,
  deriveRunUiState,
  findLastUserTask,
  getPauseTaskMessage,
  getResumeTaskMessage,
  isControlHandoffState,
  isNavigatorConfigured,
} from './sidePanelLogic.ts';

describe('readiness gate: Navigator is mandatory', () => {
  it('is not ready when no agent is configured', () => {
    assert.equal(isNavigatorConfigured([]), false);
  });

  it('is not ready when only Planner is configured (old "any agent" check was wrong)', () => {
    assert.equal(isNavigatorConfigured(['planner']), false);
  });

  it('is ready when Navigator is configured', () => {
    assert.equal(isNavigatorConfigured(['navigator']), true);
  });

  it('is ready when Navigator plus Planner are configured', () => {
    assert.equal(isNavigatorConfigured(['planner', 'navigator']), true);
  });
});

describe('pause/resume message posting', () => {
  it('posts the pause_task message the background handles', () => {
    assert.deepEqual(getPauseTaskMessage(), { type: 'pause_task' });
  });

  it('posts the resume_task message the background handles', () => {
    assert.deepEqual(getResumeTaskMessage(), { type: 'resume_task' });
  });
});

describe('run-snapshot application (applyRunSnapshot mirror)', () => {
  it('shows Stop + follow-up lock while running', () => {
    const state = deriveRunUiState({
      phase: 'running',
      running: true,
      queued: false,
      runningTurnSource: 'user',
      busyWithUser: true,
    });
    assert.equal(state.runPhase, 'running');
    assert.equal(state.showStopButton, true);
    assert.equal(state.isFollowUpMode, true);
    assert.equal(state.dispatchLocked, true);
    assert.equal(state.setsInputEnabledTrue, true);
  });

  it('hints "not your work" when held by another source', () => {
    const state = deriveRunUiState({
      phase: 'running',
      running: true,
      queued: false,
      runningTurnSource: 'replay',
      busyWithUser: false,
    });
    assert.equal(state.runHintKind, 'not_your_work');
    assert.equal(state.runHintSource, 'replay');
  });

  it('hints "collects previous" when queued while running without a named source', () => {
    const state = deriveRunUiState({
      phase: 'running',
      running: true,
      queued: true,
      runningTurnSource: null,
      busyWithUser: true,
    });
    assert.equal(state.runHintKind, 'collects_previous');
    assert.equal(state.runHintSource, null);
  });

  it('releases Stop + follow-up lock when waiting', () => {
    const state = deriveRunUiState({
      phase: 'waiting',
      running: false,
      queued: false,
      runningTurnSource: null,
      busyWithUser: false,
    });
    assert.equal(state.showStopButton, false);
    assert.equal(state.isFollowUpMode, false);
    assert.equal(state.dispatchLocked, false);
    assert.equal(state.runHintKind, null);
    assert.equal(state.setsInputEnabledTrue, true);
  });

  it('keeps input enabled on error (retry path stays reachable)', () => {
    const state = deriveRunUiState({
      phase: 'error',
      running: false,
      queued: false,
      runningTurnSource: null,
      busyWithUser: false,
    });
    assert.equal(state.runPhase, 'error');
    assert.equal(state.setsInputEnabledTrue, true);
  });
});

describe('run log', () => {
  it('appends entries in order without mutating the previous list', () => {
    const before = [{ actor: 'system', state: 'task.start', step: 0, maxSteps: 100, timestamp: 1 }];
    const after = appendRunLogEntry(before, {
      actor: 'navigator',
      state: 'step.start',
      step: 1,
      maxSteps: 100,
      timestamp: 2,
    });
    assert.equal(after.length, 2);
    assert.equal(after[1].state, 'step.start');
    assert.equal(before.length, 1);
  });

  it('marks task/run transitions as control handoffs, not step/act progress', () => {
    assert.equal(isControlHandoffState('task.pause'), true);
    assert.equal(isControlHandoffState('task.resume'), true);
    assert.equal(isControlHandoffState('run.update'), true);
    assert.equal(isControlHandoffState('step.start'), false);
    assert.equal(isControlHandoffState('act.ok'), false);
  });
});

describe('error-retry task lookup', () => {
  it('returns the last user-authored task', () => {
    assert.equal(
      findLastUserTask([
        { actor: 'user', content: 'first task' },
        { actor: 'navigator', content: 'working' },
        { actor: 'user', content: 'second task' },
      ]),
      'second task',
    );
  });

  it('returns null when there is no user task', () => {
    assert.equal(findLastUserTask([{ actor: 'system', content: 'hello' }]), null);
    assert.equal(findLastUserTask([]), null);
  });
});
