# Omnibus — Node → Rust Porting Audit

Generated 2026-06-05. Parity review of `omnibus-engine/` (Rust / Axum / sqlx / tokio+rayon) against the original Node/TypeScript implementations, based on 7 parallel deep-dive reviews covering all 11 ported modules plus the orchestration seam.

> **Progress — Phase 0 landed & compiles (cargo check exit 0):** C-1 (backup PBKDF2+salt v3.0, no literal key), C-2 (`Series.size`), C-3 (storage cache keys + per-series JSON + epoch-ms), C-5 (embed SQL-injection → bound params), C-8 (WebP settings threaded into repack), X-1 (storage/ghost/integrity DB errors now logged). Verified by compile + line-by-line match against the Node `backup`/`restore`/`storage` references.
>
> **Progress — Phase 1a (scanner) landed & verified (cargo test: 6/6 pass):** C-6 (reads ComicInfo.xml on scan → auto-match, publisher, cv/metron IDs, source/matchState), C-7 (issue-number algorithm rewritten with year-skip + reverse scan; unit-tested against the `Saga 2014 012 → 12` regression), H-4 (isManga from ComicInfo Manga tag ‖ `Library.isManga`; full AniList `detectManga` deferred), H-5 (per-library ghost-series purge with monitored/active-request exclusions + drive-disconnected bail). Also: H-7 (scan extensions restricted to cbz/cbr/zip to match Node), per-library scoping of both ghost passes (safer than Node's global purge under the per-library HTTP model), and restored `[Scanner Debug]` logging. Deferred: ComicInfo dynamic API-resolution fallback, scanner parallelism (Phase 3).
>
> **Progress — Phase 1b (search scoring & filtering) landed & verified (cargo test: 10/10 pass):** C-9 (scoring now `seeders + peers*0.5 + 8 default rules`, priority multiplier removed — unit-tested that a heavily-seeded `.cbr` ranks below a low-seed `.cbz`), H-11 (Prowlarr now sends `indexerIds` from the Indexer table + drops category `8030` for comics; `is_manga` threaded through → resolves the unused-`is_manga` warning), H-12/PG-7 (core-title match-ratio reverse-validation + yearless-title rejection for Prowlarr results), PG-11 (deterministic insertion-ordered query generation), PERF-1 (hot regexes hoisted to `OnceLock`), plus Prowlarr error logging. Deferred within this area: the full source-specific filter split (mandatory significant-word intersection beyond `words_to_enforce`), the GetComics-side internal filtering (C-10, getcomics module), and the "multiple distinct editions → STALL" safety (needs the queue-worker/notification seam → Phase 2).
>
> **Progress — Phase 1c-a (ComicVine metadata fetch) landed & verified (cargo test: 14/14 pass):** C-4a — `sync_metadata` now actually fetches from ComicVine (was a no-op): GET volume → upserts series name/publisher/year/description/cover/status (+ cover download to `cover.<ext>` with existing-file fallback) and genres from concepts; paginated GET issues → upserts each issue with `is_same_issue` dedupe, `hasCustomMetadata` lock respect, MATCHED state, and the "Ended after >1.5y inactivity" rule; 429 sets the `cv_rate_limit_time` flag. Pure helpers unit-tested (`is_same_issue`, `cv_is_ended`, `parse_date_ms`, `json_num_string`). **Deferred: C-4b Metron fetch** (Metron series currently skip the fetch and just re-embed existing data), `logApiUsage` telemetry, and rich file-embedding (still the 4-tag inline writer until H-8 — fetched data lands in the DB so the UI sees it, but only 4 tags reach the archives for now). Not yet runtime-tested against the live ComicVine API (needs a key + network).
>
> **Progress — Phase 1c-b (Metron metadata fetch) landed & verified (cargo test: 15/15 pass):** C-4b — ported the MetronProvider: Basic-auth client with `fetchWithBackoff` burst-rate-limit handling (`x-ratelimit-burst-remaining`/`-reset`, 429 retry + FATAL circuit-breaker), series-detail fetch (numeric id or slug-by-name), cover from `issue_list`, cursor pagination over all issues, and upsert with `is_same_issue` dedupe + `hasCustomMetadata` lock. Issue display-name formatting ported + unit-tested. **C-4 (metadata provider fetch) is now COMPLETE** — both providers fetch and upsert. (Metron credits stay `"[]"` to match Node's `getSeriesIssues`, which doesn't pull per-issue credits.) Still not runtime-tested against the live APIs (needs keys + network).
>
> **Progress — Phase 1d (embed/ComicInfo parity) landed & verified (cargo test: 17/17 pass; `writer`-unused warning gone):** H-8/H-10 — `process_embed_job` now emits the full ~21 ComicInfo tags (Volume, Month/Day, Universe, Genre+Manga, StoryArc, Characters, Web, Manga, CV/Metron IDs); `<Year>`/`<Month>`/`<Day>` come from `releaseDate` (no hardcoded 2025), summary is HTML-stripped, and the fabricated `Unknown`/`1` defaults are gone. H-9 — `series.json` is gated on `export_series_json` and uses the Komga schema (status/genres/links/readingDirection/totalBookCount, HTML-stripped summary). H-13/H-14 — watched-sync parses Writer/Penciller/Characters and dedupes via `is_same_issue` (update-or-insert). Bonus: `metadata.rs` now embeds via the unified rich writer (removed the duplicate 4-tag writer), and `inject_xml_into_zip` preserves each entry's source compression (fixes audit BUG-2). New unit tests: `strip_html`, JSON-array helpers.
>
> **Phase 1 (restore lost functionality) is essentially complete.**
>
> **Progress — Phase 2 (reliability seam) — in progress; engine compiles, 0 warnings:** X-6 — every `main.rs` background-task failure path now writes a **FAILED JobLog** (`write_failed_joblog`) so failures are DB-visible instead of vanishing after the 202; `request_id` is now used (last warning gone). X-4 — engine bind is configurable (`OMNIBUS_ENGINE_BIND`); Node gained `src/lib/engine.ts` (`ENGINE_URL` ← `OMNIBUS_ENGINE_URL`) and all **14 hardcoded `127.0.0.1:8000` URLs** across 5 files now use it. X-5 — added `omnibus-engine/Dockerfile` (multi-stage, C/C++ deps for unrar/bzip2/webp) + `.dockerignore` + a `docker-compose.yml` engine service. **Caveat:** the Dockerfile hasn't been test-built in Linux Docker yet — system deps may need a tweak on first `docker build`.
>
> **Progress — Phase 2 notifications (cargo test 18/18; Node type-checked):** H-1 — the BullMQ no-match branch now sends a `download_failed` alert (was a silent STALL). X-7 — `job_metadata_sync` / `job_diagnostics` notifications fire from the Node forwarding cases for the Rust-owned jobs (mirrors the existing `job_db_backup` pattern; event keys confirmed in discord.ts). C-10 — Rust `handle_search` detects multiple distinct DDL editions (`normalize_edition_title`, unit-tested) and returns `stall_for_review`; the worker STALLs + alerts for admin review. B2 — the interactive route now forwards `year`/`is_manga`, and the modal sends them (added `isManga?` to `comicData`; callers can opt in). **Phase 2 reliability seam is complete.**
>
> **Progress — Phase 3a (converter) landed & verified (cargo test 19/19):** PG-3 natural page-sort (`natural_cmp`, unit-tested — `page2` < `page10`), PG-4 alpha-preserving WebP (RGBA vs RGB encode), PG-7 `__MACOSX`/`._` junk filter, PERF-1 bounded CBR sweep (semaphore = core count) routed through `process_archive` so the sweep now honors WebP settings (also fixes PG-2), BUG-5 RAR Zip-Slip guard, BUG-3 DB-update-failure surfaced instead of swallowed, plus `[Converter Debug]` logs + WebP-decode-fallback warning.
>
> **Progress — Phase 3b (GetComics) landed & verified (cargo test 19/19):** PG-1 maxPages now 2 (interactive) vs 5 (automation) via an `is_interactive` flag; restored `[GetComics Debug]` logging (per-page search URL, decoded deep-link + hoster, available-hosters info, FlareSolverr bypass logs); BUG-4 Cloudflare-block flag set on 403 when FlareSolverr is absent/fails (`mark_cloudflare_flag`); BUG-5 `scrape_deep_link` now returns the graceful `unknown` sentinel on fetch error instead of erroring; PG-5 consistent full User-Agent; BUG-1 preferred-hoster fallback warning.
>
> **Progress — Phase 3c (scanner parallelism + skip_indexers) landed & verified (cargo test 19/19):** the scanner now parses each new folder's first-archive ComicInfo (5A) and each new-file ComicInfo (5B) **in parallel**, bounded by a CPU-count semaphore, then does the DB inserts sequentially — restoring the throughput the sequential ComicInfo reads had erased. `skip_indexers` is threaded end-to-end: `AutomationRequest.skip_indexers` → `handle_search` skips the Prowlarr fallback (DDL-only), forwarded from `queue.ts`.
>
> **Progress — Phase 3d (AniList detectManga + debug logging) landed & verified (cargo test 19/19, 0 warnings):** new `manga_detector.rs` ports the full `detectManga` waterfall — manga-publisher list → western-publisher bypass → **AniList GraphQL** cross-reference (fuzzy ±4-year title match) — wired as the scanner's 3rd manga-detection tier (after the ComicInfo tag + `Library.isManga`); publisher lists fetched once per scan, AniList only called for ambiguous/unknown-publisher folders. Added `[X Debug]` logging to the previously-untouched modules: diagnostics ghost/storage/integrity scans (per-item) and backup (per-table demoted to debug).
>
> **Phase 3 remaining:** only the GetComics automation-side relevance pre-filtering (already handled downstream by `filter_and_score`) and any remaining `[X Debug]` lines one might want in the rate-limiter. Nothing correctness-critical.

**Severity legend:** **Critical** = data loss / silent corruption / security / a feature that is now a no-op · **High** = wrong behavior or lost functionality · **Medium** = degraded behavior · **Low** = cosmetic / minor divergence.

**Engine compiles** (`cargo check` exit 0). The problems are behavioral parity, not compilation.

---

## Executive summary

The port has the right *shape* — Axum routes mirror the BullMQ job types, and the Node worker forwards to them. But several ported modules **silently do less than the Node original**, three modules have **Critical data-integrity/security bugs**, and the forwarding pattern **drops failure-handling, retries, and notifications**. Two themes dominate:

1. **Systemic regressions repeated in every module:** (a) almost all of Node's `[X Debug]` logging was dropped; (b) DB writes use `let _ = …await`, so **SQL errors are silently swallowed** (and counters still increment on failure); (c) several modules ignore `SystemSetting` config the Node code honored.
2. **The seam leaks reliability:** Rust handlers return `202 Accepted` then work in a detached `tokio::spawn`. If that task fails, Node already recorded success → **no retry, no FAILED JobLog, no user notification**.

The single highest-value realization: **`metadata.rs::sync_metadata` makes zero HTTP calls** — the scheduled metadata sync no longer fetches from ComicVine or Metron at all. It is a no-op that just rewrites existing DB values back into XML.

---

## Cross-cutting issues (fix once, benefits every module)

| ID | Issue | Where | Severity |
|----|-------|-------|----------|
| **X-1** | **Swallowed SQL errors** — `let _ = sqlx::…await` discards DB failures across scanner, diagnostics, converter; success counters increment even when the write failed. | `scanner.rs:146-223`, `diagnostics.rs:75`, `converter.rs:102` | High |
| **X-2** | **Debug logging stripped** — every module lost its `[X Debug]` traces; the owner explicitly wants info **and** debug parity. Also `env_logger` defaults to `info` (`main.rs:69`), so even added `debug!` needs `RUST_LOG=debug`. | all modules | High |
| **X-3** | **`success` log level lost** — Node's `'success'` level has no `log` analog; map consistently to `info!`. | all modules | Low |
| **X-4** | **Hardcoded engine URL** `http://127.0.0.1:8000` in 14 spots / 5 Node files — breaks any containerized/multi-host deploy. Make it `OMNIBUS_ENGINE_URL`. | `queue.ts`, `library-scanner.ts`, `repack/route.ts`, `search/interactive/route.ts`, `admin/diagnostics/route.ts` | High |
| **X-5** | **No Dockerfile / not in `docker-compose.yml`** — engine can't run in a packaged deploy (compose is only `db`+`redis`). | `omnibus-engine/`, `docker-compose.yml` | High |
| **X-6** | **Detached-task failures are invisible** — `Err` arms only `log::error!`; no FAILED JobLog, BullMQ retry/backoff defeated. | `main.rs:142,231,247,282,400,428…` | High |
| **X-7** | **Rust has no notification capability** — `job_metadata_sync`, `job_diagnostics`, `job_discover_sync` Discord/alert events no longer fire for Rust-owned jobs. | `notifications.ts`/`discord.ts` (Node-only) | High |

---

## Critical findings (must fix — data loss, security, or dead features)

| # | Module | Finding | Location |
|---|--------|---------|----------|
| **C-1** | backup | **Backup security regression + format divergence.** Rust uses a single unsalted **SHA-256** key and emits `version "2.2"`; Node uses **PBKDF2-HMAC-SHA256 ×100,000 + 16-byte salt**, `version "3.0"`. Worse: Rust falls back to a **hardcoded literal key** `"omnibus_default_…"` if `NEXTAUTH_SECRET` is unset (Node refuses and throws). Scheduled backups silently downgrade to unsalted SHA-256 and can be encrypted under a publicly-known constant. | `backup.rs:15-21,72-83` ↔ `admin/backup/route.ts:25-38`, `admin/restore/route.ts:41-57` |
| **C-2** | diagnostics | **Storage scan UPDATEs a non-existent column** `Series."sizeBytes"` (real column is `size Float?`). Error swallowed → every per-series size write fails silently while reporting success. | `diagnostics.rs:75-78` ↔ `schema.prisma:117` |
| **C-3** | diagnostics | **Storage scan writes the wrong `SystemSetting` keys** (`total_library_size_mb`/`last_storage_scan`) instead of the `storage_deep_dive_cache` (per-series JSON) + `storage_deep_dive_last_run` the dashboard reads → Storage page is permanently empty / `needsScan:true`. | `diagnostics.rs:83-97` ↔ `admin/storage/route.ts:17-28`, `queue.ts:119-163` |
| **C-4** | metadata | **`sync_metadata` fetches nothing** — no ComicVine, no Metron, no `reqwest` call. Reads `cv_api_key` then discards it; only re-serializes existing DB columns into XML. The scheduled sync can never pull new issues, covers, credits, or status. | `metadata.rs:7-91` ↔ `metadata-fetcher.ts:28-409`, `metron.ts` |
| **C-5** | metadata | **SQL injection** in embed: `series_id`/`issue_ids` from the HTTP body are `format!`-interpolated into SQL (every other query uses `$1` binds). | `metadata_writer.rs:48-56` |
| **C-6** | scanner | **Scanner never reads ComicInfo.xml.** Every disk-scanned series/issue lands `UNMATCHED`, publisher hardcoded `"Other"`, `isManga=false`, possibly year 0 — even for fully-tagged files. Loses embedded ComicVine/Metron match IDs. (`extract_comicinfo` already exists in `watched_sync.rs:267`.) | `scanner.rs:121-224` ↔ original `library-scanner.ts` `findSeriesFolders` |
| **C-7** | scanner | **Issue-number fallback returns the wrong number.** `captures()` takes the *first* match with no year-skip, so `Saga 2014 012.cbz` → issue **"2014"**; `(YYYY)`/`[YYYY]` are never pre-stripped. Corrupts issue identity/ordering/dedup library-wide. | `scanner.rs:127,170-172` ↔ `importer.ts:36,55-67` |
| **C-8** | converter | **Ignores `convert_to_webp`/`webp_quality` settings** — hardcodes `process_archive(&path, true, 80.0)` and never queries `SystemSetting`. Transcodes the library to WebP against an explicit user opt-out; ignores custom quality. | `main.rs:177`, `converter.rs:119-123` ↔ `converter.ts:25-30` |
| **C-9** | search | **Wrong auto-download scoring.** (a) Base score multiplies by indexer priority (`priority*1_000_000`) so priority dominates seeders/rules — Node automation uses `seeders+peers*0.5`, no priority. (b) Default scoring rules truncated **8→2**, dropping the `.cbr`/`.rar`/`vapi` −400 penalties and `[digital]`/`webrip` bonuses → bad-format releases can win. | `search_engine.rs:171-174,290` ↔ `automation.ts:269-273,284` |
| **C-10** | getcomics/search | **Relevance filtering dropped.** `getcomics::search` pushes every result with no TPB/variant/issue/year validation; **interactive search returns raw, unfiltered** GetComics links to the UI. Automation partly covered by `filter_and_score`, but the DDL "multiple distinct editions → STALL for review" safety is gone (auto-downloads where Node asked a human). | `getcomics.rs:62-74` ↔ `getcomics.ts:174-288`; `automation.ts:181-195` |
| **C-11** | converter | **Two live repack engines diverge.** API route + `/api/repack` (Rust, quality 80, parallel) vs the still-live `REPACK_ARCHIVES` BullMQ case running Node `repackArchive` (serial, no settings). Different output, possible races, two `REPACK_ARCHIVES` JobLogs. | `repack/route.ts:24` + `main.rs:149` vs `queue.ts:477-524` |

---

## High-severity findings

**Reliability / seam (gap analysis):**
- **H-1** Automated searches that find nothing now **stall silently** — the Rust no-match branch sends no `download_failed` alert that Node's `automation.ts:337-343` sent. — `queue.ts:307-310`
- **H-2** Interactive search **drops `year` and `is_manga`** end-to-end: the route POSTs only `{query}` (`interactive/route.ts:20`), and Rust's `is_manga` is parsed but unused → manga-aware filtering lost. — `main.rs:353-377`
- **H-3** `SEARCH_AND_DOWNLOAD` forwarding **drops `skip_indexers`** (and `publisher`); Rust always searches both Prowlarr+GetComics even when the caller asked to skip indexers. — `queue.ts:293-298`, `main.rs:36-41`

**Scanner:**
- **H-4** `isManga` always `false` — the `Library.isManga` column is never read and ComicInfo Manga tag/`detectManga` are gone → breaks RTL reading + manga routing. — `scanner.rs:149`
- **H-5** **Ghost-series purge missing** (Rust only cleans ghost *issues*); must be ported **with** the drive-disconnected fatal guard and `monitored`/active-request exclusions or an unmounted drive wipes a library. — `scanner.rs` (absent) ↔ `library-scanner.ts` ghost block
- **H-6** Scanner is **fully sequential** (no rayon; one awaited INSERT per file) despite the `"fast parallel scan"` log; once C-6 adds archive reads, the throughput win evaporates. — `scanner.rs:133-224`
- **H-7** Extension set too wide — indexes `.pdf/.epub/.rar`; Node's disk scanner only indexes `cbz/cbr/zip`. — `scanner.rs:82`

**Metadata / embed:**
- **H-8** ComicInfo.xml tag coverage: sync writer emits **4 of ~25** tags, embed writer **8 of ~25** — missing `Web`, `ComicVineVolumeId`/`MetronId`, `Characters`, `Genre`, `StoryArc`, `Universe`, `Manga`, `Month`/`Day`. The re-import extractor depends on these (breaks ID round-trip). — `metadata.rs:124-133`, `metadata_writer.rs:68-79` ↔ `metadata-writer.ts:70-93`
- **H-9** `series.json` **ignores the `export_series_json` flag** and uses a non-Komga schema (`name` vs `title`, no `status`/`genres`/`links`, raw HTML). — `metadata_writer.rs:128-147` ↔ `metadata-writer.ts:133-185`
- **H-10** `<Year>` hardcodes **`2025`** when `series.year` is NULL, and `releaseDate` is selected but never used → wrong issue years baked into XML & series.json. — `metadata_writer.rs:84,96,39`
- **H-11** Prowlarr **`indexerIds` restriction + manga category `8030` filtering not ported** — searches indexers the user excluded; pulls manga category into comic searches. — `prowlarr.rs:39-65` ↔ `prowlarr.ts:24-53`
- **H-12** Prowlarr inline filter (significant-word intersection + `filter_match_ratio` reverse-validation) missing → loose titles pass and can auto-download. — `search_engine.rs` ↔ `prowlarr.ts:142-167`

**Watched sync:**
- **H-13** **Credits never applied** (the flagged unused `ComicInfo.writer`): Issue INSERT omits `writers/artists/characters`; `Penciller`/`Characters` aren't even parsed. — `watched_sync.rs:20,234-242` ↔ `importer.ts:677-722`
- **H-14** Always INSERTs a new Issue — no `isSameIssue` dedupe/update-in-place → duplicate rows + orphaned pre-tracked issues. — `watched_sync.rs:231-242` ↔ `importer.ts:681-724`

**GetComics:**
- **H-15** `maxPages` hardcoded to 2 for all callers; Node automation scans **5** → background search misses page 3-5 releases. — `getcomics.rs:45` ↔ `getcomics.ts:138`
- **H-16** Logging: decoded-deep-link trace, "available hosters", selection-fallback warn, per-page URL, FlareSolverr-bypass logs all dropped. — `getcomics.rs` ↔ `getcomics.ts:368,427-445`

**GetComics getcomics.rs error handling:** `scrape_deep_link` propagates `?` instead of Node's graceful `{hoster:"unknown"}` sentinel; 403 path never sets `cloudflare_block_time` flag; strict `STANDARD.decode` drops `go.php-url=` links with trailing query params Node's lenient `Buffer` keeps. (BUG-2/4/5 in getcomics review.)

---

## Performance / parallelism

| ID | Finding | Location |
|----|---------|----------|
| **P-1** | **Unbounded `spawn_blocking`** — one blocking task per comic in CBR sweep (`converter.rs:77-91`), per issue in embed (`metadata_writer.rs:105`), per series in storage (`diagnostics.rs:44`). Thousands of items → blocking-pool exhaustion / disk thrash / OOM. **Fix:** bound with a `Semaphore` = `num_cpus` (or rayon par_iter inside one `spawn_blocking`). | converter/metadata/diagnostics |
| **P-2** | **Fully sequential where it shouldn't be** — scanner inserts (H-6), sync-path embedding (`metadata.rs:52`), repack across archives (`main.rs:170`). | scanner/metadata/converter |
| **P-3** | **Regexes recompiled in hot loops** — `filter_and_score` compiles per-result; `extract_number` compiles 4-5 regexes per call (×2 per result); acronym regexes per-acronym per-query. Hoist to `once_cell::Lazy`. | `search_engine.rs:119-152,234-252,72-98` |
| **P-4** | Storage scan forgoes Node's `du -sb` fast path (Linux/Docker target) for `jwalk` recursion. | `diagnostics.rs:50-65` ↔ `queue.ts:85-97` |
| **P-5** | Good (keep): `handle_search` runs Prowlarr+GetComics concurrently via `tokio::join!` (Node was sequential). Note it loses Node's "DDL wins → skip Prowlarr" short-circuit. | `main.rs:308-311` |

---

## Other correctness bugs (Medium/Low, condensed)

- **converter:** file deleted before DB update with `UPDATE` error swallowed → orphaned record (`converter.rs:61,102`); `__MACOSX` junk → garbage page (`converter.rs:240`); RAR extraction missing Zip-Slip guard that the ZIP path has (`converter.rs:287`); byte-sort page ordering vs natural sort (`converter.rs:152`); WebP encode drops alpha (transparent covers) (`converter.rs:218`).
- **metadata:** HTML not stripped from Summary/description (`metadata_writer.rs:83`); `"Unknown"`/`"1"` defaults fabricated into files; embed writer re-`Stored` (uncompressed) inflating archives (`metadata_writer.rs:176`); full-sync silent `LIMIT 15` throttle (`metadata.rs:30`).
- **search:** nondeterministic `HashSet` query ordering → flaky "first query wins" (`search_engine.rs:38`); `peers` mapping loses `leechers||peers` fallback when leechers=0 (`prowlarr.rs:116`); annual filter wrongly applied to Prowlarr; year-anchor too lax on yearless Prowlarr titles.
- **diagnostics:** storage `last_storage_scan` written RFC3339 vs epoch-ms → **defeats the 24h re-scan throttle** (`diagnostics.rs:91` ↔ `queue.ts:552`); ghost check marks empty-string `filePath` as MISSING; orphan scan includes `.rar` + no case-fold → false orphans; integrity scan flags missing files as CORRUPTED.
- **seam:** `STORAGE_SCAN`/`last_storage_scan` double-write (Node + Rust) (`queue.ts:1040` + `diagnostics.rs:93`); `LIBRARY_SCAN` is half-Rust/half-Node and gates on a key Rust never writes (`queue.ts:552`).

---

## Porting roadmap (what to move to Rust next)

Ranked value/effort, from the orchestration review:

| Rank | Candidate | Decision | Effort | Why |
|------|-----------|----------|--------|-----|
| 1 | `runStorageScan`/`getFolderSize` (`queue.ts:80-163`) | **Port (mostly delete)** | S | Rust path already exists; just fix C-2/C-3/P-4 and unify cache keys → delete the Node walk. Best value/effort. |
| 2 | `DISCOVER_SYNC` (`queue.ts:1058-1330`) | **Port** | L | ~30 ComicVine calls / paginated Metron, pure fetch+filter+cache, no download dependency. Self-contained. |
| 3 | `SERIES_MONITOR` (`queue.ts:652-996`) | **Partial** | L | Multi-minute Metron(3000)+CV(25) sync loop; Rust already has Metron client + rate limiter. Keep request-creation simple. |
| 4 | DDL streaming in `download-clients.ts:167-372` | **Partial** | M | Port raw stream + stall-watchdog + progress first; leave hoster resolvers in Node. |
| 5 | Batch importer (`importer.ts`) | **Defer** | L | Heavily entangled with notifications/routing; highest regression risk. |
| — | health-check, cache-cleanup, update-check | **Keep in Node** | — | Light; cache-cleanup touches Node-process memory. |

---

## Recommended execution plan (phased)

**Phase 0 — Critical quick wins (small diffs, high impact):** C-2 (`sizeBytes`→`size`), C-3 (storage cache keys + per-series JSON), C-5 (SQL-injection → bind params), C-8 (thread webp settings), C-1 (PBKDF2+salt+`3.0`, remove literal key), the storage timestamp epoch-ms fix, and X-1 (stop swallowing SQL errors).

**Phase 1 — Restore lost functionality:** C-4 (metadata provider fetch — the big one), C-6/C-7/H-4/H-5 (scanner ComicInfo + issue-number + manga + ghost-series), H-13/H-14 (watched-sync credits + dedupe), H-8/H-9/H-10 (ComicInfo tags + series.json), C-9/C-10/H-11/H-12 (search scoring + filtering).

**Phase 2 — Reliability seam:** X-6/H-1/X-7 (FAILED JobLogs, no-match alerts, job notifications), C-11/H-2/H-3 (repack dedup, interactive params, skip_indexers), X-4/X-5 (engine URL env + Dockerfile).

**Phase 3 — Logging & performance:** X-2 (restore `[X Debug]` across modules), P-1/P-2/P-3 (bounded parallelism, batch inserts, hoist regexes).

**Phase 4 — New ports:** roadmap items 1→4.
