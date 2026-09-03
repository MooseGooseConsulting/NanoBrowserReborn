(() => {
  /**
   * Reviewed Hyperagent OBSERVE payload v6.1.
   * Same-origin GET + SSE. Zero DOM scrape. No Hyperagent writes.
   *
   * v6.1 adds:
   * - main-capture dedupe (lastCapture primary, indicator fallback)
   * - exact cumulative accounting windows per forced SSE refresh
   * - main/subagent/mixed/unknown attribution with confidence
   * - run-level attribution splits
   * - best-effort Orb billing rate-card read
   */
  const ALLOWED_HOSTS = { 'hyperagent.com': true, 'www.hyperagent.com': true };
  const STOP_KEY = '__nanoHyperagentObserveStop';
  const RUN_MS = 2000;
  const IDLE_MS = 10000;
  const BILLING_MS = 5 * 60 * 1000;
  const MAX_TURNS = 300;
  const MAX_CAPTURES = 5000;
  const MAX_LEDGER = 2500;
  const MAX_FETCHES = 40;
  const FETCH_TIMEOUT_MS = 15000;
  const ZERO = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

  if (typeof globalThis[STOP_KEY] === 'function') {
    try { globalThis[STOP_KEY](); } catch (_) {}
  }

  const result = {
    loaded: true,
    scriptId: 'hyperagent-observe',
    mode: globalThis.__nanoUserscriptMode,
    origin: location.origin,
    host: location.hostname,
    threadId: null,
    signedIn: false,
    rows: [],
    ledger: [],
    latest: null,
    billing: null,
    billingError: null,
    streamEvents: 0,
    streamUp: null,
    fetches: [],
    mutatingCalls: [],
    done: false,
    error: null,
  };

  let timer = null;
  let pathInterval = null;
  let es = null;
  let busy = false;
  let refreshQueued = false;
  let stopped = false;
  let generation = 0;
  let threadId = null;
  let state = null;
  let billingBusy = false;
  let billingAt = 0;

  function allowedOrigin() { return Boolean(ALLOWED_HOSTS[location.hostname.toLowerCase()]); }
  function threadIdFromPath(pathname) { const m = pathname.match(/\/thread\/([^/?#]+)/); return m ? m[1] : null; }
  function parseEpoch(value) { if (!value) return 0; const n = Date.parse(value); return Number.isFinite(n) ? n : 0; }
  function normalizeCapture(c) {
    if (!c) return null;
    return { input: c.input_tokens || 0, output: c.output_tokens || 0, cacheRead: c.cache_read_tokens || 0, cacheCreate: c.cache_create_tokens || 0 };
  }
  function captureKey(c) { return c ? c.input + '/' + c.output + '/' + c.cacheRead + '/' + c.cacheCreate : null; }
  function liveCapture(snap) { return snap.capture ? { split: snap.capture, source: 'capture' } : { split: snap.indicator, source: 'indicator' }; }
  function contextOf(c) { return c ? c.input + c.cacheRead : 0; }

  function classify(status, thread) {
    const enqueuedAt = parseEpoch(status.lastEnqueuedAt);
    const completeAt = parseEpoch(status.turnCompleteAt);
    const queued = Array.isArray(status.pendingQueue) ? status.pendingQueue.length : 0;
    const source = status.runningTurnSource || null;
    if (thread && thread.lastMessageIsError) return { k: 'error', label: 'stopped on error', queued, since: completeAt, source };
    if (enqueuedAt > completeAt) return { k: 'running', label: source ? 'running (' + source + ')' : 'running', queued, since: enqueuedAt, source };
    if (queued) return { k: 'queued', label: 'queued x' + queued, queued, since: completeAt, source };
    if (!enqueuedAt && !completeAt) return { k: 'new', label: 'no runs yet', queued: 0, since: 0, source };
    if (status.lastRunMessageRole === 'assistant') return { k: 'waiting', label: 'waiting for you', queued: 0, since: completeAt, source };
    return { k: 'idle', label: 'idle', queued: 0, since: completeAt, source };
  }

  function readBreakdown(breakdown) {
    const items = {}, byok = {};
    (breakdown && breakdown.items ? breakdown.items : []).forEach(item => { items[item.name] = { qty: item.quantity || 0, cost: item.costUsd || 0 }; });
    (breakdown && breakdown.byokTokenUsage ? breakdown.byokTokenUsage : []).forEach(model => {
      byok[model.model] = {
        input: model.inputTokens || 0,
        output: model.outputTokens || 0,
        cacheRead: model.cacheReadTokens || 0,
        cacheCreate: model.cacheCreateTokens || 0,
      };
    });
    return { items, byok };
  }

  function emptyState(id) {
    return {
      threadId: id,
      turns: [], captures: [], ledger: [], ledgerSeq: 0,
      accountingPrev: null, pendingSse: [], lastMainCaptureKey: null,
      open: null, latest: null, streamEvents: 0, streamUp: null, err: null,
    };
  }

  function meteredDelta(start, end) {
    const out = {};
    if (!start || !end) return out;
    Object.keys(end).forEach(name => { const d = end[name].qty - (start[name] ? start[name].qty : 0); if (d) out[name] = d; });
    return out;
  }
  function itemDelta(start, end) {
    const out = {};
    if (!start || !end) return out;
    Object.keys(end).forEach(name => {
      const before = start[name] || { qty: 0, cost: 0 }, after = end[name];
      const qty = after.qty - before.qty, cost = after.cost - before.cost;
      if (qty || Math.abs(cost) > 1e-12) out[name] = { qty, cost };
    });
    return out;
  }
  function byokDelta(start, end) {
    const out = {};
    if (!start || !end) return out;
    Object.keys(end).forEach(model => {
      const before = start[model] || ZERO, after = end[model];
      const d = { input: after.input - before.input, output: after.output - before.output, cacheRead: after.cacheRead - before.cacheRead, cacheCreate: after.cacheCreate - before.cacheCreate };
      if (d.input || d.output || d.cacheRead || d.cacheCreate) out[model] = d;
    });
    return out;
  }
  function tokenQty(items, byok) {
    let total = 0;
    Object.keys(items || {}).forEach(name => { if (/Tokens$/i.test(name)) total += Math.max(0, items[name].qty || 0); });
    Object.keys(byok || {}).forEach(model => {
      const x = byok[model] || ZERO;
      total += Math.max(0, x.input || 0) + Math.max(0, x.output || 0) + Math.max(0, x.cacheRead || 0) + Math.max(0, x.cacheCreate || 0);
    });
    return total;
  }
  function modelNorm(value) {
    return String(value || '').toLowerCase().replace(/\s+tokens?$/i, '')
      .replace(/^(openai|anthropic|google|deepseek|z-ai|moonshotai|x-ai|meta-llama|mistralai)\//, '')
      .replace(/[^a-z0-9]+/g, '');
  }
  function modelTail(value) { const x = String(value || ''); return x.indexOf('/') >= 0 ? x.split('/').pop() : x; }
  function itemMatchesModel(name, model) {
    const a = modelNorm(String(name || '').replace(/\s+Tokens$/i, '')), b = modelNorm(modelTail(model));
    return Boolean(a && b && (a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0));
  }

  function classifyWindow(prev, snap, items, byok, eventCount) {
    const oldCap = liveCapture(prev).split, newCap = liveCapture(snap).split;
    const mainChanged = Boolean(newCap && captureKey(oldCap) !== captureKey(newCap));
    const tokenNames = Object.keys(items || {}).filter(n => /Tokens$/i.test(n) && (items[n].qty || 0) > 0);
    const byokNames = Object.keys(byok || {}).filter(m => { const d = byok[m]; return d.input || d.output || d.cacheRead || d.cacheCreate; });
    const mainModelSeen = tokenNames.some(n => itemMatchesModel(n, snap.model)) || byokNames.some(n => itemMatchesModel(n, snap.model));
    const otherModelSeen = tokenNames.some(n => !itemMatchesModel(n, snap.model)) || byokNames.some(n => !itemMatchesModel(n, snap.model));
    let kind = 'unknown', rationale = 'no attributable model/capture delta';
    if (mainChanged && otherModelSeen) { kind = 'mixed'; rationale = 'main capture changed while non-main model counters also advanced'; }
    else if (mainChanged && mainModelSeen && !otherModelSeen) { kind = 'main'; rationale = 'main capture changed and only the thread model advanced'; }
    else if (!mainChanged && otherModelSeen && !mainModelSeen) { kind = 'subagent'; rationale = 'no main capture change and only non-main model counters advanced'; }
    else if (!mainChanged && (mainModelSeen || otherModelSeen)) { kind = 'unknown'; rationale = 'model counters advanced without a new main capture; same-model subagents are indistinguishable'; }
    else if (mainChanged) { kind = 'main'; rationale = 'main capture changed; no model-level token line was available'; }
    let confidence = 'low';
    if (eventCount === 1 && (kind === 'main' || kind === 'subagent')) confidence = 'high';
    else if (eventCount === 1 && kind === 'mixed') confidence = 'medium';
    else if (eventCount > 1 && kind !== 'unknown') confidence = 'medium';
    return { kind, confidence, rationale, mainChanged };
  }

  function reduceAccounting(snap) {
    const prev = state.accountingPrev;
    const events = state.pendingSse.splice(0);
    if (!prev) { state.accountingPrev = snap; return null; }
    const modelDeltas = itemDelta(prev.items, snap.items);
    const byokDeltas = byokDelta(prev.byok, snap.byok);
    const costDelta = Math.max(0, (snap.cost || 0) - (prev.cost || 0));
    if (!events.length && !Object.keys(modelDeltas).length && !Object.keys(byokDeltas).length && !costDelta) {
      state.accountingPrev = snap; return null;
    }
    const attr = classifyWindow(prev, snap, modelDeltas, byokDeltas, events.length);
    const live = liveCapture(snap);
    const row = {
      seq: ++state.ledgerSeq,
      t: snap.t, from: prev.t, source: events.length ? 'sse' : 'poll',
      eventCount: events.length,
      eventSeqFirst: events.length ? events[0].seq : null,
      eventSeqLast: events.length ? events[events.length - 1].seq : null,
      sseCostUsd: events.reduce((sum, x) => sum + (x.costDeltaUsd || 0), 0),
      accountingCostDeltaUsd: costDelta,
      model: snap.model,
      modelDeltas, byokDeltas,
      tokenDelta: tokenQty(modelDeltas, byokDeltas),
      mainCapture: attr.mainChanged && live.split ? Object.assign({ source: live.source }, live.split) : null,
      attribution: attr.kind, confidence: attr.confidence, rationale: attr.rationale,
    };
    state.ledger.push(row);
    if (state.ledger.length > MAX_LEDGER) state.ledger.splice(0, state.ledger.length - MAX_LEDGER);
    state.accountingPrev = snap;
    return row;
  }

  function recordMainCapture(snap) {
    const live = liveCapture(snap), split = live.split;
    if (!split) return;
    const key = captureKey(split);
    if (!key || key === '0/0/0/0') return;
    const previous = state.open ? state.open.lastMainCaptureKey : state.lastMainCaptureKey;
    if (previous === key) return;
    const rec = Object.assign({ t: snap.t, source: live.source }, split);
    state.captures.push(rec);
    if (state.captures.length > MAX_CAPTURES) state.captures.splice(0, state.captures.length - MAX_CAPTURES);
    state.lastMainCaptureKey = key;
    if (state.open) { state.open.lastMainCaptureKey = key; state.open.caps.push(rec); }
  }

  function sumCaptures(list) {
    return list.reduce((acc, cap) => {
      acc.input += cap.input; acc.output += cap.output; acc.cacheRead += cap.cacheRead; acc.cacheCreate += cap.cacheCreate;
      acc.peak = Math.max(acc.peak, contextOf(cap)); return acc;
    }, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, peak: 0 });
  }
  function runSplit(startSeq) {
    const out = {
      tokens: { main: 0, subagent: 0, mixed: 0, unknown: 0 },
      events: { main: 0, subagent: 0, mixed: 0, unknown: 0 },
      windows: { main: 0, subagent: 0, mixed: 0, unknown: 0 },
    };
    state.ledger.forEach(row => {
      if (row.seq < startSeq) return;
      const k = Object.prototype.hasOwnProperty.call(out.tokens, row.attribution) ? row.attribution : 'unknown';
      out.tokens[k] += row.tokenDelta || 0; out.events[k] += row.eventCount || 0; out.windows[k] += 1;
    });
    return out;
  }

  function closeTurn(snap) {
    const open = state.open;
    const metered = meteredDelta(open.start.items, snap.items);
    let burn = 0;
    Object.keys(metered).forEach(name => { if (/Tokens$/.test(name)) burn += metered[name]; });
    const endedAt = snap.completeAt >= open.startedAt ? snap.completeAt : snap.t;
    const row = {
      n: state.turns.reduce((max, turn) => Math.max(max, turn.n || 0), 0) + 1,
      threadId: state.threadId,
      startedAt: open.startedAt, endedAt, ms: endedAt - open.startedAt, seconds: Math.round((endedAt - open.startedAt) / 1000),
      model: snap.model, source: open.source, metered, burn,
      byok: byokDelta(open.start.byok, snap.byok),
      calls: open.caps.length, sampled: sumCaptures(open.caps),
      costDelta: Math.max(0, (snap.cost || 0) - (open.start.cost || 0)),
      phaseAtClose: snap.phase.k,
      split: runSplit(open.ledgerStartSeq),
    };
    state.turns.unshift(row);
    if (state.turns.length > MAX_TURNS) state.turns.length = MAX_TURNS;
    state.open = null;
    return row;
  }

  function completedOffscreenCycle(snap) {
    const prev = state.latest;
    return Boolean(!snap.running && !state.open && prev && snap.enqueuedAt > prev.enqueuedAt && snap.completeAt >= snap.enqueuedAt);
  }

  function applySnapshot(snap) {
    state.err = null; result.error = null;
    if (snap.running && !state.open) {
      const baseline = state.latest && !state.latest.running ? state.latest : snap;
      state.open = {
        start: baseline, startedAt: snap.enqueuedAt || snap.t, source: snap.phase.source,
        caps: [], ledgerStartSeq: state.ledgerSeq + 1,
        lastMainCaptureKey: baseline === snap ? null : captureKey(liveCapture(baseline).split),
      };
    } else if (completedOffscreenCycle(snap)) {
      state.open = {
        start: state.latest, startedAt: snap.enqueuedAt, source: snap.phase.source,
        caps: [], ledgerStartSeq: state.ledgerSeq + 1,
        lastMainCaptureKey: captureKey(liveCapture(state.latest).split),
      };
    }
    recordMainCapture(snap);
    reduceAccounting(snap);
    if (!snap.running && state.open) closeTurn(snap);
    state.latest = snap;
  }

  function numberField(obj, names) {
    for (const name of names) {
      const v = obj && obj[name];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() && Number.isFinite(+v)) return +v;
    }
    return null;
  }
  function stringField(obj, names) {
    for (const name of names) { const v = obj && obj[name]; if (typeof v === 'string' && v.trim()) return v.trim(); }
    return null;
  }
  function findPerPriceCosts(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 7) return null;
    if (obj.perPriceCosts && typeof obj.perPriceCosts === 'object') return obj.perPriceCosts;
    for (const key of Object.keys(obj)) { const found = findPerPriceCosts(obj[key], depth + 1); if (found) return found; }
    return null;
  }
  function normalizeBilling(payload) {
    const raw = findPerPriceCosts(payload, 0);
    const entries = Array.isArray(raw) ? raw.map((x, i) => [String(i), x]) : raw && typeof raw === 'object' ? Object.entries(raw) : [];
    const lines = entries.map(([key, value]) => {
      const x = value && typeof value === 'object' ? value : {};
      const name = stringField(x, ['priceName','name','displayName','metricName','price_name']) || key;
      const quantity = numberField(x, ['quantity','qty','usageQuantity','usage','units']);
      const totalUsd = numberField(x, ['total','totalCost','cost','costUsd','amount','total_cost_usd']);
      const ratePerToken = quantity && totalUsd !== null ? totalUsd / quantity : null;
      return { name, quantity, totalUsd, ratePerToken, ratePerMillion: ratePerToken === null ? null : ratePerToken * 1e6, passThrough: /other usage/i.test(name) || !quantity };
    }).filter(x => (x.quantity || 0) !== 0 || (x.totalUsd || 0) !== 0);
    return { fetchedAt: Date.now(), lines, totalUsd: lines.reduce((sum, x) => sum + (x.totalUsd || 0), 0) };
  }

  async function withTimeout(promise, label) {
    let handle = null;
    try {
      return await Promise.race([promise, new Promise((_, reject) => { handle = setTimeout(() => reject(new Error(label + ' timed out after ' + FETCH_TIMEOUT_MS + 'ms')), FETCH_TIMEOUT_MS); })]);
    } finally { if (handle) clearTimeout(handle); }
  }
  async function getJSON(path) {
    const url = location.origin + path;
    result.fetches.push({ url, method: 'GET' });
    if (result.fetches.length > MAX_FETCHES) result.fetches.splice(0, result.fetches.length - MAX_FETCHES);
    const response = await withTimeout(fetch(path, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } }), path);
    if (!response.ok) throw new Error(path + ' ' + response.status);
    return withTimeout(response.json(), path + ' body');
  }

  async function refreshBilling(force) {
    if (stopped || !state || billingBusy) return;
    if (!force && billingAt && Date.now() - billingAt < BILLING_MS) return;
    billingBusy = true;
    try {
      const payload = await getJSON('/api/settings/billing/usage');
      result.billing = normalizeBilling(payload); result.billingError = null; billingAt = Date.now();
    } catch (error) {
      result.billingError = String(error && error.message ? error.message : error);
    } finally { billingBusy = false; publish(); }
  }

  function handleSseData(data) {
    let parsed;
    try { parsed = JSON.parse(data); } catch (_) { return 'ignore'; }
    if (parsed.type !== 'cost-updated') return 'ignore';
    const seq = ++state.streamEvents;
    state.pendingSse.push({ seq, t: Date.now(), costDeltaUsd: typeof parsed.costDeltaUsd === 'number' ? parsed.costDeltaUsd : 0 });
    return 'refresh';
  }

  function requestRefresh() {
    if (stopped || !threadId || !state) return;
    if (busy) { refreshQueued = true; return; }
    void refresh();
  }

  async function refresh() {
    if (stopped || !threadId || !state || busy) return;
    const gen = generation, id = threadId, captured = state;
    busy = true;
    try {
      const [status, thread, usage, breakdown] = await Promise.all([
        getJSON('/api/threads/' + id + '/status'),
        getJSON('/api/threads/' + id),
        getJSON('/api/threads/' + id + '/usage'),
        getJSON('/api/threads/' + id + '/usage-breakdown'),
      ]);
      if (stopped || gen !== generation || threadId !== id || state !== captured) return;
      result.signedIn = true;
      const phase = classify(status || {}, thread || {}), full = readBreakdown(breakdown || {}), totals = (usage && usage.totals) || {};
      applySnapshot({
        t: Date.now(), model: thread.modelId || null, messages: thread.messageCount || 0, phase,
        running: phase.k === 'running', enqueuedAt: parseEpoch(status.lastEnqueuedAt), completeAt: parseEpoch(status.turnCompleteAt),
        capture: normalizeCapture(usage.lastCapture), indicator: normalizeCapture(thread.lastContextIndicator),
        cost: totals.total_cost_usd || 0, items: full.items, byok: full.byok,
      });
      publish();
      void refreshBilling(false);
    } catch (error) {
      if (stopped || gen !== generation || threadId !== id || state !== captured) return;
      const message = String(error && error.message ? error.message : error);
      state.err = message; result.error = message; publish();
    } finally {
      if (gen === generation) {
        busy = false;
        if (refreshQueued) { refreshQueued = false; queueMicrotask(requestRefresh); }
        else schedule();
      }
    }
  }

  function closeStream() { if (es) { try { es.close(); } catch (_) {} es = null; } }
  function openStream() {
    closeStream();
    if (!threadId || stopped) return;
    const id = threadId, gen = generation;
    try {
      es = new EventSource('/api/events/stream?threadId=' + id);
      es.onopen = () => { if (stopped || gen !== generation || threadId !== id || !state) return; state.streamUp = true; publish(); };
      es.onerror = () => { if (stopped || gen !== generation || threadId !== id || !state) return; state.streamUp = false; publish(); };
      es.onmessage = event => {
        if (stopped || gen !== generation || threadId !== id || !state) return;
        if (handleSseData(event.data) === 'refresh') requestRefresh();
      };
    } catch (_) { if (state) state.streamUp = false; publish(); }
  }
  function schedule() {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(requestRefresh, state && state.latest && state.latest.running ? RUN_MS : IDLE_MS);
  }

  function paint(status) {
    if (!document.body) return;
    let banner = document.querySelector('#nano-hyperagent-observe');
    if (!banner) {
      banner = document.createElement('aside'); banner.id = 'nano-hyperagent-observe';
      banner.style.cssText = 'padding:10px;margin:10px;border:2px solid currentColor;border-radius:8px;max-width:42rem;white-space:pre-wrap;font:13px/1.4 sans-serif';
      document.body.prepend(banner);
    }
    banner.dataset.scriptId = 'hyperagent-observe'; banner.dataset.threadId = threadId || '';
    banner.dataset.rows = String(state ? state.turns.length : 0); banner.dataset.ledger = String(state ? state.ledger.length : 0);
    banner.dataset.phase = state && state.latest ? state.latest.phase.k : '';
    banner.textContent = status;
  }

  function publish() {
    result.threadId = threadId;
    result.error = state ? state.err : result.error;
    result.rows = state ? state.turns.slice().reverse() : [];
    result.ledger = state ? state.ledger.slice() : [];
    result.latest = state ? state.latest : null;
    result.streamEvents = state ? state.streamEvents : 0;
    result.streamUp = state ? state.streamUp : null;
    result.mutatingCalls = result.fetches.filter(call => call.method !== 'GET' && call.method !== 'HEAD');
    globalThis.__nanoHyperagentObserve = result;
    const phase = result.latest && result.latest.phase ? result.latest.phase.label : 'idle';
    const err = result.error ? '\nerror: ' + result.error : '';
    paint('Nano Reborn Hyperagent observe v6.1 (GET + SSE, no writes)\n' +
      'thread ' + (threadId || '(none)') + ' · ' + phase + ' · rows ' + result.rows.length +
      ' · ledger ' + result.ledger.length + ' · sse ' + (result.streamUp ? 'up' : 'down') +
      ' · events ' + result.streamEvents + err);
  }

  function resetPublishedThread() {
    threadId = null; state = null; result.threadId = null; result.signedIn = false;
    result.rows = []; result.ledger = []; result.latest = null; result.billing = null; result.billingError = null;
    result.streamEvents = 0; result.streamUp = null; globalThis.__nanoHyperagentObserve = result;
  }
  function onBeforeUnload() { closeStream(); }
  function dispose() {
    stopped = true; generation += 1; busy = false; refreshQueued = false; billingBusy = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (pathInterval) { clearInterval(pathInterval); pathInterval = null; }
    closeStream(); window.removeEventListener('beforeunload', onBeforeUnload);
    if (globalThis[STOP_KEY] === dispose) { try { delete globalThis[STOP_KEY]; } catch (_) { globalThis[STOP_KEY] = undefined; } }
  }

  function boot() {
    if (stopped) return;
    if (!allowedOrigin()) {
      result.error = 'hyperagent-observe is only allowed on hyperagent.com or www.hyperagent.com (host: ' + location.hostname + ')';
      result.done = true; resetPublishedThread(); paint('Nano Reborn Hyperagent observe: refused off Hyperagent'); return;
    }
    const id = threadIdFromPath(location.pathname);
    if (!id) {
      generation += 1; busy = false; refreshQueued = false; result.error = 'No Hyperagent thread id in the URL. Open /thread/{id}.'; result.done = true;
      resetPublishedThread(); if (timer) { clearTimeout(timer); timer = null; } closeStream(); paint('Nano Reborn Hyperagent observe: no /thread/{id} in this URL'); return;
    }
    if (id === threadId && state) return;

    generation += 1; busy = false; refreshQueued = false; billingBusy = false; billingAt = 0;
    threadId = id; state = emptyState(id); result.error = null; result.done = false;
    result.threadId = id; result.signedIn = false; result.rows = []; result.ledger = []; result.latest = null;
    result.billing = null; result.billingError = null; result.streamEvents = 0; result.streamUp = null; result.fetches = []; result.mutatingCalls = [];
    globalThis.__nanoHyperagentObserve = result;
    paint('Nano Reborn Hyperagent observe v6.1: establishing accounting baseline…');

    const gen = generation;
    void refresh().then(() => { if (!stopped && generation === gen && threadId === id) openStream(); });
  }

  let lastPath = location.pathname;
  pathInterval = setInterval(() => { if (!stopped && location.pathname !== lastPath) { lastPath = location.pathname; boot(); } }, 1200);
  window.addEventListener('beforeunload', onBeforeUnload);
  globalThis[STOP_KEY] = dispose;
  boot();
})();
