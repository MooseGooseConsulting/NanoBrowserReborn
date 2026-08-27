(() => {
  /**
   * Reviewed Hyperagent OBSERVE payload (Issue #1 build-order step 1).
   * Same-origin GET + SSE. Zero DOM scrape. One row per run. No writes.
   * No PATCH/POST to Hyperagent. No MCP OAuth.
   */
  const ALLOWED_HOSTS = {
    'hyperagent.com': true,
    'www.hyperagent.com': true,
  };
  const STATE_KEY = 'hyperagent-observe:rows';
  const RUN_MS = 2000;
  const IDLE_MS = 10000;
  const MAX_TURNS = 300;
  const MAX_CAPTURES = 5000;

  const result = {
    loaded: true,
    scriptId: 'hyperagent-observe',
    mode: globalThis.__nanoUserscriptMode,
    origin: location.origin,
    host: location.hostname,
    threadId: null,
    signedIn: false,
    rows: [],
    latest: null,
    streamEvents: 0,
    streamUp: null,
    fetches: [],
    mutatingCalls: [],
    done: false,
    error: null,
  };

  const ZERO = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let timer = null;
  let es = null;
  let busy = false;
  let threadId = null;
  let state = null;

  function allowedOrigin() {
    return Boolean(ALLOWED_HOSTS[location.hostname.toLowerCase()]);
  }

  function threadIdFromPath(pathname) {
    const match = pathname.match(/\/thread\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  function parseEpoch(value) {
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function classify(status, thread) {
    const enqueuedAt = parseEpoch(status.lastEnqueuedAt);
    const completeAt = parseEpoch(status.turnCompleteAt);
    const queued = Array.isArray(status.pendingQueue) ? status.pendingQueue.length : 0;
    const source = status.runningTurnSource || null;
    if (enqueuedAt > completeAt) {
      return {
        k: 'running',
        label: source ? 'running (' + source + ')' : 'running',
        queued,
        since: enqueuedAt,
        source,
      };
    }
    if (queued) return { k: 'queued', label: 'queued x' + queued, queued, since: completeAt, source };
    if (thread && thread.lastMessageIsError) {
      return { k: 'error', label: 'stopped on error', queued: 0, since: completeAt, source };
    }
    if (!enqueuedAt && !completeAt) return { k: 'new', label: 'no runs yet', queued: 0, since: 0, source };
    if (status.lastRunMessageRole === 'assistant') {
      return { k: 'waiting', label: 'waiting for you', queued: 0, since: completeAt, source };
    }
    return { k: 'idle', label: 'idle', queued: 0, since: completeAt, source };
  }

  function normalizeCapture(capture) {
    if (!capture) return null;
    return {
      input: capture.input_tokens || 0,
      output: capture.output_tokens || 0,
      cacheRead: capture.cache_read_tokens || 0,
      cacheCreate: capture.cache_create_tokens || 0,
    };
  }

  function captureKey(split) {
    return split ? split.input + '/' + split.output + '/' + split.cacheRead + '/' + split.cacheCreate : null;
  }

  function readBreakdown(breakdown) {
    const items = {};
    const byok = {};
    (breakdown && breakdown.items ? breakdown.items : []).forEach(item => {
      items[item.name] = { qty: item.quantity || 0, cost: item.costUsd || 0 };
    });
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

  function meteredDelta(start, end) {
    const delta = {};
    if (!start || !end) return delta;
    Object.keys(end).forEach(name => {
      const change = end[name].qty - (start[name] ? start[name].qty : 0);
      if (change) delta[name] = change;
    });
    return delta;
  }

  function byokDelta(start, end) {
    const delta = {};
    if (!start || !end) return delta;
    Object.keys(end).forEach(model => {
      const previous = start[model] || ZERO;
      const current = end[model];
      const change = {
        input: current.input - previous.input,
        output: current.output - previous.output,
        cacheRead: current.cacheRead - previous.cacheRead,
        cacheCreate: current.cacheCreate - previous.cacheCreate,
      };
      if (change.input || change.output || change.cacheRead || change.cacheCreate) delta[model] = change;
    });
    return delta;
  }

  function sumCaptures(list) {
    return list.reduce(
      (acc, cap) => {
        acc.input += cap.input;
        acc.output += cap.output;
        acc.cacheRead += cap.cacheRead;
        acc.cacheCreate += cap.cacheCreate;
        acc.peak = Math.max(acc.peak, cap.input + cap.cacheRead);
        return acc;
      },
      { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, peak: 0 },
    );
  }

  function emptyState(id) {
    return {
      threadId: id,
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

  function recordCapture(split, at) {
    if (!split) return;
    const key = captureKey(split);
    if (!key || key === '0/0/0/0' || state.seen[key]) return;
    state.seen[key] = 1;
    const rec = { t: at, input: split.input, output: split.output, cacheRead: split.cacheRead, cacheCreate: split.cacheCreate };
    state.captures.push(rec);
    if (state.captures.length > MAX_CAPTURES) state.captures.shift();
    if (state.open) state.open.caps.push(rec);
  }

  function closeTurn(snap) {
    const open = state.open;
    const metered = meteredDelta(open.start.items, snap.items);
    let burn = 0;
    Object.keys(metered).forEach(name => {
      if (/Tokens$/.test(name)) burn += metered[name];
    });
    const endedAt = snap.completeAt || snap.t;
    const row = {
      n: (state.turns[0] ? state.turns[0].n : 0) + 1,
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
    if (state.turns.length > MAX_TURNS) state.turns.length = MAX_TURNS;
    state.open = null;
    return row;
  }

  function applySnapshot(snap) {
    if (snap.running && !state.open) {
      state.open = {
        start: snap,
        startedAt: snap.enqueuedAt || snap.t,
        caps: [],
        streamCost: 0,
        source: snap.phase.source,
      };
    }
    recordCapture(snap.capture, snap.t);
    recordCapture(snap.indicator, snap.t);
    if (!snap.running && state.open) closeTurn(snap);
    state.latest = snap;
    state.err = null;
  }

  async function getJSON(path) {
    const url = location.origin + path;
    result.fetches.push({ url, method: 'GET' });
    const response = await fetch(path, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(path + ' ' + response.status);
    return response.json();
  }

  async function refresh() {
    if (!threadId || busy) return;
    busy = true;
    try {
      const [status, thread, usage, breakdown] = await Promise.all([
        getJSON('/api/threads/' + threadId + '/status'),
        getJSON('/api/threads/' + threadId),
        getJSON('/api/threads/' + threadId + '/usage'),
        getJSON('/api/threads/' + threadId + '/usage-breakdown'),
      ]);
      result.signedIn = true;
      const phase = classify(status, thread);
      const totals = (usage && usage.totals) || {};
      const full = readBreakdown(breakdown);
      applySnapshot({
        t: Date.now(),
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
      });
      publish();
    } catch (error) {
      state.err = String(error && error.message ? error.message : error);
      result.error = state.err;
      publish();
    } finally {
      busy = false;
      schedule();
    }
  }

  function handleSseData(data) {
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      return 'ignore';
    }
    if (parsed.type === 'cost-updated') {
      state.streamEvents += 1;
      if (state.open) state.open.streamCost += parsed.costDeltaUsd || 0;
      return 'refresh';
    }
    return 'ignore';
  }

  function closeStream() {
    if (es) {
      try {
        es.close();
      } catch (error) {
        // already closed
      }
      es = null;
    }
  }

  function openStream() {
    closeStream();
    if (!threadId) return;
    try {
      es = new EventSource('/api/events/stream?threadId=' + threadId);
      es.onopen = () => {
        state.streamUp = true;
        result.streamUp = true;
        publish();
      };
      es.onerror = () => {
        state.streamUp = false;
        result.streamUp = false;
        publish();
      };
      es.onmessage = event => {
        if (handleSseData(event.data) === 'refresh') refresh();
      };
    } catch (error) {
      state.streamUp = false;
      result.streamUp = false;
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    const running = state && state.latest && state.latest.running;
    timer = setTimeout(() => {
      refresh();
    }, running ? RUN_MS : IDLE_MS);
  }

  function paint(status) {
    if (!document.body) return;
    let banner = document.querySelector('#nano-hyperagent-observe');
    if (!banner) {
      banner = document.createElement('aside');
      banner.id = 'nano-hyperagent-observe';
      banner.style.cssText =
        'padding:10px;margin:10px;border:2px solid currentColor;border-radius:8px;max-width:42rem;white-space:pre-wrap;font:13px/1.4 sans-serif';
      document.body.prepend(banner);
    }
    banner.dataset.scriptId = 'hyperagent-observe';
    banner.dataset.threadId = threadId || '';
    banner.dataset.rows = String((state && state.turns ? state.turns.length : 0) || result.rows.length);
    banner.dataset.phase = state && state.latest ? state.latest.phase.k : '';
    banner.textContent = status;
  }

  function persist() {
    GM_setValue(STATE_KEY, {
      fetched_at: Date.now(),
      origin: result.origin,
      threadId,
      rows: state ? state.turns.slice(0, 50) : result.rows,
      error: result.error,
    });
  }

  function publish() {
    result.threadId = threadId;
    result.rows = state ? state.turns.slice().reverse() : result.rows;
    result.latest = state ? state.latest : null;
    result.streamEvents = state ? state.streamEvents : 0;
    result.streamUp = state ? state.streamUp : null;
    result.mutatingCalls = result.fetches.filter(call => call.method !== 'GET' && call.method !== 'HEAD');
    globalThis.__nanoHyperagentObserve = result;
    persist();
    const phase = result.latest && result.latest.phase ? result.latest.phase.label : 'idle';
    const err = result.error ? '\nerror: ' + result.error : '';
    paint(
      'Nano Reborn Hyperagent observe (GET + SSE, no writes)\n' +
        'thread ' +
        (threadId || '(none)') +
        ' · ' +
        phase +
        ' · rows ' +
        result.rows.length +
        ' · sse ' +
        (result.streamUp ? 'up' : 'down') +
        ' · events ' +
        result.streamEvents +
        err,
    );
  }

  function boot() {
    if (!allowedOrigin()) {
      result.error = 'hyperagent-observe is only allowed on hyperagent.com (host: ' + location.hostname + ')';
      result.done = true;
      globalThis.__nanoHyperagentObserve = result;
      paint('Nano Reborn Hyperagent observe: refused off hyperagent.com');
      return;
    }

    const id = threadIdFromPath(location.pathname);
    if (!id) {
      result.error = 'No Hyperagent thread id in the URL. Open /thread/{id}.';
      result.done = true;
      globalThis.__nanoHyperagentObserve = result;
      paint('Nano Reborn Hyperagent observe: no /thread/{id} in this URL');
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      closeStream();
      return;
    }
    if (id === threadId && timer) return;

    threadId = id;
    const saved = GM_getValue(STATE_KEY, null);
    state = emptyState(id);
    if (saved && saved.threadId === id && Array.isArray(saved.rows)) {
      state.turns = saved.rows.slice().reverse();
    }
    result.error = null;
    result.done = false;
    paint('Nano Reborn Hyperagent observe: fetching /status /usage /usage-breakdown…');
    openStream();
    refresh();
  }

  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      boot();
    }
  }, 1200);
  window.addEventListener('beforeunload', closeStream);
  boot();
})();
