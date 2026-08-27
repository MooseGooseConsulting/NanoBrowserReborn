import { isHyperagentObserveOrigin } from './catalog';

export const HYPERAGENT_THREAD_PATH = /\/thread\/([^/?#]+)/;

export type RunPhaseKind = 'running' | 'queued' | 'waiting' | 'error' | 'new' | 'idle';

export interface RunPhase {
  k: RunPhaseKind;
  label: string;
  queued: number;
  since: number;
  source: string | null;
}

export interface TokenSplit {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface MeteredItem {
  qty: number;
  cost: number;
}

export interface ObserveSnapshot {
  t: number;
  model: string | null;
  messages: number;
  phase: RunPhase;
  running: boolean;
  enqueuedAt: number;
  completeAt: number;
  capture: TokenSplit | null;
  indicator: TokenSplit | null;
  cost: number;
  items: Record<string, MeteredItem> | null;
  byok: Record<string, TokenSplit> | null;
}

export interface ObserveRow {
  n: number;
  threadId: string;
  startedAt: number;
  endedAt: number;
  ms: number;
  seconds: number;
  model: string | null;
  source: string | null;
  metered: Record<string, number>;
  burn: number;
  byok: Record<string, TokenSplit>;
  calls: number;
  sampled: TokenSplit & { peak: number };
  costDelta: number;
  phaseAtClose: RunPhaseKind;
}

export interface OpenRun {
  start: ObserveSnapshot;
  startedAt: number;
  caps: Array<TokenSplit & { t: number }>;
  streamCost: number;
  source: string | null;
}

export interface ObserveReducerState {
  threadId: string;
  turns: ObserveRow[];
  captures: Array<TokenSplit & { t: number }>;
  seen: Record<string, 1>;
  open: OpenRun | null;
  latest: ObserveSnapshot | null;
  streamEvents: number;
  streamUp: boolean | null;
  err: string | null;
}

export interface ThreadStatusPayload {
  lastEnqueuedAt?: string | null;
  turnCompleteAt?: string | null;
  pendingQueue?: unknown[];
  runningTurnSource?: string | null;
  lastRunMessageRole?: string | null;
  inFlightQueueItem?: unknown;
}

export interface ThreadPayload {
  modelId?: string | null;
  messageCount?: number;
  lastMessageIsError?: boolean;
  lastContextIndicator?: TokenCapturePayload | null;
}

export interface TokenCapturePayload {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_create_tokens?: number;
}

export interface UsagePayload {
  lastCapture?: TokenCapturePayload | null;
  totals?: { total_cost_usd?: number };
}

export interface UsageBreakdownPayload {
  items?: Array<{ name: string; quantity?: number; costUsd?: number }>;
  byokTokenUsage?: Array<{
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreateTokens?: number;
  }>;
}

const ZERO: TokenSplit = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

export function threadIdFromPath(pathname: string): string | null {
  const match = pathname.match(HYPERAGENT_THREAD_PATH);
  return match ? match[1] : null;
}

export function parseEpoch(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function classifyRunPhase(status: ThreadStatusPayload, thread?: ThreadPayload | null): RunPhase {
  const enqueuedAt = parseEpoch(status.lastEnqueuedAt);
  const completeAt = parseEpoch(status.turnCompleteAt);
  const queued = Array.isArray(status.pendingQueue) ? status.pendingQueue.length : 0;
  const source = status.runningTurnSource || null;

  if (enqueuedAt > completeAt) {
    return {
      k: 'running',
      label: source ? `running (${source})` : 'running',
      queued,
      since: enqueuedAt,
      source,
    };
  }
  if (queued) {
    return { k: 'queued', label: `queued x${queued}`, queued, since: completeAt, source };
  }
  if (thread && thread.lastMessageIsError) {
    return { k: 'error', label: 'stopped on error', queued: 0, since: completeAt, source };
  }
  if (!enqueuedAt && !completeAt) {
    return { k: 'new', label: 'no runs yet', queued: 0, since: 0, source };
  }
  if (status.lastRunMessageRole === 'assistant') {
    return { k: 'waiting', label: 'waiting for you', queued: 0, since: completeAt, source };
  }
  return { k: 'idle', label: 'idle', queued: 0, since: completeAt, source };
}

export function normalizeCapture(capture: TokenCapturePayload | null | undefined): TokenSplit | null {
  if (!capture) {
    return null;
  }
  return {
    input: capture.input_tokens || 0,
    output: capture.output_tokens || 0,
    cacheRead: capture.cache_read_tokens || 0,
    cacheCreate: capture.cache_create_tokens || 0,
  };
}

export function captureKey(split: TokenSplit | null): string | null {
  return split ? `${split.input}/${split.output}/${split.cacheRead}/${split.cacheCreate}` : null;
}

export function readBreakdown(breakdown: UsageBreakdownPayload | null | undefined): {
  items: Record<string, MeteredItem>;
  byok: Record<string, TokenSplit>;
} {
  const items: Record<string, MeteredItem> = {};
  const byok: Record<string, TokenSplit> = {};
  for (const item of breakdown?.items || []) {
    items[item.name] = { qty: item.quantity || 0, cost: item.costUsd || 0 };
  }
  for (const model of breakdown?.byokTokenUsage || []) {
    byok[model.model] = {
      input: model.inputTokens || 0,
      output: model.outputTokens || 0,
      cacheRead: model.cacheReadTokens || 0,
      cacheCreate: model.cacheCreateTokens || 0,
    };
  }
  return { items, byok };
}

export function snapshotFromApis(
  status: ThreadStatusPayload,
  thread: ThreadPayload,
  usage: UsagePayload,
  breakdown: UsageBreakdownPayload | null,
  now: number,
): ObserveSnapshot {
  const phase = classifyRunPhase(status, thread);
  const totals = usage.totals || {};
  const full = breakdown ? readBreakdown(breakdown) : { items: null, byok: null };
  return {
    t: now,
    model: thread.modelId || null,
    messages: thread.messageCount || 0,
    phase,
    running: phase.k === 'running',
    enqueuedAt: parseEpoch(status.lastEnqueuedAt),
    completeAt: parseEpoch(status.turnCompleteAt),
    capture: normalizeCapture(usage.lastCapture),
    indicator: normalizeCapture(thread.lastContextIndicator),
    cost: totals.total_cost_usd || 0,
    items: full.items,
    byok: full.byok,
  };
}

export function emptyObserveState(threadId: string): ObserveReducerState {
  return {
    threadId,
    turns: [],
    captures: [],
    seen: {},
    open: null,
    latest: null,
    streamEvents: 0,
    streamUp: null,
    err: null,
  };
}

function contextOf(split: TokenSplit | null): number {
  return split ? split.input + split.cacheRead : 0;
}

function meteredDelta(
  start: Record<string, MeteredItem> | null,
  end: Record<string, MeteredItem> | null,
): Record<string, number> {
  const delta: Record<string, number> = {};
  if (!start || !end) {
    return delta;
  }
  for (const [name, item] of Object.entries(end)) {
    const change = item.qty - (start[name] ? start[name].qty : 0);
    if (change) {
      delta[name] = change;
    }
  }
  return delta;
}

function byokDelta(
  start: Record<string, TokenSplit> | null,
  end: Record<string, TokenSplit> | null,
): Record<string, TokenSplit> {
  const delta: Record<string, TokenSplit> = {};
  if (!start || !end) {
    return delta;
  }
  for (const [model, current] of Object.entries(end)) {
    const previous = start[model] || ZERO;
    const change: TokenSplit = {
      input: current.input - previous.input,
      output: current.output - previous.output,
      cacheRead: current.cacheRead - previous.cacheRead,
      cacheCreate: current.cacheCreate - previous.cacheCreate,
    };
    if (change.input || change.output || change.cacheRead || change.cacheCreate) {
      delta[model] = change;
    }
  }
  return delta;
}

function sumCaptures(list: Array<TokenSplit>): TokenSplit & { peak: number } {
  return list.reduce(
    (acc, cap) => {
      acc.input += cap.input;
      acc.output += cap.output;
      acc.cacheRead += cap.cacheRead;
      acc.cacheCreate += cap.cacheCreate;
      acc.peak = Math.max(acc.peak, contextOf(cap));
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, peak: 0 },
  );
}

function recordCapture(state: ObserveReducerState, split: TokenSplit | null, at: number): void {
  if (!split) {
    return;
  }
  const key = captureKey(split);
  if (!key || key === '0/0/0/0' || state.seen[key]) {
    return;
  }
  state.seen[key] = 1;
  const rec = { t: at, ...split };
  state.captures.push(rec);
  if (state.open) {
    state.open.caps.push(rec);
  }
}

function closeTurn(state: ObserveReducerState, snap: ObserveSnapshot): ObserveRow {
  const open = state.open as OpenRun;
  const metered = meteredDelta(open.start.items, snap.items);
  let burn = 0;
  for (const [name, qty] of Object.entries(metered)) {
    if (/Tokens$/.test(name)) {
      burn += qty;
    }
  }
  const endedAt = snap.completeAt || snap.t;
  const row: ObserveRow = {
    n: state.turns.reduce((max, turn) => Math.max(max, turn.n), 0) + 1,
    threadId: state.threadId,
    startedAt: open.startedAt,
    endedAt,
    ms: endedAt - open.startedAt,
    seconds: Math.round((endedAt - open.startedAt) / 1000),
    model: snap.model,
    source: open.source,
    metered,
    burn,
    byok: byokDelta(open.start.byok, snap.byok),
    calls: open.caps.length,
    sampled: sumCaptures(open.caps),
    costDelta: open.streamCost || (snap.cost || 0) - (open.start.cost || 0),
    phaseAtClose: snap.phase.k,
  };
  state.turns.unshift(row);
  state.open = null;
  return row;
}

function completedOffscreenCycle(state: ObserveReducerState, snap: ObserveSnapshot): boolean {
  const prev = state.latest;
  return Boolean(
    !snap.running &&
      !state.open &&
      prev &&
      snap.enqueuedAt > 0 &&
      snap.enqueuedAt > prev.enqueuedAt &&
      snap.completeAt >= snap.enqueuedAt,
  );
}

export function applyObserveSnapshot(state: ObserveReducerState, snap: ObserveSnapshot): ObserveRow | null {
  state.err = null;

  if (snap.running && !state.open) {
    state.seen = {};
    state.open = {
      start: snap,
      startedAt: snap.enqueuedAt || snap.t,
      caps: [],
      streamCost: 0,
      source: snap.phase.source,
    };
  } else if (completedOffscreenCycle(state, snap) && state.latest) {
    state.seen = {};
    state.open = {
      start: state.latest,
      startedAt: snap.enqueuedAt,
      caps: [],
      streamCost: 0,
      source: snap.phase.source,
    };
  }

  recordCapture(state, snap.capture, snap.t);
  recordCapture(state, snap.indicator, snap.t);

  let closed: ObserveRow | null = null;
  if (!snap.running && state.open) {
    closed = closeTurn(state, snap);
  }
  state.latest = snap;
  return closed;
}

export function handleSseData(state: ObserveReducerState, data: string): 'refresh' | 'ignore' {
  let parsed: { type?: string; costDeltaUsd?: number };
  try {
    parsed = JSON.parse(data) as { type?: string; costDeltaUsd?: number };
  } catch {
    return 'ignore';
  }
  if (parsed.type === 'cost-updated') {
    state.streamEvents += 1;
    if (state.open) {
      state.open.streamCost += parsed.costDeltaUsd || 0;
    }
    return 'refresh';
  }
  return 'ignore';
}

export interface ObserveFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ObserveFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}

export type ObserveFetch = (url: string, init?: ObserveFetchInit) => Promise<ObserveFetchResponse>;

export interface ObserveSseHandlers {
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void | Promise<void>;
  onerror?: () => void;
}

export interface ObserveSseHandle {
  close: () => void;
}

export type ObserveSseFactory = (url: string, handlers: ObserveSseHandlers) => ObserveSseHandle;

export interface ObserveFetchCall {
  url: string;
  method: string;
}

export interface HyperagentObserveResult {
  loaded: boolean;
  scriptId: 'hyperagent-observe';
  origin: string;
  threadId: string | null;
  signedIn: boolean;
  rows: ObserveRow[];
  latest: ObserveSnapshot | null;
  streamEvents: number;
  streamUp: boolean | null;
  fetches: ObserveFetchCall[];
  mutatingCalls: ObserveFetchCall[];
  error: string | null;
}

export function observeJsonResponse(status: number, body: unknown, statusText = 'OK'): ObserveFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  };
}

function asGetMethod(init?: ObserveFetchInit): string {
  return (init?.method || 'GET').toUpperCase();
}

async function readJson(response: ObserveFetchResponse, label: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export async function runHyperagentObservePass(options: {
  origin: string;
  pathname?: string;
  fetchImpl: ObserveFetch;
  openEventSource?: ObserveSseFactory;
  now?: () => number;
}): Promise<HyperagentObserveResult> {
  const origin = options.origin.replace(/\/$/, '');
  const pathname = options.pathname || '/';
  const now = options.now || (() => Date.now());
  const fetches: ObserveFetchCall[] = [];
  const result: HyperagentObserveResult = {
    loaded: true,
    scriptId: 'hyperagent-observe',
    origin,
    threadId: null,
    signedIn: false,
    rows: [],
    latest: null,
    streamEvents: 0,
    streamUp: null,
    fetches,
    mutatingCalls: [],
    error: null,
  };

  if (!isHyperagentObserveOrigin(`${origin}/`)) {
    result.error = `hyperagent-observe is only allowed on hyperagent.com (origin: ${origin})`;
    return result;
  }

  const threadId = threadIdFromPath(pathname);
  result.threadId = threadId;
  if (!threadId) {
    result.error = 'No Hyperagent thread id in the URL. Open /thread/{id}.';
    return result;
  }

  const state = emptyObserveState(threadId);

  const get = async (path: string): Promise<unknown> => {
    const url = `${origin}${path}`;
    const method = 'GET';
    fetches.push({ url, method });
    const response = await options.fetchImpl(url, {
      method,
      headers: { accept: 'application/json' },
    });
    const used = asGetMethod({ method });
    if (used !== 'GET' && used !== 'HEAD') {
      result.mutatingCalls.push({ url, method: used });
      throw new Error(`hyperagent-observe is GET-only; refused ${used} ${path}`);
    }
    return readJson(response, path);
  };

  const asErrorMessage = (error: unknown): string =>
    String(error instanceof Error ? error.message : error);

  const cycle = async () => {
    const [status, thread, usage, breakdown] = (await Promise.all([
      get(`/api/threads/${threadId}/status`),
      get(`/api/threads/${threadId}`),
      get(`/api/threads/${threadId}/usage`),
      get(`/api/threads/${threadId}/usage-breakdown`),
    ])) as [ThreadStatusPayload, ThreadPayload, UsagePayload, UsageBreakdownPayload];
    result.signedIn = true;
    result.error = null;
    const snap = snapshotFromApis(status, thread, usage, breakdown, now());
    applyObserveSnapshot(state, snap);
  };

  try {
    await cycle();
  } catch (error) {
    result.error = asErrorMessage(error);
    result.rows = [...state.turns].reverse();
    result.latest = state.latest;
    result.streamEvents = state.streamEvents;
    result.streamUp = state.streamUp;
    result.mutatingCalls = fetches.filter(call => call.method !== 'GET' && call.method !== 'HEAD');
    return result;
  }

  if (options.openEventSource) {
    let refreshTail = Promise.resolve();
    const enqueueRefresh = () => {
      refreshTail = refreshTail.then(async () => {
        try {
          await cycle();
        } catch (error) {
          result.error = asErrorMessage(error);
        }
      });
    };
    const streamUrl = `${origin}/api/events/stream?threadId=${threadId}`;
    const handle = options.openEventSource(streamUrl, {
      onopen: () => {
        state.streamUp = true;
      },
      onerror: () => {
        state.streamUp = false;
      },
      onmessage: event => {
        if (handleSseData(state, event.data) === 'refresh') {
          enqueueRefresh();
        }
      },
    });
    let previousTail: Promise<void> | null = null;
    let spins = 0;
    while (spins < 32 && previousTail !== refreshTail) {
      previousTail = refreshTail;
      await Promise.resolve();
      await refreshTail;
      spins += 1;
    }
    handle.close();
  }

  result.rows = [...state.turns].reverse();
  result.latest = state.latest;
  result.streamEvents = state.streamEvents;
  result.streamUp = state.streamUp;
  result.mutatingCalls = fetches.filter(call => call.method !== 'GET' && call.method !== 'HEAD');
  result.error = result.error || state.err;
  return result;
}

