# Multi-provider generalization spec

**Status: NOT BUILT.** This is the design; P1 in `GOAL.md` implements it.

Today the tool is z.ai-only. `BASE = 'https://chat.z.ai'` is pasted into three files
and the Open WebUI data shape is baked into the core. The user wants this to cover
ChatGPT and other providers.

---

## What is actually provider-specific right now

Audit at time of writing — 28 references across 5 files:

| File | Provider-coupled things |
|---|---|
| `core.js` | `BASE`, all three endpoint paths, `general_agent`, tree shape assumptions |
| `render.js` | `general_agent`, `content_blocks`, block type names |
| `files.js` | `z-cdn` URL pattern, `auth_key` expiry format |
| `node/sync.mjs` | `BASE`, DevTools token instructions, `--agents-only` filter |
| `userscript/*.js` | `@match`, `BASE`, endpoints |

## What is genuinely generic (keep in core)

- Delta on a watermark + content hash guard
- Failure-never-watermarked rule
- Raw-first lossless capture
- NDJSON emission
- Rate limiting / delay
- Sync loop orchestration

The split is clean: **core owns the sync algorithm, adapters own the wire format.**

---

## Adapter contract

```js
export default {
  id: 'zai',                       // state namespace key — MUST be stable
  label: 'Z.ai',
  origin: 'https://chat.z.ai',
  match: ['https://chat.z.ai/*'],  // for userscript @match generation

  // AUTH — return a request() the core can call. Adapter decides cookie vs bearer.
  makeRequest({ token, credentials }) -> async (url, opts) => json,

  // LIST — return normalized manifest rows. This is the ONLY shape core sees.
  //   [{ id, title, updated_at, kind }]
  // updated_at may be epoch seconds or ms — normalize HERE, not in core.
  listChats(request) -> Promise<Row[]>,

  // CAPTURE — return raw payloads VERBATIM plus a stable envelope.
  //   { _schema, _provider, id, fetched_at, detail, messages, _counts }
  // Do not reshape provider data. Raw-first is non-negotiable (see README).
  fetchChatRaw(request, chatId) -> Promise<Raw>,

  // RENDER — provider-specific interpretation of the raw payload.
  walkActiveBranch(raw) -> Stub[],
  splitBlocks(rawMessage) -> { text, reasoning, toolCalls, unknownBlocks },
  extractFiles(raw) -> FileRef[],   // include expiry semantics if signed

  // OPTIONAL
  kinds: ['default', 'general_agent'],  // for --kind filtering
};
```

Core must end up with **zero** provider strings. Verification:

```bash
grep -rn "z\.ai\|chatgpt\|general_agent\|content_blocks\|backend-api" core.js
# must return nothing
```

---

## Provider: z.ai (Open WebUI fork) — VERIFIED

Port the existing behavior as-is. See README findings table. Key shapes:

- List: `GET /api/v1/chats/` → all rows, no bodies, `updated_at` in **seconds**
- Detail: `GET /api/v1/chats/{id}` → skeleton only, `chat.history.messages` tree
- Content: `POST /api/v1/chats/{id}/messages/batch` body `{ids:[…]}`
- Tree: `parentId` / `childrenIds`, pointer is `history.currentId`
- Blocks: `content_blocks[]` with `reasoning` | `text` | `tool_calls`
- Kinds: `default`, `general_agent`
- Files: `meta.cdn_url`, signed with expiring `auth_key`

Note: any other Open WebUI instance (self-hosted, other forks) should work with the
same adapter and a different `origin`. Stock Open WebUI additionally has a native
**Export Chats** button and an **API Keys** page — z.ai removed both. If the target
has them, prefer the official export and skip all of this.

---

## Provider: ChatGPT — grounded in a working reference implementation

Derived from ocombe's public exporter gist (`gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5`,
Mar 2026, 16 forks). That is a **working, in-use implementation**, so these are not
guesses about endpoint shapes. They are still UNVERIFIED against a live account by
this project — verify before trusting.

> **Licensing note.** The gist carries no license. API endpoints, field names and
> data shapes are facts, and reimplementing from them is clean. Do **not** paste their
> source verbatim into this repo. Write our own adapter against the documented shapes.

### Auth — materially better than expected

```
GET /api/auth/session   ->   { accessToken: "..." }
```

Same-origin, no localStorage read, no DevTools, no hand-copied token. This solves the
exact problem that blocked us on z.ai. Under Playwright (P2) the flow is: restore
session -> hit this endpoint -> get a fresh token -> sync.

Required headers on every `/backend-api` call:

```
Authorization:  Bearer <accessToken>
Content-Type:   application/json
Accept:         application/json
Oai-Device-Id:  <a UUID, generated once per run>
Oai-Language:   en-US
```

WARNING: **ChatGPT tokens are SHORT-LIVED.** The gist's own troubleshooting says so.
This is the opposite of z.ai's no-`exp` JWT. Consequences: re-auth is mandatory rather
than optional, the token must be fetched at the START of each run and never persisted,
and a long run may need to refresh mid-flight. Design for expiry.

### Cloudflare — CORRECTED

An earlier draft of this doc claimed Cloudflare makes out-of-browser runs impossible
without Playwright. **That is wrong.** The reference implementation's Node variant
(`export-chatgpt.mjs`) talks to `/backend-api` directly from plain `node:fetch` and
works, because it sends a complete browser-impersonating header set:

```js
{
  "Content-Type":      "application/json",
  "Accept":            "application/json",
  "Accept-Language":   "en-US,en;q=0.9",
  "User-Agent":        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
                       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Referer":           "https://chatgpt.com/",
  "Origin":            "https://chatgpt.com",
  "Oai-Device-Id":     "<uuid, once per run>",
  "Oai-Language":      "en-US",
  "Sec-Ch-Ua":         '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile":  "?0",
  "Sec-Ch-Ua-Platform":'"macOS"',
  "Sec-Fetch-Dest":    "empty",
  "Sec-Fetch-Mode":    "cors",
  "Sec-Fetch-Site":    "same-origin",
}
```

The `Sec-Fetch-*`, `Sec-Ch-Ua*`, `Referer`/`Origin` and `User-Agent` trio are what get
it through. Note the README says **python3 may still be blocked while Node works** —
i.e. TLS fingerprint matters too, not just headers. Node passes; `urllib` sometimes
does not.

So Playwright is **not required** for ChatGPT. It remains useful for surviving token
expiry unattended, but it is no longer the only way in. Keep the header set in the
adapter and treat it as load-bearing: dropping one may 403.

### Token acquisition without DevTools — directly reusable for z.ai

The reference impl's out-of-browser variants solve the "I don't know what a browser
console is" problem elegantly, and this pattern should be copied for z.ai (P2):

1. The tool starts a **local web server** (127.0.0.1:8423) and opens it in the browser.
2. The page tells the user: open `https://chatgpt.com/api/auth/session` in a tab,
   select all (Cmd/Ctrl+A), copy, and paste it into a textarea.
3. The page parses the pasted JSON and pulls `accessToken` out of it.
4. Export runs server-side; progress streams back over **SSE** (`EventSource` against
   `GET /progress/{id}`, with `event:`/`data:` frames).

No DevTools, no Application tab, no localStorage spelunking — just "open a link, copy
the page, paste it." z.ai has no `/api/auth/session` equivalent confirmed yet, so for
z.ai this becomes: find the closest whoami/session endpoint, or fall back to a paste of
the token itself with a much friendlier set of instructions than "DevTools > Application".

This local-server-plus-paste-plus-SSE shape is also a concrete answer to the "input
container" idea: a small local UI that drives repeated syncs and streams progress.

### Endpoints

| Purpose | Call |
|---|---|
| List | `GET /backend-api/conversations?offset=N&limit=100` -> `{items:[...], total}` |
| Detail | `GET /backend-api/conversation/{id}` -> full convo **including content** |
| File meta | `GET /backend-api/files/download/{fileId}` -> `{download_url, file_name}` |
| File bytes | `GET <download_url>` (plain fetch, no auth headers) |

Paginate until `items` is empty or `offset >= total`. Reference impl uses 500ms delay.

**Correction to an earlier assumption in this doc:** there IS a separate detail call,
but unlike z.ai it returns content inline — no second batch call. So `fetchChatRaw` is
ONE request for ChatGPT and TWO for z.ai. The core must not assume either.

### Tree shape

`convo.mapping`, keyed by node id:

```js
{ id, message, parent, children: [ids] }
```

The message is nested at `node.message`, and it may be null (the root is typically a
bare node). Root is the node whose `parent == null`.

The reference impl walks **BFS from root, pushing all children**, i.e. it exports every
branch rather than one active path. There is no `currentId` equivalent in use. Our z.ai
walker picks the active branch; for ChatGPT the adapter should return the full tree and
let the renderer decide. Raw capture keeps everything either way.

### Message shape — more complex than z.ai

```js
msg.author.role          // 'user' | 'assistant' | 'system' | 'tool'
msg.content.content_type // see list below
msg.content.parts        // ARRAY - entries are STRINGS or OBJECTS, mixed
msg.metadata.attachments // [{ id, name }]
msg.metadata.citations   // [{ metadata: { file_id, title } }]
msg.create_time          // epoch SECONDS (float)
```

`parts` is the trap that mirrors z.ai's `tool_calls`: entries can be plain strings OR
objects such as `{content_type:'image_asset_pointer', asset_pointer:'file-service://...'}`.
Blindly joining them produces `[object Object]` — the exact bug class our tests already
guard against. Handle strings and objects separately.

Known `content_type` values: `text`, `multimodal_text`, `code`, `execution_output`,
`computer_output`, `tether_browsing_display`, `system_error`, `user_editable_context`,
`image_asset_pointer`. Anything not `text` is effectively internal/tool output — the
ChatGPT analogue of our `tool_calls` channel. Preserve unknown types, never drop them.

Roles `system` and `tool` exist and are usually hidden in UI renderings. Capture them;
filter at render time only.

### Files

Two-step, unlike z.ai's embedded signed CDN URL:

1. `GET /backend-api/files/download/{fileId}` -> `{download_url, file_name}`
2. plain `GET` on `download_url` for the bytes

File ids come from three places, all of which must be scanned:

- `parts[].asset_pointer` matching `^(?:file-service|sediment)://(.+)$`
- `msg.metadata.attachments[].id`
- `msg.metadata.citations[].metadata.file_id`

WARNING: download URLs **expire**, same trap as z.ai finding #8. Download in the
discovering pass. Filenames collide across conversations — dedupe and namespace by
conversation. A missing extension can be inferred from the response `content-type`.

### Hard-won details from the reference impl's git history

The gist is a git repo with **31 commits**. Cloning it (`git clone
https://gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5`) surfaces a 5th file the
web file-list does not show (`export-chatgpt.sh`) plus the full evolution. The history is
effectively a list of bugs they hit in production. Do not rediscover these:

**1. The CDN binary fetch must NOT carry the API header set.**
Commit `b57a66e` added `User-Agent` + `Sec-Ch-Ua*` + `Sec-Fetch-Dest: image` /
`Sec-Fetch-Mode: no-cors` / `Sec-Fetch-Site: cross-site` to the file-download fetch.
Commit `6513e6a` **removed them again**. Final state: `/backend-api` calls get the full
browser header set plus bearer auth; the `download_url` fetch is a plain request with
`Accept: */*` and no auth. Two different header policies in one adapter.

**2. `asset_pointer` prefixes are an open set.**
It started matching only `file-service://`. Commit `64682c0` added `sediment://` after
files went missing. Regex today: `^(?:file-service|sediment)://(.+)$`. Assume more
prefixes exist and log non-matching pointers instead of silently dropping them.

**3. `file_name` frequently has no extension.**
Same commit added a MIME→extension table and infers the suffix from the response
`content-type` when the name has no dot. Without it you get extensionless blobs.

**4. Citation markers must be stripped.**
Commit `b06d636` (the most recent) added `stripCitations` — assistant text carries
U+3010…U+3011 CJK-bracket citation markers inline. Strip at render, never at capture.

**5. `user_editable_context` appeared late** (`f247812`) as a user-role content_type that
should be treated as internal, not prose. More content_types will appear.

**6. Auth evolved AWAY from an env var.**
The first working version took `CHATGPT_TOKEN` as an environment variable. Commit
`6ec35ec` replaced it with the local-web-UI paste flow. Their own iteration abandoned the
env-var approach as too user-hostile — worth remembering before we ship `ZAI_TOKEN=` as
the primary UX.

**7. Node passes Cloudflare, python3 often does not.**
`export-chatgpt.sh` detects the runtime and says so explicitly: *"Prefers Node.js 18+
(passes Cloudflare), falls back to python3"*, and warns the user that Python may 403.
Header parity is not sufficient; TLS fingerprint matters.

**Unexplored lead:** the gist has 16 forks and 7 comments. Forks may carry fixes for
breakage that postdates the original. Worth a look if the adapter misbehaves.

### Zero-dependency ZIP

Both reference variants build a ZIP with no libraries. The Node one hand-rolls the
format: `crc32` table, local file header `0x04034b50`, central directory `0x02014b50`,
EOCD `0x06054b50`, STORE (no compression). Works identically with `Buffer` in Node and
`Uint8Array` in the browser. Worth reimplementing if we want single-file archives; the
Python variant just uses stdlib `zipfile`.

### Text cleanup

Assistant text embeds citation markers in CJK lenticular brackets (U+3010 / U+3011).
Strip at render time, never at capture.

### Delta

The reference impl has **no delta** — it re-exports everything every run. Our
incremental design is genuinely additive here. Verify that list `items` carry an
`update_time` usable as a watermark; if not, fall back to hashing the detail payload.

### Differences that stress the core design

| Concern | z.ai | ChatGPT |
|---|---|---|
| List pagination | none (all 618 at once) | `offset`/`limit`, with `total` |
| Content fetch | mandatory 2nd batch call | inline with detail |
| Token source | localStorage (read blocked) | `/api/auth/session` endpoint |
| Token lifetime | no `exp`, long-lived | **short-lived** |
| Bot protection | none observed | **Cloudflare** |
| Tree fields | `parentId`/`childrenIds` | `parent`/`children` under `mapping` |
| Message nesting | node IS the message | `node.message`, may be null |
| Branch selection | `currentId` pointer | none; BFS all branches |
| Content field | `content_blocks[]` typed blocks | `content.parts[]` mixed str/obj |
| Roles | user, assistant | + system, tool |
| Files | embedded signed CDN url | 2-step download endpoint |
| Timestamps | `updated_at` seconds | `create_time` float seconds |
| Delta support | built | none in prior art |

Pagination, inline-vs-batch content, and token lifetime are the three that must not be
hardcoded in core.

---

## State namespacing

Current state file is `{chats: {id: {...}}}`. Two providers WILL collide — ids are
not globally unique and a ChatGPT id could theoretically match a z.ai id.

Target:

```json
{
  "providers": {
    "zai":     { "chats": { "<id>": {...} }, "lastSync": 0 },
    "chatgpt": { "chats": { "<id>": {...} }, "lastSync": 0 }
  }
}
```

Write a migration for the existing v2 flat state so nobody has to re-pull 618 chats.

---

## Output namespacing

NDJSON records must carry `_provider` so a downstream DB can tell them apart, and
output paths should be `data/<provider>/raw-<ts>.ndjson`. Files likewise:
`data/<provider>/files/`.

---

## Adding a third provider later

The bar should be: write one adapter file, register it, done. If adding Claude,
Gemini, or a self-hosted instance requires touching `core.js`, the abstraction
is wrong and should be fixed rather than worked around.
