import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  CHATGPT_ORGANIZE_FILE,
  CHATGPT_ORGANIZE_SCRIPT_ID,
  filesForMode,
  payloadFileFor,
  REVIEWED_USERSCRIPT_HOSTS,
} from '../catalog';
import { assertUserscriptOrigin } from '../register';
import { URLNotAllowedError } from '@src/background/browser/views';
import { assertSourceMatchesChatGptOrganizeContract } from '../chatgpt-organize-contract';

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };
type FetchCall = { url: string; method: string; headers: Record<string, string>; body?: string };
type MockResponse = { ok: boolean; status: number; statusText: string; json: () => Promise<unknown> };
type OrganizeMutation = { id?: string; action?: string; title?: string; ok?: boolean; error?: string };
type OrganizeResult = {
  done?: boolean;
  signedIn?: boolean;
  listed?: number;
  fetchedJson?: number;
  error?: string | null;
  mutations: OrganizeMutation[];
  scrap: Array<{ id?: string; title?: string }>;
  named?: unknown[];
  current?: unknown;
};
type Banner = { style: { cssText: string }; dataset: Record<string, string>; textContent: string; id: string };
type PayloadVm = {
  location: URL;
  document: {
    body: { prepend(): void };
    cookie: string;
    querySelector: () => Banner | null;
    createElement: () => Banner;
  };
  fetch: (url: string, init?: FetchInit) => Promise<MockResponse>;
  GM_getValue: (key: string, fallback?: unknown) => unknown;
  GM_setValue: (key: string, value: unknown) => void;
  crypto: { randomUUID: () => string };
  AbortController: typeof AbortController;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  Promise: PromiseConstructor;
  String: StringConstructor;
  Boolean: BooleanConstructor;
  Array: ArrayConstructor;
  Object: ObjectConstructor;
  Date: DateConstructor;
  JSON: JSON;
  Error: ErrorConstructor;
  Map: MapConstructor;
  Set: SetConstructor;
  Number: NumberConstructor;
  encodeURIComponent: typeof encodeURIComponent;
  decodeURIComponent: typeof decodeURIComponent;
  globalThis?: PayloadVm;
  __nanoUserscriptMode?: string;
  __nanoOrganizeRun?: boolean;
  __nanoOrganizeDeadline?: number;
  __nanoOrganizeCancelled?: boolean;
  __nanoOrganizeAbort?: AbortController;
  __nanoChatGptOrganize?: OrganizeResult;
};
type RunOptions = {
  href?: string;
  cookie?: string;
  oneShot?: boolean;
  deadlineExpired?: boolean;
  source?: string;
  fetchImpl: (url: string, init?: FetchInit) => Promise<MockResponse>;
};

/** Bytes Chrome injects for the packaged seed. Tests must not use a parallel TS helper. */
function payloadSource() {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, '../../../../public/userscripts/chatgpt-organize.user.js'), 'utf8');
}

/** Overlay when set, otherwise the packaged .user.js seed — the same bytes Chrome would run. */
function sourceChromeWouldRun(overlaySource?: string) {
  return overlaySource ?? payloadSource();
}

function jsonResponse(status: number, body: unknown, statusText = 'OK'): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  };
}

function insertionOrderTrapConversation() {
  return {
    current_node: 'leaf',
    mapping: {
      decoy: {
        id: 'decoy',
        parent: 'root',
        children: [],
        message: {
          author: { role: 'user' },
          content: { parts: ['DECOY OBJECT.VALUES FIRST USER THAT IS LONG ENOUGH'] },
        },
      },
      root: { id: 'root', parent: null, children: ['u1', 'decoy'], message: null },
      u1: {
        id: 'u1',
        parent: 'root',
        children: ['leaf'],
        message: { author: { role: 'user' }, content: { parts: ['Compare local vLLM recipes for DeepSeek V4'] } },
      },
      leaf: {
        id: 'leaf',
        parent: 'u1',
        children: [],
        message: { author: { role: 'assistant' }, content: { parts: ['ok'] } },
      },
    },
  };
}

function activeBranchConversation(firstUser: unknown, secondUserObject: unknown) {
  return {
    current_node: 'leaf',
    mapping: {
      root: { id: 'root', parent: null, children: ['u1'], message: null },
      u1: {
        id: 'u1',
        parent: 'root',
        children: ['a1'],
        message: { author: { role: 'user' }, content: { parts: [firstUser] } },
      },
      a1: {
        id: 'a1',
        parent: 'u1',
        children: ['u2'],
        message: { author: { role: 'assistant' }, content: { parts: ['ok'] } },
      },
      u2: {
        id: 'u2',
        parent: 'a1',
        children: ['leaf'],
        message: {
          author: { role: 'user' },
          content: { parts: [secondUserObject] },
        },
      },
      leaf: {
        id: 'leaf',
        parent: 'u2',
        children: [],
        message: { author: { role: 'assistant' }, content: { parts: ['done'] } },
      },
    },
  };
}

async function runInjectedPayload(options: RunOptions) {
  const href = options.href || 'https://chatgpt.com/c/named-keep';
  const location = new URL(href);
  let created: Banner | null = null;
  const gm: Record<string, unknown> = {};
  const calls: FetchCall[] = [];
  const context: PayloadVm = {
    location,
    document: {
      body: { prepend() {} },
      cookie: options.cookie || '',
      querySelector: () => created,
      createElement: () => {
        created = { style: { cssText: '' }, dataset: {}, textContent: '', id: '' };
        return created;
      },
    },
    fetch: async (url: string, init: FetchInit = {}) => {
      calls.push({
        url: String(url),
        method: init.method || 'GET',
        headers: init.headers || {},
        body: init.body,
      });
      return options.fetchImpl(String(url), init);
    },
    GM_getValue: (key: string, fallback?: unknown) =>
      Object.prototype.hasOwnProperty.call(gm, key) ? gm[key] : fallback,
    GM_setValue: (key: string, value: unknown) => {
      gm[key] = value;
    },
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    AbortController,
    setTimeout,
    clearTimeout,
    Promise,
    String,
    Boolean,
    Array,
    Object,
    Date,
    JSON,
    Error,
    Map,
    Set,
    Number,
    encodeURIComponent,
    decodeURIComponent,
  };
  context.globalThis = context;
  context.__nanoUserscriptMode = 'chrome.scripting.registerContentScripts';
  if (options.oneShot !== false) {
    context.__nanoOrganizeRun = true;
  }
  if (options.deadlineExpired) {
    context.__nanoOrganizeDeadline = Date.now() - 1;
    context.__nanoOrganizeCancelled = true;
    context.__nanoOrganizeAbort = new AbortController();
    context.__nanoOrganizeAbort.abort();
  }
  vm.runInNewContext(sourceChromeWouldRun(options.source), context, { timeout: 5000 });
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (context.__nanoChatGptOrganize && context.__nanoChatGptOrganize.done) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const result = context.__nanoChatGptOrganize;
  if (!result) {
    throw new Error('payload did not set __nanoChatGptOrganize');
  }
  return { result, calls, banner: created, gm };
}

describe('chatgpt-organize injected payload (mocked fetch)', () => {
  it('sends Bearer and Oai-Device-Id, titles from active-branch first user text including object parts, and does not archive empty scraps', async () => {
    const { result, calls } = await runInjectedPayload({
      cookie: 'oai-did=device-from-cookie; _account=acct-99',
      fetchImpl: async (url, init = {}) => {
        if (url.endsWith('/api/auth/session')) {
          return jsonResponse(200, { accessToken: 'session-token' });
        }
        if (url.includes('/backend-api/conversations?')) {
          return jsonResponse(200, {
            items: [
              { id: 'scrap-rename', title: 'New chat' },
              { id: 'scrap-empty', title: 'Untitled' },
              { id: 'named-keep', title: 'Monitor upgrade decision' },
            ],
          });
        }
        if (url.endsWith('/backend-api/conversation/scrap-rename') && (!init.method || init.method === 'GET')) {
          return jsonResponse(
            200,
            activeBranchConversation('Compare local vLLM recipes for DeepSeek V4', {
              content_type: 'text',
              text: 'later turn must not win',
            }),
          );
        }
        if (url.endsWith('/backend-api/conversation/scrap-empty')) {
          return jsonResponse(200, { current_node: 'root', mapping: { root: { parent: null, children: [], message: null } } });
        }
        if (init.method === 'PATCH') {
          return jsonResponse(200, { success: true });
        }
        return jsonResponse(404, {}, 'Not Found');
      },
    });

    expect(result.signedIn).toBe(true);
    expect(result.listed).toBe(3);
    expect(result.mutations).toEqual([
      { id: 'scrap-rename', action: 'rename', title: 'Compare local vLLM recipes for DeepSeek V4', ok: true },
    ]);
    expect(result.mutations.some(item => item.action === 'archive')).toBe(false);

    const backendCalls = calls.filter(call => call.url.includes('/backend-api/'));
    expect(backendCalls.length).toBeGreaterThan(0);
    for (const call of backendCalls) {
      expect(call.headers.Authorization).toBe('Bearer session-token');
      expect(call.headers['Oai-Device-Id']).toBe('device-from-cookie');
      expect(call.headers['Chatgpt-Account-Id']).toBe('acct-99');
    }
    const patches = calls.filter(call => call.method === 'PATCH');
    expect(patches).toEqual([
      expect.objectContaining({
        url: 'https://chatgpt.com/backend-api/conversation/scrap-rename',
        method: 'PATCH',
        body: JSON.stringify({ title: 'Compare local vLLM recipes for DeepSeek V4' }),
      }),
    ]);
  });

  it('skips sticky content-script reruns without the one-shot flag', async () => {
    const { result, calls } = await runInjectedPayload({
      oneShot: false,
      fetchImpl: async () => {
        throw new Error('fetch should not run');
      },
    });
    expect(result.error).toMatch(/one-shot only/);
    expect(calls).toEqual([]);
  });

  it('titles from current_node parent walk, not Object.values insertion order', async () => {
    const { result, calls } = await runInjectedPayload({
      cookie: 'oai-did=device-from-cookie',
      fetchImpl: async (url, init = {}) => {
        if (url.endsWith('/api/auth/session')) {
          return jsonResponse(200, { accessToken: 'session-token' });
        }
        if (url.includes('/backend-api/conversations?')) {
          return jsonResponse(200, { items: [{ id: 'scrap-rename', title: 'New chat' }] });
        }
        if (url.endsWith('/backend-api/conversation/scrap-rename') && (!init.method || init.method === 'GET')) {
          return jsonResponse(200, insertionOrderTrapConversation());
        }
        if (init.method === 'PATCH') {
          return jsonResponse(200, { success: true });
        }
        return jsonResponse(404, {}, 'Not Found');
      },
    });
    expect(result.mutations).toEqual([
      { id: 'scrap-rename', action: 'rename', title: 'Compare local vLLM recipes for DeepSeek V4', ok: true },
    ]);
    expect(calls.filter(call => call.method === 'PATCH')[0].body).not.toMatch(/DECOY OBJECT\.VALUES/);
    const mapping = insertionOrderTrapConversation().mapping;
    const valuesFirstUser = Object.values(mapping)
      .map(node => node && node.message)
      .find(message => message && message.author && message.author.role === 'user');
    expect(valuesFirstUser && valuesFirstUser.content.parts[0]).toMatch(/DECOY OBJECT\.VALUES/);
  });

  it('does not PATCH after the organize deadline is cancelled', async () => {
    const { result, calls } = await runInjectedPayload({
      deadlineExpired: true,
      fetchImpl: async () => {
        throw new Error('fetch should not run after cancel');
      },
    });
    expect(result.done).toBe(true);
    expect(result.error).toMatch(/timed out/);
    expect(calls.filter(call => call.method === 'PATCH')).toEqual([]);
  });

  it('sends Bearer without inventing Oai-Device-Id when oai-did is missing', async () => {
    const { result, calls } = await runInjectedPayload({
      cookie: '_account=acct-99',
      fetchImpl: async (url, init = {}) => {
        if (url.endsWith('/api/auth/session')) {
          return jsonResponse(200, { accessToken: 'session-token' });
        }
        if (url.includes('/backend-api/conversations?')) {
          return jsonResponse(200, { items: [{ id: 'named-keep', title: 'Monitor upgrade decision' }] });
        }
        if (url.endsWith('/backend-api/conversation/named-keep') && (!init.method || init.method === 'GET')) {
          return jsonResponse(200, { current_node: 'root', mapping: { root: { parent: null, children: [], message: null } } });
        }
        return jsonResponse(404, {}, 'Not Found');
      },
    });
    expect(result.signedIn).toBe(true);
    const backendCalls = calls.filter(call => call.url.includes('/backend-api/'));
    expect(backendCalls.length).toBeGreaterThan(0);
    for (const call of backendCalls) {
      expect(call.headers.Authorization).toBe('Bearer session-token');
      expect(call.headers).not.toHaveProperty('Oai-Device-Id');
      expect(call.headers['Chatgpt-Account-Id']).toBe('acct-99');
    }
    expect(calls.some(call => call.headers['Oai-Device-Id'] === '11111111-1111-4111-8111-111111111111')).toBe(false);
  });

  it('does not invent a device id or crash on a malformed oai-did cookie', async () => {
    const { result, calls } = await runInjectedPayload({
      cookie: 'oai-did=%E0%A4%A; _account=acct-99',
      fetchImpl: async (url, init = {}) => {
        if (url.endsWith('/api/auth/session')) {
          return jsonResponse(200, { accessToken: 'session-token' });
        }
        if (url.includes('/backend-api/conversations?')) {
          return jsonResponse(200, { items: [{ id: 'named-keep', title: 'Monitor upgrade decision' }] });
        }
        if (url.endsWith('/backend-api/conversation/named-keep') && (!init.method || init.method === 'GET')) {
          return jsonResponse(200, { current_node: 'root', mapping: { root: { parent: null, children: [], message: null } } });
        }
        return jsonResponse(404, {}, 'Not Found');
      },
    });
    expect(result.signedIn).toBe(true);
    expect(result.error).toBeNull();
    const backendCalls = calls.filter(call => call.url.includes('/backend-api/'));
    expect(backendCalls.length).toBeGreaterThan(0);
    for (const call of backendCalls) {
      expect(call.headers.Authorization).toBe('Bearer session-token');
      expect(call.headers['Chatgpt-Account-Id']).toBe('acct-99');
    }
  });

  it('treats a failed title PATCH as a payload error and does not persist previews', async () => {
    const { result, calls, gm } = await runInjectedPayload({
      cookie: 'oai-did=device-from-cookie',
      fetchImpl: async (url, init = {}) => {
        if (url.endsWith('/api/auth/session')) {
          return jsonResponse(200, { accessToken: 'session-token' });
        }
        if (url.includes('/backend-api/conversations?')) {
          return jsonResponse(200, { items: [{ id: 'scrap-rename', title: 'New chat' }] });
        }
        if (url.endsWith('/backend-api/conversation/scrap-rename') && (!init.method || init.method === 'GET')) {
          return jsonResponse(
            200,
            activeBranchConversation('Compare local vLLM recipes for DeepSeek V4', { text: 'later' }),
          );
        }
        if (init.method === 'PATCH') {
          return jsonResponse(401, {}, 'Unauthorized');
        }
        return jsonResponse(404, {}, 'Not Found');
      },
    });
    expect(result.done).toBe(true);
    expect(result.signedIn).toBe(true);
    expect(result.mutations).toEqual([
      expect.objectContaining({ id: 'scrap-rename', action: 'rename', ok: false }),
    ]);
    expect(result.error).toMatch(/401/);
    const inventory = gm['chatgpt-organize:last-inventory'] as Record<string, unknown> | undefined;
    expect(inventory?.scrap).toBeUndefined();
    expect(inventory?.preview).toBeUndefined();
    expect(JSON.stringify(inventory)).not.toMatch(/Compare local vLLM/);
    expect(JSON.stringify(result)).not.toMatch(/"preview"/);
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });

  it('treats HTTP 200 PATCH { success: false } as a failed mutation and does not keep the local title', async () => {
    const { result, calls } = await runInjectedPayload({
      cookie: 'oai-did=device-from-cookie',
      fetchImpl: async (url, init = {}) => {
        if (url.endsWith('/api/auth/session')) {
          return jsonResponse(200, { accessToken: 'session-token' });
        }
        if (url.includes('/backend-api/conversations?')) {
          return jsonResponse(200, { items: [{ id: 'scrap-rename', title: 'New chat' }] });
        }
        if (url.endsWith('/backend-api/conversation/scrap-rename') && (!init.method || init.method === 'GET')) {
          return jsonResponse(
            200,
            activeBranchConversation('Compare local vLLM recipes for DeepSeek V4', { text: 'later' }),
          );
        }
        if (init.method === 'PATCH') {
          return jsonResponse(200, { success: false });
        }
        return jsonResponse(404, {}, 'Not Found');
      },
    });
    expect(result.done).toBe(true);
    expect(result.signedIn).toBe(true);
    expect(result.mutations).toEqual([
      expect.objectContaining({
        id: 'scrap-rename',
        action: 'rename',
        title: 'Compare local vLLM recipes for DeepSeek V4',
        ok: false,
        error: expect.stringMatching(/success=false/),
      }),
    ]);
    expect(result.error).toMatch(/success=false/);
    expect(result.scrap[0].title).toBe('New chat');
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });

  it('fails when every conversation-detail GET fails and does not PATCH', async () => {
    const { result, calls } = await runInjectedPayload({
      href: 'https://chatgpt.com/',
      cookie: 'oai-did=device-from-cookie',
      fetchImpl: async (url, init = {}) => {
        if (url.endsWith('/api/auth/session')) {
          return jsonResponse(200, { accessToken: 'session-token' });
        }
        if (url.includes('/backend-api/conversations?')) {
          return jsonResponse(200, {
            items: [
              { id: 'scrap-a', title: 'New chat' },
              { id: 'scrap-b', title: 'Untitled' },
            ],
          });
        }
        if (/\/backend-api\/conversation\/scrap-[ab]$/.test(url) && (!init.method || init.method === 'GET')) {
          return jsonResponse(500, {}, 'Internal Server Error');
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    });
    expect(result.done).toBe(true);
    expect(result.signedIn).toBe(true);
    expect(result.fetchedJson).toBe(0);
    expect(result.error).toMatch(/500/);
    expect(result.mutations).toEqual([]);
    expect(calls.filter(call => call.method === 'PATCH')).toEqual([]);
  });

  it('skips a 404 scrap but still titles others', async () => {
    const { result, calls } = await runInjectedPayload({
      cookie: 'oai-did=device-from-cookie',
      fetchImpl: async (url, init = {}) => {
        if (url.endsWith('/api/auth/session')) {
          return jsonResponse(200, { accessToken: 'session-token' });
        }
        if (url.includes('/backend-api/conversations?')) {
          return jsonResponse(200, {
            items: [
              { id: 'scrap-gone', title: 'New chat' },
              { id: 'scrap-rename', title: 'Untitled' },
            ],
          });
        }
        if (url.endsWith('/backend-api/conversation/scrap-gone') && (!init.method || init.method === 'GET')) {
          return jsonResponse(404, {}, 'Not Found');
        }
        if (url.endsWith('/backend-api/conversation/scrap-rename') && (!init.method || init.method === 'GET')) {
          return jsonResponse(
            200,
            activeBranchConversation('Compare local vLLM recipes for DeepSeek V4', { text: 'later' }),
          );
        }
        if (init.method === 'PATCH') {
          return jsonResponse(200, { success: true });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    });
    expect(result.error).toBeNull();
    expect(result.mutations).toEqual([
      { id: 'scrap-rename', action: 'rename', title: 'Compare local vLLM recipes for DeepSeek V4', ok: true },
    ]);
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });

  it('treats a conversation-detail 429 as a payload error and does not PATCH', async () => {
    const { result, calls } = await runInjectedPayload({
      cookie: 'oai-did=device-from-cookie',
      fetchImpl: async (url, init = {}) => {
        if (url.endsWith('/api/auth/session')) {
          return jsonResponse(200, { accessToken: 'session-token' });
        }
        if (url.includes('/backend-api/conversations?')) {
          return jsonResponse(200, { items: [{ id: 'scrap-rename', title: 'New chat' }] });
        }
        if (url.endsWith('/backend-api/conversation/scrap-rename') && (!init.method || init.method === 'GET')) {
          return jsonResponse(429, {}, 'Too Many Requests');
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    });
    expect(result.done).toBe(true);
    expect(result.signedIn).toBe(true);
    expect(result.error).toMatch(/429/);
    expect(result.mutations).toEqual([]);
    expect(calls.filter(call => call.method === 'PATCH')).toEqual([]);
  });

  it('treats a conversation-detail 401 as a payload error and does not PATCH', async () => {
    const { result, calls } = await runInjectedPayload({
      cookie: 'oai-did=device-from-cookie',
      fetchImpl: async (url, init = {}) => {
        if (url.endsWith('/api/auth/session')) {
          return jsonResponse(200, { accessToken: 'session-token' });
        }
        if (url.includes('/backend-api/conversations?')) {
          return jsonResponse(200, { items: [{ id: 'scrap-rename', title: 'New chat' }] });
        }
        if (url.endsWith('/backend-api/conversation/scrap-rename') && (!init.method || init.method === 'GET')) {
          return jsonResponse(401, {}, 'Unauthorized');
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    });
    expect(result.done).toBe(true);
    expect(result.signedIn).toBe(true);
    expect(result.error).toMatch(/401/);
    expect(result.mutations).toEqual([]);
    expect(calls.filter(call => call.method === 'PATCH')).toEqual([]);
  });

  it('treats session 401 as done with an error and does not list or PATCH', async () => {
    const { result, calls } = await runInjectedPayload({
      fetchImpl: async url => {
        if (url.endsWith('/api/auth/session')) {
          return jsonResponse(401, {}, 'Unauthorized');
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    });
    expect(result.done).toBe(true);
    expect(result.signedIn).toBe(false);
    expect(result.error).toMatch(/session failed: 401/);
    expect(calls.filter(call => call.url.includes('/backend-api/'))).toEqual([]);
  });

  it('does not archive short real chats or unfetched scraps', async () => {
    const scraps = Array.from({ length: 10 }, (_, i) => ({ id: `scrap-${i}`, title: 'New chat' }));
    const { result, calls } = await runInjectedPayload({
      href: 'https://chatgpt.com/',
      fetchImpl: async (url, init = {}) => {
        if (url.endsWith('/api/auth/session')) {
          return jsonResponse(200, { accessToken: 'session-token' });
        }
        if (url.includes('/backend-api/conversations?')) {
          return jsonResponse(200, { items: scraps });
        }
        const match = url.match(/\/backend-api\/conversation\/(scrap-\d+)$/);
        if (match && (!init.method || init.method === 'GET')) {
          const index = Number(match[1].slice('scrap-'.length));
          const firstUser = index === 0 ? 'fix it' : `Compare local vLLM recipes for scrap ${index}`;
          return jsonResponse(200, activeBranchConversation(firstUser, { text: 'later' }));
        }
        if (init.method === 'PATCH') {
          return jsonResponse(200, { success: true });
        }
        return jsonResponse(404, {}, 'Not Found');
      },
    });

    expect(result.signedIn).toBe(true);
    expect(result.listed).toBe(10);
    expect(result.fetchedJson).toBe(8);
    expect(result.mutations.some(item => item.action === 'archive')).toBe(false);
    expect(result.mutations.some(item => item.id === 'scrap-0')).toBe(false);
    expect(result.mutations.map(item => item.id)).toEqual([
      'scrap-1',
      'scrap-2',
      'scrap-3',
      'scrap-4',
      'scrap-5',
      'scrap-6',
      'scrap-7',
    ]);
    const fetchedGets = calls.filter(
      call => call.method === 'GET' && /\/backend-api\/conversation\/scrap-\d+$/.test(call.url),
    );
    expect(fetchedGets).toHaveLength(8);
    expect(calls.some(call => call.url.endsWith('/conversation/scrap-8'))).toBe(false);
    expect(calls.some(call => call.url.endsWith('/conversation/scrap-9'))).toBe(false);
  });

  it('does not fetch off ChatGPT origins', async () => {
    const { result, calls } = await runInjectedPayload({
      href: 'https://example.com/',
      fetchImpl: async () => {
        throw new Error('fetch should not run');
      },
    });
    expect(result.error).toMatch(/only allowed on chatgpt.com/);
    expect(calls).toEqual([]);
  });

  it('overlay bytes still refuse off-origin fetch', async () => {
    const { result, calls } = await runInjectedPayload({
      href: 'https://example.com/',
      source: `${payloadSource()}\n/* overlay-keep-current */`,
      fetchImpl: async () => {
        throw new Error('fetch should not run');
      },
    });
    expect(result.error).toMatch(/only allowed on chatgpt.com/);
    expect(calls).toEqual([]);
  });

  it('does not fetch on chat.openai.com because it 308s and does not serve /backend-api', async () => {
    const { result, calls } = await runInjectedPayload({
      href: 'https://chat.openai.com/c/abc',
      fetchImpl: async () => {
        throw new Error('fetch should not run');
      },
    });
    expect(result.error).toMatch(/only allowed on chatgpt.com/);
    expect(calls).toEqual([]);
  });
});

describe('chatgpt-organize catalog gates', () => {
  it('allows chatgpt.com only; chat.openai.com and www hosts do not serve /backend-api', () => {
    expect(REVIEWED_USERSCRIPT_HOSTS[CHATGPT_ORGANIZE_SCRIPT_ID]).toEqual(['chatgpt.com']);
    expect(REVIEWED_USERSCRIPT_HOSTS[CHATGPT_ORGANIZE_SCRIPT_ID]).not.toContain('www.chatgpt.com');
    expect(REVIEWED_USERSCRIPT_HOSTS[CHATGPT_ORGANIZE_SCRIPT_ID]).not.toContain('chat.openai.com');
    expect(() => assertUserscriptOrigin(CHATGPT_ORGANIZE_SCRIPT_ID, 'https://chatgpt.com/c/abc')).not.toThrow();
    expect(() => assertUserscriptOrigin(CHATGPT_ORGANIZE_SCRIPT_ID, 'https://chat.openai.com/chat')).toThrow(URLNotAllowedError);
    expect(() => assertUserscriptOrigin(CHATGPT_ORGANIZE_SCRIPT_ID, 'https://www.chatgpt.com/')).toThrow(URLNotAllowedError);
    expect(() => assertUserscriptOrigin(CHATGPT_ORGANIZE_SCRIPT_ID, 'https://www.chat.openai.com/')).toThrow(
      URLNotAllowedError,
    );
    expect(() => assertUserscriptOrigin(CHATGPT_ORGANIZE_SCRIPT_ID, 'https://example.com/')).toThrow(URLNotAllowedError);
  });

  it('keys filesForMode by scriptId so organize cannot ship fixture', () => {
    expect(payloadFileFor(CHATGPT_ORGANIZE_SCRIPT_ID)).toBe(CHATGPT_ORGANIZE_FILE);
    expect(filesForMode('chrome.scripting.registerContentScripts', CHATGPT_ORGANIZE_SCRIPT_ID)).toContain(
      CHATGPT_ORGANIZE_FILE,
    );
    expect(filesForMode('chrome.scripting.registerContentScripts', CHATGPT_ORGANIZE_SCRIPT_ID)).not.toContain(
      'userscripts/fixture.user.js',
    );
    expect(filesForMode('chrome.userScripts', CHATGPT_ORGANIZE_SCRIPT_ID)).toEqual([
      'userscripts/mode-user-scripts.js',
      'userscripts/compat.js',
      CHATGPT_ORGANIZE_FILE,
    ]);
  });

  it('asserts the injected file, not a TS helper, is the ChatGPT payload', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    expect(existsSync(resolve(here, '../chatgpt-organize.ts'))).toBe(false);
    const src = payloadSource();
    expect(payloadFileFor('chatgpt-organize')).toBe(CHATGPT_ORGANIZE_FILE);
    expect(src).toContain('Authorization: `Bearer ${accessToken}`');
    expect(src).toContain("'Oai-Device-Id'");
    expect(src).toContain("'Chatgpt-Account-Id'");
    expect(src).toContain('current_node');
    expect(src).toContain('__nanoOrganizeRun');
    expect(src).toContain('__nanoChatGptOrganize');
    expect(src).not.toContain('is_archived');
    expect(src).not.toContain('randomUUID');
    expect(src).not.toContain('chatgpt-organize:device-id');
    expect(src).toContain('success === false');
    expect(src).toContain('LIST_PAGE_CAP');
    expect(src).toContain('organizeSignal()');
    expect(src).not.toMatch(/Object\.values\(mapping\)/);
    expect(src).toContain('for (const queued of fetchQueue)');
    expect(() => assertSourceMatchesChatGptOrganizeContract(src)).not.toThrow();
  });

  it('exercises overlay bytes, not a parallel TS reimplementation', async () => {
    const overlay = `${payloadSource()}\n/* overlay-keep-current */`;
    expect(() => assertSourceMatchesChatGptOrganizeContract(overlay)).not.toThrow();
    const { result, calls } = await runInjectedPayload({
      source: overlay,
      fetchImpl: async url => {
        if (url.endsWith('/api/auth/session')) {
          return jsonResponse(401, {}, 'Unauthorized');
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    });
    expect(result.done).toBe(true);
    expect(result.signedIn).toBe(false);
    expect(result.error).toMatch(/session failed: 401/);
    expect(calls.filter(call => call.url.includes('/backend-api/'))).toEqual([]);
  });
});
