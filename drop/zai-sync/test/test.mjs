#!/usr/bin/env node
/**
 * Offline test suite. No network, no credentials. `node test/test.mjs`
 *
 * These tests encode every bug that was actually hit while building this against
 * the live account. If you change core/render/files, these must still pass.
 * A green run here does NOT prove the live API still behaves — for that run
 * `node test/live-check.mjs` with ZAI_TOKEN set.
 */

import assert from 'node:assert/strict';
import { diffManifest, hashRaw, sync, makeClient } from '../core.js';
import { walkActiveBranch, splitBlocks, normalize, toMarkdown } from '../render.js';
import { extractFiles, parseAuthKeyExpiry, isExpired } from '../files.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const ta = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

// ---------------------------------------------------------------- fixtures
// Shaped from REAL payloads observed on chat.z.ai.

const treeWithOrphan = {
  currentId: 'u2',
  messages: {
    u1: { id: 'u1', parentId: null, childrenIds: ['a1', 'a2'], role: 'user', timestamp: 1 },
    a1: { id: 'a1', parentId: 'u1', childrenIds: [], role: 'assistant', timestamp: 2 },       // orphan
    a2: { id: 'a2', parentId: 'u1', childrenIds: ['u2'], role: 'assistant', timestamp: 3 },
    u2: { id: 'u2', parentId: 'a2', childrenIds: [], role: 'user', timestamp: 4 },
  },
};

const rawDefault = {
  _schema: 'zai-raw/1', id: 'chat-default',
  detail: {
    id: 'chat-default', title: 'Normal chat', type: 'default',
    created_at: 100, updated_at: 200,
    chat: { models: ['glm-5.3'], history: treeWithOrphan },
  },
  messages: {
    u1: { id: 'u1', role: 'user', content: 'hello', content_blocks: null },
    a2: {
      id: 'a2', role: 'assistant', content: null, model_name: 'GLM-5.3',
      usage: { total_tokens: 42 },
      content_blocks: [
        { type: 'reasoning', content: 'thinking hard' },
        { type: 'text', content: 'the answer' },
      ],
    },
    u2: { id: 'u2', role: 'user', content: 'follow up', content_blocks: null },
  },
};

const rawAgent = {
  _schema: 'zai-raw/1', id: 'chat-agent',
  detail: {
    id: 'chat-agent', title: 'Agent run', type: 'general_agent',
    created_at: 300, updated_at: 400,
    im_context: { session_id: 'web-x', channel: 'zai-web', model: 'glm-5.3' },
    chat: {
      models: ['glm-5.3'],
      history: {
        currentId: 'am1',
        messages: { am1: { id: 'am1', parentId: null, childrenIds: [], role: 'assistant', timestamp: 1 } },
      },
    },
  },
  messages: {
    am1: {
      id: 'am1', role: 'assistant', content: null,
      files: [{
        type: 'file', id: 'f1', name: 'notes.md', size: 505615, ref_user_msg_id: 'u9',
        file: {
          id: 'file-uuid-1', filename: 'notes.md',
          meta: {
            name: 'notes.md', content_type: 'text/markdown', size: 505615,
            cdn_url: 'https://z-cdn-media.chatglm.cn/files/file-uuid-1.md?auth_key=1787729627-abc',
          },
        },
      }],
      content_blocks: [
        { type: 'reasoning', content: 'plan it' },
        {
          type: 'tool_calls', started_at: 1, ended_at: 2, results: [{ ok: true }],
          content: [{ id: 'call_1', type: 'function', function: { name: 'TodoWrite', arguments: '{"todos":[1,2]}' } }],
        },
        { type: 'text', content: 'done' },
      ],
    },
  },
};

// ---------------------------------------------------------------- tree

console.log('\ntree walking');

t('active branch excludes orphaned regeneration branch', () => {
  const ids = walkActiveBranch(treeWithOrphan).map((m) => m.id);
  assert.deepEqual(ids, ['u1', 'a2', 'u2']);
});

t('REGRESSION: mid-tree currentId still captures descendants', () => {
  // Bug hit in dev: walking only upward truncated everything below currentId.
  const ids = walkActiveBranch({ ...treeWithOrphan, currentId: 'a2' }).map((m) => m.id);
  assert.ok(ids.includes('u2'), `tail dropped: got ${ids.join('>')}`);
  assert.deepEqual(ids, ['u1', 'a2', 'u2']);
});

t('dangling currentId falls back to deepest leaf', () => {
  const ids = walkActiveBranch({ ...treeWithOrphan, currentId: 'ghost' }).map((m) => m.id);
  assert.ok(ids.length > 0);
  assert.equal(ids[ids.length - 1], 'u2');
});

t('cyclic parent chain terminates', () => {
  const ids = walkActiveBranch({
    currentId: 'x',
    messages: { x: { id: 'x', parentId: 'y', role: 'user' }, y: { id: 'y', parentId: 'x', role: 'user' } },
  }).map((m) => m.id);
  assert.ok(ids.length <= 2);
});

t('empty history does not throw', () => {
  assert.deepEqual(walkActiveBranch({}), []);
  assert.deepEqual(walkActiveBranch({ messages: {} }), []);
});

// ---------------------------------------------------------------- blocks

console.log('\ncontent blocks');

t('user string content becomes text', () => {
  assert.equal(splitBlocks({ content: 'hi' }).text, 'hi');
});

t('assistant reasoning and text are separated', () => {
  const r = splitBlocks(rawDefault.messages.a2);
  assert.equal(r.text, 'the answer');
  assert.equal(r.reasoning, 'thinking hard');
});

t('REGRESSION: tool_calls never leak into prose', () => {
  // Bug hit in dev: `text += b.content` on an ARRAY produced "[object Object]".
  const r = splitBlocks(rawAgent.messages.am1);
  assert.equal(r.text, 'done');
  assert.ok(!r.text.includes('[object Object]'), 'tool_calls corrupted the text');
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, 'TodoWrite');
});

t('tool_call arguments JSON string is parsed', () => {
  const r = splitBlocks(rawAgent.messages.am1);
  assert.deepEqual(r.toolCalls[0].arguments, { todos: [1, 2] });
});

t('malformed tool arguments survive as raw string', () => {
  const r = splitBlocks({
    content_blocks: [{ type: 'tool_calls', content: [{ function: { name: 'x', arguments: '{not json' } }] }],
  });
  assert.equal(r.toolCalls[0].arguments, '{not json');
});

t('unknown block types are preserved, not stringified', () => {
  const r = splitBlocks({ content_blocks: [{ type: 'future_thing', content: { a: 1 } }] });
  assert.equal(r.text, '');
  assert.equal(r.unknownBlocks.length, 1);
});

// ---------------------------------------------------------------- normalize

console.log('\nnormalize');

t('default chat tagged non-agent', () => {
  const c = normalize(rawDefault);
  assert.equal(c.kind, 'default');
  assert.equal(c.isAgent, false);
  assert.equal(c.messages.length, 3);
  assert.equal(c.orphaned, 1);
});

t('agent chat tagged and context preserved', () => {
  const c = normalize(rawAgent);
  assert.equal(c.kind, 'general_agent');
  assert.equal(c.isAgent, true);
  assert.equal(c.agentContext.session_id, 'web-x');
});

t('usage token counts survive normalization', () => {
  const c = normalize(rawDefault);
  assert.equal(c.messages.find((m) => m.id === 'a2').usage.total_tokens, 42);
});

t('markdown renders without throwing and includes tool block', () => {
  assert.ok(toMarkdown(rawDefault).includes('# Normal chat'));
  const md = toMarkdown(rawAgent);
  assert.ok(md.includes('TodoWrite'));
  assert.ok(md.includes('(agent)'));
});

// ---------------------------------------------------------------- files

console.log('\nfiles');

t('extracts attachments from agent chat', () => {
  const f = extractFiles(rawAgent);
  assert.equal(f.length, 1);
  assert.equal(f[0].name, 'notes.md');
  assert.equal(f[0].content_type, 'text/markdown');
});

t('default chat yields no files', () => {
  assert.equal(extractFiles(rawDefault).length, 0);
});

t('signed-url expiry parsed from auth_key', () => {
  assert.equal(parseAuthKeyExpiry('https://x/y?auth_key=1787729627-abc'), 1787729627000);
  assert.equal(parseAuthKeyExpiry('https://x/y'), null);
  assert.equal(parseAuthKeyExpiry(null), null);
});

t('expired signed url is detected', () => {
  const f = extractFiles(rawAgent)[0];
  assert.equal(isExpired(f, 1787729627000 + 1), true);
  assert.equal(isExpired(f, 1787729627000 - 1000), false);
});

// ---------------------------------------------------------------- delta

console.log('\ndelta + hashing');

t('cold start marks everything added', () => {
  const d = diffManifest([{ id: 'a', updated_at: 1 }, { id: 'b', updated_at: 2 }], { chats: {} });
  assert.equal(d.added.length, 2);
  assert.equal(d.changed.length, 0);
});

t('warm sync isolates only moved chats', () => {
  const list = [{ id: '1', updated_at: 10 }, { id: '2', updated_at: 20 }, { id: '3', updated_at: 30 }];
  const d = diffManifest(list, { chats: { 2: { updated_at: 20 }, 3: { updated_at: 99 }, 9: { updated_at: 1 } } });
  assert.equal(d.added.length, 1);      // '1'
  assert.equal(d.changed.length, 1);    // '3'
  assert.equal(d.unchanged.length, 1);  // '2'
  assert.equal(d.removed.length, 1);    // '9' deleted remotely
});

t('REGRESSION: truncated list is flagged, not treated as mass deletion', () => {
  // Prior art documents the list endpoint under-reporting badly under load.
  // Acting on `removed` in that case would look like the account was wiped.
  const state = { chats: {} };
  for (let i = 0; i < 100; i++) state.chats['c' + i] = { updated_at: 1 };
  const truncated = [{ id: 'c0', updated_at: 1 }, { id: 'c1', updated_at: 1 }];
  const d = diffManifest(truncated, state);
  assert.equal(d.suspectTruncation, true, 'did not flag an obviously truncated list');
  assert.equal(d.knownCount, 100);
});

t('empty remote list is always suspect when state is non-empty', () => {
  const d = diffManifest([], { chats: { a: { updated_at: 1 } } });
  assert.equal(d.suspectTruncation, true);
});

t('a couple of genuine deletions are NOT flagged as truncation', () => {
  const state = { chats: {} };
  for (let i = 0; i < 100; i++) state.chats['c' + i] = { updated_at: 1 };
  const list = [];
  for (let i = 0; i < 98; i++) list.push({ id: 'c' + i, updated_at: 1 });
  const d = diffManifest(list, state);
  assert.equal(d.removed.length, 2);
  assert.equal(d.suspectTruncation, false, 'false positive on normal deletions');
});

t('cold start is never flagged as truncation', () => {
  assert.equal(diffManifest([], { chats: {} }).suspectTruncation, false);
});

t('hash is stable and order-independent', () => {
  assert.equal(hashRaw(rawDefault), hashRaw(rawDefault));
  const reordered = { ...rawDefault, detail: { ...rawDefault.detail } };
  assert.equal(hashRaw(reordered), hashRaw(rawDefault));
});

t('hash changes when message text changes', () => {
  const mutated = JSON.parse(JSON.stringify(rawDefault));
  mutated.messages.u1.content = 'different';
  assert.notEqual(hashRaw(mutated), hashRaw(rawDefault));
});

t('REGRESSION: hash changes when only tool_calls change', () => {
  // Agent runs can differ solely in tool activity.
  const mutated = JSON.parse(JSON.stringify(rawAgent));
  mutated.messages.am1.content_blocks[1].content[0].function.name = 'DifferentTool';
  assert.notEqual(hashRaw(mutated), hashRaw(rawAgent));
});

// ---------------------------------------------------------------- sync

console.log('\nsync loop (mocked transport)');

function mockClient(list, chatsById, log = []) {
  return {
    listChats: async () => { log.push('list'); return list; },
    fetchChatRaw: async (id) => { log.push('fetch:' + id); return chatsById[id]; },
    sleep: async () => {},
  };
}

await ta('second sync fetches nothing when nothing moved', async () => {
  const list = [{ id: 'chat-default', updated_at: 200, title: 'x', type: 'default' }];
  const byId = { 'chat-default': rawDefault };
  const log1 = [];
  const r1 = await sync(mockClient(list, byId, log1), { chats: {} });
  assert.equal(r1.records.length, 1);

  const log2 = [];
  const r2 = await sync(mockClient(list, byId, log2), r1.state);
  assert.equal(r2.records.length, 0, 'refetched unchanged chat');
  assert.ok(!log2.some((l) => l.startsWith('fetch:')), 'made needless detail calls');
});

await ta('watermark moves but identical content emits nothing', async () => {
  const byId = { 'chat-default': rawDefault };
  const r1 = await sync(mockClient([{ id: 'chat-default', updated_at: 200 }], byId), { chats: {} });
  const r2 = await sync(mockClient([{ id: 'chat-default', updated_at: 999 }], byId), r1.state);
  assert.equal(r2.records.length, 0);
  assert.equal(r2.stats.skippedByHash, 1);
});

await ta('changed content is re-emitted', async () => {
  const byId = { 'chat-default': rawDefault };
  const r1 = await sync(mockClient([{ id: 'chat-default', updated_at: 200 }], byId), { chats: {} });
  const edited = JSON.parse(JSON.stringify(rawDefault));
  edited.messages.u2.content = 'edited!';
  const r2 = await sync(mockClient([{ id: 'chat-default', updated_at: 201 }], { 'chat-default': edited }), r1.state);
  assert.equal(r2.records.length, 1);
});

await ta('one failing chat does not abort the run', async () => {
  const list = [{ id: 'good', updated_at: 1 }, { id: 'bad', updated_at: 1 }];
  const client = {
    listChats: async () => list,
    fetchChatRaw: async (id) => { if (id === 'bad') throw new Error('boom'); return { ...rawDefault, id: 'good' }; },
    sleep: async () => {},
  };
  const r = await sync(client, { chats: {} });
  assert.equal(r.stats.failed, 1);
  assert.equal(r.records.length, 1);
});

await ta('failed chat is NOT watermarked (retried next run)', async () => {
  const list = [{ id: 'bad', updated_at: 5 }];
  const client = {
    listChats: async () => list,
    fetchChatRaw: async () => { throw new Error('boom'); },
    sleep: async () => {},
  };
  const r = await sync(client, { chats: {} });
  assert.equal(r.state.chats.bad, undefined, 'failed chat was marked synced — it would be lost forever');
});

await ta('raw capture keeps fields the renderer ignores', async () => {
  // The whole point of raw-first: nothing is dropped at capture time.
  const r = await sync(mockClient([{ id: 'chat-agent', updated_at: 400 }], { 'chat-agent': rawAgent }), { chats: {} });
  const stored = r.records[0];
  assert.ok(stored.messages.am1.files, 'files dropped');
  assert.ok(stored.detail.im_context, 'agent context dropped');
  assert.ok(stored.messages.am1.content_blocks.some((b) => b.type === 'tool_calls'), 'tool_calls dropped');
});

// ---------------------------------------------------------------- done

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
