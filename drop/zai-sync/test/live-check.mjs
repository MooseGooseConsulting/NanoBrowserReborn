#!/usr/bin/env node
/**
 * LIVE contract check. Offline tests can't tell you the API changed — this can.
 *
 *   ZAI_TOKEN=... node test/live-check.mjs
 *
 * Read-only. Touches a handful of chats, never writes. Run this FIRST when
 * something breaks: it tells you whether the bug is yours or theirs.
 */

import { makeClient, diffManifest, hashRaw } from '../core.js';
import { normalize, walkActiveBranch } from '../render.js';
import { extractFiles, isExpired } from '../files.js';

const BASE = 'https://chat.z.ai';
const TOKEN = process.env.ZAI_TOKEN;

if (!TOKEN) {
  console.error('ZAI_TOKEN not set.\nDevTools > Application > Local Storage > chat.z.ai > "token"');
  process.exit(2);
}

let pass = 0, fail = 0, warn = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };
const bad = (m) => { console.error(`  ✗ ${m}`); fail++; };
const wrn = (m) => { console.warn(`  ! ${m}`); warn++; };

async function request(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url}`);
  return res.json();
}

const main = async () => {
  console.log('\n── auth ──');
  let list;
  try {
    list = await request(`${BASE}/api/v1/chats/`);
    ok(`bearer token accepted, ${list.length} chats visible`);
  } catch (e) {
    bad(`manifest call failed: ${e.message}`);
    console.error('\n  If this is 401/403 the token is stale. Get a fresh one and retry.\n');
    process.exit(1);
  }

  console.log('\n── manifest contract ──');
  const row = list[0];
  for (const f of ['id', 'title', 'updated_at']) {
    row[f] !== undefined ? ok(`manifest row has \`${f}\``) : bad(`manifest row MISSING \`${f}\` — delta sync depends on it`);
  }
  if (row.chat && row.chat.history) {
    wrn('manifest now embeds full history — delta is cheaper if you use it, revisit fetch strategy');
  } else {
    ok('manifest is lightweight (no message bodies)');
  }

  const kinds = list.reduce((a, c) => (a[c.type || '?'] = (a[c.type || '?'] || 0) + 1, a), {});
  console.log(`    kinds: ${JSON.stringify(kinds)}`);
  Object.keys(kinds).forEach((k) => {
    if (!['default', 'general_agent'].includes(k)) wrn(`unrecognised chat kind '${k}' — check render/normalize handles it`);
  });

  console.log('\n── detail + batch contract ──');
  const client = makeClient(request, { delayMs: 300 });
  const target = list.find((c) => c.type === 'general_agent') || list[0];
  let raw;
  try {
    raw = await client.fetchChatRaw(target.id);
    ok(`fetched "${(target.title || '').slice(0, 34)}"`);
  } catch (e) {
    bad(`detail/batch failed: ${e.message}`);
    process.exit(1);
  }

  const hist = raw.detail?.chat?.history;
  hist?.messages ? ok('detail carries history.messages tree') : bad('history.messages MISSING');
  hist?.currentId ? ok('history.currentId present') : wrn('currentId absent — walker falls back to deepest leaf');

  const stub = Object.values(hist?.messages || {})[0] || {};
  'content' in stub
    ? wrn('detail now includes message content — the batch call may be redundant')
    : ok('detail is skeleton-only (batch call still required)');

  raw._counts.hydrated === raw._counts.tree
    ? ok(`batch hydrated all ${raw._counts.tree} messages`)
    : wrn(`batch returned ${raw._counts.hydrated}/${raw._counts.tree} messages`);

  console.log('\n── block shapes ──');
  const blockTypes = new Set();
  for (const m of Object.values(raw.messages)) {
    for (const b of (m.content_blocks || [])) blockTypes.add(b.type);
  }
  console.log(`    block types: ${[...blockTypes].join(', ') || '(none)'}`);
  for (const bt of blockTypes) {
    if (!['reasoning', 'text', 'tool_calls'].includes(bt)) {
      wrn(`NEW block type '${bt}' — raw keeps it, but render.js ignores it. Add handling.`);
    }
  }
  const tc = Object.values(raw.messages).flatMap((m) => m.content_blocks || []).find((b) => b.type === 'tool_calls');
  if (tc) {
    Array.isArray(tc.content)
      ? ok('tool_calls.content is an array (as expected)')
      : bad(`tool_calls.content is ${typeof tc.content} — renderer assumes array`);
  }

  console.log('\n── round trip ──');
  const c = normalize(raw);
  const branch = walkActiveBranch(hist || {});
  branch.length ? ok(`active branch: ${branch.length} messages (${c.orphaned} orphaned)`) : bad('empty active branch');
  const chars = c.messages.reduce((a, m) => a + m.text.length, 0);
  const think = c.messages.reduce((a, m) => a + m.reasoning.length, 0);
  const tools = c.messages.reduce((a, m) => a + m.toolCalls.length, 0);
  console.log(`    text ${chars} chars | reasoning ${think} chars | ${tools} tool calls`);
  chars + think + tools > 0 ? ok('content extracted') : bad('round trip produced NOTHING — capture is broken');
  c.messages.some((m) => m.text.includes('[object Object]')) ? bad('prose corrupted by object concat') : ok('no [object Object] corruption');

  console.log('\n── files ──');
  const files = extractFiles(raw);
  if (!files.length) {
    console.log('    (none on this chat)');
  } else {
    ok(`${files.length} attachment(s)`);
    const dead = files.filter((f) => isExpired(f));
    dead.length
      ? wrn(`${dead.length} signed URL(s) ALREADY EXPIRED — download during the sync pass, not later`)
      : ok('signed URLs still valid');
  }

  console.log('\n── delta ──');
  const cold = diffManifest(list, { chats: {} });
  cold.added.length === list.length ? ok(`cold start: ${cold.added.length} added`) : bad('cold diff wrong');
  const state = { chats: Object.fromEntries(list.map((r) => [r.id, { updated_at: r.updated_at, hash: 'x' }])) };
  const warm = diffManifest(list, state);
  warm.added.length === 0 && warm.changed.length === 0
    ? ok(`warm sync: 0 to fetch, ${warm.unchanged.length} skipped`)
    : bad(`warm diff should be empty, got +${warm.added.length}/~${warm.changed.length}`);
  hashRaw(raw) === hashRaw(raw) ? ok('hash deterministic') : bad('hash unstable');

  console.log(`\n${fail === 0 ? '✓ LIVE OK' : '✗ LIVE FAILED'} — ${pass} passed, ${fail} failed, ${warn} warnings\n`);
  if (warn) console.log('Warnings mean the API drifted. Raw capture still safe; update render.js.\n');
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((e) => { console.error('✗ unexpected:', e); process.exit(1); });
