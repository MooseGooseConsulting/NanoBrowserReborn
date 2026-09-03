/**
 * BrowserPort seam (ADR-003): the plug inside our code that a browser driver answers.
 *
 * MV3 answers it today (see ./mv3.ts); a Node Stagehand host may answer it later.
 * Types only — this module has zero runtime imports by design, so a future
 * out-of-extension host can implement the seam without pulling in MV3 code.
 */

/** Options for {@link BrowserPort.observe}. */
export interface ObserveOptions {
  /** Capture a screenshot alongside the DOM snapshot. @default false */
  useVision?: boolean;
  /** Return the last cached snapshot instead of re-reading the page. @default false */
  cached?: boolean;
}

/**
 * Minimal page snapshot. Full driver state (e.g. MV3 `BrowserState`) travels
 * opaquely in `raw` so the seam stays host-agnostic.
 */
export interface Observation {
  url: string;
  title: string;
  screenshot: string | null;
  /** Host-specific full state; consumers must not depend on its shape. */
  raw: unknown;
}

/** Serializable action envelope covering the executor's current verb surface. */
export type BrowserAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'goBack' }
  | { kind: 'goForward' }
  | { kind: 'refresh' }
  | { kind: 'openTab'; url: string }
  | { kind: 'closeTab'; tabId: number }
  | { kind: 'switchTab'; tabId: number }
  | { kind: 'click'; index: number }
  | { kind: 'inputText'; index: number; text: string }
  | { kind: 'sendKeys'; keys: string }
  | { kind: 'scrollToPercent'; yPercent: number; index?: number }
  | { kind: 'scrollPage'; direction: 'up' | 'down' }
  | { kind: 'scrollToText'; text: string }
  | { kind: 'getDropdownOptions'; index: number }
  | { kind: 'selectDropdownOption'; index: number; text: string };

/** Outcome of one {@link BrowserPort.execute} call. `data` carries read-back payloads (e.g. dropdown options). */
export interface ExecuteResult {
  ok: boolean;
  message?: string;
  error?: string;
  data?: unknown;
}

/** Options for {@link BrowserPort.waitFor}. */
export interface WaitOptions {
  /** Settle timeout in milliseconds. @default host default */
  timeoutMs?: number;
}

/** Options for {@link BrowserPort.reconnect}. */
export interface ReconnectOptions {
  /** Reattach to this tab instead of the current one. @default current tab */
  tabId?: number;
}

export interface BrowserPort {
  /** Capture the current page snapshot for the planner/navigator. */
  observe(options?: ObserveOptions): Promise<Observation>;
  /** Perform one browser action via the attached tab. */
  execute(action: BrowserAction): Promise<ExecuteResult>;
  /** Wait until the page settles (load + network idle) or the timeout elapses. */
  waitFor(options?: WaitOptions): Promise<void>;
  /** Detach and reattach the driver after navigation, crash, or target churn. */
  reconnect(options?: ReconnectOptions): Promise<void>;
  /** Detach cleanly, leaving the user's Chrome running. */
  release(): Promise<void>;
}
