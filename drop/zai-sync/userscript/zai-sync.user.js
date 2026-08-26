// ==UserScript==
// @name         Z.ai Incremental Sync (raw)
// @namespace    zai-sync
// @version      2.0.0
// @description  Lossless delta capture of chat.z.ai conversations. Rides your live session — no token, no DOM scraping, no scrolling.
// @match        https://chat.z.ai/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/*
 * Harness A: browser. Auth = your existing session (credentials:'include').
 * Nothing is ever extracted from storage. State persists in GM storage, so each
 * run fetches only what changed.
 *
 * Captures RAW API payloads verbatim — no normalization, nothing dropped.
 * Transform downstream with render.js.
 *
 * Tampermonkey menu:
 *   Sync now (delta)  /  Full resync  /  Download file manifest  /  Show state  /  Reset state
 */

(function () {
  'use strict';

  const BASE = 'https://chat.z.ai';
  const STATE_KEY = 'zai_sync_state_v2';
  const DELAY_MS = 350;

  async function request(url, opts = {}) {
    const res = await fetch(url, {
      credentials: 'include',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      ...opts,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- raw capture (mirrors core.js) --------------------------------------
  async function fetchChatRaw(chatId) {
    const detail = await request(`${BASE}/api/v1/chats/${chatId}`);
    const hist = detail && detail.chat && detail.chat.history;
    const ids = hist && hist.messages ? Object.keys(hist.messages) : [];
    let messages = {};
    if (ids.length) {
      await sleep(DELAY_MS);
      // Mandatory: the detail endpoint returns NO message text.
      const batch = await request(`${BASE}/api/v1/chats/${chatId}/messages/batch`, {
        method: 'POST', body: JSON.stringify({ ids }),
      });
      messages = (batch && batch.data) || {};
    }
    return {
      _schema: 'zai-raw/1', id: chatId, fetched_at: Date.now(),
      detail, messages,
      _counts: { tree: ids.length, hydrated: Object.keys(messages).length },
    };
  }

  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }

  function hashRaw(raw) {
    const canon = stableStringify({ detail: raw.detail, messages: raw.messages });
    let h1 = 0x9e3779b9, h2 = 0x85ebca6b;
    for (let i = 0; i < canon.length; i++) {
      const c = canon.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = (h1 ^ (h1 >>> 16)) >>> 0; h2 = (h2 ^ (h2 >>> 13)) >>> 0;
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  function diffManifest(list, state) {
    const prev = (state && state.chats) || {};
    const added = [], changed = [], unchanged = [];
    const seen = new Set();
    for (const r of list) {
      seen.add(r.id);
      const o = prev[r.id];
      if (!o) added.push(r);
      else if ((o.updated_at || 0) !== (r.updated_at || 0)) changed.push(r);
      else unchanged.push(r);
    }
    return { added, changed, unchanged, removed: Object.keys(prev).filter((i) => !seen.has(i)) };
  }

  function extractFiles(raw) {
    const out = [];
    for (const [msgId, m] of Object.entries(raw.messages || {})) {
      if (!Array.isArray(m.files)) continue;
      for (const f of m.files) {
        if (!f) continue;
        const inner = f.file || {}, meta = inner.meta || {};
        const url = meta.cdn_url || f.url || null;
        const em = typeof url === 'string' ? url.match(/[?&]auth_key=(\d{9,11})-/) : null;
        out.push({
          chat_id: raw.id, message_id: msgId, kind: f.type || null,
          file_id: inner.id || f.id || null,
          name: meta.name || inner.filename || f.name || null,
          content_type: meta.content_type || null, size: meta.size ?? f.size ?? null,
          url, expires_at: em ? Number(em[1]) * 1000 : null,
        });
      }
    }
    return out;
  }

  const loadState = () => {
    try { return JSON.parse(GM_getValue(STATE_KEY, '') || '{"chats":{}}'); }
    catch { return { chats: {} }; }
  };
  const saveState = (s) => GM_setValue(STATE_KEY, JSON.stringify(s));

  let panel;
  function ui(msg) {
    if (!panel) {
      panel = document.createElement('div');
      panel.style.cssText =
        'position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#161b22;color:#e6edf3;' +
        'font:12px/1.5 ui-monospace,monospace;padding:10px 14px;border:1px solid #30363d;' +
        'border-radius:8px;max-width:360px;box-shadow:0 4px 16px rgba(0,0,0,.4);white-space:pre-wrap';
      document.body.appendChild(panel);
    }
    panel.textContent = msg;
  }

  function download(name, text, mime = 'application/x-ndjson') {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  let running = false;
  async function runSync({ full = false } = {}) {
    if (running) { ui('Already running…'); return; }
    running = true;
    try {
      const state = full ? { chats: {} } : loadState();
      ui('Fetching manifest…');
      const list = await request(`${BASE}/api/v1/chats/`);
      const delta = diffManifest(list, state);
      const targets = [...delta.added, ...delta.changed];

      if (!targets.length) { ui(`Up to date.\n${list.length} chats, nothing changed.`); return; }
      ui(`${list.length} chats\n+${delta.added.length} new  ~${delta.changed.length} changed\nFetching ${targets.length}…`);

      const nextChats = { ...state.chats };
      const records = [], files = [];
      let skipped = 0, failed = 0;

      for (let i = 0; i < targets.length; i++) {
        const row = targets[i];
        ui(`[${i + 1}/${targets.length}] ${(row.title || '').slice(0, 40)}`);
        try {
          const raw = await fetchChatRaw(row.id);
          const hash = hashRaw(raw);
          if (nextChats[row.id] && nextChats[row.id].hash === hash) skipped++;
          else { records.push(raw); files.push(...extractFiles(raw)); }
          nextChats[row.id] = { updated_at: row.updated_at, hash, title: row.title, kind: row.type || 'default' };
        } catch (e) {
          failed++; // no watermark on failure -> retried next run
          console.warn('[zai-sync]', row.id, e);
        }
        if (i < targets.length - 1) await sleep(DELAY_MS);
      }

      saveState({ chats: nextChats, lastSync: Date.now() });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');

      if (records.length) {
        download(`zai-raw-${stamp}.ndjson`, records.map((r) => JSON.stringify(r)).join('\n'));
      }
      if (files.length) {
        // Browsers can't bulk-save cross-origin binaries reliably; emit the manifest
        // and let the Node harness fetch them BEFORE the signed URLs expire.
        download(`zai-files-${stamp}.json`, JSON.stringify(files, null, 2), 'application/json');
      }

      ui(`Done.\n${records.length} raw records, ${files.length} file refs\n` +
         `${skipped} unchanged-by-hash, ${failed} failed\n${delta.unchanged.length} skipped entirely`);
    } catch (e) {
      ui('Error: ' + e.message);
      console.error('[zai-sync]', e);
    } finally {
      running = false;
    }
  }

  GM_registerMenuCommand('Sync now (delta)', () => runSync({ full: false }));
  GM_registerMenuCommand('Full resync', () => runSync({ full: true }));
  GM_registerMenuCommand('Show sync state', () => {
    const s = loadState();
    const n = Object.keys(s.chats || {}).length;
    const agents = Object.values(s.chats || {}).filter((c) => c.kind === 'general_agent').length;
    ui(`Tracked: ${n} chats (${agents} agent)\nLast sync: ${s.lastSync ? new Date(s.lastSync).toLocaleString() : 'never'}`);
  });
  GM_registerMenuCommand('Reset state', () => {
    saveState({ chats: {} });
    ui('State cleared. Next sync pulls everything.');
  });
})();
