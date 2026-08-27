(() => {
  /**
   * Reviewed ChatGPT organize payload (injected file).
   * Same-origin fetch: session cookie → /api/auth/session → conversation JSON,
   * then PATCH title on scrap chats. One-shot: skip sticky content-script reruns.
   */
  const ALLOWED_HOSTS = {
    'chatgpt.com': true,
    'chat.openai.com': true,
  };
  const LIST_LIMIT = 100;
  const SCRAP_JSON_CAP = 8;
  const RENAME_CAP = 8;
  const DELAY_MS = 350;
  const STATE_KEY = 'chatgpt-organize:last-inventory';
  const SCRAP_TITLE = /^(new chat|untitled(?: chat)?|chatgpt)$/i;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const result = {
    loaded: true,
    scriptId: 'chatgpt-organize',
    mode: globalThis.__nanoUserscriptMode,
    origin: location.origin,
    host: location.hostname,
    signedIn: false,
    listed: 0,
    scrap: [],
    named: [],
    current: null,
    fetchedJson: 0,
    mutations: [],
    done: false,
    error: null,
  };

  function allowedOrigin() {
    return Boolean(ALLOWED_HOSTS[location.hostname.toLowerCase()]);
  }

  function chatIdFromUrl() {
    const match = location.pathname.match(/^\/(?:share|c|g\/[a-z0-9-]+\/c)\/([a-z0-9-]+)/i);
    return match ? match[1] : null;
  }

  function isScrapTitle(title) {
    const trimmed = String(title || '').trim();
    return trimmed.length === 0 || SCRAP_TITLE.test(trimmed);
  }

  function partText(part) {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    if (Array.isArray(part.parts)) return part.parts.map(partText).join(' ');
    return '';
  }

  function titleFromPreview(preview) {
    const cleaned = String(preview || '').replace(/\s+/g, ' ').trim();
    if (cleaned.length < 8) return '';
    const cut = cleaned.slice(0, 80);
    const atWord = cut.length === 80 ? cut.replace(/\s+\S*$/, '') : cut;
    const proposed = (atWord || cut).trim();
    if (!proposed || isScrapTitle(proposed)) return '';
    return proposed;
  }

  function deviceId() {
    const cookie = document.cookie.match(/(?:^|;)\s*oai-did=([^;]+)/);
    if (cookie) return decodeURIComponent(cookie[1]);
    return '';
  }

  function accountId(session) {
    const cookie = document.cookie.match(/(?:^|;)\s*_account=([^;]+)/);
    if (cookie) return decodeURIComponent(cookie[1]);
    if (session && typeof session.accountId === 'string' && session.accountId) return session.accountId;
    return '';
  }

  function backendUrl(path) {
    return `${location.origin}/backend-api${path}`;
  }

  async function readJson(response, label) {
    if (!response.ok) {
      throw new Error(`${label} failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  async function fetchSession() {
    const response = await fetch(`${location.origin}/api/auth/session`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    return readJson(response, 'session');
  }

  async function fetchBackend(path, accessToken, options = {}) {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Oai-Language': 'en-US',
    };
    const device = deviceId();
    if (device) headers['Oai-Device-Id'] = device;
    const account = options.accountId;
    if (account) headers['Chatgpt-Account-Id'] = account;
    if (options.body) headers['Content-Type'] = 'application/json';
    const response = await fetch(backendUrl(path), {
      method: options.method || 'GET',
      credentials: 'include',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return readJson(response, path);
  }

  function activeBranch(conversation) {
    const mapping = conversation && conversation.mapping;
    if (!mapping || typeof mapping !== 'object') return [];
    const chain = [];
    const seen = new Set();
    let nodeId = conversation.current_node;
    if (!nodeId) {
      nodeId = Object.keys(mapping).find(id => {
        const node = mapping[id];
        return node && (!node.children || node.children.length === 0);
      });
    }
    while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
      seen.add(nodeId);
      chain.push(mapping[nodeId]);
      nodeId = mapping[nodeId].parent;
    }
    return chain.reverse();
  }

  function firstUserPreview(conversation) {
    for (const node of activeBranch(conversation)) {
      const message = node && node.message;
      if (!message || !message.author || message.author.role !== 'user') continue;
      const parts = message.content && message.content.parts;
      const text = (Array.isArray(parts) ? parts.map(partText) : []).join(' ').trim();
      if (text) return text.slice(0, 180);
    }
    return '';
  }

  function messageCount(conversation) {
    return activeBranch(conversation).filter(node => node && node.message).length;
  }

  function summarizeItem(item, extra) {
    return {
      id: item.id,
      title: item.title || '',
      update_time: item.update_time || null,
      bucket: extra.bucket,
      preview: extra.preview || '',
      message_count: extra.message_count || 0,
      mutation: extra.mutation || null,
    };
  }

  function paint(status) {
    if (!document.body) return;
    let banner = document.querySelector('#nano-chatgpt-organize');
    if (!banner) {
      banner = document.createElement('aside');
      banner.id = 'nano-chatgpt-organize';
      banner.style.cssText =
        'padding:10px;margin:10px;border:2px solid currentColor;border-radius:8px;max-width:42rem;white-space:pre-wrap;font:13px/1.4 sans-serif';
      document.body.prepend(banner);
    }
    banner.dataset.scriptId = 'chatgpt-organize';
    banner.dataset.signedIn = String(result.signedIn);
    banner.dataset.listed = String(result.listed);
    banner.dataset.scrap = String(result.scrap.length);
    banner.dataset.mutations = String(result.mutations.length);
    banner.textContent = status;
  }

  function persistInventory() {
    GM_setValue(STATE_KEY, {
      fetched_at: Date.now(),
      origin: result.origin,
      signedIn: result.signedIn,
      listed: result.listed,
      scrap: result.scrap,
      namedCount: result.named.length,
      mutations: result.mutations,
      currentId: result.current && result.current.id,
      error: result.error,
    });
  }

  function finish() {
    result.done = true;
    persistInventory();
    globalThis.__nanoChatGptOrganize = result;
  }

  async function organize() {
    if (!globalThis.__nanoOrganizeRun) {
      result.error = 'one-shot only; skip sticky content-script rerun';
      finish();
      return;
    }
    globalThis.__nanoOrganizeRun = undefined;

    if (!allowedOrigin()) {
      result.error = `chatgpt-organize is only allowed on chatgpt.com / chat.openai.com (host: ${location.hostname})`;
      finish();
      return;
    }

    paint('Nano Reborn ChatGPT organize: fetching session…');
    const session = await fetchSession();
    const accessToken = session && session.accessToken;
    if (!accessToken) {
      result.error = 'Not signed in. This payload has no login UI.';
      finish();
      paint('Nano Reborn ChatGPT organize: not signed in (no login UI in this payload).');
      return;
    }
    result.signedIn = true;
    const workspaceId = accountId(session);

    paint('Nano Reborn ChatGPT organize: listing conversations…');
    const page = await fetchBackend(`/conversations?offset=0&limit=${LIST_LIMIT}`, accessToken, {
      accountId: workspaceId,
    });
    const items = Array.isArray(page && page.items) ? page.items : [];
    result.listed = items.length;

    const currentId = chatIdFromUrl();
    const scrapItems = [];
    const namedItems = [];
    for (const item of items) {
      if (isScrapTitle(item.title)) scrapItems.push(item);
      else namedItems.push(item);
    }

    const fetchQueue = [];
    if (currentId) {
      const listed = items.find(item => item.id === currentId);
      fetchQueue.push(listed || { id: currentId, title: '(current)', update_time: null });
    }
    for (const item of scrapItems) {
      if (fetchQueue.length >= SCRAP_JSON_CAP + (currentId ? 1 : 0)) break;
      if (fetchQueue.some(queued => queued.id === item.id)) continue;
      fetchQueue.push(item);
    }

    const jsonById = {};
    for (let i = 0; i < fetchQueue.length; i += 1) {
      if (i > 0) await sleep(DELAY_MS);
      const item = fetchQueue[i];
      try {
        jsonById[item.id] = await fetchBackend(`/conversation/${item.id}`, accessToken, { accountId: workspaceId });
        result.fetchedJson += 1;
      } catch (error) {
        jsonById[item.id] = { error: String(error && error.message ? error.message : error) };
      }
    }

    let renameCount = 0;
    const mutationById = {};
    // Title-only. Skip unfetched / failed JSON / empty-or-short preview. Never archive.
    for (const item of scrapItems) {
      const raw = jsonById[item.id];
      if (!raw || raw.error) continue;
      const preview = firstUserPreview(raw);
      const proposed = titleFromPreview(preview);
      if (!proposed) continue;
      if (renameCount >= RENAME_CAP) break;
      await sleep(DELAY_MS);
      try {
        await fetchBackend(`/conversation/${item.id}`, accessToken, {
          method: 'PATCH',
          body: { title: proposed },
          accountId: workspaceId,
        });
        const mutation = { id: item.id, action: 'rename', title: proposed, ok: true };
        result.mutations.push(mutation);
        mutationById[item.id] = mutation;
        item.title = proposed;
        renameCount += 1;
      } catch (error) {
        const mutation = {
          id: item.id,
          action: 'rename',
          title: proposed,
          ok: false,
          error: String(error && error.message ? error.message : error),
        };
        result.mutations.push(mutation);
        mutationById[item.id] = mutation;
      }
    }

    result.scrap = scrapItems.map(item => {
      const raw = jsonById[item.id];
      return summarizeItem(item, {
        bucket: 'scrap',
        preview: raw && !raw.error ? firstUserPreview(raw) : '',
        message_count: raw && !raw.error ? messageCount(raw) : 0,
        mutation: mutationById[item.id] || null,
      });
    });
    result.named = namedItems.map(item => summarizeItem(item, { bucket: 'named' }));
    if (currentId) {
      const listed = items.find(item => item.id === currentId) || { id: currentId, title: '(current)' };
      const raw = jsonById[currentId];
      result.current = summarizeItem(listed, {
        bucket: isScrapTitle(listed.title) ? 'scrap' : 'named',
        preview: raw && !raw.error ? firstUserPreview(raw) : '',
        message_count: raw && !raw.error ? messageCount(raw) : 0,
        mutation: mutationById[currentId] || null,
      });
    }

    finish();
    const mutationLines = result.mutations
      .slice(0, 12)
      .map(item => `- ${item.action} ${item.id.slice(0, 8)}…${item.title ? ` → ${item.title}` : ''}`)
      .join('\n');
    paint(
      `Nano Reborn ChatGPT organize via same-origin fetch (active-branch preview)\n` +
        `listed ${result.listed} · scrap ${result.scrap.length} · named ${result.named.length} · json ${result.fetchedJson} · mutations ${result.mutations.length}\n` +
        (mutationLines || '(no title mutations this pass)'),
    );
  }

  organize().catch(error => {
    result.error = String(error && error.message ? error.message : error);
    finish();
    paint(`Nano Reborn ChatGPT organize failed: ${result.error}`);
  });
})();
