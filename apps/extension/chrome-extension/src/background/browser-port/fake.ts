import type { BrowserAction, BrowserPort, ExecuteResult, Observation } from './types';

/** Script driving a {@link FakeBrowserPort}: observations replay in order, results map 1:1 onto executes. */
export interface FakePortScript {
  observations?: Observation[];
  results?: ExecuteResult[];
}

export function blankObservation(overrides?: Partial<Observation>): Observation {
  return { url: 'about:blank', title: '', screenshot: null, raw: null, ...overrides };
}

/**
 * In-memory BrowserPort for executor tests: zero Chrome. Observations replay
 * from the script (sticking on the last one when exhausted); every executed
 * action is recorded in call order for assertions.
 */
export class FakeBrowserPort implements BrowserPort {
  /** Every action passed to execute(), in call order. */
  readonly recorded: BrowserAction[] = [];
  waitCalls = 0;
  reconnectCalls = 0;
  released = false;

  private readonly observations: Observation[];
  private readonly results: ExecuteResult[];
  private observationCursor = 0;
  private resultCursor = 0;

  constructor(script: FakePortScript = {}) {
    this.observations =
      script.observations && script.observations.length > 0
        ? script.observations.map(o => ({ ...o }))
        : [blankObservation()];
    this.results = [...(script.results ?? [])];
  }

  async observe(): Promise<Observation> {
    const current = this.observations[this.observationCursor];
    if (this.observationCursor < this.observations.length - 1) {
      this.observationCursor += 1;
    }
    return { ...current };
  }

  async execute(action: BrowserAction): Promise<ExecuteResult> {
    this.recorded.push(action);
    if (this.resultCursor < this.results.length) {
      const result = this.results[this.resultCursor];
      this.resultCursor += 1;
      return { ...result };
    }
    return { ok: true };
  }

  async waitFor(): Promise<void> {
    this.waitCalls += 1;
  }

  async reconnect(): Promise<void> {
    this.reconnectCalls += 1;
  }

  async release(): Promise<void> {
    this.released = true;
  }

  reset(): void {
    this.recorded.length = 0;
    this.waitCalls = 0;
    this.reconnectCalls = 0;
    this.released = false;
    this.observationCursor = 0;
    this.resultCursor = 0;
  }
}
