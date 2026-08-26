#!/usr/bin/env node
/**
 * Harness B: unattended daemon. Same core as the userscript, different auth.
 *
 *   ZAI_TOKEN=<token> node node/sync.mjs --out ./data --files --md
 *
 * Auth: bearer token. Verified that chat.z.ai accepts `Authorization: Bearer <token>`
 * with NO cookies, and the JWT carries no `exp` claim — so it keeps working
 * unattended until the session is revoked server-side.
 *
 * Writes RAW NDJSON (lossless, one chat per line) as the source of truth.
 * Markdown/files are optional derived outputs you can regenerate any time.
 *
 * Flags:
 *   --out <dir>   output dir (default ./data)
 *   --full        ignore saved state, refetch everything
 *   --limit <n>   cap chats this pass (smoke test: --limit 3)
 *   --delay <ms>  inter-request delay (default 350)
 *   --md          also write derived markdown
 *   --files       also download attachments (do NOT defer: signed URLs expire)
 *   --agents-only / --chats-only   filter by kind
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { makeClient, diffManifest, hashRaw } from '../core.js';
import { toMarkdown, normalize } from '../render.js';
import { extractFiles, downloadFiles } from '../files.js';

const BASE = 'https://chat.z.ai';
const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};

const OUT = String(flag('--out', './data'));
const FULL = argv.includes('--full');
const WRITE_MD = argv.includes('--md');
const GET_FILES = argv.includes('--files');
const AGENTS_ONLY = argv.includes('--agents-only');
const CHATS_ONLY = argv.includes('--chats-only');
const LIMIT = Number(flag('--limit', Infinity));
const DELAY = Number(flag('--delay', 350));

const TOKEN = process.env.ZAI_TOKEN;
if (!TOKEN) {
  console.error(
    'ZAI_TOKEN is not set.\n' +
    'Get it from a logged-in browser:\n' +
    '  DevTools > Application > Local Storage > https://chat.z.ai > key "token"\n' +
    'Then:  ZAI_TOKEN=... node node/sync.mjs'
  );
  process.exit(1);
}

async function request(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('AUTH_REJECTED: token no longer valid — grab a fresh one from the browser.');
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url}`);
  return res.json();
}

const statePath = () => path.join(OUT, 'state.json');
const loadState = async () => {
  if (FULL) return { chats: {} };
  try { return JSON.parse(await fs.readFile(statePath(), 'utf8')); }
  catch { return { chats: {} }; }
};

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const client = makeClient(request, { delayMs: DELAY });
  const state = await loadState();

  console.log('→ manifest…');
  let list = await client.listChats();
  const kinds = list.reduce((a, c) => (a[c.type || '?'] = (a[c.type || '?'] || 0) + 1, a), {});
  console.log(`  ${list.length} chats remote  ${JSON.stringify(kinds)}`);

  if (AGENTS_ONLY) list = list.filter((c) => c.type === 'general_agent');
  if (CHATS_ONLY) list = list.filter((c) => c.type !== 'general_agent');

  const delta = diffManifest(list, state);
  const targets = [...delta.added, ...delta.changed].slice(0, LIMIT);
  console.log(
    `  +${delta.added.length} new | ~${delta.changed.length} changed | ` +
    `${delta.unchanged.length} unchanged | -${delta.removed.length} gone remotely`
  );

  if (!targets.length) { console.log('✓ up to date, nothing fetched.'); return; }
  console.log(`→ fetching ${targets.length}…`);

  const nextChats = { ...state.chats };
  const records = [];
  const allFiles = [];
  let skipped = 0, failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const row = targets[i];
    process.stdout.write(`  [${i + 1}/${targets.length}] ${(row.title || row.id).slice(0, 46)}\n`);
    try {
      const raw = await client.fetchChatRaw(row.id);
      const hash = hashRaw(raw);
      if (nextChats[row.id] && nextChats[row.id].hash === hash) skipped++;
      else { records.push(raw); allFiles.push(...extractFiles(raw)); }
      // Watermark ONLY on success — a failure must be retried next run.
      nextChats[row.id] = { updated_at: row.updated_at, hash, title: row.title, kind: row.type || 'default' };
    } catch (e) {
      failed++;
      console.warn(`    ! ${e.message}`);
      if (String(e.message).startsWith('AUTH_REJECTED')) {
        console.error('\n✗ aborting: credentials are dead.\n');
        break;
      }
    }
    if (i < targets.length - 1) await client.sleep(DELAY);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (records.length) {
    const ndjson = path.join(OUT, `raw-${stamp}.ndjson`);
    await fs.writeFile(ndjson, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`✓ raw  → ${ndjson}`);

    if (WRITE_MD) {
      const mdDir = path.join(OUT, 'markdown');
      await fs.mkdir(mdDir, { recursive: true });
      for (const r of records) {
        const c = normalize(r);
        const safe = (c.title || r.id).replace(/[^\w\-. ]+/g, '_').slice(0, 80);
        const pre = c.isAgent ? 'agent__' : '';
        await fs.writeFile(path.join(mdDir, `${pre}${safe}__${r.id.slice(0, 8)}.md`), toMarkdown(r));
      }
      console.log(`✓ md   → ${mdDir} (${records.length})`);
    }

    if (GET_FILES && allFiles.length) {
      console.log(`→ downloading ${allFiles.length} attachment(s) (signed URLs expire — now or never)…`);
      const rep = await downloadFiles(allFiles, { dir: path.join(OUT, 'files'), fs, path });
      console.log(`✓ files → ${rep.ok} saved, ${rep.skipped} already present, ${rep.expired} expired, ${rep.failed.length} failed`);
    } else if (GET_FILES) {
      console.log('  (no attachments in this delta)');
    }
  }

  await fs.writeFile(statePath(), JSON.stringify({ chats: nextChats, lastSync: Date.now() }, null, 2));
  console.log(
    `✓ done — ${records.length} emitted, ${skipped} unchanged-by-hash, ` +
    `${failed} failed, ${delta.unchanged.length} never touched.`
  );
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
