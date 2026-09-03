import { isHyperagentObserveOrigin } from './catalog';

export const HYPERAGENT_THREAD_PATH = /\/thread\/([^/?#]+)/;

export type RunPhaseKind = 'running' | 'queued' | 'waiting' | 'error' | 'new' | 'idle';
export type AttributionKind = 'main' | 'subagent' | 'mixed' | 'unknown';
export type AttributionConfidence = 'high' | 'medium' | 'low';

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

export interface ObserveLedgerWindow {
  seq: number;
  t: number;
  from: number;
  source: 'sse' | 'poll';
  eventCount: number;
  eventSeqFirst: number | null;
  eventSeqLast: number | null;
  sseCostUsd: number;
  accountingCostDeltaUsd: number;
  model: string | null;
  modelDeltas: Record<string, MeteredItem>;
  byokDeltas: Record<string, TokenSplit>;
  tokenDelta: number;
  mainCapture: (TokenSplit & { source: 'capture' | 'indicator' }) | null;
  attribution: AttributionKind;
  confidence: AttributionConfidence;
  rationale: string;
}

export interface AttributionSplit {
  tokens: Record<AttributionKind, number>;
  events: Record<AttributionKind, number>;
  windows: Record<AttributionKind, number>;
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
  /** v6 accounting-window attribution; optional for restored v5 rows. */
  split?: AttributionSplit;
}

export interface OpenRun {
  start: ObserveSnapshot;
  startedAt: number;
  caps: Array<TokenSplit & { t: number; source?: 'capture' | 'indicator' }>;
  lastMainCaptureKey: string | null;
  source: string | null;
  ledgerStartSeq: number;
}

export interface PendingSseCost {
  seq: number;
  t: number;
  costDeltaUsd: number;
}

export interface ObserveReducerState {
  threadId: string;
  turns: ObserveRow[];
  captures: Array<TokenSplit & { t: number; source?: 'capture' | 'indicator' }>;
  ledger: ObserveLedgerWindow[];
  ledgerSeq: number;
  accountingPrev: ObserveSnapshot | null;
  pendingSse: PendingSseCost[];
  lastMainCaptureKey: string | null;
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

export interface BillingRateLine {
  name: string;
  quantity: number | null;
  totalUsd: number | null;
  ratePerToken: number | null;
  ratePerMillion: number | null;
  passThrough: boolean;
}

export interface BillingRateCard {
  fetchedAt: number;
  lines: BillingRateLine[];
  totalUsd: number;
}

const ZERO: TokenSplit = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
export const MAX_OBSERVE_TURNS = 300;
export const MAX_OBSERVE_CAPTURES = 5000;
export const MAX_OBSERVE_LEDGER = 2500;
export const OBSERVE_FETCH_TIMEOUT_MS = 15_000;

export function threadIdFromPath(pathname: string): string | null {
  const match = pathname.match(HYPERAGENT_THREAD_PATH);
  return match ? match[1] : null;
}

export function parseEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function classifyRunPhase(status: ThreadStatusPayload, thread?: ThreadPayload | null): RunPhase {
  const enqueuedAt = parseEpoch(status.lastEnqueuedAt);
  const completeAt = parseEpoch(status.turnCompleteAt);
  const queued = Array.isArray(status.pendingQueue) ? status.pendingQueue.length : 0;
  const source = status.runningTurnSource || null;

  if (thread?.lastMessageIsError) {
    return { k: 'error', label: 'stopped on error', queued, since: completeAt, source };
  }
  if (enqueuedAt > completeAt) {
    return { k: 'running', label: source ? `running (${source})` : 'running', queued, since: enqueuedAt, source };
  }
  if (queued) return { k: 'queued', label: `queued x${queued}`, queued, since: completeAt, source };
  if (!enqueuedAt && !completeAt) return { k: 'new', label: 'no runs yet', queued: 0, since: 0, source };
  if (status.lastRunMessageRole === 'assistant') {
    return { k: 'waiting', label: 'waiting for you', queued: 0, since: completeAt, source };
  }
  return { k: 'idle', label: 'idle', queued: 0, since: completeAt, source };
}

export function normalizeCapture(capture: TokenCapturePayload | null | undefined): TokenSplit | null {
  if (!capture) return null;
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

function liveCapture(snap: ObserveSnapshot): { split: TokenSplit | null; source: 'capture' | 'indicator' } {
  if (snap.capture) return { split: snap.capture, source: 'capture' };
  return { split: snap.indicator, source: 'indicator' };
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
    cost: usage.totals?.total_cost_usd || 0,
    items: full.items,
    byok: full.byok,
  };
}

export function emptyObserveState(threadId: string): ObserveReducerState {
  return {
    threadId,
    turns: [],
    captures: [],
    ledger: [],
    ledgerSeq: 0,
    accountingPrev: null,
    pendingSse: [],
    lastMainCaptureKey: null,
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

function meteredDelta(start: Record<string, MeteredItem> | null, end: Record<string, MeteredItem> | null): Record<string, number> {
  const delta: Record<string, number> = {};
  if (!start || !end) return delta;
  for (const [name, item] of Object.entries(end)) {
    const change = item.qty - (start[name]?.qty || 0);
    if (change) delta[name] = change;
  }
  return delta;
}

function itemDelta(start: Record<string, MeteredItem> | null, end: Record<string, MeteredItem> | null): Record<string, MeteredItem> {
  const delta: Record<string, MeteredItem> = {};
  if (!start || !end) return delta;
  for (const [name, item] of Object.entries(end)) {
    const previous = start[name] || { qty: 0, cost: 0 };
    const qty = item.qty - previous.qty;
    const cost = item.cost - previous.cost;
    if (qty || Math.abs(cost) > 1e-12) delta[name] = { qty, cost };
  }
  return delta;
}

function byokDelta(start: Record<string, TokenSplit> | null, end: Record<string, TokenSplit> | null): Record<string, TokenSplit> {
  const delta: Record<string, TokenSplit> = {};
  if (!start || !end) return delta;
  for (const [model, current] of Object.entries(end)) {
    const previous = start[model] || ZERO;
    const change: TokenSplit = {
      input: current.input - previous.input,
      output: current.output - previous.output,
      cacheRead: current.cacheRead - previous.cacheRead,
      cacheCreate: current.cacheCreate - previous.cacheCreate,
    };
    if (change.input || change.output || change.cacheRead || change.cacheCreate) delta[model] = change;
  }
  return delta;
}

function byokTokenDelta(byok: Record<string, TokenSplit>): number {
  return Object.values(byok).reduce(
    (sum, x) => sum + Math.max(0, x.input) + Math.max(0, x.output) + Math.max(0, x.cacheRead) + Math.max(0, x.cacheCreate),
    0,
  );
}

function itemTokenDelta(items: Record<string, MeteredItem>): number {
  return Object.entries(items).reduce((sum, [name, x]) => (/Tokens$/i.test(name) ? sum + Math.max(0, x.qty) : sum), 0);
}

function modelNorm(value: string | null | undefined): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+tokens?$/i, '')
    .replace(/^(openai|anthropic|google|deepseek|z-ai|moonshotai|x-ai|meta-llama|mistralai)\//, '')
    .replace(/[^a-z0-9]+/g, '');
}

function modelTail(value: string | null | undefined): string {
  const text = String(value || '');
  return text.includes('/') ? text.split('/').pop() || text : text;
}

function itemMatchesModel(itemName: string, model: string | null): boolean {
  const left = modelNorm(itemName.replace(/\s+Tokens$/i, ''));
  const right = modelNorm(modelTail(model));
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

function classifyWindow(
  prev: ObserveSnapshot,
  snap: ObserveSnapshot,
  items: Record<string, MeteredItem>,
  byok: Record<string, TokenSplit>,
  eventCount: number,
): { kind: AttributionKind; confidence: AttributionConfidence; rationale: string; mainChanged: boolean } {
  const prevCap = liveCapture(prev).split;
  const nextCap = liveCapture(snap).split;
  const mainChanged = Boolean(nextCap && captureKey(prevCap) !== captureKey(nextCap));
  const tokenNames = Object.entries(items)
    .filter(([name, x]) => /Tokens$/i.test(name) && x.qty > 0)
    .map(([name]) => name);
  const byokNames = Object.entries(byok)
    .filter(([, x]) => x.input || x.output || x.cacheRead || x.cacheCreate)
    .map(([name]) => name);
  const mainModelSeen = tokenNames.some(name => itemMatchesModel(name, snap.model)) || byokNames.some(name => itemMatchesModel(name, snap.model));
  const otherModelSeen = tokenNames.some(name => !itemMatchesModel(name, snap.model)) || byokNames.some(name => !itemMatchesModel(name, snap.model));

  let kind: AttributionKind = 'unknown';
  let rationale = 'no attributable model/capture delta';
  if (mainChanged && otherModelSeen) {
    kind = 'mixed';
    rationale = 'main capture changed while non-main model counters also advanced';
  } else if (mainChanged && mainModelSeen && !otherModelSeen) {
    kind = 'main';
    rationale = 'main capture changed and only the thread model advanced';
  } else if (!mainChanged && otherModelSeen && !mainModelSeen) {
    kind = 'subagent';
    rationale = 'no main capture change and only non-main model counters advanced';
  } else if (!mainChanged && (mainModelSeen || otherModelSeen)) {
    kind = 'unknown';
    rationale = 'model counters advanced without a new main capture; same-model subagents are indistinguishable';
  } else if (mainChanged) {
    kind = 'main';
    rationale = 'main capture changed; no model-level token line was available';
  }

  let confidence: AttributionConfidence = 'low';
  if (eventCount === 1 && (kind === 'main' || kind === 'subagent')) confidence = 'high';
  else if (eventCount === 1 && kind === 'mixed') confidence = 'medium';
  else if (eventCount > 1 && kind !== 'unknown') confidence = 'medium';
  return { kind, confidence, rationale, mainChanged };
}

function reduceAccountingWindow(state: ObserveReducerState, snap: ObserveSnapshot): ObserveLedgerWindow | null {
  const prev = state.accountingPrev;
  if (!prev) {
    state.accountingPrev = snap;
    return null;
  }
  const events = state.pendingSse.splice(0);
  const modelDeltas = itemDelta(prev.items, snap.items);
  const byokDeltas = byokDelta(prev.byok, snap.byok);
  const accountingCostDeltaUsd = Math.max(0, snap.cost - prev.cost);
  if (!events.length && !Object.keys(modelDeltas).length && !Object.keys(byokDeltas).length && accountingCostDeltaUsd <= 0) {
    state.accountingPrev = snap;
    return null;
  }

  const attr = classifyWindow(prev, snap, modelDeltas, byokDeltas, events.length);
  const live = liveCapture(snap);
  const row: ObserveLedgerWindow = {
    seq: ++state.ledgerSeq,
    t: snap.t,
    from: prev.t,
    source: events.length ? 'sse' : 'poll',
    eventCount: events.length,
    eventSeqFirst: events[0]?.seq ?? null,
    eventSeqLast: events.at(-1)?.seq ?? null,
    sseCostUsd: events.reduce((sum, event) => sum + event.costDeltaUsd, 0),
    accountingCostDeltaUsd,
    model: snap.model,
    modelDeltas,
    byokDeltas,
    tokenDelta: itemTokenDelta(modelDeltas) + byokTokenDelta(byokDeltas),
    mainCapture: attr.mainChanged && live.split ? { ...live.split, source: live.source } : null,
    attribution: attr.kind,
    confidence: attr.confidence,
    rationale: attr.rationale,
  };
  state.ledger.push(row);
  if (state.ledger.length > MAX_OBSERVE_LEDGER) state.ledger.splice(0, state.ledger.length - MAX_OBSERVE_LEDGER);
  state.accountingPrev = snap;
  return row;
}

function sumCaptures(list: Array<TokenSplit>): TokenSplit & { peak: number } {
  return list.reduce<TokenSplit & { peak: number }>((acc, cap) => {
    acc.input += cap.input;
    acc.output += cap.output;
    acc.cacheRead += cap.cacheRead;
    acc.cacheCreate += cap.cacheCreate;
    acc.peak = Math.max(acc.peak, contextOf(cap));
    return acc;
  }, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, peak: 0 });
}

function recordMainCapture(state: ObserveReducerState, snap: ObserveSnapshot): void {
  const live = liveCapture(snap);
  if (!live.split) return;
  const key = captureKey(live.split);
  if (!key || key === '0/0/0/0') return;
  const previous = state.open?.lastMainCaptureKey ?? state.lastMainCaptureKey;
  if (previous === key) return;
  const rec = { t: snap.t, source: live.source, ...live.split };
  state.captures.push(rec);
  if (state.captures.length > MAX_OBSERVE_CAPTURES) state.captures.splice(0, state.captures.length - MAX_OBSERVE_CAPTURES);
  state.lastMainCaptureKey = key;
  if (state.open) {
    state.open.lastMainCaptureKey = key;
    state.open.caps.push(rec);
  }
}

function splitForRun(state: ObserveReducerState, startSeq: number): AttributionSplit {
  const out: AttributionSplit = {
    tokens: { main: 0, subagent: 0, mixed: 0, unknown: 0 },
    events: { main: 0, subagent: 0, mixed: 0, unknown: 0 },
    windows: { main: 0, subagent: 0, mixed: 0, unknown: 0 },
  };
  for (const row of state.ledger) {
    if (row.seq < startSeq) continue;
    out.tokens[row.attribution] += row.tokenDelta;
    out.events[row.attribution] += row.eventCount;
    out.windows[row.attribution] += 1;
  }
  return out;
}

function closeTurn(state: ObserveReducerState, snap: ObserveSnapshot): ObserveRow {
  const open = state.open as OpenRun;
  const metered = meteredDelta(open.start.items, snap.items);
  const burn = Object.entries(metered).reduce((sum, [name, qty]) => (/Tokens$/.test(name) ? sum + qty : sum), 0);
  const endedAt = snap.completeAt >= open.startedAt ? snap.completeAt : snap.t;
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
    costDelta: Math.max(0, snap.cost - open.start.cost),
    phaseAtClose: snap.phase.k,
    split: splitForRun(state, open.ledgerStartSeq),
  };
  state.turns.unshift(row);
  if (state.turns.length > MAX_OBSERVE_TURNS) state.turns.length = MAX_OBSERVE_TURNS;
  state.open = null;
  return row;
}

function completedOffscreenCycle(state: ObserveReducerState, snap: ObserveSnapshot): boolean {
  const prev = state.latest;
  return Boolean(!snap.running && !state.open && prev && snap.enqueuedAt > prev.enqueuedAt && snap.completeAt >= snap.enqueuedAt);
}

export function applyObserveSnapshot(state: ObserveReducerState, snap: ObserveSnapshot): ObserveRow | null {
  state.err = null;
  if (snap.running && !state.open) {
    const baseline = state.latest && !state.latest.running ? state.latest : snap;
    state.open = {
      start: baseline,
      startedAt: snap.enqueuedAt || snap.t,
      caps: [],
      lastMainCaptureKey: baseline === snap ? null : captureKey(liveCapture(baseline).split),
      source: snap.phase.source,
      ledgerStartSeq: state.ledgerSeq + 1,
    };
  } else if (completedOffscreenCycle(state, snap) && state.latest) {
    state.open = {
      start: state.latest,
      startedAt: snap.enqueuedAt,
      caps: [],
      lastMainCaptureKey: captureKey(liveCapture(state.latest).split),
      source: snap.phase.source,
      ledgerStartSeq: state.ledgerSeq + 1,
    };
  }

  recordMainCapture(state, snap);
  reduceAccountingWindow(state, snap);

  let closed: ObserveRow | null = null;
  if (!snap.running && state.open) closed = closeTurn(state, snap);
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
  if (parsed.type !== 'cost-updated') return 'ignore';
  const seq = ++state.streamEvents;
  state.pendingSse.push({ seq, t: Date.now(), costDeltaUsd: typeof parsed.costDeltaUsd === 'number' ? parsed.costDeltaUsd : 0 });
  return 'refresh';
}

function numberField(value: Record<string, unknown>, names: string[]): number | null {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === 'string' && candidate.trim() && Number.isFinite(Number(candidate))) return Number(candidate);
  }
  return null;
}

function stringField(value: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function findPerPriceCosts(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== 'object' || depth > 7) return null;
  const object = value as Record<string, unknown>;
  if (object.perPriceCosts && typeof object.perPriceCosts === 'object') return object.perPriceCosts;
  for (const child of Object.values(object)) {
    const found = findPerPriceCosts(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export function normalizeBillingUsage(payload: unknown, now = Date.now()): BillingRateCard {
  const raw = findPerPriceCosts(payload);
  const entries: Array<[string, unknown]> = Array.isArray(raw)
    ? raw.map((value, index) => [String(index), value])
    : raw && typeof raw === 'object'
      ? Object.entries(raw as Record<string, unknown>)
      : [];
  const lines = entries
    .map(([key, rawLine]): BillingRateLine => {
      const line = rawLine && typeof rawLine === 'object' ? rawLine as Record<string, unknown> : {};
      const name = stringField(line, ['priceName', 'name', 'displayName', 'metricName', 'price_name']) || key;
      const quantity = numberField(line, ['quantity', 'qty', 'usageQuantity', 'usage', 'units']);
      const totalUsd = numberField(line, ['total', 'totalCost', 'cost', 'costUsd', 'amount', 'total_cost_usd']);
      const ratePerToken = quantity && totalUsd !== null ? totalUsd / quantity : null;
      return {
        name,
        quantity,
        totalUsd,
        ratePerToken,
        ratePerMillion: ratePerToken === null ? null : ratePerToken * 1_000_000,
        passThrough: /other usage/i.test(name) || !quantity,
      };
    })
    .filter(line => (line.quantity || 0) !== 0 || (line.totalUsd || 0) !== 0);
  return { fetchedAt: now, lines, totalUsd: lines.reduce((sum, line) => sum + (line.totalUsd || 0), 0) };
}

export interface ObserveFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
export interface ObserveFetchResponse { ok: boolean; status: number; statusText: string; json: () => Promise<unknown>; }
export type ObserveFetch = (url: string, init?: ObserveFetchInit) => Promise<ObserveFetchResponse>;
export interface ObserveSseHandlers { onopen?: () => void; onmessage?: (event: { data: string }) => void | Promise<void>; onerror?: () => void; }
export interface ObserveSseHandle { close: () => void; }
export type ObserveSseFactory = (url: string, handlers: ObserveSseHandlers) => ObserveSseHandle;
export interface ObserveFetchCall { url: string; method: string; }

export interface HyperagentObserveResult {
  loaded: boolean;
  scriptId: 'hyperagent-observe';
  origin: string;
  threadId: string | null;
  signedIn: boolean;
  rows: ObserveRow[];
  ledger: ObserveLedgerWindow[];
  latest: ObserveSnapshot | null;
  billing: BillingRateCard | null;
  billingError: string | null;
  streamEvents: number;
  streamUp: boolean | null;
  fetches: ObserveFetchCall[];
  mutatingCalls: ObserveFetchCall[];
  error: string | null;
}

export function observeJsonResponse(status: number, body: unknown, statusText = 'OK'): ObserveFetchResponse {
  return { ok: status >= 200 && status < 300, status, statusText, json: async () => body };
}

async function readJson(response: ObserveFetchResponse, label: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${label} failed: ${response.status} ${response.statusText}`);
  return response.json();
}

export async function runHyperagentObservePass(options: {
  origin: string;
  pathname?: string;
  fetchImpl: ObserveFetch;
  openEventSource?: ObserveSseFactory;
  now?: () => number;
  fetchTimeoutMs?: number;
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
    ledger: [],
    latest: null,
    billing: null,
    billingError: null,
    streamEvents: 0,
    streamUp: null,
    fetches,
    mutatingCalls: [],
    error: null,
  };
  if (!isHyperagentObserveOrigin(`${origin}/`)) {
    result.error = `hyperagent-observe is only allowed on hyperagent.com or www.hyperagent.com (origin: ${origin})`;
    return result;
  }
  const threadId = threadIdFromPath(pathname);
  result.threadId = threadId;
  if (!threadId) {
    result.error = 'No Hyperagent thread id in the URL. Open /thread/{id}.';
    return result;
  }

  const state = emptyObserveState(threadId);
  const fetchTimeoutMs = options.fetchTimeoutMs ?? OBSERVE_FETCH_TIMEOUT_MS;
  const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${fetchTimeoutMs}ms`)), fetchTimeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const get = async (path: string): Promise<unknown> => {
    const url = `${origin}${path}`;
    fetches.push({ url, method: 'GET' });
    const response = await withTimeout(options.fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } }), `GET ${path}`);
    return withTimeout(readJson(response, path), `GET ${path} body`);
  };
  const getOptional = async (path: string): Promise<{ value: unknown | null; error: string | null }> => {
    try {
      return { value: await get(path), error: null };
    } catch (error) {
      return { value: null, error: String(error instanceof Error ? error.message : error) };
    }
  };
  const asError = (error: unknown) => String(error instanceof Error ? error.message : error);
  const cycle = async () => {
    const [status, thread, usage, breakdown] = (await Promise.all([
      get(`/api/threads/${threadId}/status`),
      get(`/api/threads/${threadId}`),
      get(`/api/threads/${threadId}/usage`),
      get(`/api/threads/${threadId}/usage-breakdown`),
    ])) as [ThreadStatusPayload, ThreadPayload, UsagePayload, UsageBreakdownPayload];
    result.signedIn = true;
    result.error = null;
    applyObserveSnapshot(state, snapshotFromApis(status, thread, usage, breakdown, now()));
  };

  try {
    await cycle();
    const billing = await getOptional('/api/settings/billing/usage');
    if (billing.value) result.billing = normalizeBillingUsage(billing.value, now());
    else result.billingError = billing.error;
  } catch (error) {
    result.error = asError(error);
    result.rows = [...state.turns].reverse();
    result.ledger = [...state.ledger];
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
        try { await cycle(); } catch (error) { result.error = asError(error); }
      });
    };
    const handle = options.openEventSource(`${origin}/api/events/stream?threadId=${threadId}`, {
      onopen: () => { state.streamUp = true; },
      onerror: () => { state.streamUp = false; },
      onmessage: event => { if (handleSseData(state, event.data) === 'refresh') enqueueRefresh(); },
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
  result.ledger = [...state.ledger];
  result.latest = state.latest;
  result.streamEvents = state.streamEvents;
  result.streamUp = state.streamUp;
  result.mutatingCalls = fetches.filter(call => call.method !== 'GET' && call.method !== 'HEAD');
  result.error = result.error || state.err;
  return result;
}
