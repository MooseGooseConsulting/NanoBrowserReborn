# zai-sync

Lossless, incremental capture of your **chat.z.ai** conversation corpus.

Delta-only by design: a warm sync touches the handful of chats that actually moved, not all 618.

> **Status: z.ai only.** Multi-provider (ChatGPT et al.) is designed but NOT built — see
> `PROVIDERS.md`. Unattended out-of-browser automation is designed but NOT built — see
> `GOAL.md` P2. Your corpus has NOT been pulled yet — see `GOAL.md` P0.

**Docs:** `GOAL.md` (work order — the outstanding scope) · `PROVIDERS.md` (multi-provider spec)
· `RESEARCH.md` (findings, prior art, why the DOM is wrong) · this file (what works today).

---

## Why this exists / what was learned the hard way

chat.z.ai is a customised **Open WebUI** fork. Its Settings UI has had *Export Chats* and the
*API Keys* page removed, so there is no supported export path. But the upstream REST API is
intact underneath, and that is what this uses.

**Findings, all verified live against a real 618-chat account (Aug 2026).** Each one cost a probe:

| # | Finding | Why it matters |
|---|---|---|
| 1 | `GET /api/v1/chats/` returns all 618 rows with `updated_at`, ~320KB, **no message bodies** | Perfect cheap delta watermark |
| 2 | `GET /api/v1/chats/{id}` returns a **skeleton only** — `id/parentId/childrenIds/role/timestamp`, *no content* | Skipping step 3 silently yields empty transcripts |
| 3 | `POST /api/v1/chats/{id}/messages/batch` body `{ids:[…]}` returns content. Field **must** be `ids` (`message_ids` → 422) | The only way to get message text |
| 4 | `history.messages` is a **tree**; `currentId` → root → reverse gives the active branch | Iterating `Object.values()` yields orphaned dead branches, out of order |
| 5 | user msgs: `content` is a **string**. assistant msgs: `content` is **null**, text lives in `content_blocks[]` | Two different shapes in one field |
| 6 | Block types: `reasoning`, `text`, and (agent chats) **`tool_calls`** | `tool_calls.content` is an **array**, never a string |
| 7 | Two chat kinds: **`default` (521)** and **`general_agent` (97)** | Agent runs are mostly tool activity: one sampled chat had 32 tool_calls vs 17 text |
| 8 | Agent chats carry **attachments**, and their `cdn_url` is a **signed URL with an expiring `auth_key`** | ⚠ URLs stored in JSON go dead. Download in the same pass or lose the file permanently |
| 9 | `Authorization: Bearer <token>` works with **no cookies**; the JWT has **no `exp` claim** | Enables unattended runs |
| 10 | Reasoning is often **larger than the answer** (one chat: 56,102 reasoning vs 43,489 text chars) | DOM scraping silently discards over half the corpus |

**The DOM is the wrong source.** It lazy-loads (needs scroll-to-top loops), collapses reasoning to
"Thought Process", renders markdown to lossy text, and hides orphaned branches. The API needs no
scrolling and returns strictly more.

---

## Design rule: capture raw, transform later

`core.js` stores API responses **verbatim**. It does not reshape, interpret, or drop anything.

This rule exists because it was already violated once during development: a normalizer was written
*before* `tool_calls` blocks were discovered, and it would have stringified them into prose as
`[object Object]`, corrupting 97 chats. **Unknown-unknowns are the default here.**

So: raw NDJSON is the source of truth. `render.js` (markdown, flattening, tagging) is a derived
view you can re-run over stored raw whenever you learn something new. Re-scraping 618
conversations because you discovered a field is the failure mode this avoids.

---

## Layout

```
core.js       raw capture + delta + hashing   (auth-agnostic, inject a request adapter)
reference/    the original DOM scraper        (SUPERSEDED, kept as emergency fallback)
render.js     downstream views                (branch walk, block splitting, markdown)
files.js      attachment extraction + expiry  (signed-URL aware)
node/sync.mjs unattended daemon               (bearer token)
userscript/   browser harness                 (rides your live session, no token)
test/test.mjs 30 offline tests, no network
test/live-check.mjs  live API contract check
```

Both harnesses share the same logic; only the auth adapter differs.

---

## Usage

### A. Browser (no token, easiest)

1. Install Tampermonkey.
2. Add `userscript/zai-sync.user.js`.
3. On chat.z.ai, Tampermonkey menu → **Sync now (delta)**.

Downloads `zai-raw-<ts>.ndjson` (one chat per line) plus `zai-files-<ts>.json` when attachments
are found. State persists across browser restarts, so later runs fetch only what changed.

### B. Node daemon (unattended)

```bash
export ZAI_TOKEN='...'   # DevTools > Application > Local Storage > chat.z.ai > "token"
node node/sync.mjs --out ./data --limit 3        # smoke test first
node node/sync.mjs --out ./data --md --files     # real run
```

Flags: `--full` `--limit N` `--delay ms` `--md` `--files` `--agents-only` `--chats-only`

Schedule it however you like; each pass is incremental. **Use `--files`** — deferring attachment
downloads loses them to URL expiry.

### C. Tests

```bash
node test/test.mjs              # 30 offline tests, no creds
ZAI_TOKEN=... node test/live-check.mjs   # verifies the API still behaves
```

The offline suite is mutation-tested: breaking `tool_calls` handling, the branch walk, the
failure-watermark rule, or hash coverage each make it fail. Run `live-check` first when something
breaks — it tells you whether the bug is yours or theirs.

---

## Correctness properties worth preserving

- **Failures are never watermarked.** A chat that errors is retried next run rather than marked
  synced and lost forever. There is a regression test for this.
- **A shrinking remote list is never treated as deletions.** `diffManifest` returns
  `suspectTruncation` when the list loses a large fraction of known chats, and `sync()`
  warns instead of acting. Mature prior art saw its list endpoint report 101 items when
  1086 existed; acting on that would look like the account was wiped. Four tests.
- **Hash covers the whole raw payload.** Agent runs can differ *only* in tool activity; a
  text-only hash would call them unchanged.
- **`updated_at` is the watermark, hash is the guard.** Watermark churn with identical content
  emits nothing.
- **Unknown block types are preserved, never stringified into prose.**
- **`--delay` exists deliberately.** 618 chats is a lot of requests; don't hammer.

---

## Not yet built

Full work order with acceptance criteria lives in **`GOAL.md`**. Summary:

| P | Item |
|---|---|
| 0 | Pull the actual corpus (never done; attachment URLs decay) |
| 1 | Multi-provider refactor — 28 hardcoded z.ai refs today (`PROVIDERS.md`) |
| 2 | Unattended out-of-browser automation (Playwright storageState + scheduler) |
| 3 | Attachment sweep across all 618 chats |
| 4 | Database sink (NDJSON is interchange, not the destination) |
| 5 | Write path — send messages back (design only) |

Open questions: do archived chats appear in the list endpoint? why does `/all` paginate
at 50 while `/` returns all 618? what is the real signed-URL TTL? `folder_id` and
`share_id` are currently ignored.


## Handoff notes for a follow-up session

If you pick this up in a fresh session with browser control:

- **Verify before trusting.** Run `node test/test.mjs`, then `live-check.mjs`. Do not assume the
  API is unchanged; findings above are dated Aug 2026.
- **The browser can run the whole pipeline** via `javascript_tool` on a logged-in chat.z.ai tab
  using `fetch(..., {credentials:'include'})`. No token needed for read-only work.
- **Do not try to read `localStorage.token` programmatically** — it is blocked by a safety
  classifier. The user must copy it manually if the daemon path is wanted.
- **Smoke-test with `--limit 3`** before any full run.
- **If something returns empty transcripts**, the cause is almost certainly a missed
  `messages/batch` call (finding #2).
- **If prose contains `[object Object]`**, a new non-string block type appeared (finding #6).
- Known-good sample: chat `2ac58925-cafc-4535-b1a8-248ef4999a77` → 26 tree / 24 active / 2 orphaned.
