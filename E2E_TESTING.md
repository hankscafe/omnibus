# Omnibus Rust Engine — End-to-End Test Checklist

Runtime validation for `omnibus-engine` against a **live Postgres + real API keys**. Everything so far is compile-verified + unit-tested + parity-read, but nothing below has been exercised at runtime yet.

Work top-to-bottom: **§0 setup → §2 backup (do this first, it's the highest-stakes) → the rest**.

> **Commands** are shown as `curl` (use `curl.exe` on Windows PowerShell — the bare `curl` alias is `Invoke-WebRequest` and won't accept these flags). A PowerShell `Invoke-RestMethod` equivalent is given once in §1.
> **SQL** examples assume `psql` against the same database the engine uses (note the quoted PascalCase identifiers).
> **Auth:** when `NEXTAUTH_SECRET` is set in the engine's env, every engine endpoint requires the header `-H "X-Internal-Secret: <your NEXTAUTH_SECRET>"` (Node forwards this automatically via `engineHeaders()`). The raw `curl` examples below omit it for brevity — add it, or for quick manual probing leave `NEXTAUTH_SECRET` unset (the engine then runs open and logs a warning, but the backup tests in §2 need the secret set, so test those with the header).

---

## 0. Prerequisites & setup

- [ ] **Postgres is up and the Prisma schema is applied.** From the repo root: `npx prisma db push` (or `migrate deploy`) against the Postgres `DATABASE_URL`. Confirm tables exist: `\dt` in psql should list `Series`, `Issue`, `JobLog`, `SystemSetting`, `Library`, etc.
- [ ] **Settings are seeded** (via the Node app's setup/settings UI, or direct `SystemSetting` rows): at minimum `cv_api_key` (ComicVine), and for the relevant tests `metron_user`/`metron_pass`, `prowlarr_url`/`prowlarr_key`, `ddl_enabled`, `convert_to_webp`/`webp_quality`, `export_series_json`.
- [ ] **`omnibus-engine/.env`** (or shell env) is set:
  - `DATABASE_URL` — same DB as the Node app
  - `NEXTAUTH_SECRET` — **must be byte-identical to the Node app's** (backups + 2FA depend on it)
  - `OMNIBUS_BACKUPS_DIR`, `OMNIBUS_CACHE_DIR`, `OMNIBUS_WATCHED_DIR`, `OMNIBUS_AWAITING_MATCH_DIR`
  - optional: `OMNIBUS_ENGINE_BIND` (default `127.0.0.1:8000`)
- [ ] **The engine sees the same filesystem paths stored in the DB.** `Issue.filePath`, `Series.folderPath`, and `Library.path` must resolve on the machine running the engine (in Docker: mount the same media + config volumes the Node app uses).
- [ ] **Build & run** with logging:
  - Linux/macOS: `cd omnibus-engine && RUST_LOG=info cargo run --release`
  - PowerShell: `cd omnibus-engine; $env:RUST_LOG="info"; cargo run --release`
  - For the `[X Debug]` lines, use `RUST_LOG=debug` instead.
- [ ] On the **Node** side, set `OMNIBUS_ENGINE_URL` if the engine isn't on `http://127.0.0.1:8000` (e.g. `http://omnibus-engine:8000` in Docker).

**Pass:** engine logs `Connecting to PostgreSQL database...`, `✅ Connected to PostgreSQL!`, `🚀 Omnibus Engine listening on http://…`.

---

## 1. Smoke test

- [ ] `curl -X POST http://127.0.0.1:8000/api/diagnostics/storage` → **HTTP 202 Accepted**.
- [ ] PowerShell equivalent: `Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/diagnostics/storage` (returns nothing on 202; no error = pass).

If you get connection-refused, the engine isn't running/bound where you think. If you get a 500/panic in the logs, the DB connection or schema is wrong.

---

## 2. Backup → restore round-trip ⭐ (do this first)

This validates the most security-sensitive change (PBKDF2 + salt, v3.0) and the no-literal-key guard.

- [ ] Trigger: `curl -X POST http://127.0.0.1:8000/api/backup` → 202.
- [ ] A file `omnibus_backup_<epoch_ms>.json` appears in `OMNIBUS_BACKUPS_DIR`. Open it and confirm:
  - `"encrypted": true`, `"version": "3.0"`
  - `"salt"` = **32 hex chars** (16 bytes), `"iv"` = 32 hex chars, `"data"` = long hex string
- [ ] JobLog: `SELECT status, message FROM "JobLog" WHERE "jobType"='DATABASE_BACKUP' ORDER BY "createdAt" DESC LIMIT 1;` → **COMPLETED**.
- [ ] **Round-trip:** in the Node admin UI, use **Restore** and upload that `.json`. It must decrypt and restore **without** "Decryption failed." (Proves the engine's v3.0 PBKDF2 output matches the Node restore path. If it fails → `NEXTAUTH_SECRET` differs between engine and Node.)
- [ ] **Security negative test:** stop the engine, unset `NEXTAUTH_SECRET`, restart, `POST /api/backup` again → **no new file**; JobLog row `status='FAILED'`, message contains `NEXTAUTH_SECRET is not configured`. (Confirms the hardcoded-fallback was removed.) Restore `NEXTAUTH_SECRET` afterward.

---

## 3. Library scan

- [ ] Prereq: a `Library` row whose `path` contains comic folders; at least one folder with a **tagged** `.cbz` (ComicInfo.xml carrying `Series`, `Number`, and ideally `Web`/`ComicVineVolumeId`/`MetronId` and `Manga`).
- [ ] Trigger via the Node app (Library Scan), or directly:
  `curl -X POST http://127.0.0.1:8000/api/scan -H "Content-Type: application/json" -d "{\"library_id\":\"<id>\",\"library_path\":\"<path>\"}"` → 202.
- [ ] **Auto-match (C-6):** `SELECT name, publisher, year, "metadataSource", "matchState", "cvId", "metronId", "isManga" FROM "Series" WHERE "folderPath" ILIKE '%<folder>%';` → the tagged folder's series should be `MATCHED`, real publisher, correct source + IDs (not `Other`/`LOCAL`/`UNMATCHED`).
- [ ] **Issue numbers (C-7):** drop a file named like `Saga 2014 012.cbz` (a year **and** an issue number). After scan: `SELECT number FROM "Issue" WHERE "filePath" ILIKE '%Saga 2014 012%';` → **`12`**, not `2014`.
- [ ] **Manga 3rd tier (AniList):** an **untagged**, unknown-publisher folder whose name is a real manga (e.g. `Berserk`). With `RUST_LOG=info`, watch for `[Manga Engine] Identified via AniList API Match` and confirm that series' `isManga = true`. (A known western title should log `Bypassing AniList due to Western Publisher` and stay `false`.)
- [ ] **Ghost-series purge (H-5):** pick a *throwaway* non-monitored series with no active request, delete its folder on disk, re-scan → its `Series` + `Issue` rows are gone, and logs show `[Scan] Purged N ghost series records.`
- [ ] **Drive guard (H-5):** point a library at a non-existent path and scan → engine logs `Drive disconnected` and **does not** delete anything for that library.
- [ ] Debug (`RUST_LOG=debug`): `[Scanner Debug]` lines for traversal/extraction/per-issue.

---

## 4. Metadata sync — ComicVine + Metron

- [ ] Prereq: `cv_api_key` set; a `Series` with `metadataSource='COMICVINE'` and a valid CV volume id in `metadataId`. For Metron: `metron_user`/`metron_pass` + a `METRON` series.
- [ ] Trigger (targeted): `curl -X POST http://127.0.0.1:8000/api/metadata/sync -H "Content-Type: application/json" -d "{\"series_ids\":[\"<series-id>\"]}"` → 202. (Body `{"series_ids":null}` does a full sync, capped at 15 oldest.)
- [ ] **Series updated:** `SELECT name, publisher, year, status, "coverUrl", LEFT(description,40) FROM "Series" WHERE id='<id>';` → fields populated; `coverUrl` is a `/api/library/cover?path=…` URL. A `cover.jpg`/`.png`/`.webp` file now exists in the series `folderPath`.
- [ ] **Issues upserted:** `SELECT number, name, "releaseDate", "matchState", LEFT(genres,30), LEFT(writers,30) FROM "Issue" WHERE "seriesId"='<id>' ORDER BY number;` → `MATCHED`, real names/dates; ComicVine series get `genres`; Metron series get `writers/artists/characters` = `[]` (expected — Node's `getSeriesIssues` returns no per-issue credits).
- [ ] **Embed flow-through:** open a synced `.cbz` and inspect `ComicInfo.xml` → full ~21 tags (`<Web>`, `<ComicVineVolumeId>`/`<MetronId>`, `<Characters>`, `<Genre>`, `<Year>/<Month>/<Day>` from the release date, etc.).
- [ ] **Rate-limit negative:** if CV returns 429, `SELECT value FROM "SystemSetting" WHERE key='cv_rate_limit_time';` is set and a `METADATA_SYNC` JobLog row is `FAILED`.
- [ ] Debug: `[Metadata Fetcher Debug]`, `[Metron Debug]`, `[Manga Engine Debug]`.

> Note: a *successful* metadata sync writes **no** COMPLETED JobLog (it's fire-and-forget like Node) — verify via DB state, not JobLog. Only failures write a `FAILED` row.

---

## 5. Embed (standalone)

- [ ] Trigger: `curl -X POST http://127.0.0.1:8000/api/metadata/embed -H "Content-Type: application/json" -d "{\"series_id\":\"<id>\"}"` → 202.
- [ ] `ComicInfo.xml` inside each `.cbz` of that series is rewritten with the full tag set; the archive's other entries are intact (pages still open in order).
- [ ] **series.json gate (H-9):** with `export_series_json='true'`, a `series.json` (Komga schema: `metadata.title/status/genres/links/readingDirection/totalBookCount`) appears in the series folder. With the setting `false`/absent → **no** `series.json`.
- [ ] JobLog: `EMBED_METADATA` row `COMPLETED`, message includes `Updated N files … Exported N series.json files.`

---

## 6. Converter — CBR sweep & repack

- [ ] Prereq: an `Issue` whose `filePath` is a real `.cbr`. Set `convert_to_webp` + `webp_quality`.
- [ ] CBR sweep: `curl -X POST http://127.0.0.1:8000/api/converter/cbr-sweep` → 202.
- [ ] On disk: the `.cbr` becomes `.cbz`, original `.cbr` is deleted, and `SELECT "filePath" FROM "Issue" WHERE id='<id>';` now ends in `.cbz`.
- [ ] **WebP setting honored (C-8/PG-2):** open the new `.cbz` — if `convert_to_webp='true'` pages are `page_0001.webp …`; if `'false'` they keep their original extension. With it `false`, your library is **not** transcoded.
- [ ] **Page order (PG-3):** pages are `page_0001, page_0002, … page_0010` in natural order (test with a source archive that had non-zero-padded names like `1.jpg … 10.jpg`).
- [ ] **Transparent cover (PG-4):** include a PNG page with transparency → the WebP output keeps its alpha (not a black box).
- [ ] JobLog: `CBR_CONVERTER` `COMPLETED`.
- [ ] Repack: `curl -X POST http://127.0.0.1:8000/api/repack -H "Content-Type: application/json" -d "{\"series_ids\":[\"<id>\"]}"` → 202 → `REPACK_ARCHIVES` JobLog.

---

## 7. Watched-folder sync

- [ ] Drop a **tagged** `.cbz` into `OMNIBUS_WATCHED_DIR`.
- [ ] Trigger: `curl -X POST http://127.0.0.1:8000/api/watched-sync` → 202.
- [ ] File is moved into the library structure (`Publisher/Series (Year)/…`), and a new `Issue` row has `writers/artists/characters` populated from ComicInfo (H-13).
- [ ] **Dedupe (H-14):** drop the *same* issue again → the existing row is **updated**, not duplicated (`SELECT count(*) FROM "Issue" WHERE "seriesId"='<id>' AND number='<n>';` stays 1).
- [ ] An **untagged** file (no `<Series>`) is moved to `OMNIBUS_AWAITING_MATCH_DIR` instead.
- [ ] JobLog: `WATCHED_FOLDER_SYNC` `COMPLETED`.

---

## 8. Diagnostics

- [ ] **Ghost:** delete a known `Issue`'s file on disk → `curl -X POST .../api/diagnostics/ghosts` → that issue's `status='MISSING'`; `DIAGNOSTICS` JobLog `COMPLETED`.
- [ ] **Storage (C-2/C-3):** `curl -X POST .../api/diagnostics/storage` → `SELECT key FROM "SystemSetting" WHERE key IN ('storage_deep_dive_cache','storage_deep_dive_last_run');` both present; `storage_deep_dive_cache` value is a JSON array of `{id,name,publisher,isManga,issueCount,path,sizeBytes}`; `Series.size` is set. **The Storage dashboard in the app now shows data** (no longer `needsScan`).
- [ ] **Orphan:** `curl -X POST .../api/diagnostics/orphans` → returns JSON `{ "success": true, "orphaned_files": [...] }` listing on-disk files not in the DB.
- [ ] **Integrity:** corrupt a `.cbz` (truncate it) → `curl -X POST .../api/diagnostics/integrity` → that issue's `status='CORRUPTED'`.

---

## 9. Search

- [ ] Prereq: `prowlarr_url` + `prowlarr_key` (and configured `Indexer` rows); `ddl_enabled='true'`; optionally `flaresolverr_url`.
- [ ] **Automation:** `curl -X POST .../api/automation/search -H "Content-Type: application/json" -d "{\"request_id\":\"t1\",\"name\":\"Batman 001 2016\",\"year\":\"2016\",\"is_manga\":false}"` → JSON `{success, best_match, stall_for_review}`. Confirm `best_match` favors `.cbz`/digital over `.cbr` (C-9 scoring).
- [ ] **Indexer restriction (H-11):** with `RUST_LOG=debug`, the `[Prowlarr Debug] Hitting endpoint:` URL includes `&indexerIds=<your ids>` and, for non-manga, **no** `&categories=8030`.
- [ ] **skip_indexers:** add `"skip_indexers":true` → logs `skip_indexers set — searching Direct Downloads only.` and Prowlarr is not queried.
- [ ] **STALL safety (C-10):** a query that returns multiple distinct GetComics editions → `stall_for_review: true` in the response (and, when driven through the BullMQ queue, the request goes `STALLED` with a `download_failed` "multiple editions" alert).
- [ ] **Interactive** (through the Node route, which now forwards year/manga): open `GET /api/search/interactive?q=<query>&year=2016&isManga=false` → `{prowlarr:[…], getcomics:[…]}`.

---

## 10. Reliability seam

- [ ] **FAILED JobLogs (X-6):** force a background failure (e.g. stop Postgres mid-scan, or point a job at a path that errors) → a `JobLog` row with `status='FAILED'` appears for that `jobType`. (Before this work, such failures vanished after the 202.)
- [ ] **Job notifications (X-7):** configure a Discord webhook and enable `job_metadata_sync` / `job_diagnostics`, then trigger those jobs **through the Node queue** (not the raw engine endpoint) → a Discord alert fires.
- [ ] **No-match alert (H-1):** drive a `SEARCH_AND_DOWNLOAD` for a nonsense title through the queue → request `STALLED` **and** a `download_failed` alert is sent (previously silent).
- [ ] **Engine URL (X-4):** set `OMNIBUS_ENGINE_URL` to a non-localhost address and confirm the Node forwarders still reach the engine (relevant for Docker/multi-host).
- [ ] **Engine auth:** with `NEXTAUTH_SECRET` set on both Node and the engine, a raw `curl` to any engine endpoint *without* `-H "X-Internal-Secret: <secret>"` returns **401**; the Node-forwarded jobs (which send the header via `engineHeaders()`) still succeed. With the secret unset, the engine logs the "UNAUTHENTICATED" warning at startup and accepts unheadered requests.

---

## 11. Discover Sync (DISCOVER_SYNC)

- [ ] Prereq: `cv_api_key` set (**required even for the Metron path** — Node throws without it). For Metron, also set `primary_metadata_source='METRON'` + `metron_user`/`metron_pass`.
- [ ] Trigger through the Node queue (scheduled `DISCOVER_SYNC`) or directly: `curl -X POST http://127.0.0.1:8000/api/discover/sync` → **202**.
- [ ] **Caches populated:** `SELECT key, LEFT(value, 80) FROM "SystemSetting" WHERE key IN ('discover_cache_new','discover_cache_popular');` → both present; `discover_cache_new` is a JSON array of `{id, volumeId, name, issueNumber, isReleased, year, publisher, image, description, siteUrl, …}`. ComicVine source fills **both** caches (store_date / cover_date sorts); Metron source fills `discover_cache_new` and leaves `discover_cache_popular` `[]`.
- [ ] **The Discover dashboard** in the app shows the New & Popular tabs populated.
- [ ] **Filtering (CV path):** with `filter_enabled='true'` + `filter_publishers`/`filter_keywords`, blocked publishers/keywords are absent from the cache. `discover_manga_filter_mode='HIDE_ALL'` → no manga titles; `'ALLOWED_ONLY'` keeps only `discover_manga_allowed_publishers`.
- [ ] JobLog: `DISCOVER_SYNC` row `COMPLETED`, message `Successfully rebuilt the Discover cache (New & Popular). Filter enabled: …`.
- [ ] Debug (`RUST_LOG=debug`): `[Discover Sync Debug]` filter lines.

---

## 12. Series Monitor (SERIES_MONITOR)

This is a **partial** port: the engine does the heavy fetch/match/skeleton-upsert; the Node worker keeps request creation + `searchAndDownload` + the Phase-3 UNRELEASED sweep.

- [ ] Prereq: ≥1 `monitored=true` series. Phase 1 needs `metron_user`/`metron_pass`; Phase 2 needs `cv_api_key` + monitored `COMICVINE` series.
- [ ] **Trigger through the Node queue** (scheduled `SERIES_MONITOR`) — the worker calls the engine `/api/monitor/sync` (**synchronous; can take minutes**) then creates requests.
- [ ] Direct engine probe: `curl -X POST http://127.0.0.1:8000/api/monitor/sync` (+ `X-Internal-Secret`) → JSON `{ skeletons_created, metron_fetched, notes:[…], candidates:[…] }`. This does **only** the fetch/skeleton half — no `Request` rows until the Node worker processes the candidates.
- [ ] **Skeletons:** monitored series gain WANTED `Issue` rows for upcoming issues — `SELECT number, status, "releaseDate" FROM "Issue" WHERE "seriesId"='<id>' AND status='WANTED' ORDER BY number;`. Re-running updates `releaseDate` in place (no duplicates).
- [ ] **Requests (Node):** for monitored, not-in-library issues, a `Request` appears (`PENDING` if released, `UNRELEASED` if future) — `SELECT "activeDownloadName", status FROM "Request" WHERE "volumeId"='<metadataId>';`. Released ones enqueue a `SEARCH_AND_DOWNLOAD` (§9).
- [ ] **UNRELEASED upgrade:** an existing `UNRELEASED` request whose skeleton `releaseDate` has passed flips to `PENDING` and triggers a search.
- [ ] JobLog: `SERIES_MONITOR` row `COMPLETED`, message includes `[Phase 1] Metron Oracle fetched N …` + `Final Summary: N calendar entries, N new downloads, N upgrades.`

---

## 13. DDL streaming (engine byte pump)

Partial port: hoster resolution + the Mega SDK path stay in Node; the engine streams plain HTTP(S) URLs.

- [ ] Prereq: a request that resolves to a **non-Mega** DDL — a plain GetComics `comicfiles`/`comic-files` URL, or a hoster (mediafire/pixeldrain/…) that `HosterEngine` resolves to a direct HTTP URL. Drive it through automation/interactive so `downloadDirectFile` runs.
- [ ] **Engine streams it:** during the download `SELECT progress, status FROM "Request" WHERE id='<id>';` shows `progress` climbing (~every 5%); the file lands at the request's filePath (`.part` while in flight, renamed on completion). Engine log: `[Internal DL] Streaming download for request … -> …` then `Engine stream complete`.
- [ ] **Importer hand-off:** on completion the Node caller triggers the importer (file imported into the library).
- [ ] **Mega still in Node:** a `mega.nz` link still downloads via the Node Mega SDK path (engine **not** involved).
- [ ] **Small-file / HTML guard:** a link returning an HTML error page or a <500 KB file → engine aborts (`HTML webpage` / `suspiciously small`), returns `{success:false}`; Node sets the request `STALLED` and fires a `download_failed` alert.
- [ ] **Stall-watchdog:** (hard to force) no bytes for 45 s → engine aborts, deletes the `.part`, `{success:false}` → Node STALL + alert.
- [ ] Direct engine probe: `curl -X POST .../api/download/stream -H "Content-Type: application/json" -H "X-Internal-Secret: <secret>" -d '{"request_id":"t","url":"<direct-cbz-url>","dest_path":"/tmp/test.cbz","ext":"cbz"}'` → `{"success":true,"final_path":…}` and the file exists.

> Note: `/api/monitor/sync` (§12) and `/api/download/stream` both hold the connection open for the entire operation. To stop undici's ~5-min default headers timeout (`UND_ERR_HEADERS_TIMEOUT`) from killing long syncs/large downloads, the Node side calls both via `engineFetchLong()` ([engine.ts](src/lib/engine.ts)) — an undici `Agent` with `headersTimeout`/`bodyTimeout` set to `0` (validated against a delayed server). No action needed; just don't revert those two calls to a plain `fetch`.

---

## Appendix

**Enable all debug logs:** run the engine with `RUST_LOG=debug`. Greppable prefixes: `[Scanner Debug]`, `[Metadata Fetcher Debug]`, `[Metron Debug]`, `[Manga Engine Debug]`, `[Converter Debug]`, `[GetComics Debug]`, `[Prowlarr Debug]`, `[Storage Scan Debug]`, `[Ghost Check Debug]`, `[Integrity Scan Debug]`, `[Backup Debug]`.

**Handy SQL:**
- Recent jobs: `SELECT "jobType", status, "durationMs", LEFT(message,60), "createdAt" FROM "JobLog" ORDER BY "createdAt" DESC LIMIT 20;`
- Match health: `SELECT "matchState", count(*) FROM "Series" GROUP BY "matchState";`
- Rate-limit flags: `SELECT key, value FROM "SystemSetting" WHERE key LIKE '%rate_limit%' OR key='cloudflare_block_time';`

**Top gotchas:**
1. `NEXTAUTH_SECRET` mismatch between engine and Node → backups won't restore.
2. Engine can't see a `filePath`/`folderPath` (wrong mount/path) → scans/converts/embeds silently find nothing.
3. Prisma schema not applied to Postgres → engine queries fail at startup or per-job.
4. AniList/ComicVine/Metron/Prowlarr rate limits on a large first run — pace big scans; check the rate-limit flags above.
