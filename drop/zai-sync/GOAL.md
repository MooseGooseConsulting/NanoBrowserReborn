# WORK ORDER — zai-sync

Paste into a session with browser control (Claude in Chrome) + shell. This is the
complete outstanding scope. **You own all of it.** Do not ask the user to pick an
order; the order is below. Ask only if you hit a genuine fork with irreversible
consequences.

Read `RESEARCH.md` (findings, prior art) and `PROVIDERS.md` (multi-provider spec)
before starting. `README.md` documents what already works.

---

## Prime directive

Nothing counts until it has RUN and produced verifiable output. Do not read code,
conclude it looks right, and report success. Every claim needs a command you ran
and its real output. If you change any of `core.js` / `render.js` / `files.js`,
`node test/test.mjs` must still pass and you add a regression test for the fix.

---

## State of play

**Working and verified live** (Aug 2026, 618-chat account):
- Full API reverse-engineering — 10 findings, see README table
- Raw-first lossless capture (`core.js`)
- Delta sync on `updated_at` + content hash
- chat vs agent tagging, tool_calls parsing, attachment extraction
- 30 offline tests, mutation-verified (4 injected bugs all caught)

**Not done — this is your scope:**
| P | Item | Why it matters |
|---|---|---|
| 0 | Pull the actual corpus | Never done. Attachment URLs decay. |
| 1 | Multi-provider refactor | 28 hardcoded z.ai refs. User wants ChatGPT + others. |
| 2 | Outside-the-browser automation | Explicitly asked for; never delivered. |
| 3 | Attachment sweep | Unknown how many URLs already dead. |
| 4 | DB sink | NDJSON is interchange; DB is the destination. |
| 5 | Write path | Roadmap only. |

---

## P0 — Pull the corpus. Do this FIRST.

> **Read `RESEARCH.md` on list under-reporting before this run.** Mature prior art
> (`github.com/thiscantbeserious/chatgpt-exporter`) documents its list endpoint
> reporting 101 conversations when 1086 existed, and warns that earlier versions
> "could silently lose most of an export on long runs". Verify counts; do not assume
> a single clean pass succeeded because it exited 0.

Attachment signed-URLs expire (finding #8). Every hour of design work is potential
permanent data loss. Capture before you refactor.

- [ ] Full run over all 618 chats, `--delay` ≥ 350ms
- [ ] `--files` ON — attachments must download in the same pass that finds them
- [ ] Report: chats captured, total raw bytes, failures, attachments saved vs expired
- [ ] Second run immediately after → must fetch **zero** (proves delta)
- [ ] Spot-check 3 chats (1 default, 1 agent, 1 with attachments) against the live UI
- [ ] **Verify the count.** Assert the number captured matches the 618 the list reports,
      AND that the list still reports ~618 on a second call. If it ever reports far fewer,
      that is the truncation bug — `sync()` now warns via `phase:'warn'`, do not ignore it.
- [ ] **Add retry with backoff before the full run.** Current code has NONE: a transient
      failure just increments `failed`. It is safe (failures are not watermarked, so the
      next run retries) but wasteful over 618 chats. Prior art needed 10s delays and
      exponential backoff at 1000+ conversations. Start at `--delay 1000` and back off on
      429/5xx rather than 350ms flat.
- [ ] **Text first, files second.** Prior art secures all conversation JSON before
      spending any quota on attachments. NOTE the tension with z.ai signed-URL expiry:
      verify whether re-fetching a chat detail mints a FRESH `cdn_url`. If it does, files
      are recoverable and the "download now or lose forever" framing in README finding #8
      is too strong and should be softened. If it does not, files must stay in-pass.

No token? Run it in-browser: `javascript_tool` on a logged-in chat.z.ai tab with
`fetch(url, {credentials:'include'})`. The userscript logic works verbatim there.

⚠ **Do NOT try to read `localStorage.token` programmatically.** A safety classifier
blocks it. Only the user can copy it out, by hand.

---

## P1 — Multi-provider refactor

Full spec in `PROVIDERS.md`. Summary: today `BASE = 'https://chat.z.ai'` is pasted
in three files and the Open WebUI shape is baked into the core. Target: a provider
adapter interface, with z.ai and ChatGPT as the first two implementations.

- [ ] `providers/` dir with an adapter contract (see PROVIDERS.md)
- [ ] `providers/zai.js` — port existing behavior, no regressions, tests still green
- [ ] `providers/chatgpt.js` — spec is now GROUNDED in a working reference impl, see
      `PROVIDERS.md`. Key points: token via `GET /api/auth/session` (no DevTools needed),
      `Oai-Device-Id`/`Oai-Language` headers required, tokens are SHORT-LIVED, Cloudflare
      blocks non-browser requests, content is inline with detail (no batch call),
      `content.parts[]` mixes strings and objects. Reimplement from the shapes — the gist
      has no license, do not copy its source
- [ ] Core carries zero provider strings; grep must come back clean
- [ ] Per-provider state namespacing so two providers can't collide in one store
- [ ] Tests parameterized across both adapters
- [ ] Verify ChatGPT adapter live if the user has a session; otherwise fixture-test it
      and mark clearly as UNVERIFIED in the README

---

## P2 — Automation from outside the browser

The user said, verbatim: *"I want this automated, preferably from outside the
browser"* and *"I don't know what a browser console script is."* Current state fails
both — the userscript needs a manual menu click, and the daemon's setup instruction
is "open DevTools", which is the exact thing they said they don't do.

Build the unattended path:

- [ ] **Local-UI token flow FIRST** (cheaper than Playwright, solves the real complaint).
      Copy the reference impl's pattern documented in `PROVIDERS.md`: start a local server,
      open it in the browser, tell the user to open a session URL, select-all, copy, paste.
      Parse the token out of the pasted blob. No DevTools, no localStorage. For z.ai, first
      look for a `/api/v1/auths/` whoami-style endpoint that returns the token the way
      ChatGPT's `/api/auth/session` does; if none exists, a friendly paste box still beats
      "DevTools > Application > Local Storage".
- [ ] Stream progress back over SSE so the local UI shows live status. This is also the
      "input container" the user described.
- [ ] Playwright `storageState` flow as the SECOND step, for fully unattended runs where
      nobody is present to paste anything. NOTE: it is NOT required to defeat Cloudflare —
      see the corrected Cloudflare section in `PROVIDERS.md`. Its value is surviving token
      expiry without a human.
- [ ] Scheduled runner. Ship real config, not prose: systemd timer + `cron` line +
      a GitHub Actions workflow. Pick sane defaults, explain the tradeoff in one line each.
- [ ] Health/staleness signal — the run must be able to say "auth died" loudly rather
      than silently syncing nothing forever.
- [ ] Re-auth path when the session dies. JWT has no `exp` today, but that is not a
      contract.
- [ ] Prove it: schedule it, let it fire unattended, show the log from a run you did
      not trigger by hand.

---

## P3 — Attachment sweep

- [ ] Inventory attachments across all 97 agent chats AND the 521 default chats
- [ ] Count already-expired URLs; report the number plainly
- [ ] Download everything still alive
- [ ] Measure the actual TTL of a fresh signed URL and write it into README finding #8

---

## P4 — Database sink

NDJSON is interchange, not the destination. The user said these are "eventually just
going to go to a database."

- [ ] Loader: NDJSON → SQLite (Postgres-compatible schema)
- [ ] Suggested tables: `chats`, `messages`, `tool_calls`, `files`, `sync_runs`
- [ ] Idempotent — re-loading the same NDJSON must not duplicate
- [ ] Keys already exist in raw; do not invent surrogate ids
- [ ] Include a couple of example queries (find by content, agent runs by tool used)

---

## P5 — Write path (design only, do not ship blind)

Send messages back into a conversation. Unexplored. Needs the completions endpoint,
SSE streaming, and the `im_context` envelope agent chats carry. Capture is read-only
by design; keep the write path behind an explicit flag and never let a sync run mutate.

---

## Open questions to resolve

- Do **archived** chats appear in `/api/v1/chats/`? If not, 618 is not the true total.
  (Settings has "Archive All Chats" — the endpoint's behavior is untested.)
- `/api/v1/chats/all?page=N` returned 50/page while `/api/v1/chats/` returned all 618
  at once. Unexplained. Determine which is authoritative and whether `/all` terminates
  cleanly at the end of range.
- `folder_id` and `share_id` exist on chat objects and are entirely ignored.
- What is the real signed-URL TTL?

---

## Verify these API facts still hold

Undocumented, dated Aug 2026, can change without notice:

1. `GET /api/v1/chats/` → array with `id`, `title`, `updated_at`, no message bodies
2. `GET /api/v1/chats/{id}` → skeleton only, **no message content**
3. `POST /api/v1/chats/{id}/messages/batch` with `{ids:[…]}` → content
   (field must be `ids`; `message_ids` → 422)
4. Assistant text lives in `content_blocks[]`, not `content`
5. `tool_calls.content` is an **array**
6. Chat kinds are `default` (521) and `general_agent` (97)

`test/live-check.mjs` automates all six given a token; otherwise replicate in-browser.

---

## Known traps

| Symptom | Cause |
|---|---|
| Empty transcripts | Missed the `messages/batch` call (fact #2) |
| `[object Object]` in prose | New non-string block type; see `splitBlocks` in `render.js` |
| Messages missing from tail | `currentId` sat mid-tree; walker must descend AND climb |
| A chat silently never syncs | It got watermarked despite failing. Bug. Test exists. |
| Attachments 403 | Signed `auth_key` expired — download in the discovering pass |
| Two providers clobber each other | State not namespaced per provider (P1) |

---

## Process notes

- **Clone repos, don't scrape them.** A GitHub gist is a git repo:
  `git clone https://gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5`.
  That single command gets every file plus full history. Fetching raw URLs one at a time
  missed a file and all 31 commits during this project's research phase.
- **Read the history, not just HEAD.** For any reference implementation, `git log -p` and
  `git log -S<term>` show which bugs the author actually hit. That is worth more than the
  final source.
- **Follow the comments, not just the code.** The gist's comment thread linked to two
  forks and then to a full repository that is far more advanced than the gist. Comments
  are NOT in a `git clone` — read them separately.
- **Prefer the mature descendant.** `github.com/thiscantbeserious/chatgpt-exporter`
  (MIT, 75 commits, CI, tests) supersedes the gist. Read its README, CHANGELOG and
  `docs/PLAN-v1.1.md` before writing the ChatGPT adapter. Being MIT licensed it can be
  adapted with attribution, unlike the unlicensed gist.
- **Check remaining forks.** 16 on the gist; two were followed, the rest are unexamined.

---

## Ground rules

- Smoke-test `--limit 3` before any full run.
- `--delay` ≥ 350ms. 618 chats is a lot of requests.
- Read-only until P5. Nothing may POST a message or mutate the account.
- Known-good sample: chat `2ac58925-cafc-4535-b1a8-248ef4999a77` → 26 tree / 24 active / 2 orphaned,
  43,455 text chars, 56,102 reasoning chars.
