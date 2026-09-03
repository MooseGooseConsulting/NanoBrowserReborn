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

/** Cap so a long chat cannot grow an unbounded render list. */
export const MAX_RUN_LOG_ENTRIES = 200;

/**
 * Append-only run log; returns a new array. A `task.start` event starts a
 * fresh log so the previous task's entries do not linger. Excess entries
 * are dropped from the front.
 */
export function appendRunLogEntry(
  entries: readonly RunLogEntry[],
  event: RunLogEventInput,
  maxEntries: number = MAX_RUN_LOG_ENTRIES,
): RunLogEntry[] {
  const base = event.state === 'task.start' ? [] : entries;
  const next = [...base, { ...event }];
  if (next.length <= maxEntries) {
    return next;
  }
  return next.slice(-maxEntries);
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

/**
 * Payload actually sent to the executor vs the display string shown in chat.
 * Attachments put file contents in `payload` and filenames in `display`.
 */
export interface SubmittedTask {
  payload: string;
  display: string;
}

export function rememberSubmittedTask(payload: string, display?: string): SubmittedTask {
  return { payload, display: display ?? payload };
}

/** Prefer the original executor payload so retry keeps attached file contents. */
export function resolveRetryTask(
  lastSubmitted: SubmittedTask | null,
  messages: readonly ChatMessageInput[],
): string | null {
  if (lastSubmitted?.payload.trim()) {
    return lastSubmitted.payload;
  }
  return findLastUserTask(messages);
}

/** Pause/Resume handlers that every ChatInput instance (empty + active) must receive. */
export function getChatPauseProps<T extends { onPauseTask: unknown; onResumeTask: unknown; isPaused: unknown }>(
  props: T,
): Pick<T, 'onPauseTask' | 'onResumeTask' | 'isPaused'> {
  return {
    onPauseTask: props.onPauseTask,
    onResumeTask: props.onResumeTask,
    isPaused: props.isPaused,
  };
}
