/**
 * zai-sync core — raw-first incremental capture for chat.z.ai (Open WebUI fork).
 *
 * DESIGN RULE: capture is lossless. We store API responses VERBATIM and never
 * drop, reshape, or interpret anything on the way in. Normalization is a separate,
 * re-runnable pass over stored raw data (see render.js) so that discovering a new
 * field later does not mean re-scraping 618 conversations.
 *
 * This rule exists because it was already violated once: `tool_calls` blocks were
 * discovered only AFTER a normalizer had been written, and that normalizer would
 * have stringified them into prose. Unknown-unknowns are the default here.
 *
 * You inject a `request` adapter, so the core is auth-agnostic:
 *   - browser/userscript: fetch(credentials:'include')   -> no token needed
 *   - node daemon:        Authorization: Bearer <token>
 *
 * Verified API surface (probed live, Aug 2026):
 *   GET  /api/v1/chats/                     -> [{id,title,updated_at,created_at,type}]
 *                                              618 rows / ~320KB, NO message bodies.
 *                                              This is the delta watermark source.
 *   GET  /api/v1/chats/{id}                 -> {chat:{history:{messages,currentId}}, type, im_context, ...}
 *                                              SKELETON ONLY: id/parentId/childrenIds/role/timestamp.
 *   POST /api/v1/chats/{id}/messages/batch  -> body {ids:[...]}  (field is `ids`; `message_ids` 422s)
 *                                              => {data:{msgId:{content, content_blocks, usage, files, ...}}}
 *
 * Chat kinds observed: 'default' (521) and 'general_agent' (97). Agent chats carry
 * tool_calls blocks and an im_context envelope.
 */

const BASE = 'https://chat.z.ai';

// ---------------------------------------------------------------- client

export function makeClient(request, { delayMs = 350 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Cheap manifest: every chat with updated_at, no bodies. */
  async function listChats() {
    return request(`${BASE}/api/v1/chats/`);
  }

  /**
   * Lossless capture of one conversation.
   * Returns both raw API payloads verbatim plus a tiny envelope of our own.
   * NOTE: we deliberately do NOT filter to the active branch here — orphaned
   * regeneration branches are part of the corpus and are cheap to keep.
   */
  async function fetchChatRaw(chatId) {
    const detail = await request(`${BASE}/api/v1/chats/${chatId}`);
    const hist = detail && detail.chat && detail.chat.history;
    const ids = hist && hist.messages ? Object.keys(hist.messages) : [];

    let messages = {};
    if (ids.length) {
      await sleep(delayMs);
      // Mandatory second call: the detail endpoint returns NO message text.
      const batch = await request(`${BASE}/api/v1/chats/${chatId}/messages/batch`, {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      messages = (batch && batch.data) || {};
    }

    return {
      _schema: 'zai-raw/1',
      id: chatId,
      fetched_at: Date.now(),
      detail,    // verbatim GET  /chats/{id}
      messages,  // verbatim POST /chats/{id}/messages/batch -> .data
      _counts: {
        tree: ids.length,
        hydrated: Object.keys(messages).length,
      },
    };
  }

  return { listChats, fetchChatRaw, sleep };
}

// ---------------------------------------------------------------- delta

/**
 * Compare remote manifest against saved state. Watermark: updated_at.
 *
 * ⚠ `removed` is ADVISORY ONLY. Never delete stored data based on it.
 * Prior art (thiscantbeserious/chatgpt-exporter v1.0.7) documents the list endpoint
 * UNDER-REPORTING under load — a reported total of 101 against 1086 known conversations.
 * If that happens here, every missing chat would look "removed". Local state is ground
 * truth for what EXISTS; the remote list only adds new chats and freshness hints.
 * `suspectTruncation` flags the case so callers can refuse to act on `removed`.
 */
export function diffManifest(remoteList, state) {
  const prev = (state && state.chats) || {};
  const added = [], changed = [], unchanged = [];
  const seen = new Set();

  for (const row of remoteList) {
    seen.add(row.id);
    const old = prev[row.id];
    if (!old) added.push(row);
    else if ((old.updated_at || 0) !== (row.updated_at || 0)) changed.push(row);
    else unchanged.push(row);
  }

  const removed = Object.keys(prev).filter((id) => !seen.has(id));
  const known = Object.keys(prev).length;

  // A real account loses a few chats at a time. Losing a large fraction in one pass
  // is far more likely a truncated list than a mass deletion.
  const suspectTruncation =
    known > 0 && (remoteList.length === 0 || removed.length > Math.max(5, known * 0.2));

  return { added, changed, unchanged, removed, suspectTruncation, knownCount: known };
}

/**
 * Hash of the RAW payload. Because it covers everything we stored, it stays
 * correct when new block types or fields appear — no schema knowledge required.
 * Keys are sorted so JSON key order can't produce phantom diffs.
 */
export function hashRaw(raw) {
  const canon = stableStringify({ detail: raw.detail, messages: raw.messages });
  let h1 = 0x9e3779b9, h2 = 0x85ebca6b;
  for (let i = 0; i < canon.length; i++) {
    const c = canon.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = (h1 ^ (h1 >>> 16)) >>> 0;
  h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/**
 * One incremental pass. Fetches ONLY chats whose updated_at moved.
 * Emits raw records; storage/rendering is the caller's business.
 */
export async function sync(client, state = { chats: {} }, opts = {}) {
  const { onProgress = () => {}, delayMs = 350, limit = Infinity } = opts;

  onProgress({ phase: 'manifest' });
  const list = await client.listChats();
  const delta = diffManifest(list, state);
  const targets = [...delta.added, ...delta.changed].slice(0, limit);

  if (delta.suspectTruncation) {
    // Do NOT treat this as deletions. Keep syncing what the list did return.
    onProgress({
      phase: 'warn',
      message:
        `Remote list returned ${list.length} chats but local state knows ${delta.knownCount}. ` +
        `Treating this as a TRUNCATED LIST, not ${delta.removed.length} deletions. ` +
        `Nothing will be dropped. Re-run when the API is calmer.`,
    });
  }

  onProgress({
    phase: 'planned',
    added: delta.added.length, changed: delta.changed.length,
    unchanged: delta.unchanged.length, removed: delta.removed.length,
    suspectTruncation: delta.suspectTruncation,
    toFetch: targets.length,
  });

  const nextChats = { ...(state.chats || {}) };
  const records = [];
  let skippedByHash = 0, failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const row = targets[i];
    onProgress({ phase: 'fetch', done: i, total: targets.length, title: row.title });
    try {
      const raw = await client.fetchChatRaw(row.id);
      const hash = hashRaw(raw);
      if (nextChats[row.id] && nextChats[row.id].hash === hash) skippedByHash++;
      else records.push(raw);
      nextChats[row.id] = {
        updated_at: row.updated_at, hash,
        title: row.title, kind: row.type || 'default',
      };
    } catch (e) {
      failed++;
      onProgress({ phase: 'error', id: row.id, message: e.message });
    }
    if (i < targets.length - 1) await client.sleep(delayMs);
  }

  onProgress({ phase: 'done', emitted: records.length, skippedByHash, failed });

  return {
    records,
    state: { chats: nextChats, lastSync: Date.now() },
    stats: {
      total: list.length,
      added: delta.added.length, changed: delta.changed.length,
      unchanged: delta.unchanged.length, removed: delta.removed,
      suspectTruncation: delta.suspectTruncation,
      emitted: records.length, skippedByHash, failed,
    },
  };
}
