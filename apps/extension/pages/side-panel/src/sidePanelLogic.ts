/**
 * Pure, dependency-free helpers for the side panel.
 *
 * Kept free of React/chrome/i18n imports so the first side-panel tests can
 * exercise them with the Node built-in runner (no new dependencies).
 */

export const NAVIGATOR_AGENT_NAME = 'navigator';

export type RunPhase = 'running' | 'queued' | 'waiting' | 'error';

/**
 * Readiness gate: Navigator is mandatory, Planner is optional.
 * Background setupExecutor throws without a Navigator model and falls back to
 * the Navigator LLM when no Planner model is configured, so "any agent
 * configured" is the wrong check (see ADR-0001/ADR-0004).
 */
export function isNavigatorConfigured(configuredAgents: readonly string[]): boolean {
  return configuredAgents.includes(NAVIGATOR_AGENT_NAME);
}

/** Port messages the background already handles (see background/index.ts). */
export function getPauseTaskMessage(): { type: string } {
  return { type: 'pause_task' };
}

export function getResumeTaskMessage(): { type: string } {
  return { type: 'resume_task' };
}

export interface RunSnapshotInput {
  phase: RunPhase;
  running: boolean;
  queued: boolean;
  runningTurnSource: string | null;
  busyWithUser: boolean;
}

export type RunHintKind = 'not_your_work' | 'collects_previous' | null;

export interface RunUiState {
  runPhase: RunPhase;
  showStopButton: boolean;
  runHintKind: RunHintKind;
  /** Trigger source for the "not your work" hint (e.g. 'replay'), null otherwise. */
  runHintSource: string | null;
  /** applyRunSnapshot only ever enables input, never disables it. */
  setsInputEnabledTrue: boolean;
  isFollowUpMode: boolean;
  dispatchLocked: boolean;
}

/**
 * Pure mirror of SidePanel.applyRunSnapshot: maps a run snapshot onto the UI
 * state it drives. SidePanel keeps the i18n mapping (hint kind -> text).
 */
export function deriveRunUiState(run: RunSnapshotInput): RunUiState {
  let runHintKind: RunHintKind = null;
  let runHintSource: string | null = null;
  if (run.running && !run.busyWithUser && run.runningTurnSource) {
    runHintKind = 'not_your_work';
    runHintSource = run.runningTurnSource;
  } else if (run.running && run.queued) {
    runHintKind = 'collects_previous';
  }
  const setsInputEnabledTrue = run.phase === 'waiting' || run.phase === 'error' || run.running || run.queued;
  const active = run.queued || run.running;
  return {
    runPhase: run.phase,
    showStopButton: run.running,
    runHintKind,
    runHintSource,
    setsInputEnabledTrue,
    isFollowUpMode: active,
    dispatchLocked: active,
  };
}

export interface RunLogEventInput {
  actor: string;
  state: string;
  step: number;
  maxSteps: number;
  timestamp: number;
}

export interface RunLogEntry extends RunLogEventInput {}

/** Append-only run log; returns a new array. Read-only rendering of EXECUTION data. */
export function appendRunLogEntry(
  entries: readonly RunLogEntry[],
  event: RunLogEventInput,
): RunLogEntry[] {
  return [...entries, { ...event }];
}

/** Control-handoff transitions (task lifecycle + run clock) vs step/act progress. */
export function isControlHandoffState(state: string): boolean {
  return state.startsWith('task.') || state === 'run.update';
}

export interface ChatMessageInput {
  actor: string;
  content: string;
}

/** Last user-authored task text, used by the error-retry path. Null when none. */
export function findLastUserTask(messages: readonly ChatMessageInput[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].actor === 'user' && messages[i].content.trim() !== '') {
      return messages[i].content;
    }
  }
  return null;
}
