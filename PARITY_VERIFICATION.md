# Omnibus — Node→Rust Parity Verification

Generated 2026-06-05. A verification pass over `omnibus-engine/` (Rust) against the **pristine Node base at git `HEAD` (v1.1.0-beta.016)**, built from 25 agents (12 per-module parity reviewers + adversarial verification of every critical/high finding + 4 cross-cutting passes). This **verifies the "done" claims in `PORTING_AUDIT.md` against the live code** and surfaces new divergences.

**Headline:** the port is structurally sound — most modules are at *substantial* parity, logging parity broadly **passes**, and hot-path regexes are correctly hoisted. But there are **9 confirmed-real high-severity divergences** (every high flagged was verified real — 0 refuted), several of which are **data-integrity or auto-download-quality risks not in the original audit**, and **two operational blockers**: the engine Dockerfile will not build on Linux, and CI never builds/tests the engine.

> Nothing here has been runtime-tested against a live Postgres + real API keys. These are code-level parity findings.

---

## Scorecard

| Module | Verdict | Verified-real highs |
|---|---|---|
| `scanner.rs` | substantial | 2 — phantom new-issue inserts; JobLock dropped |
| `search_engine.rs` | substantial | 1 — Prowlarr word-intersection weakened |
| `metadata.rs` | substantial | 1 — rate-limit no longer halts batch |
| `metadata_writer.rs` | substantial | 0 (unbounded embed I/O — see Parallelism) |
| `watched_sync.rs` | **partial** | 1 — un-ID'd files imported as MATCHED |
| `converter.rs` | substantial | 1 — repack DB-update error swallowed |
| `getcomics.rs` | substantial | 0 (relevance filter relocated; page-2 miss) |
| `prowlarr.rs` | substantial | 0 (annual/variant/peers regressions) |
| `diagnostics.rs` | **partial** | 1 — ghost scan has no drive guard |
| `backup.rs` | substantial | 0 (dir default + datetime round-trip) |
| `manga_detector.rs` | substantial | 0 (scanner-tier only) |
| `main.rs` (seam) | substantial | 1 — detached-task failures not retried |

Cross-cutting: **Logging = PASS** (minor gaps) · **Parallelism = NEEDS WORK** · **CI/Docker = NOT READY** · **Next-ports = roadmap below**

---

## P0 — Blockers (deploy + data integrity)

### Deploy blockers (Goal #6)

- **🔴 CRITICAL: `omnibus-engine/Dockerfile` will fail its first Linux build.** `Cargo.toml:39` declares `reqwest = { version="0.11", features=["json","rustls-tls"] }` *without* `default-features=false`, so reqwest keeps `default-tls` and pulls `native-tls → openssl-sys` (confirmed in `Cargo.lock:1729-1738,2161,2166`). The build stage installs `pkg-config` but **not `libssl-dev`**, so `openssl-sys` fails ("Could not find OpenSSL"). **Fix:** set reqwest to `default-features = false, features = ["json","rustls-tls"]`, `cargo update -p reqwest`, verify `cargo tree -i openssl-sys` is empty. (Or, minimal: add `libssl-dev` to the apt-get.) — `omnibus-engine/Dockerfile:6-8`
- **🟠 CI never builds/tests the Rust engine.** Both workflows (`.github/workflows/test-and-notify.yml:17-35`, `docker-publish.yml:15-28`) are Node-only (`npm ci`/`vitest`/`next build`). The engine's `cargo test` suite runs only on your Windows machine. **Fix:** add a Rust job (`dtolnay/rust-toolchain@stable` + `Swatinem/rust-cache@v2`) running `cargo build --release`, `cargo clippy -- -D warnings`, `cargo test` in `omnibus-engine/`, gated on `omnibus-engine/**`.
- **🟠 Release workflow ships only the Node image; the engine is never built or pushed.** `docker-compose.yml:25` uses `build: ./omnibus-engine`, so **every upgrader compiles the whole Rust tree locally** on `docker compose up`. **Fix:** add a build-push step for `omnibus-engine/Dockerfile` → `ghcr.io/<repo>-engine:<tag>`, and switch compose to `image:` instead of `build:`.
- **🟠 No cargo dependency caching in the Dockerfile** (`omnibus-engine/Dockerfile:10-12`) — `COPY src` precedes `cargo build`, so any source edit recompiles ~300 crates incl. the vendored C builds (unrar/bzip2/webp). **Fix:** cargo-chef or a deps-first layer + BuildKit `--mount=type=cache`.
- **🟠 No Node `web` service in `docker-compose.yml`** — only `db`/`redis`/`engine` (Goal #3/#6). The engine has nothing to serve and `OMNIBUS_ENGINE_URL` is never set on a Node service. **Fix:** add a `web` service (`build: .`), wire `DATABASE_URL`, `OMNIBUS_REDIS_URL`, `NEXTAUTH_SECRET` (shared), `OMNIBUS_ENGINE_URL=http://omnibus-engine:8000`, and share the config/data volumes (uncomment the engine mounts).

### Data-integrity highs (Goal #1, all VERIFIED-REAL)

- **🔴 `diagnostics::run_ghost_check` mutates `status='MISSING'` with no drive-online guard** — an unmounted/disconnected library flips **every** issue to MISSING. The pristine Node UI scan is *read-only*, and the Node background job checks `fs.existsSync` on every `Library.path` and **skips** the ghost pass if any drive is offline. Rust has neither protection. Also: ghost/integrity scans changed from *read-only discovery* to *in-place mutation* with **no `AuditLogger` entry**. — `diagnostics.rs:22-58` ↔ `admin/diagnostics/route.ts:40-58`, `queue.ts@HEAD:1384-1418`
- **🔴 Live `/api/repack` swallows the `filePath` UPDATE error and counts success anyway** — `let _ = sqlx::query(UPDATE "Issue"…).await; success_count += 1;`. Since `process_archive` already deleted the `.cbr` and renamed the `.cbz`, a failed UPDATE leaves the row pointing at a **deleted path** while reporting COMPLETED. (The CBR *sweep* was fixed; the primary repack path was not.) — `main.rs:214-220` ↔ `converter.ts:212-215`
- **🟠 Watched-sync imports un-ID'd (LOCAL) files into the library as MATCHED** instead of routing them to `/unmatched`. Node imports only when `meta.metadataId` is real; a `<Series>`-tagged file with no CV/Metron ID is moved to `/unmatched` for human matching. Rust assigns a **random UUID** `metadataId`, hardcodes `matchState='MATCHED'`, and imports it — polluting the library and suppressing later re-matching. — `watched_sync.rs:118-133,227`
- **🟠 Scanner now inserts NEW issues into already-indexed series (Section 5B) — Node's scanner never did this.** Node only indexes *new* folders; new issues come via the importer/watched-sync. Rust's added path has **no `isSameIssue` dedupe and no unique constraint** (`schema.prisma:177-179` are plain indexes), so a re-path/rename/casing mismatch creates **duplicate Issue rows**. — `scanner.rs:437,453-457,643-691`
- **🟠 `LIBRARY_SCAN` concurrency lock (JobLock) removed** — pristine Node took a `LIBRARY_SCAN_ACTIVE` JobLock with atomic stale-timeout takeover and returned early if held. Neither the forwarder nor `scan_library` re-implements it, so a scheduled + manual scan (or an overlapping long scan) run concurrently — and combined with 5B above, can **race two inserts of the same issue**. — `scanner.rs:276-300` ↔ `library-scanner.ts@HEAD:11-57`

### IP-protection high (Goal #1, VERIFIED-REAL)

- **🟠 `metadata::sync_metadata` no longer halts the batch on rate-limit.** Node `break`s the entire batch (`[HALTED] … to protect IP`) on `FATAL_RATE_LIMIT`/`429`. Rust logs per-series and **continues**, so a Metron `FATAL_RATE_LIMIT` or CV 429 keeps hammering the just-blocked API for every remaining series. — `metadata.rs:48-63` ↔ `queue.ts@HEAD:~943-949`

---

## P1 — Correctness & auto-download quality

### Reliability seam (Goal #1, VERIFIED-REAL)

- **🟠 Detached-task failures are DB-visible but not retried.** All 9 long-running handlers return `202 Accepted` then run in a detached `tokio::spawn`. Node awaits only the 202, so BullMQ marks the job COMPLETED. `write_failed_joblog` (X-6) records a FAILED JobLog, but **BullMQ's `attempts:3` + backoff never fire for the actual work** — they only protect the HTTP handoff. Notifications (`job_metadata_sync`/`job_db_backup`/…) likewise fire on *handoff*, not completion, so users get "complete" alerts even when the job later fails. — `main.rs:138-173,285` ↔ `queue.ts:449-453,626`

### Search / automation regressions (Goal #1)

- **Prowlarr mandatory significant-word intersection not ported** (VERIFIED-REAL) — Node requires *every* significant query word to appear in the title (`prowlarr.ts:142-145`); Rust only enforces the truncated `words_to_enforce`, so loose torrents matching series+number but missing arc/qualifier words can pass and **auto-download**. — `search_engine.rs:357-365`
- **GetComics `search` does zero relevance filtering** (VERIFIED-REAL, downgraded to medium) — filtering was relocated to `filter_and_score`, but it is keyed on `payload.name` (not the matched query), drops the year-preferring sort, and feeds the **distinct-edition STALL count on unfiltered results** (spurious STALLs). — `getcomics.rs:99-111`, `main.rs:357-378`
- **Automation `page-2..5` miss** — because filtering left `getcomics::search`, the loop returns page-1 raw results and never advances; Node paginated until a result *survived filtering*. — `getcomics.rs:97-121`
- **Annual + variant filters now wrongly applied to Prowlarr** — both were GetComics-only in Node; merged into one shared Rust filter with no `is_ddl` gate, so legitimate Prowlarr torrents containing "annual"/"noir"/"variant" are dropped. — `search_engine.rs:308-311,340`
- **`leechers:0` no longer falls back to `peers`** (`Option::or` vs JS `||`) and empty-string `downloadUrl` no longer falls back to `magnetUrl` — affected releases score lower or become un-downloadable. — `prowlarr.rs:128,144`
- **Automation orchestration features dropped** — per-issue `dynamicYear` override, the `failedLinks`/blocklist filter (Rust retry can re-pick a known-bad release), and batch-pack dedupe are not forwarded to the engine. — `queue.ts:294-300` ↔ `automation.ts:64-99,159-165`

### Watched-sync cluster (Goal #1 — module is *partial*)

- ComicVine/Metron **ID tags ignored** and Web-URL ID extracted as a slug, not the `4050-`/`4000-` numeric id → real matches stored as garbage IDs. — `watched_sync.rs:135-147`
- Every imported issue hardcoded **`matchState='MATCHED'`** even with no per-issue ID. — `watched_sync.rs:262-271`
- UPDATE-in-place **clobbers existing credits/name/description** with possibly-empty values (Node preserves non-empty). — `watched_sync.rs:260-268`
- **detectManga waterfall dropped** here (only the Manga tag honored); **`.epub` dropped**; **`{UniverseName}`** never substituted; year ignores `<Volume>` fallback + hardcodes 2025; failed RAR-convert lands RAR bytes in a `.cbz`. — `watched_sync.rs:50,126,129-130,186-206`

### Diagnostics architecture (Goal #1 — module is *partial*)

- **Integrity scan flags missing files as CORRUPTED** and tests `.zip` Node never tested. — `diagnostics.rs:202,212-218`
- **Orphan scan includes `.rar` and skips case-folding** → false orphans (Node uses `/\.(cbz|cbr|zip)$/i` + `toLowerCase`). — `diagnostics.rs:178-197`
- Engine diagnostics endpoints are **unauthenticated** and now mutate state (the Node route enforces ADMIN). — `main.rs:98-101,497,580`

### Backup round-trip (Goal #1)

- **Default backup dir mismatch**: Rust defaults to `/config/backups`, every Node reference defaults to `/backups` — with `OMNIBUS_BACKUPS_DIR` unset, Rust backups land where Node's restore/UI won't look. — `backup.rs:96-102`
- **Datetime round-trip**: `row_to_json` emits offset-less timestamps (`…789`), Node `JSON.stringify(Date)` emits `…789Z`; Prisma upsert on restore may reject/zone-shift these. — `backup.rs:64-67`

> ✅ Crypto envelope is compatible: AES-256-CBC + PKCS7, lowercase-hex salt/iv/data, 20-table superset — a Rust backup *is* decryptable by Node restore (C-1 PBKDF2+salt holds).

### Parallelism — unbounded I/O (Goal #5)

- **6 hot paths fan out one `spawn_blocking` per DB row with no semaphore** (tokio default `max_blocking_threads=512`): `run_ghost_check`, `run_storage_scan`, `run_integrity_scan` (`diagnostics.rs:32,86,210`), `process_embed_job` (`metadata_writer.rs:89`), watched-sync Phase 1 (`watched_sync.rs:66`), and `handle_repack` is both unbounded *and* fully sequential across archives (`main.rs:191-227`). On a large library this thrashes disk and balloons RAM. The model to copy already exists: `scanner.rs:477` and `converter.rs:146` bound by a CPU-sized `Semaphore`; `process_archive` uses rayon. ✅ P-3 is clean — no regexes recompiled in hot loops.

---

## P2 — Polish (condensed)

- **Logging (Goal #4 — PASS):** `env_logger` defaults to `info` and honors `RUST_LOG` (`main.rs:72`); all `[X Debug]` families restored (25 `debug!` across 9 modules); `success→info!` mapped. Gaps: `watched_sync.rs` has **no `[Watched Sync Debug]` traces**; `watched_sync.rs:225` series-upsert and `main.rs:214` repack-UPDATE and `metadata.rs:322,616` Ended-UPDATE **swallow errors but log success anyway** (fix the swallow → the info line then tells the truth); `convert_cbr_to_cbz` fast path emits no logs.
- **Scanner mediums/lows:** drive-guard is now per-library (lost Node's global "any drive down → abort all"); 3rd-tier manga detection feeds publisher where Node passed none (western-published untagged files mis-classified).
- **metadata lows:** `logApiUsage` telemetry **not implemented** (dashboard API-quota view goes stale); Metron 429 doesn't set `metron_rate_limit_time`; Metron `universe` not written; inline embed loses the 5-min debounce/dedupe.
- **Env (Goal #3 — from the earlier sweep):** the only real hardcoded-host fallback is `main.rs:75-79` (engine silently defaults to a localhost Postgres URL + misleading warn) — should fail fast like Node/Prisma. Engine URL/Redis/DB are otherwise correctly env-driven. Add a `.env.example` (mind the `.env*` gitignore).

---

## Goal-by-goal verdict

| # | Goal | Verdict |
|---|---|---|
| 1 | 1:1 parity | **Substantial, with 9 verified-real highs** to close before "1:1". Most audit "done" claims hold; several `not_implemented`/`partial` contradict the audit text (peers fallback, annual filter, `logApiUsage`, diagnostics empty-path/casefold/missing≠corrupt). |
| 2 | Further ports | Clear roadmap (below). Do-next: delete dead Node storage walk (S), `DISCOVER_SYNC` (L). |
| 3 | Env / no hardcoded hosts | **Done** — engine URL, Postgres (`DATABASE_URL`), Redis all env-driven; one fail-fast fix + compose hygiene + `.env.example`. |
| 4 | Logging parity | **PASS** with minor gaps (above). |
| 5 | Parallelism + Settings controls | Bounding fixes needed (6 paths); **full Settings concurrency design below**. |
| 6 | CI / Docker | **NOT READY** — Dockerfile won't build on Linux; CI doesn't build/test/ship the engine. |

---

## Goal #5 — Settings-driven concurrency design

Store knobs in the `SystemSetting` table (Node UI writes via `admin/config/route.ts`; engine reads at startup into an `EngineConfig::load`). Replace `available_parallelism()` calls and the bare `#[tokio::main]` with configured values; clamp every value to a safe range.

| Setting key | Controls | Default | Apply at |
|---|---|---|---|
| `engine_max_scan_workers` | scanner + 3 diagnostics file-probe concurrency | logical cores | `scanner.rs:477`, `diagnostics.rs:26/72/203` |
| `engine_max_convert_workers` | CBR sweep, bulk repack, watched convert, embed ZIP rewrites | `max(1, cores/2)` | `converter.rs:146`, `main.rs` repack, `watched_sync.rs:63`, `metadata_writer.rs:87` |
| `engine_cpu_cap` | global tokio `worker_threads` + rayon pool | cores | replace `#[tokio::main]` with manual runtime + `rayon::ThreadPoolBuilder…build_global()` |
| `engine_max_blocking_threads` | tokio blocking-pool ceiling (backstop) | 64 (down from 512) | runtime builder `.max_blocking_threads()` |
| `engine_memory_ceiling_mb` | soft cap → derates worker counts (`min(workers, ceiling/per_task_budget)`) | 0 = off | `EngineConfig::load` |

Each unbounded `spawn_blocking` site gets the `scanner.rs:484-489` pattern: `Arc<Semaphore>` → `spawn(async { let _p = sem.acquire_owned().await; spawn_blocking(probe).await })`.

---

## Goal #2 — Next-ports roadmap

| Rank | Candidate | Decision | Effort | Notes |
|---|---|---|---|---|
| 1 | `runStorageScan`/`getFolderSize` | **Port (delete)** | S | Rust path exists; Node walk still runs inline in `LIBRARY_SCAN` (`queue.ts:582`). Forward to `/api/diagnostics/storage`, delete the walk. |
| 2 | `DISCOVER_SYNC` (`queue.ts:1080-1352`) | **Port** | L | Pure fetch→filter→cache; Rust already has CV+Metron clients + rate-limiter. Cleanest standalone. |
| 3 | `SERIES_MONITOR` (`queue.ts:672-1016`) | **Partial** | L | Port the Metron(3000)+CV(25) fetch/match/skeleton-upsert; keep request-creation + `searchAndDownload` in Node. |
| 4 | DDL streaming (`download-clients.ts:167-372`) | **Partial** | M | Port reqwest stream + 45s stall-watchdog + progress; keep hoster resolvers + alerts in Node. |
| 5 | Batch importer (`importer.ts`) | **Keep / defer** | L+ | Most entangled function; highest regression risk. Do last. |
| — | health-check, cache-cleanup, update-check, weekly-digest | **Keep in Node** | — | Light; cache-cleanup touches Node-process memory; all end in alerts/mail. |

**Prerequisite that gates 3 & 4:** the **Rust engine has no notification capability** (0 `sendAlert`). Simplest unblock — a Node-side `POST /api/internal/notify` the engine calls (reuses `SystemNotifier`) rather than reimplementing `discord.ts`/mailer.

---

## How these map to `PORTING_AUDIT.md`

The audit's Phases 0–3 largely **hold up** — crypto, ComicInfo read, issue-number year-skip, scoring model, full ~21-tag embed, Metron fetch, scanner parallelism, and logging all verified present. The new findings are mostly **second-order**: behaviors the port *added* (5B issue inserts, ghost mutation, annual/variant on Prowlarr), Node safety nets *not re-created* across the new HTTP seam (JobLock, drive guard, batch rate-limit halt, BullMQ retry), and a few audit "done" lines that the live code only *partially* satisfies (peers fallback, `logApiUsage`, diagnostics edge cases).
