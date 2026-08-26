# Research log

Everything learned while building this, so it survives outside the chat session it
came from. Dated Aug 2026.

---

## 1. What chat.z.ai actually is

A customized **Open WebUI** fork. Open WebUI is a popular open-source, self-hostable
chat frontend (originally "Ollama WebUI"). Not related to OpenAI or ChatGPT.

How it was identified: the API paths match stock Open WebUI exactly, and so does the
distinctive way a conversation is stored — a *tree* of messages with
`parentId`/`childrenIds` so regenerated replies branch. That is a documented Open
WebUI design choice, not something two teams invent identically.

What z.ai removed from stock Open WebUI:
- Settings → Data Controls → **Export Chats** (stock has it; z.ai has only Archive/Delete All)
- Account → **API Keys** page (stock has it)

So there is no supported export path, and no way to mint a durable API key. That is
the whole reason this project exists.

Also noticed in the z.ai Dashboard: a live cron job and a sandbox task named
"Setup and Execution of Tampermonkey Script", firing every 15 minutes. Something was
already being built in that direction. Worth checking before duplicating effort.

---

## 2. Why the DOM is the wrong source

The first working version scraped `#messages-container`. It worked (24 turns, 95,905
chars) but is strictly inferior:

| Problem | Consequence |
|---|---|
| Lazy-loads on scroll | Needs a scroll-to-top loop; first attempt silently captured only half the conversation (12 of 24 turns) |
| Collapses reasoning | Shows "Thought Process"; the actual thinking is discarded |
| Renders markdown to text | Lossy; raw markdown is unrecoverable |
| Hides inactive branches | Orphaned regeneration branches invisible |
| No tool call structure | Agent tool activity flattened or lost |

Measured on one conversation: DOM gave 24,143 chars for a message where the API gave
30,269 chars of text **plus** 12,356 chars of reasoning. Across the whole chat:
43,455 text + 56,102 reasoning. **The reasoning is larger than the answer.** DOM
scraping was discarding more than half the corpus.

The API needs no scrolling at all — it returns the complete tree regardless of what
is rendered. Verified on a 42-message chat that had never been scrolled.

---

## 3. Prior art survey

Searched GitHub, GitHub topics, and the web for existing tools. Findings:

### Nothing exists for z.ai / GLM chat history
No backup tool, no reverse-engineered client, no community script. `docs.z.ai` is the
separate GLM *inference* API product, unrelated to consumer chat history. This is a
genuine gap.

### Open WebUI backup tools — all API-key based, so all unusable here

| Project | What it does | Why it doesn't work here |
|---|---|---|
| `vosiander/open-webui-backup` | Go CLI, chats/knowledge/models, age-encrypted | Needs `OPEN_WEBUI_API_KEY`; z.ai removed the API Keys page. Low adoption (~0 stars) |
| `parsalotfy/openwebui-notes-backup` | Server-side Function, backs up Notes to GitHub on a schedule | Requires admin Function install on the instance; you are not the admin of a hosted fork |
| `schirmacher/openwebui-access` / `-client` | Python API clients | API-key dependent, and not export-focused |
| `yetanotherchris/openwebui-importer` | Imports Grok/Claude/ChatGPT exports INTO Open WebUI | Wrong direction |

### Browser extensions / userscripts — mature but manual-only

| Tool | Mechanism | Scope | Unattended? |
|---|---|---|---|
| "Save my Chatbot" (5,000+ users, actively maintained) | Reads current page, downloads markdown | One chat, click to run | No |
| `Qalxry/GiveMeDoc` | Extension/userscript, Pandoc WASM → .docx. Auto-reads DeepSeek via API/IndexedDB; everything else is paste-in | One chat | No |
| `dkasak/export-chatgpt-transcript` | Tampermonkey, DOM → clipboard markdown | One chat | No |

Notable: GiveMeDoc lists **GLM** as a supported platform but cannot actually scrape
it — it only offers a paste-your-own-markdown box. So even the tool that names this
provider doesn't handle it.

These are all the same category as the very first script written in this project:
runs inside an authenticated tab, extracts no credentials, but requires a human to
click, one conversation at a time.

### The closest architectural prior art

**ocombe's ChatGPT exporter gist** (`gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5`)
independently arrived at the same architecture:

| Element | ocombe (ChatGPT) | This project (z.ai) |
|---|---|---|
| Source | `/backend-api/conversations`, not DOM | `/api/v1/chats/`, not DOM |
| Auth | reuses live session, same-origin | same |
| Why same-origin | avoids credential extraction AND Cloudflare | avoids credential extraction |
| Pagination | `PAGE_SIZE = 100` | 50/page on `/all`, or all at once on `/` |
| Tree | ChatGPT `mapping` | Open WebUI `history.messages` |
| Output | JSON + MD + HTML viewer, zipped in-memory | raw NDJSON |

Two ideas taken from it: **build the archive in-memory in the browser** (so a full
export needs no token at all), and **put a delay between requests**. Both adopted.

**Its source has since been read in full** (via Exa; two earlier WebFetch attempts
returned only the gist README, not the code). What that added, beyond the prose:

- ChatGPT exposes `GET /api/auth/session` -> `{accessToken}`, a same-origin endpoint.
  No localStorage read, no DevTools, no hand-copied token. That is the cleanest
  solution seen anywhere in this survey to the credential problem that blocked us on z.ai.
- `/backend-api` calls require `Oai-Device-Id` (a per-run UUID) and `Oai-Language`
  headers alongside the bearer token.
- ChatGPT tokens are **short-lived**, unlike z.ai's no-`exp` JWT — re-auth is mandatory.
- Cloudflare blocks its shell variant (403s) while the console variant works, because
  same-origin. This is why storageState matters for ChatGPT specifically.
- `content.parts[]` mixes strings and objects, the same `[object Object]` trap as z.ai's
  `tool_calls`. Independent confirmation that the raw-first rule is the right call.
- It has **no delta** at all — full re-export every run. Our incremental design is
  additive relative to the best prior art found.

**All four gist files have now been read** (README, `export-chatgpt-console.js`,
`export-chatgpt.mjs`, `export-chatgpt.py`) by driving a browser to the raw URLs. The
`.mjs` is the important one and it **corrected a claim made earlier in this project**:

- **Cloudflare does NOT require Playwright.** Plain Node `fetch` reaches `/backend-api`
  successfully when it sends a full browser-impersonating header set (`User-Agent`,
  `Referer`, `Origin`, `Sec-Fetch-*`, `Sec-Ch-Ua*`). Exact headers in `PROVIDERS.md`.
  Python's `urllib` may still be blocked where Node is not, so TLS fingerprint matters
  as well as headers. An earlier note here saying storageState was the only way in was
  wrong.
- **A DevTools-free token flow exists and is worth stealing conceptually**: run a local
  web server, have the user open a session URL, select-all, copy, paste into a textarea,
  parse the token out. Progress streams back over SSE. This is a far more accessible
  answer than "open DevTools > Application > Local Storage" and is now P2 in `GOAL.md`.
- **Zero-dependency ZIP building** in both variants (hand-rolled headers in Node,
  stdlib `zipfile` in Python).
- The `.py` is a functional duplicate of the `.mjs`; it adds an `ssl` context but no new
  architecture.

**A gist is a git repository.** Cloning it (`git clone
https://gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5`) is the correct way to
read one — it yields all files plus history in a single command. Reading raw URLs one at
a time through a browser missed a 5th file (`export-chatgpt.sh`, absent from the web
file-list) and all 31 commits. The commit history turned out to be the single most
valuable artifact in this whole survey: it is a record of the bugs the author hit in
production. Details in `PROVIDERS.md`; highlights include the CDN fetch needing a
*different* header policy than the API, `asset_pointer` prefixes being an open set, and
the author abandoning an env-var token in favour of a paste UI.

Full detail in `PROVIDERS.md`. Note the gist carries **no license**: the API shapes and
header requirements are facts and safe to reimplement, but its source should not be
pasted into this repo.

What it does NOT solve: it is still a human pasting into a console and clicking.
Its shell-script variant makes you hand-copy the session token. Nobody in this
lineage has solved unattended scheduling.

### The chain nobody should have to re-walk

The gist's **comments** (not in the git clone) link onward. Following them:

1. `gist.github.com/eileenthg/af15b92f...` — a fork for 1000+ conversation accounts.
   Raised `DELAY` from 500ms to **10,000ms**, added linear backoff
   (`delay += DELAY` per attempt, up to N retries, then record and move on) and a
   failed-conversation report. Direct evidence that HTTP 429 is the binding constraint
   at scale, not correctness.
2. `gist.github.com/Mohammad-Sherif/d761a...` — another fork, 800+ conversations, same
   429 problem plus "crashes due to expired old assets".
3. **`github.com/thiscantbeserious/chatgpt-exporter`** — a proper repository, **MIT
   licensed**, 75 commits, CI, a test harness, v1.0.8. This is the mature end of the
   lineage and by far the most valuable artifact found in this survey.

### What the mature implementation knows that we did not

Its README and CHANGELOG read as a list of failure modes discovered the hard way:

- **The conversation-list endpoint UNDER-REPORTS under load.** Observed: a reported
  total of **101 against 1086** real conversations, plus an early empty page. Their fix:
  treat the **local cache as ground truth** for what exists and export the *union* of
  cached and fetched, so a flaky list can never shrink the export. They also paginate
  **until an empty page, advancing by received count**, rather than trusting `total`.
  *This directly threatened our design* — `diffManifest` reported everything missing from
  the list as `removed`. A truncated list would have looked like a mass deletion. Fixed:
  `removed` is now advisory only, and `suspectTruncation` flags the case. Four tests.
- **"Earlier versions could silently lose most of an export on long runs."** The exact
  failure mode to fear, and an argument for verifying counts after our P0 run.
- **HTTP 412 "conversation is stale"** is retryable, not fatal. They eventually added an
  `x-oai-is-pending-updates` header carrying discoverable `ois1` tokens to unstick it,
  and a browser-assist pass that loads stubborn conversations through the SPA itself.
- **Session tokens expire mid-run.** They refresh on 401/403/412 instead of failing.
- **Adaptive throttle beats a fixed delay.** Base 1200ms, 4 parallel workers sharing one
  account-wide budget, learns the tolerated rate from observed 429s, floors at punished
  rates, recovers when the penalty lifts, and coordinates **across browser tabs** via
  `localStorage` so two tabs share one pause window.
- **Text first, files second.** All conversation JSON is secured before any file
  download starts, so quota is never spent on attachments while text is still at risk.
- **Verified output.** Every ZIP entry's CRC32 is re-checked after building, plus a
  `checksums-sha256.txt` manifest.
- **Archived chats are included** — confirming archived-chat coverage is a real concern
  and not hypothetical (still an open question for z.ai).
- **Distribution as a bookmarklet**, which sidesteps "what is a console" entirely: the
  user clicks a bookmark.

Being MIT licensed, this one *can* be adapted with attribution — unlike the unlicensed
gist. Worth reading before writing the ChatGPT adapter.

### Playwright storageState — the pattern that does solve it

Not a packaged project; a documented technique. Authenticate once (headed, manual),
save `storageState.json` (cookies + localStorage), reuse it headlessly on every
scheduled run. The credential is captured by the framework internally rather than
being read out and pasted by a human.

Relevant references: Playwright's own auth docs, `browser-use`'s
`export_storage_state()`, `browserstate-org/browserstate` (portable profiles with
S3/GCS backends). Closest chat-specific implementations —
`cbusillo/chatgpt-automation-mcp` (archived, "OUT OF DATE") and
`gneitzke/chatgpt-exporter` (0 stars) — both use persisted profiles but target
ChatGPT's DOM and are not maintained.

**Conclusion: nothing off-the-shelf fits. Custom is correct here, but the *pattern*
is well-established.** This is P2 in `GOAL.md`.

---

## 4. Auth findings

- `Authorization: Bearer <token>` works with **no cookies at all**. Verified: a plain
  fetch with only that header returned all 618 chats.
- The token is a JWT with claims `{id, email}` and **no `exp`**, so it does not
  self-expire the way most session tokens do. Not a contract — do not rely on it
  forever.
- The token lives in `localStorage` under key `token`.
- ⚠ **Reading that value programmatically is blocked by a safety classifier.** Only
  the user can copy it out by hand. This is why P2 (storageState) matters: it makes
  the manual copy unnecessary.

---

## 5. Design decision: raw-first

Capture stores API responses verbatim. Normalization is a separate re-runnable pass.

This rule was written *after* violating it. A normalizer was built before `tool_calls`
blocks were discovered; it did `text += b.content` on what turned out to be an array,
which would have produced `[object Object]` and corrupted all 97 agent chats. Fields
that were also being silently dropped: `usage` (token counts), `files`,
`status_history`, `extra`, and tool `results`.

The general lesson: **schema knowledge is always incomplete.** Anything interpreted
at capture time is destroyed for anything you learn later. Re-rendering is cheap;
re-scraping 618 conversations is not.

---

## 6. Testing approach

30 offline tests, no network. They were mutation-tested — deliberately reintroducing
each historical bug to confirm the suite catches it:

| Injected bug | Tests failed |
|---|---|
| tool_calls concatenated into prose | 4 |
| branch walk stops descending | 1 |
| failed chat gets watermarked | 1 |
| hash ignores message content | 3 |

A suite that cannot fail proves nothing. `test/live-check.mjs` covers what offline
tests structurally cannot: whether the live API itself drifted.
