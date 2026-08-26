/**
 * File extraction for zai-sync.
 *
 * Agent chats (kind 'general_agent') attach files and images. Normal chats can too,
 * but agent runs are where they cluster.
 *
 * ⚠ CRITICAL, verified live: attachment URLs are SIGNED and EXPIRING. They look like
 *     https://z-cdn-media.chatglm.cn/files/<uuid>.md?auth_key=<unix_ts>-<sig>...
 * The leading number in auth_key is an expiry timestamp. A URL captured in a raw
 * JSON record WILL be dead if you try to download it on a later run. Therefore:
 * download during the same sync pass that discovered it, or accept permanent loss.
 *
 * This module only READS the raw records — it does not mutate them. Raw stays raw.
 */

/** Pull every file reference out of a raw record. Returns [] for most chats. */
export function extractFiles(raw) {
  const out = [];
  const msgs = (raw && raw.messages) || {};

  for (const [msgId, m] of Object.entries(msgs)) {
    if (!Array.isArray(m.files)) continue;
    for (const f of m.files) {
      if (!f) continue;
      const inner = f.file || {};
      const meta = inner.meta || {};
      out.push({
        chat_id: raw.id,
        message_id: msgId,
        ref_user_msg_id: f.ref_user_msg_id || null,
        kind: f.type || null,               // 'file' | 'image'
        file_id: inner.id || f.id || null,
        name: meta.name || inner.filename || f.name || null,
        content_type: meta.content_type || null,
        size: meta.size ?? f.size ?? null,
        // Prefer the CDN url; fall back to the relative one.
        url: meta.cdn_url || f.url || null,
        expires_at: parseAuthKeyExpiry(meta.cdn_url || f.url),
      });
    }
  }
  return out;
}

/** auth_key=<unix_ts>-<...>  ->  ms epoch, or null if absent/unparseable. */
export function parseAuthKeyExpiry(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/[?&]auth_key=(\d{9,11})-/);
  if (!m) return null;
  const secs = Number(m[1]);
  return Number.isFinite(secs) ? secs * 1000 : null;
}

export function isExpired(fileRef, now = Date.now()) {
  return typeof fileRef.expires_at === 'number' && fileRef.expires_at <= now;
}

/**
 * Download files to disk. Node only (needs fs). Skips ones already present.
 * Returns a report; never throws on individual failures.
 */
export async function downloadFiles(fileRefs, { dir, fs, path, fetchImpl = fetch, delayMs = 200 }) {
  const report = { ok: 0, skipped: 0, expired: 0, failed: [] };
  if (!fileRefs.length) return report;
  await fs.mkdir(dir, { recursive: true });

  for (const f of fileRefs) {
    if (!f.url) { report.failed.push({ f, why: 'no url' }); continue; }
    if (isExpired(f)) { report.expired++; report.failed.push({ f, why: 'signed url expired' }); continue; }

    // Namespace by file_id so identical filenames across chats can't collide.
    const safe = String(f.name || 'file').replace(/[^\w\-. ]+/g, '_').slice(0, 100);
    const dest = path.join(dir, `${String(f.file_id || 'x').slice(0, 8)}__${safe}`);

    try {
      await fs.access(dest);
      report.skipped++;
      continue;
    } catch { /* not present, download it */ }

    try {
      const res = await fetchImpl(f.url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(dest, buf);
      report.ok++;
    } catch (e) {
      report.failed.push({ f, why: e.message });
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return report;
}
