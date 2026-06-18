# Anna's Archive as a First-Class Search Source — Implementation Plan

Status: **Phase 1 + 2 + 3 DONE (2026-06-18, uncommitted) — code-complete, pending live keyed-automation test + commit**. Target branch: `rust-engine`.
Scope (confirmed): build it **fully** — interactive search inclusion **and** admin-orderable
automation source priority across GetComics / Anna's Archive / Indexers.

**Phase 2 shipped (verified: engine clippy `--all-targets -D warnings` clean + 75 tests; Node tsc 0 +
185 tests):** new pure `search_engine::parse_search_source_order` (ordered enabled sources; default
[getcomics, prowlarr]; Anna's Archive opt-in; +unit test); `handle_search` REFACTORED from hardcoded
GetComics→Prowlarr phases into a loop over the configured order — per-source handlers (getcomics:
multi-edition stall + `filter_and_score` skip_relevance=true + `scrape_deep_link` + manual_fallback;
annas_archive: `filter_and_score` skip_relevance=false + single `{md5_url, "annas_archive"}` candidate;
prowlarr: torrent), all enabled sources searched concurrently, first downloadable wins, manual_ddl
fallback preserved; `annas_archive::search` now only appends the `[fmt]` title suffix when interactive
(clean title for automation matching). Node: `queue.ts` all-fail manual-hold generalized to also catch
an Anna's Archive `/md5/` link; new shared `src/lib/annas-test.ts` (`testAnnasArchiveKey`) used by both
`/api/admin/test` and the **save-time automation gate** in `/api/admin/config` (enabling AA for
automation requires a key + passing test on the enable transition, else reverts to `enabled:false` +
returns a warning — interactive unaffected); settings "Automation Search Source Priority" drag list
(`search_source_priority`) + state/load/save wiring + save warning toast. **Deviation from plan §6.5:**
no client test-on-toggle (relied on the authoritative server gate + the existing Test-API-Key button +
post-save warning, to avoid the unsaved-key/hash-resync wrinkle). **NOT yet live-tested**; engine must
be rebuilt + dev server restarted to load the changes.

**Phase 3 shipped (verified: engine clippy `--all-targets -D warnings` clean + 76 tests; Node tsc 0 +
185 tests):** mirror-domain failover in `annas_archive::search` (`KNOWN_MIRRORS` + pure
`mirror_candidates`; the first fetch locks onto a reachable host, fails over to a known mirror when the
configured base is dead, then uses it for the rest of the call + the `/md5/` result URLs, logging a
warning to update the Base URL; +unit test). Removed the orphaned `annas_archive` entry from the
hoster-mirror priority defaults (Node `DEFAULT_HOSTER_ORDER` + Rust `default_hoster_prefs` + settings
useState/load defaults) — it's a search source now, not a GetComics mirror; the download key still lives
in a `HosterAccount`, and existing saved configs keep their (now-inert) entry harmlessly. Added an
`annas_archive_formats` settings field + config default; README updated (AA as a search source + the
automation flow). **Deferred (untestable without a key / low value):** the daily download cap (AA
enforces quota server-side, and keyless/exhausted hits already fall to `MANUAL_DDL`) and the known-md5
test probe (the placeholder-md5 probe stands until a real key is available to validate a stricter
check). **Remaining: live keyed-automation E2E (needs an AA membership key) + the user commits.**

**Phase 1 shipped (verified: engine clippy `--all-targets -D warnings` clean + 74 tests; Node tsc 0 +
185 tests):** engine `omnibus-engine/src/annas_archive.rs` (HTML scrape: comment-unwrap, `/md5/`
anchors, `content=book_comic`+repeatable `ext`, format/size parse → unified `ProwlarrResult`; 5 unit
tests) + registered in `main.rs`; `InteractiveResponse.annas_archive` + gated call in
`handle_interactive_search` (gate = `annas_archive_interactive_enabled`, **default OFF/opt-in**);
modal merges the 3rd array + amber "Anna's" badge + `sourceOf()` routing + size shows `formatSize`;
`request/manual` `source==='annas_archive'` branch (+ `skipIndexers`); `downloadDirectFile` keyless
`annas_archive`→`MANUAL_DDL` (no throw); **resolver endpoint fixed** `/api/fast_download` →
`/dyn/api/fast_download.json` (+ parses `download_url`/`error`/quota); settings hosters-tab section
(interactive toggle, base-URL, no-key info banner, Test-API-Key button) + `annas_archive` branch in
`/api/admin/test` + config defaults. **NOT yet live-tested** (AA is Cloudflare-blocked from the dev
box) — the scraper selectors + the test-probe md5 need a real-world pass; engine must be rebuilt for
the new module to load.

---

## 1. Background: what exists today, and why it's a dead end

Anna's Archive is currently only the **back half** of a download pipeline — a *hoster resolver* —
with no front half (no search):

- `src/lib/hosters/annas-archive.ts` — `resolveAnnasArchive(url, account)`: extracts the md5 from a
  `…/md5/{md5}` URL and, **if** a premium API key is configured, calls `fast_download` for a direct
  URL. No key → returns `success:false` → request drops to `MANUAL_DDL`.
- `src/lib/hosters/index.ts:60` — registered in the `HosterEngine.resolveLink` switch (already pulls
  the decrypted `HosterAccount` key).
- `src/lib/getcomics.ts:17` + `omnibus-engine/src/getcomics.rs:32` — listed in the default
  `hoster_priority`, enabled by default.
- `src/app/admin/settings/page.tsx` + `src/app/setup/page.tsx` — credential field + priority row,
  backed by the `HosterAccount` table.

**The dead end:** a hoster resolver only fires when something tags a URL `hoster:"annas_archive"`.
The *only* tagging path is the GetComics article scraper's `getHosterFromUrl`
(`src/lib/getcomics.ts:425-440`) / Rust `get_hoster_from_url`. **Neither has a branch for
`annas-archive.org`** — such links return `"unknown"` and are dropped. GetComics articles don't link
to Anna's Archive anyway. **So the resolver is unreachable. It is an orphan.**

## 2. The core insight: Anna's Archive is a *source*, not a *hoster*

The codebase has two abstractions that the current implementation conflates:

| Abstraction      | Examples                | Role                              | Priority setting |
|------------------|-------------------------|-----------------------------------|------------------|
| **Search source**| GetComics, Prowlarr     | query → candidate results         | *hardcoded today*|
| **File hoster**  | MediaFire, Mega, Pixeldrain | resolve one link → bytes      | `hoster_priority`|

Anna's Archive spans **both**: it has a **search** (like GetComics) *and* **serves the file** (like a
hoster, via `fast_download`). Only its hoster half is built, and it's filed under the wrong
abstraction. Making it "its own search/scrape/downloader" = **build its search half + re-file it as a
source**; the bytes-fetching plumbing already works and is reused unchanged.

## 3. How the two existing sources are wired (the template)

- **Seam:** Node → Rust engine. Automation `POST /api/automation/search` → `handle_search`
  (`omnibus-engine/src/main.rs:756`). Interactive `POST /api/search/interactive` →
  `handle_interactive_search` (`main.rs:896`), via `src/app/api/search/interactive/route.ts`.
- **Unified result type:** both sources return `prowlarr::ProwlarrResult`; GetComics sets
  `protocol:"ddl"`. Interactive returns `{ prowlarr:[…], getcomics:[…] }` (`main.rs:128-132`).
- **Automation priority is HARDCODED:** `handle_search` does GetComics first (`main.rs:835`), Prowlarr
  only if DDL produced nothing (`main.rs:864`). Only source knob = `skip_indexers` (DDL-only).
  **No admin setting orders sources** — this is the gap behind goal (b).
- **Interactive UI** (`src/components/interactive-search-modal.tsx`) flattens both arrays into one
  table (`:98-101`) and tags each row's `source` = `'getcomics'` if `protocol==='ddl'` else
  `'prowlarr'` (`:256`, `:295`). Download routes via `src/app/api/request/manual/route.ts`, which
  branches on `source` (`:159` prowlarr, `:198` getcomics).
- **Automation download** (`src/lib/queue.ts:299-352`): loops `ddl_candidates`, calls
  `downloadDirectFile(url, …, hoster)`, falls through on failure. **All-fail fallback at `:345` only
  holds `getcomics.org/dls/` links as `MANUAL_DDL`** → a keyless Anna's Archive result would get stuck
  in `DOWNLOADING`. Phase 2 must fix this.

---

## 4. Target data flow

**Search result mapping (Anna's Archive → `ProwlarrResult`):**

| Field         | Value                                                       |
|---------------|-------------------------------------------------------------|
| `guid`        | md5 (or md5 URL)                                            |
| `title`       | parsed title (+ format/lang where useful)                  |
| `size`        | best-effort bytes parsed from the result row (0 if absent) |
| `indexer`     | `"annas_archive"` (machine key; display label "Anna's Archive") |
| `seeders`/`peers` | 0                                                       |
| `info_url`    | `{base}/md5/{md5}`                                          |
| `download_url`| `{base}/md5/{md5}`                                          |
| `protocol`    | `"ddl"`                                                     |
| `publish_date`| `""` (AA doesn't expose)                                    |
| `info_hash`   | `None`                                                      |

**Interactive:** modal merges a third `annas_archive:[…]` array; row `source` derived from
`indexer` (contains "anna" → `annas_archive`).

**Automation:** engine, per the configured source order, emits `best_match` (indexer
`annas_archive`, downloadUrl = md5 URL) + a single `ddl_candidate { url: md5Url, hoster:"annas_archive" }`.
Node's existing `queue.ts` DDL loop → `downloadDirectFile(…, "annas_archive")` →
`HosterEngine.resolveLink` → `resolveAnnasArchive` → (key) direct URL → engine streams; (no key) →
`MANUAL_DDL`. **The engine never needs the API key.**

---

## 5. Phase 1 — Interactive search inclusion (low risk, self-contained)

Works with or without an API key (keyless gated files fall to the manual queue).

### 5.1 Engine: new module `omnibus-engine/src/annas_archive.rs`
- `pub async fn search(db, limiter, queries, is_interactive, is_manga) -> anyhow::Result<Vec<ProwlarrResult>>`.
- Read settings: `annas_archive_base_url` (default `https://annas-archive.org`),
  `annas_archive_formats` (default `cbz,cbr,pdf,epub`), page depth (reuse a pair like
  `annas_archive_interactive_pages` / `_automated_pages`, defaults 1–2).
- Build `{base}/search?q={query}` with repeated `ext=` filters; reuse the existing Cloudflare-aware
  `fetch_html` (FlareSolverr/Byparr) helper and `limiter.enforce("annas_archive", 2500)`.
- **Parse:** unwrap the lazy-rendered result markup (Anna's Archive wraps result blocks in HTML
  comments `<!-- … -->` for performance — **must strip comment delimiters before scraping**), extract
  anchors to `/md5/{md5}` (`[a-f0-9]{32}`), title, format, size, language.
- Filter to comic-relevant formats; map to `ProwlarrResult` per §4.
- Register `mod annas_archive;` in `main.rs`.
- **Unit tests** (mirror `getcomics.rs`): md5 regex, HTML-comment unwrap, format filtering, size
  parsing, result mapping.

### 5.2 Engine: interactive response
- `InteractiveResponse` (`main.rs:128`) gains `annas_archive: Vec<ProwlarrResult>`.
- `handle_interactive_search` (`main.rs:896`): add `annas_archive::search(...)` to the existing
  `tokio::join!`; gate on the source being enabled (see §6 `search_source_priority`).

### 5.3 Node: surface in UI
- `src/components/interactive-search-modal.tsx`: push `data.annas_archive` into `combined`
  (`:98-101`); set `source` per row from `indexer` (anna → `annas_archive`); give it a distinct badge
  (reuse the `Globe`/Direct styling or a new icon). `src/app/api/search/interactive/route.ts` passes
  the response through unchanged (no edit needed beyond docstring).

### 5.4 Node: interactive download branch
- `src/app/api/request/manual/route.ts`: add `else if (source === 'annas_archive')` — no scrape
  needed; directly `DownloadService.downloadDirectFile(searchResult.downloadUrl, safeTitle,
  config.download_path, targetReqId, 'annas_archive')` then `Importer.importRequest` on success
  (mirror the getcomics branch at `:198-249`, minus `scrapeDeepLink`). The `skipIndexers` flag set at
  `:119` should also be true for `annas_archive` (it's a DDL source).

### 5.5 Node: keyless → manual (shared with Phase 2)
- `src/lib/download-clients.ts` `downloadDirectFile`: when `hoster==='annas_archive'` and
  `resolveLink` fails with the "requires a Premium API Key" error, **set the request to `MANUAL_DDL`
  with the md5 URL and return `false`** (mirror the existing getcomics manual path at `:262-269`)
  instead of throwing. Single source of truth for the keyless-manual behavior; makes both the
  interactive and automation paths do the right thing.

### 5.6 Minimal settings (Phase 1)
- `annas_archive_interactive_enabled` (**ungated**, default `true` once configured): controls whether
  Anna's Archive appears in **interactive** search. No API key required — keyless gated files fall to
  the manual queue.
- Base-URL field + a "Test Connection" button next to the API-key field in the Hosters tab (mirrors
  the Prowlarr/ComicVine test buttons; uses the new `annas_archive` test type from §6.5).
- **Informational message** wherever Anna's Archive is configured, shown when **no active API key**
  exists: _"Without a premium API key, Anna's Archive works for **interactive search only** — gated
  files are sent to the manual download queue. Automation requires an API key."_
- (Full automation priority UI + the save-time gate land in Phase 2.)

## 6. Phase 2 — Configurable source priority + automation

### 6.1 New setting `search_source_priority`
- `SystemSetting` key, JSON ordered list with enable flags, e.g.
  `[{"source":"getcomics","enabled":true},{"source":"annas_archive","enabled":false},{"source":"prowlarr","enabled":true}]`.
- **Default preserves today's behavior** (getcomics → prowlarr; annas off until configured).
- Parser + default mirror `parseHosterPrefs`/`DEFAULT_HOSTER_ORDER` (kept in sync Node↔Rust). The
  engine is the single reader (like `hoster_priority`); Node only writes it via the UI.

### 6.2 Engine: refactor `handle_search` (`main.rs:756-894`)
- Load the source order; honor `skip_indexers` by dropping `prowlarr`.
- Still search all enabled sources **concurrently** (extend the `tokio::join!`/use `FuturesUnordered`)
  for latency, then **iterate in configured order** and take the first downloadable match:
  - **DDL source (getcomics):** unchanged — `filter_and_score` → `scrape_deep_link` → candidates →
    `best_match`+`ddl_candidates`; else hold `manual_fallback`.
  - **DDL source (annas_archive):** `filter_and_score`; the result's `download_url` is already the
    md5 link → emit `ddl_candidates = [{url, hoster:"annas_archive"}]` when `annas_archive` is enabled
    in `hoster_priority` (mirrors how `scrape_deep_link` gates on enabled hosters); else
    `manual_fallback`.
  - **Indexer source (prowlarr):** unchanged — `filter_and_score` → torrent/usenet `best_match`.
- Generalize the **multiple-distinct-editions stall** (currently GetComics-only, `main.rs:816-825`) to
  run against whichever DDL source is being evaluated.
- Generalize the **`manual_ddl` fallback** (`main.rs:885-890`) to the first DDL source that matched
  but resolved to no enabled hoster.

### 6.3 Node: automation download fallback
- `src/lib/queue.ts:345`: generalize the all-candidates-failed `MANUAL_DDL` hold so it also catches an
  Anna's Archive `/md5/` URL (or rely on §5.5 having already set `MANUAL_DDL` inside
  `downloadDirectFile`). Net: a keyless annas automation hit lands in `MANUAL_DDL`, not stuck
  `DOWNLOADING`.

### 6.4 Node: settings UI — "Search Sources" priority list
- New section reusing the existing hoster-priority drag-reorder component: order + enable
  GetComics / Anna's Archive / Indexers, persisted to `search_source_priority`.
- The Anna's Archive **automation** toggle here is **gated** — see §6.5.

### 6.5 API-key gating for Anna's Archive automation enablement

Two distinct enable concepts (per the agreed model):

| Capability   | Setting                              | Gated? | Behavior without a key            |
|--------------|--------------------------------------|--------|-----------------------------------|
| Interactive  | `annas_archive_interactive_enabled`  | No     | Works; gated files → manual queue |
| Automation   | `search_source_priority` annas `enabled` | **Yes** | Cannot be enabled; reverts to disabled (interactive-only) |

**Connection-test endpoint.** Add a `type === 'annas_archive'` branch to `src/app/api/admin/test/route.ts`
(mirrors the `prowlarr`/`comicvine` branches). It reads the active `HosterAccount` key
(`hoster:'annas_archive'`, decrypted) — or a `'********'`-masked value resolved from the DB — and hits
a **non-quota-consuming** account/membership validation endpoint with it (see §10 open question 4),
returning `{ success, message, quotaRemaining? }`. No key → `{ success:false }`.

**Gate at save (authoritative, server-side).** In `src/app/api/admin/config/route.ts` (POST), before
persisting `search_source_priority`: if the incoming payload has `annas_archive` enabled for
automation, then —
1. require an active Anna's Archive `HosterAccount` key; and
2. run the §6.5 connection test.

If either fails, **force that entry's `enabled` back to `false`** before writing, and return a
`warnings: [...]` field. The save still succeeds for everything else; Anna's Archive remains available
for interactive search. Message returned/toasted:
_"Anna's Archive automation was disabled: a premium API key with a successful connection test is
required. It remains available for interactive search."_

**Client UX (immediate feedback).** When the admin flips the automation toggle **on**, the settings
page first calls the test endpoint; only on success does it submit the toggle as `enabled:true`. On
failure/no-key it shows the message above and leaves the toggle **off**. The server-side gate is the
backstop so the rule can't be bypassed and is enforced even when the key is missing entirely.

## 7. Phase 3 — Hardening

- **Base-URL everywhere:** wire `annas_archive_base_url` into `resolveAnnasArchive` (currently
  hardcodes `annas-archive.org`); supports the rotating `.org`/`.se`/`.li` mirror domains.
- **fast_download verification:** confirm the endpoint/response — existing resolver uses
  `…/api/fast_download?key=&md5=`; the documented member endpoint is `…/dyn/api/fast_download.json`.
  Fix if drifted; capture remaining-quota if returned.
- **Quota/rate safety:** per-source rate limit + optional `annas_archive_daily_cap` (counter in
  `SystemSetting` or a tiny table) to protect the membership quota and reduce ban risk.
- **Format filter UI** for `annas_archive_formats`.
- **Cleanup decision:** the orphaned `annas_archive` default in `hoster_priority` is enabled-by-default
  but does nothing today — decide whether to flip its default to `false` until configured (parity edit
  in both `getcomics.ts:17` and `getcomics.rs:32`).
- **Docs:** README "search sources" section + an `E2E_TESTING.md` entry.

---

## 8. Settings & schema summary

| Key                               | New? | Default                      | Read by        |
|-----------------------------------|------|------------------------------|----------------|
| `search_source_priority`          | ✅   | getcomics→prowlarr (annas off)| engine; annas `enabled` **gated at save** (§6.5) |
| `annas_archive_interactive_enabled`| ✅  | `true`                       | engine (interactive); **ungated** |
| `annas_archive_base_url`          | ✅   | `https://annas-archive.org`  | engine + Node resolver |
| `annas_archive_formats`           | ✅   | `cbz,cbr,pdf,epub`           | engine         |
| `annas_archive_interactive_pages` | ✅   | `1`                          | engine         |
| `annas_archive_automated_pages`   | ✅   | `2`                          | engine         |
| `annas_archive_daily_cap` (P3)    | ✅   | unset (no cap)               | Node resolver  |
| `hoster_priority` (`annas_archive`)| —   | (existing) download-enable + key binding | engine + Node |
| `HosterAccount` (annas key)       | —    | (existing, encrypted)        | Node resolver  |

**No Prisma migration required** — everything is `SystemSetting` + the existing `HosterAccount`. No
`prisma db push` needed.

## 9. Parity / sync points (Node ↔ Rust)

- `search_source_priority` default + parser must match if both sides ever read it (engine is the
  intended sole reader; keep Node's writer aligned).
- If the orphaned-default cleanup (§7) happens, edit **both** `getcomics.ts:17` and `getcomics.rs:32`.
- `ProwlarrResult` shape is shared — Anna's Archive mapping must populate the same fields GetComics
  does so the modal + queue treat it uniformly.

## 10. Open questions to verify at implementation time

1. **AA search HTML contract** — exact CSS selectors, the HTML-comment lazy-render wrapper, and the
   real `content=`/`ext=` query-param names/values for comics. Pin against the live site.
2. **fast_download endpoint/response** — verify `/api/fast_download` vs `/dyn/api/fast_download.json`
   and the `download_url` field name; confirm quota error shape.
3. **Stall semantics for AA** — AA often returns many editions/formats per query; confirm the
   distinct-edition stall isn't over-triggered (may want format-aware normalization).
4. **Non-quota-consuming key validation (for the §6.5 connection test)** — find an account/membership
   status endpoint that confirms the key is valid (ideally returning remaining quota) **without**
   spending a fast-download. If none exists, decide the fallback (a documented minimal call, or accept
   that the test costs one download).

## 11. Risks & operational notes

- **API key required for automation, enforced at save (§6.5).** Enabling Anna's Archive for automation
  requires a key + a passing connection test; otherwise it reverts to disabled (interactive-only).
  Caveat: the save-time test is a **guard, not a runtime guarantee** — if the key is later deleted,
  expires, or exhausts its quota, automation hits fall back to `MANUAL_DDL` at download time (already
  handled by §5.5/§6.3). Interactive search remains key-free throughout.
- **Quota & bans.** `fast_download` is daily-quota-limited; search is Cloudflare-gated. Aggressive
  automation risks quota exhaustion / IP or key bans → §7 rate limit + daily cap.
- **Rotating mirror domains** → base-URL setting (§7).
- **ToS.** Shadow-library scraping/automation runs against Anna's Archive terms; document for
  operators. (Self-hosted personal tool; not a code blocker.)

## 12. Test plan

- **Rust unit:** annas_archive parsing (md5, comment-unwrap, format filter, size, mapping);
  source-priority parser; `handle_search` order selection (extract pure-logic where possible).
- **Node unit:** `request/manual` annas branch; `downloadDirectFile` keyless→`MANUAL_DDL`; queue
  all-fail annas→`MANUAL_DDL`; settings persistence; modal source tagging; **the §6.5 save-time gate**
  (config POST with annas automation enabled but no key / failing test → persisted entry reverts to
  `enabled:false` + a warning is returned, interactive flag untouched); the `annas_archive` test-route
  branch.
- **E2E (live, manual):** interactive search returns AA results; keyless pick → `MANUAL_DDL` with
  clickable link; keyed pick → streams + imports; automation with AA top-priority picks AA; verify
  `cargo test --bin omnibus-engine` + `clippy --all-targets -D warnings` + `tsc` + Node tests green.

## 13. Build/verify commands

- Engine: `cd omnibus-engine && cargo test --bin omnibus-engine` and
  `cargo clippy --all-targets -- -D warnings`.
- Node: `npm run build` / `tsc` + the Jest suite.
