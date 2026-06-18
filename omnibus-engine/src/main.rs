mod converter;
mod scanner;
mod metadata;
mod prowlarr;
mod search_engine;
mod getcomics;
mod rate_limiter;
mod metadata_writer;
mod watched_sync;
mod backup;
mod diagnostics;
mod manga_detector;
mod engine_config;
mod discover;
mod monitor;
mod download;
mod log_forward;
mod secret_crypto;

use axum::{routing::{get, post}, Router, Json, extract::{State, Request}, http::StatusCode, middleware::{self, Next}, response::Response};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::sync::{Arc, OnceLock};

/// Process-wide reqwest clients, built once and reused. Rebuilding a `Client` per request re-creates
/// the TLS config, DNS cache, and connection pool every time; sharing one keeps HTTP keep-alive alive
/// across calls to the same host. `reqwest::Client` is `Arc`-backed, so `.clone()` is cheap and shares
/// the underlying pool. `browser_http_client` carries a browser User-Agent (GetComics/Cloudflare).
pub(crate) fn shared_http_client() -> reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().build().expect("build shared reqwest client"))
        .clone()
}

pub(crate) fn browser_http_client() -> reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .build()
            .expect("build browser reqwest client")
    })
    .clone()
}

#[derive(Deserialize)]
struct RepackRequest {
    series_ids: Vec<String>,
}

#[derive(Deserialize)]
struct ScanRequest {
    library_id: String,
    library_path: String,
    // Targeted scan (beta.024): crawl only this subtree and skip the global ghost cleanup.
    #[serde(default)]
    specific_path: Option<String>,
}

#[derive(Deserialize)]
struct MetadataRequest {
    series_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct CbrSweepRequest {
    #[serde(default)]
    issue_id: Option<String>,
}

#[derive(Deserialize)]
struct AutomationRequest {
    request_id: String,
    name: String,
    year: Option<String>,
    is_manga: Option<bool>,
    skip_indexers: Option<bool>,
    // Blocklist of previously-failed releases (title / download URL / GUID / info-hash) to skip
    // (parity with automation.ts failedItems, forwarded from the Request's failedLinks).
    #[serde(default)]
    failed_links: Option<Vec<String>>,
    // Pack isolation (beta.035): true when the matched series has ZERO downloaded issues, so bulk
    // packs are worth grabbing; false suppresses packs even when globally enabled. Computed by
    // queue.ts alongside the dynamic-year lookup (parity with automation.ts allowPacksForThisRequest).
    #[serde(default)]
    allow_packs: Option<bool>,
    // The ORIGINAL series year (pack queries search against this; `year` is the dynamic,
    // possibly issue-release-overridden year used for issue queries).
    #[serde(default)]
    series_year: Option<String>,
}

#[derive(Deserialize)]
struct InteractiveSearchQuery {
    query: String,
    year: Option<String>,
    is_manga: Option<bool>,
}

#[derive(Serialize)]
struct SearchResponse {
    success: bool,
    best_match: Option<prowlarr::ProwlarrResult>,
    stall_for_review: bool,
    // A GetComics match was found but resolved to no enabled hoster, and no indexer release was
    // available either: the link is held for human pickup (parity with automation.ts MANUAL_DDL).
    #[serde(skip_serializing_if = "Option::is_none")]
    manual_ddl: Option<ManualDdl>,
    // Ranked DDL links for the matched GetComics article (one per hoster, best first). Node tries them
    // in order at download time, falling back to the next hoster if one fails. Empty for torrents/usenet.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    ddl_candidates: Vec<DdlCandidate>,
}

#[derive(Serialize)]
struct ManualDdl {
    url: String,
    name: String,
}

#[derive(Serialize)]
struct DdlCandidate {
    url: String,
    hoster: String,
}

#[derive(Serialize)]
struct InteractiveResponse {
    prowlarr: Vec<prowlarr::ProwlarrResult>,
    getcomics: Vec<prowlarr::ProwlarrResult>,
}

struct AppState {
    db: PgPool,
    limiter: Arc<rate_limiter::RateLimiter>,
    // Shared secret (Node's NEXTAUTH_SECRET) required in the X-Internal-Secret header on every
    // request. `None` when unset → endpoints are open (dev/localhost); a startup warning is logged.
    internal_secret: Option<String>,
}

/// Known throwaway secrets shipped in the example compose files. Treated as "no secret configured"
/// so a deployer who never overrode them cannot run with a value that is public in the repo.
fn is_placeholder_secret(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    l.contains("change_me") || l.contains("change_this")
}

/// True when the engine's bind address is reachable beyond the local host (0.0.0.0, ::, or a LAN
/// IP). Loopback (127.0.0.1 / ::1 / localhost) is treated as host-only.
fn is_network_exposed(bind_addr: &str) -> bool {
    let host = bind_addr.rsplit_once(':').map(|(h, _)| h).unwrap_or(bind_addr);
    let host = host.trim_start_matches('[').trim_end_matches(']');
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => !ip.is_loopback(),
        Err(_) => !host.eq_ignore_ascii_case("localhost"),
    }
}

/// Constant-time comparison of the internal-auth secret, so a match position can't be inferred from
/// response timing. (Length mismatch short-circuits — acceptable for a fixed-length secret.)
fn secrets_match(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod auth_tests {
    use super::*;

    #[test]
    fn placeholder_secrets_are_rejected() {
        assert!(is_placeholder_secret("change_me_to_a_long_random_string"));
        assert!(is_placeholder_secret("change_this_to_a_random_secure_string_123!"));
        assert!(is_placeholder_secret("CHANGE_ME")); // case-insensitive
        assert!(is_placeholder_secret("prefix_change_this_suffix"));
        assert!(!is_placeholder_secret("a-genuinely-random-48-char-secret-xyz123"));
        assert!(!is_placeholder_secret(""));
    }

    #[test]
    fn network_exposure_detects_non_loopback_binds() {
        // Loopback / host-only — safe to run without a secret.
        assert!(!is_network_exposed("127.0.0.1:8000"));
        assert!(!is_network_exposed("[::1]:8000"));
        assert!(!is_network_exposed("localhost:8000"));
        // Reachable off-host — must have a real secret (engine fails closed otherwise).
        assert!(is_network_exposed("0.0.0.0:8000"));
        assert!(is_network_exposed("[::]:8000"));
        assert!(is_network_exposed("192.168.1.50:8000"));
        assert!(is_network_exposed("10.0.0.5:8000"));
    }

    #[test]
    fn secret_compare_is_exact_and_length_safe() {
        assert!(secrets_match("hunter2hunter2hunter2", "hunter2hunter2hunter2"));
        assert!(!secrets_match("hunter2", "hunter3"));
        assert!(!secrets_match("short", "longer-value")); // differing lengths must not panic
        assert!(secrets_match("", ""));
        assert!(!secrets_match("x", ""));
    }
}

#[cfg(test)]
mod version_tests {
    use super::*;

    #[test]
    fn resolve_version_prefers_baked_file_else_dev() {
        // A real baked version is reported as a release.
        assert_eq!(resolve_version(Some("1.1.0-beta.041".into())), ("1.1.0-beta.041".to_string(), true));
        // Trailing whitespace/newline from the build-time write is trimmed.
        assert_eq!(resolve_version(Some("1.1.0-beta.041\n".into())), ("1.1.0-beta.041".to_string(), true));
        // Blank or missing file -> crate version, flagged as a dev build so drift detection is skipped.
        assert!(!resolve_version(Some(String::new())).1);
        assert!(!resolve_version(Some("  \n".into())).1);
        assert!(!resolve_version(None).1);
    }
}

/// Authenticates Node→engine calls with the shared NEXTAUTH_SECRET (X-Internal-Secret header),
/// mirroring Node's /api/internal/notify guard in reverse. The engine refuses to START without a
/// real secret when bound to a non-loopback address (see `run`), so this skip path only applies to a
/// loopback-only dev bind, where the endpoints aren't reachable off-host anyway.
async fn require_internal_auth(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if let Some(secret) = &state.internal_secret {
        let ok = req.headers()
            .get("x-internal-secret")
            .and_then(|v| v.to_str().ok())
            .map(|p| secrets_match(p, secret))
            .unwrap_or(false);
        if !ok {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }
    Ok(next.run(req).await)
}

fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    // Installs the global logger: prints to stdout as before AND mirrors lines to the Node app's
    // unified logger (drained by a task spawned in `run`). RUST_LOG still controls verbosity.
    log_forward::init();

    // Fail fast on a missing/empty DATABASE_URL (parity with Node/Prisma's `env("DATABASE_URL")`,
    // which refuses to start). Silently falling back to a hardcoded localhost DB would mask a
    // misconfiguration and risk connecting to (or creating) an unintended database.
    let db_url = match std::env::var("DATABASE_URL") {
        Ok(url) if !url.trim().is_empty() => url,
        _ => {
            log::error!(
                "DATABASE_URL is not set. Provide it via the environment or a .env file \
                 (e.g. postgresql://user:pass@host:5432/omnibus?schema=public). Refusing to start."
            );
            anyhow::bail!("DATABASE_URL must be set");
        }
    };

    // Pre-flight: read the runtime concurrency knobs (cpu_cap, blocking_threads) BEFORE building the
    // real runtime — worker_threads / max_blocking_threads can only be set at construction time.
    let cfg = {
        let boot = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        boot.block_on(async {
            match PgPoolOptions::new().max_connections(1).connect(&db_url).await {
                Ok(pool) => {
                    let c = engine_config::EngineConfig::load(&pool).await;
                    pool.close().await;
                    c
                }
                Err(e) => {
                    log::warn!("[Config] Preflight DB read failed ({}); using default concurrency limits.", e);
                    engine_config::EngineConfig::defaults()
                }
            }
        })
    };

    log::info!(
        "[Config] Concurrency limits → cpu_cap={} blocking_threads={} scan_workers={} convert_workers={} db_connections={} memory_ceiling_mb={}",
        cfg.cpu_cap, cfg.blocking_threads, cfg.scan_workers, cfg.convert_workers, cfg.db_connections, cfg.memory_ceiling_mb
    );

    // Size rayon's global pool (used for per-page WebP encoding in the converter) to the CPU cap.
    if let Err(e) = rayon::ThreadPoolBuilder::new().num_threads(cfg.cpu_cap).build_global() {
        log::warn!("[Config] Could not set the rayon global pool size: {}", e);
    }

    // Build the real multi-threaded runtime with the configured CPU + blocking-pool caps.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(cfg.cpu_cap)
        .max_blocking_threads(cfg.blocking_threads)
        .enable_all()
        .build()?;

    runtime.block_on(run(db_url, cfg.db_connections))
}

/// Connects to Postgres, retrying with backoff for up to ~90s before giving up. The engine and DB
/// often share a Docker bridge whose ports take time to start forwarding (e.g. STP forward-delay on
/// a QNAP virtual switch adds a ~15-30s dead window when a container's interface first joins), and
/// the DB container may still be starting. Without this, the process would exit on the first failure
/// and `restart: always` would reset the bridge port — a loop that can never outlast the window.
async fn connect_with_retry(db_url: &str, max_connections: u32) -> anyhow::Result<PgPool> {
    const MAX_ATTEMPTS: u32 = 30;
    const DELAY_SECS: u64 = 3;
    let mut attempt = 1;
    loop {
        log::info!("Connecting to PostgreSQL database (attempt {}/{})...", attempt, MAX_ATTEMPTS);
        match PgPoolOptions::new().max_connections(max_connections).connect(db_url).await {
            Ok(pool) => return Ok(pool),
            Err(e) if attempt < MAX_ATTEMPTS => {
                log::warn!(
                    "Database not reachable yet ({}); retrying in {}s (attempt {}/{}).",
                    e, DELAY_SECS, attempt, MAX_ATTEMPTS
                );
                tokio::time::sleep(std::time::Duration::from_secs(DELAY_SECS)).await;
                attempt += 1;
            }
            Err(e) => {
                log::error!("Database unreachable after {} attempts (~{}s). Giving up.", MAX_ATTEMPTS, MAX_ATTEMPTS as u64 * DELAY_SECS);
                return Err(e.into());
            }
        }
    }
}

/// Async entrypoint. The runtime is built manually in `main` so its size honors EngineConfig.
async fn run(db_url: String, db_connections: u32) -> anyhow::Result<()> {
    // Start draining buffered log lines to the Node app now that the runtime exists. Any lines
    // emitted during startup (preflight, the DB-connect retries below) were buffered and flush here.
    log_forward::spawn_forwarder();

    let pool = connect_with_retry(&db_url, db_connections).await?;

    log::info!("✅ Connected to PostgreSQL!");

    let limiter = Arc::new(rate_limiter::RateLimiter::new());

    // Resolve the bind address up front: whether a missing auth secret is tolerable depends on
    // whether the engine is reachable off-host.
    let bind_addr =
        std::env::var("OMNIBUS_ENGINE_BIND").unwrap_or_else(|_| "127.0.0.1:8000".to_string());

    // Treat empty AND the shipped placeholder values as "unset", so a copy-pasted compose file can't
    // silently authenticate every request with a token that is public in the repo.
    let internal_secret = std::env::var("NEXTAUTH_SECRET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && !is_placeholder_secret(s));

    if internal_secret.is_none() {
        if is_network_exposed(&bind_addr) {
            // Fail closed: never serve the DB-/filesystem-mutating endpoints unauthenticated on an
            // interface other devices can reach.
            log::error!(
                "NEXTAUTH_SECRET is unset or still a placeholder, but the engine is bound to a \
                 non-loopback address ({bind_addr}). Refusing to start unauthenticated and \
                 network-exposed — set NEXTAUTH_SECRET to the same value as the Node app."
            );
            anyhow::bail!("NEXTAUTH_SECRET must be set when OMNIBUS_ENGINE_BIND is not loopback");
        }
        log::warn!(
            "NEXTAUTH_SECRET is not set — engine HTTP endpoints are UNAUTHENTICATED, but the bind \
             address ({bind_addr}) is loopback-only, so they are not reachable off-host (dev/single-host)."
        );
    }
    let shared_state = Arc::new(AppState { db: pool, limiter, internal_secret });

    let api = Router::new()
        .route("/api/repack", post(handle_repack))
        .route("/api/scan", post(handle_scan))
        .route("/api/converter/cbr-sweep", post(handle_cbr_sweep))
        .route("/api/watched-sync", post(handle_watched_sync))
        .route("/api/backup", post(handle_backup))
        .route("/api/diagnostics/ghosts", post(handle_ghost_check))
        .route("/api/diagnostics/storage", post(handle_storage_scan))
        .route("/api/diagnostics/orphans", post(handle_orphan_scan))
        .route("/api/diagnostics/integrity", post(handle_integrity_scan))
        .route("/api/metadata/sync", post(handle_metadata_sync))
        .route("/api/metadata/embed", post(handle_metadata_embed))
        .route("/api/metadata/export-series-json", post(handle_export_series_json))
        .route("/api/discover/sync", post(handle_discover_sync))
        .route("/api/monitor/sync", post(handle_monitor_sync))
        .route("/api/download/stream", post(handle_download_stream))
        .route("/api/automation/search", post(handle_search))
        .route("/api/search/interactive", post(handle_interactive_search))
        .layer(middleware::from_fn_with_state(shared_state.clone(), require_internal_auth))
        .with_state(shared_state);

    // /health is intentionally UNAUTHENTICATED (liveness + version report): the Node app reads the
    // running engine version from it for web/engine drift detection, and a container healthcheck can
    // hit it without the shared secret.
    let app = Router::new()
        .route("/health", get(handle_health))
        .merge(api);

    // bind_addr was resolved above (OMNIBUS_ENGINE_BIND; 0.0.0.0 inside a container).
    let listener = tokio::net::TcpListener::bind(&bind_addr).await.unwrap();
    log::info!("🚀 Omnibus Engine listening on http://{}", bind_addr);
    axum::serve(listener, app).await.unwrap();

    Ok(())
}

/// Path of the release-version marker baked into the image at build time. A FILE — not a runtime env —
/// is used deliberately: container platforms like QNAP Container Station materialize an image's `ENV`
/// vars into the container definition and then freeze them, silently pinning a stale version across
/// image updates. A baked file can't be overridden that way, so the engine always reports the version
/// it was actually built with.
const VERSION_FILE: &str = "/etc/omnibus-version";

/// Resolves the reported (version, is_release) from the baked version file's contents. A present,
/// non-blank value is a real release; missing/blank (a local `cargo run`, or an image built without the
/// build-arg) falls back to the crate version, flagged as a dev build so the Node health check skips the
/// drift warning.
fn resolve_version(baked: Option<String>) -> (String, bool) {
    match baked.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(v) => (v.to_string(), true),
        None => (env!("CARGO_PKG_VERSION").to_string(), false),
    }
}

/// Unauthenticated liveness + version endpoint. The release version is baked into the image at build
/// time (CI writes the package.json version to `/etc/omnibus-version` via the OMNIBUS_VERSION
/// build-arg); the Node health check reads it for web/engine drift detection.
async fn handle_health() -> Json<serde_json::Value> {
    let (version, release) = resolve_version(std::fs::read_to_string(VERSION_FILE).ok());
    Json(serde_json::json!({
        "status": "ok",
        "version": version,
        "release": release,
    }))
}

/// Records a FAILED JobLog so a background-task failure is DB-visible (BullMQ already got its 202,
/// so without this the failure would only appear in the Rust logs and silently vanish from the UI).
async fn write_failed_joblog(db: &PgPool, job_type: &str, duration_ms: i32, message: String) {
    if let Err(e) = sqlx::query(
        r#"INSERT INTO "JobLog" (id, "jobType", status, "durationMs", message, "createdAt", attempts)
           VALUES ($1, $2, 'FAILED', $3, $4, NOW(), 1)"#,
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(job_type)
    .bind(duration_ms)
    .bind(message)
    .execute(db)
    .await
    {
        log::error!("Failed to write FAILED JobLog for {}: {:?}", job_type, e);
    }
}

/// Best-effort callback to the Node app so a detached job's user-facing notification fires on actual
/// COMPLETION, not at the 202 handoff (the BullMQ worker only awaits the 202). Reuses NEXTAUTH_SECRET
/// as a shared internal auth token (verified by Node's /api/internal/notify route). Never fatal.
async fn notify_node(event: &str, description: &str) {
    let secret = std::env::var("NEXTAUTH_SECRET").unwrap_or_default();
    if secret.is_empty() {
        log::debug!("[Notify] NEXTAUTH_SECRET unset; skipping completion notification '{}'.", event);
        return;
    }
    let node_url = std::env::var("OMNIBUS_NODE_URL").unwrap_or_else(|_| "http://localhost:3000".to_string());
    let url = format!("{}/api/internal/notify", node_url.trim_end_matches('/'));
    let body = serde_json::json!({ "event": event, "payload": { "description": description } });
    match shared_http_client()
        .post(&url)
        .header("X-Internal-Secret", &secret)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) if !resp.status().is_success() => {
            log::warn!("[Notify] Node /api/internal/notify returned {} for '{}'.", resp.status(), event);
        }
        Err(e) => log::warn!("[Notify] Could not reach Node for completion notification '{}': {}", event, e),
        _ => {}
    }
}

async fn handle_cbr_sweep(
    State(state): State<Arc<AppState>>,
    payload: Option<Json<CbrSweepRequest>>,
) -> StatusCode {
    // An optional issue_id converts just that issue (beta.034 targeted conversion); no body = full sweep.
    let issue_id = payload.and_then(|Json(p)| p.issue_id);
    match &issue_id {
        Some(id) => log::info!("Received request to run targeted CBR conversion for issue {}.", id),
        None => log::info!("Received request to run CBR Conversion Sweep."),
    }

    tokio::spawn(async move {
        let db = state.db.clone();
        let start_time = std::time::Instant::now();

        match converter::process_cbr_sweep(db.clone(), issue_id).await {
            Ok((success, fail, details)) => {
                let duration = start_time.elapsed().as_millis() as i32;
                let status = if fail > 0 { "COMPLETED_WITH_ERRORS" } else { "COMPLETED" };
                
                let msg = if success == 0 && fail == 0 {
                    "No CBR files found to convert.".to_string()
                } else {
                    format!("{}\nSummary: {} Converted, {} Failed.", details, success, fail)
                };
                
                log::info!("{}", msg);

                let _ = sqlx::query(
                    r#"INSERT INTO "JobLog" (id, "jobType", status, "durationMs", message, "createdAt", attempts)
                       VALUES ($1, 'CBR_CONVERTER', $2, $3, $4, NOW(), 1)"#
                )
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(status)
                .bind(duration)
                .bind(msg)
                .execute(&db).await;
            },
            Err(e) => {
                log::error!("❌ Background CBR Sweep failed: {:?}", e);
                write_failed_joblog(&db, "CBR_CONVERTER", start_time.elapsed().as_millis() as i32, format!("CBR sweep failed: {:?}", e)).await;
            },
        }
    });

    StatusCode::ACCEPTED
}

async fn handle_repack(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RepackRequest>,
) -> StatusCode {
    log::info!("Received bulk repack job for {} series", payload.series_ids.len());

    tokio::spawn(async move {
        let db = state.db.clone();
        let start_time = std::time::Instant::now();
        let mut success_count = 0;
        let mut fail_count = 0;

        // Honor the user's WebP settings instead of hardcoding (parity with converter.ts).
        let (convert_to_webp, webp_quality) = converter::get_webp_settings(&db).await;
        log::info!("[Repack] WebP conversion: {} (quality {})", convert_to_webp, webp_quality);

        // Collect every issue across all requested series, then process them through one bounded pool.
        // This fixes the previously strictly-sequential repack (P-2) without going unbounded (P-1).
        let mut targets: Vec<(String, String)> = Vec::new();
        for series_id in &payload.series_ids {
            let issues = sqlx::query(r#"SELECT id, "filePath" FROM "Issue" WHERE "seriesId" = $1 AND "filePath" IS NOT NULL"#)
                .bind(series_id)
                .fetch_all(&db)
                .await
                .unwrap_or_default();
            for issue in issues {
                targets.push((issue.get("id"), issue.get("filePath")));
            }
        }
        log::info!("[Repack] Processing {} archives across {} series.", targets.len(), payload.series_ids.len());

        let cfg = engine_config::EngineConfig::load(&db).await;
        let sem = Arc::new(tokio::sync::Semaphore::new(cfg.convert_workers));
        let mut join_set = tokio::task::JoinSet::new();
        for (issue_id, file_path) in targets {
            let sem = sem.clone();
            join_set.spawn(async move {
                let _permit = sem.acquire_owned().await.ok();
                let path = PathBuf::from(&file_path);
                let result = tokio::task::spawn_blocking(move || converter::process_archive(&path, convert_to_webp, webp_quality)).await;
                (issue_id, file_path, result)
            });
        }

        while let Some(res) = join_set.join_next().await {
            let (issue_id, file_path, result) = match res {
                Ok(t) => t,
                Err(e) => { log::error!("[Repack] task join error: {:?}", e); fail_count += 1; continue; }
            };
            match result {
                Ok(Ok(new_path)) => {
                    let new_path_str = new_path.to_string_lossy().to_string();
                    let mut db_ok = true;
                    if new_path_str != file_path {
                        // process_archive already deleted the original and renamed the .cbz, so a failed
                        // UPDATE would orphan the Issue row pointing at a now-deleted path — surface it.
                        if let Err(e) = sqlx::query(r#"UPDATE "Issue" SET "filePath" = $1 WHERE id = $2"#)
                            .bind(new_path_str)
                            .bind(&issue_id)
                            .execute(&db)
                            .await
                        {
                            log::error!("[Repack] Repacked {} on disk but failed to update its database path: {:?}", file_path, e);
                            db_ok = false;
                        }
                    }
                    if db_ok { success_count += 1; } else { fail_count += 1; }
                }
                Ok(Err(e)) => { log::error!("Failed to repack {}: {:?}", file_path, e); fail_count += 1; }
                Err(e) => { log::error!("[Repack] conversion task panicked for {}: {:?}", file_path, e); fail_count += 1; }
            }
        }

        let duration_ms = start_time.elapsed().as_millis() as i32;
        let status = if fail_count > 0 { "COMPLETED_WITH_ERRORS" } else { "COMPLETED" };
        let message = format!("Internal repack complete. Processed {} archives successfully. Failed: {}.", success_count, fail_count);
        let log_id = uuid::Uuid::new_v4().to_string();

        let _ = sqlx::query(
            r#"INSERT INTO "JobLog" (id, "jobType", status, "durationMs", message, "createdAt", attempts)
               VALUES ($1, 'REPACK_ARCHIVES', $2, $3, $4, NOW(), 1)"#
        )
        .bind(log_id)
        .bind(status)
        .bind(duration_ms)
        .bind(message.clone())
        .execute(&db)
        .await;

        log::info!("Job complete: {}", message);
    });

    StatusCode::ACCEPTED
}

async fn handle_scan(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ScanRequest>,
) -> StatusCode {
    log::info!("Received library scan request for path: {}", payload.library_path);

    tokio::spawn(async move {
        let db = state.db.clone();
        let lock_id = format!("LIBRARY_SCAN_{}", payload.library_id);

        // Concurrency lock (parity with the pristine Node JobLock): refuse to start a second scan of the
        // SAME library while one is active, so overlapping scheduled+manual triggers can't race two
        // inserts of the same issue. Per-library so different libraries still scan concurrently. A stale
        // lock (>10 min, e.g. from a crashed scan) is atomically taken over.
        match sqlx::query(
            r#"INSERT INTO "JobLock" (id, "lockedAt") VALUES ($1, NOW())
               ON CONFLICT (id) DO UPDATE SET "lockedAt" = NOW()
               WHERE "JobLock"."lockedAt" < NOW() - INTERVAL '10 minutes'"#,
        )
        .bind(&lock_id)
        .execute(&db)
        .await
        {
            Ok(r) if r.rows_affected() == 0 => {
                log::warn!("[Scanner] Library scan for '{}' already in progress; skipping.", payload.library_path);
                return;
            }
            Err(e) => log::warn!("[Scanner] Non-fatal JobLock error, proceeding without lock: {:?}", e),
            _ => {}
        }

        let start_time = std::time::Instant::now();
        if let Err(e) = scanner::scan_library(db.clone(), payload.library_path, payload.library_id.clone(), payload.specific_path).await {
            log::error!("❌ Library scan failed: {:?}", e);
            write_failed_joblog(&db, "LIBRARY_SCAN", start_time.elapsed().as_millis() as i32, format!("Library scan failed: {:?}", e)).await;
        }

        // Release the lock (best-effort; the 10-min stale takeover covers a missed release on panic).
        let _ = sqlx::query(r#"DELETE FROM "JobLock" WHERE id = $1"#).bind(&lock_id).execute(&db).await;
    });

    StatusCode::ACCEPTED
}

async fn handle_metadata_sync(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<MetadataRequest>,
) -> StatusCode {
    log::info!("Received request to route metadata synchronization to background threads.");

    tokio::spawn(async move {
        let db = state.db.clone();
        let start_time = std::time::Instant::now();
        match metadata::sync_metadata(db.clone(), payload.series_ids).await {
            Ok(_) => notify_node("job_metadata_sync", "Metadata synchronization completed.").await,
            Err(e) => {
                log::error!("❌ Background Metadata Synchronization failed: {:?}", e);
                write_failed_joblog(&db, "METADATA_SYNC", start_time.elapsed().as_millis() as i32, format!("Metadata sync failed: {:?}", e)).await;
                notify_node("job_metadata_sync", "Metadata synchronization failed. Check the engine logs.").await;
            }
        }
    });

    StatusCode::ACCEPTED
}

async fn handle_metadata_embed(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<metadata_writer::EmbedRequest>,
) -> StatusCode {
    log::info!("Received request to embed metadata into archives.");

    tokio::spawn(async move {
        let db = state.db.clone();
        let start_time = std::time::Instant::now();

        match metadata_writer::process_embed_job(db.clone(), payload).await {
            Ok((success, fail, json_count)) => {
                let duration = start_time.elapsed().as_millis() as i32;
                let status = if fail > 0 { "COMPLETED_WITH_ERRORS" } else { "COMPLETED" };
                let msg = format!("Metadata embedding complete. Updated {} files. Failed: {}. Exported {} series.json files.", success, fail, json_count);
                
                log::info!("{}", msg);

                let _ = sqlx::query(
                    r#"INSERT INTO "JobLog" (id, "jobType", status, "durationMs", message, "createdAt", attempts)
                       VALUES ($1, 'EMBED_METADATA', $2, $3, $4, NOW(), 1)"#
                )
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(status)
                .bind(duration)
                .bind(msg)
                .execute(&db).await;
            },
            Err(e) => {
                log::error!("❌ Background Metadata Embedding failed: {:?}", e);
                write_failed_joblog(&db, "EMBED_METADATA", start_time.elapsed().as_millis() as i32, format!("Metadata embedding failed: {:?}", e)).await;
            },
        }
    });

    StatusCode::ACCEPTED
}

#[derive(serde::Deserialize)]
struct ExportSeriesJsonRequest {
    series_ids: Option<Vec<String>>,
}

/// Standalone Mylar series.json export (the Node EXPORT_SERIES_JSON job forwards here).
/// Synchronous — file writes only, fast — so Node can log the counts in its own JobLog.
async fn handle_export_series_json(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ExportSeriesJsonRequest>,
) -> Json<serde_json::Value> {
    log::info!("Received request to export Mylar series.json files.");
    let (exported, total) = metadata_writer::run_series_json_export(&state.db, payload.series_ids).await;
    log::info!("series.json export complete. Wrote {} of {} series folders.", exported, total);
    Json(serde_json::json!({ "exported": exported, "total": total }))
}

async fn handle_search(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<AutomationRequest>,
) -> Json<SearchResponse> {
    log::info!("Received automation search request for: {} (request {})", payload.name, payload.request_id);

    let is_manga = payload.is_manga.unwrap_or(false);
    let skip_indexers = payload.skip_indexers.unwrap_or(false);
    let req_year = payload.year.clone();
    // The original series year (pack queries search against it); fall back to the dynamic year.
    let series_year = payload.series_year.clone().or_else(|| req_year.clone());

    // Pack isolation (beta.035): packs are only used when the global setting allows them AND the
    // request's series owns zero downloaded files; prioritization additionally needs its own flag.
    let global_allow_bulk = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'allow_bulk_packs'"#)
        .fetch_optional(&state.db).await.ok().flatten().as_deref() == Some("true");
    let global_prioritize = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'prioritize_packs'"#)
        .fetch_optional(&state.db).await.ok().flatten().as_deref() == Some("true");
    let use_packs = global_allow_bulk && payload.allow_packs.unwrap_or(false);
    let prioritize_packs = global_prioritize && use_packs;

    let acronyms = search_engine::get_custom_acronyms(&state.db).await.unwrap_or_default();
    let year_str = req_year.clone().unwrap_or_default();
    let mut queries = search_engine::generate_search_queries(&payload.name, &year_str, &acronyms, prioritize_packs, use_packs);

    if !queries.contains(&payload.name) {
        queries.insert(0, payload.name.clone());
    }

    // Honor skip_indexers (DDL-only requests): skip the Prowlarr fallback entirely.
    let (prow_res_raw, get_res_raw) = if skip_indexers {
        log::info!("skip_indexers set — searching Direct Downloads only.");
        (Ok::<Vec<prowlarr::ProwlarrResult>, anyhow::Error>(Vec::new()),
         getcomics::search(&state.db, &state.limiter, &queries, false, &payload.name, req_year.as_deref(), series_year.as_deref(), is_manga, Some(use_packs)).await)
    } else {
        log::info!("Querying Direct Downloads and Indexers concurrently...");
        tokio::join!(
            prowlarr::search(&state.db, &state.limiter, &queries, is_manga),
            getcomics::search(&state.db, &state.limiter, &queries, false, &payload.name, req_year.as_deref(), series_year.as_deref(), is_manga, Some(use_packs))
        )
    };

    // Drop blocklisted releases (previously-failed downloads) before the stall count + scoring (parity
    // with automation.ts failedItems). A result is blocked if the list contains its title, download
    // URL, GUID, or info-hash (the latter cover Prowlarr's trackingHash = infoHash||guid||downloadUrl).
    // NOTE (known minor divergence): this runs AFTER each source already broke out of its per-query
    // loop on the first relevant result, so — unlike Node, which filters inside the loop — it won't try
    // the next query if the first query's only matches are all blocklisted (a rare retry/DDL-only edge;
    // the flow still falls through to Prowlarr below). Same "break on first successful query" trade-off
    // as the GetComics relevance relocation.
    let blocklist = payload.failed_links.clone().unwrap_or_default();
    let not_blocked = |r: &prowlarr::ProwlarrResult| -> bool {
        !blocklist.iter().any(|f| {
            f == &r.title || f == &r.download_url || f == &r.guid || r.info_hash.as_deref() == Some(f.as_str())
        })
    };
    let get_res_raw = get_res_raw.map(|v| v.into_iter().filter(|r| not_blocked(r)).collect::<Vec<_>>());
    let prow_res_raw = prow_res_raw.map(|v| v.into_iter().filter(|r| not_blocked(r)).collect::<Vec<_>>());

    // Multiple distinct DDL editions for one request → stall for human review (parity with automation.ts).
    if let Ok(get_res) = &get_res_raw {
        if get_res.len() > 1 {
            let editions: std::collections::HashSet<String> =
                get_res.iter().map(|r| search_engine::normalize_edition_title(&r.title)).collect();
            if editions.len() > 1 {
                log::warn!("Multiple distinct DDL editions found for {}. Stalling for admin review.", payload.name);
                return Json(SearchResponse { success: false, best_match: None, stall_for_review: true, manual_ddl: None, ddl_candidates: Vec::new() });
            }
        }
    }

    let mut best_match: Option<prowlarr::ProwlarrResult> = None;
    // A GetComics match whose only hosters are user-disabled is held here, then surfaced as a
    // MANUAL_DDL link if no indexer release wins either (parity with automation.ts fallbackManualUrl).
    let mut manual_fallback: Option<(String, String)> = None;
    // Ranked DDL links (one per hoster) for the chosen GetComics match — Node tries them in order.
    let mut ddl_candidates: Vec<DdlCandidate> = Vec::new();

    // Priority phase: Direct Downloads first.
    if let Ok(get_res) = get_res_raw {
        if !get_res.is_empty() {
            // GetComics results are already relevance-filtered per-query in getcomics::search, so here
            // we only apply the operator's junk/exclude lists + scoring (skip_relevance = true).
            if let Ok(Some(mut best_ddl)) = search_engine::filter_and_score(
                &state.db, get_res, &payload.name, is_manga, req_year.clone(), true, Some(use_packs)
            ).await {
                // Resolve the article to a concrete hoster link. scrape_deep_link already drops
                // user-disabled hosters; a "unknown" hoster means no enabled hoster can serve this
                // match — Node holds it for manual pickup and falls through to Prowlarr.
                let candidates = getcomics::scrape_deep_link(&state.db, &state.limiter, &best_ddl.download_url)
                    .await
                    .unwrap_or_default();
                if let Some(top) = candidates.first() {
                    log::info!("Successfully matched a Direct Download! Discarding indexer results.");
                    best_ddl.download_url = top.url.clone();
                    best_ddl.indexer = top.hoster.clone();
                    ddl_candidates = candidates.iter()
                        .map(|c| DdlCandidate { url: c.url.clone(), hoster: c.hoster.clone() })
                        .collect();
                    best_match = Some(best_ddl);
                } else {
                    log::warn!("[GetComics] Best match for {} has no enabled hoster. Holding manual link and falling back to Prowlarr...", payload.name);
                    manual_fallback = Some((best_ddl.download_url.clone(), best_ddl.title.clone()));
                }
            }
        }
    }

    if best_match.is_none() {
        log::info!("No downloadable DDL. Evaluating Prowlarr indexer results...");
        if let Ok(prow_res) = prow_res_raw {
            if !prow_res.is_empty() {
                if let Ok(Some(best_prow)) = search_engine::filter_and_score(
                    &state.db, prow_res, &payload.name, is_manga, req_year.clone(), false, Some(use_packs)
                ).await {
                    best_match = Some(best_prow);
                }
            }
        }
    }

    // DDL deep-links are already resolved above; Prowlarr results are torrents/usenet, returned as-is.
    if let Some(best) = best_match {
        return Json(SearchResponse { success: true, best_match: Some(best), stall_for_review: false, manual_ddl: None, ddl_candidates });
    }

    // Nothing auto-downloadable. If we held a GetComics link and GetComics is an enabled hoster,
    // surface it for manual download (parity with the automation.ts MANUAL_DDL fallback, which is
    // gated on `enabledHosters.includes('getcomics')`).
    if let Some((url, name)) = manual_fallback {
        if getcomics::is_getcomics_enabled(&state.db).await {
            log::warn!("Prowlarr failed for {}. Reverting to GetComics manual DDL fallback.", payload.name);
            return Json(SearchResponse { success: false, best_match: None, stall_for_review: false, manual_ddl: Some(ManualDdl { url, name }), ddl_candidates: Vec::new() });
        }
    }

    log::warn!("No valid release found for {} after checking all sources.", payload.name);
    Json(SearchResponse { success: false, best_match: None, stall_for_review: false, manual_ddl: None, ddl_candidates: Vec::new() })
}

async fn handle_interactive_search(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<InteractiveSearchQuery>,
) -> Json<InteractiveResponse> {
    log::info!("Received Interactive Search request for: {}", payload.query);
    
    // Parity with the upstream interactive route (beta.035): both services receive the single raw
    // query; getcomics::search fans it out into the upstream variant set internally (raw,
    // symbol-cleaned, year-stripped, issue-stripped) and aggregates across all pages with URL dedup.
    let queries = vec![payload.query.clone()];

    let (prow_res, get_res) = tokio::join!(
        prowlarr::search(&state.db, &state.limiter, &queries, payload.is_manga.unwrap_or(false)),
        getcomics::search(&state.db, &state.limiter, &queries, true, &payload.query, payload.year.as_deref(), payload.year.as_deref(), payload.is_manga.unwrap_or(false), None)
    );

    Json(InteractiveResponse {
        prowlarr: prow_res.unwrap_or_default(),
        getcomics: get_res.unwrap_or_default()
    })
}

async fn handle_watched_sync(State(state): State<Arc<AppState>>) -> StatusCode {
    log::info!("Received request to process Watched Folder.");

    tokio::spawn(async move {
        let db = state.db.clone();
        let start_time = std::time::Instant::now();

        match watched_sync::process_watched_folder(db.clone()).await {
            Ok((_success, _unmatched, details)) => {
                let duration = start_time.elapsed().as_millis() as i32;
                log::info!("{}", details);

                let _ = sqlx::query(
                    r#"INSERT INTO "JobLog" (id, "jobType", status, "durationMs", message, "createdAt", attempts)
                       VALUES ($1, 'WATCHED_FOLDER_SYNC', 'COMPLETED', $2, $3, NOW(), 1)"#
                )
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(duration)
                .bind(details)
                .execute(&db).await;
            },
            Err(e) => {
                log::error!("❌ Background Watched Sync failed: {:?}", e);
                write_failed_joblog(&db, "WATCHED_FOLDER_SYNC", start_time.elapsed().as_millis() as i32, format!("Watched folder sync failed: {:?}", e)).await;
            },
        }
    });

    StatusCode::ACCEPTED
}

async fn handle_backup(State(state): State<Arc<AppState>>) -> StatusCode {
    log::info!("Received request to run Database Backup.");

    tokio::spawn(async move {
        let db = state.db.clone();
        let start_time = std::time::Instant::now();

        match backup::process_backup(db.clone()).await {
            Ok((_, details)) => {
                let duration = start_time.elapsed().as_millis() as i32;
                log::info!("{}", details);
                notify_node("job_db_backup", &details).await;

                let _ = sqlx::query(
                    r#"INSERT INTO "JobLog" (id, "jobType", status, "durationMs", message, "createdAt", attempts)
                       VALUES ($1, 'DATABASE_BACKUP', 'COMPLETED', $2, $3, NOW(), 1)"#
                )
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(duration)
                .bind(details)
                .execute(&db).await;
            },
            Err(e) => {
                log::error!("❌ Background Database Backup failed: {:?}", e);
                write_failed_joblog(&db, "DATABASE_BACKUP", start_time.elapsed().as_millis() as i32, format!("Database backup failed: {:?}", e)).await;
                notify_node("job_db_backup", "Database backup failed. Check the engine logs.").await;
            },
        }
    });

    StatusCode::ACCEPTED
}

async fn handle_discover_sync(State(state): State<Arc<AppState>>) -> StatusCode {
    log::info!("Received request to run Discover Sync.");

    tokio::spawn(async move {
        let db = state.db.clone();
        let start_time = std::time::Instant::now();

        match discover::run_discover_sync(db.clone()).await {
            Ok((_count, details)) => {
                let duration = start_time.elapsed().as_millis() as i32;
                log::info!("{}", details);

                let _ = sqlx::query(
                    r#"INSERT INTO "JobLog" (id, "jobType", status, "durationMs", message, "createdAt", attempts)
                       VALUES ($1, 'DISCOVER_SYNC', 'COMPLETED', $2, $3, NOW(), 1)"#
                )
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(duration)
                .bind(details)
                .execute(&db).await;
            },
            Err(e) => {
                log::error!("❌ Background Discover Sync failed: {:?}", e);
                write_failed_joblog(&db, "DISCOVER_SYNC", start_time.elapsed().as_millis() as i32, format!("Discover sync failed: {:?}", e)).await;
            },
        }
    });

    StatusCode::ACCEPTED
}

/// SERIES_MONITOR (heavy half). Synchronous — Node needs the candidates to create requests + trigger
/// searches, so this awaits the full multi-minute fetch and returns skeleton count + candidates.
async fn handle_monitor_sync(State(state): State<Arc<AppState>>) -> Result<Json<monitor::MonitorOutput>, StatusCode> {
    log::info!("Received request to run Series Monitor (fetch/match/skeleton phase).");
    match monitor::run_series_monitor(state.db.clone()).await {
        Ok(out) => {
            log::info!("Series Monitor engine phase complete: {} skeletons, {} candidates.", out.skeletons_created, out.candidates.len());
            Ok(Json(out))
        }
        Err(e) => {
            log::error!("❌ Series Monitor engine phase failed: {:?}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// Streams a single DDL (raw byte pump + stall-watchdog + progress). Synchronous — Node awaits the
/// result to know whether to hand off to the importer. The Mega SDK path + hoster resolution + the
/// failure alert stay in Node.
async fn handle_download_stream(
    State(state): State<Arc<AppState>>,
    Json(req): Json<download::StreamRequest>,
) -> Json<download::StreamResponse> {
    log::info!("[Internal DL] Streaming download for request {} -> {}", req.request_id, req.dest_path);
    match download::stream_download(&state.db, req).await {
        Ok(final_path) => {
            log::info!("[Internal DL] Engine stream complete: {}", final_path);
            Json(download::StreamResponse { success: true, final_path: Some(final_path), error: None })
        }
        Err(e) => {
            log::error!("[Internal DL] Engine stream failed: {:?}", e);
            Json(download::StreamResponse { success: false, final_path: None, error: Some(e.to_string()) })
        }
    }
}

async fn handle_ghost_check(State(state): State<Arc<AppState>>) -> StatusCode {
    log::info!("Received request to run Ghost File Diagnostics.");

    tokio::spawn(async move {
        let db = state.db.clone();
        let start_time = std::time::Instant::now();

        match diagnostics::run_ghost_check(db.clone()).await {
            Ok((_, _, details)) => {
                let duration = start_time.elapsed().as_millis() as i32;
                log::info!("{}", details);
                notify_node("job_diagnostics", &details).await;

                let _ = sqlx::query(
                    r#"INSERT INTO "JobLog" (id, "jobType", status, "durationMs", message, "createdAt", attempts)
                       VALUES ($1, 'DIAGNOSTICS', 'COMPLETED', $2, $3, NOW(), 1)"#
                )
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(duration)
                .bind(details)
                .execute(&db).await;
            }
            Err(e) => {
                log::error!("❌ Ghost File Diagnostics failed: {:?}", e);
                write_failed_joblog(&db, "DIAGNOSTICS", start_time.elapsed().as_millis() as i32, format!("Ghost check failed: {:?}", e)).await;
                notify_node("job_diagnostics", "Ghost file diagnostics failed. Check the engine logs.").await;
            }
        }
    });

    StatusCode::ACCEPTED
}

async fn handle_storage_scan(State(state): State<Arc<AppState>>) -> StatusCode {
    log::info!("Received request to run Deep Storage Scan.");

    tokio::spawn(async move {
        let db = state.db.clone();
        let start_time = std::time::Instant::now();

        match diagnostics::run_storage_scan(db.clone()).await {
            Ok((_, _, details)) => {
                let duration = start_time.elapsed().as_millis() as i32;
                log::info!("{}", details);
                notify_node("job_diagnostics", &details).await;

                let _ = sqlx::query(
                    r#"INSERT INTO "JobLog" (id, "jobType", status, "durationMs", message, "createdAt", attempts)
                       VALUES ($1, 'STORAGE_SCAN', 'COMPLETED', $2, $3, NOW(), 1)"#
                )
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(duration)
                .bind(details)
                .execute(&db).await;
            }
            Err(e) => {
                log::error!("❌ Deep Storage Scan failed: {:?}", e);
                write_failed_joblog(&db, "STORAGE_SCAN", start_time.elapsed().as_millis() as i32, format!("Storage scan failed: {:?}", e)).await;
                notify_node("job_diagnostics", "Deep storage scan failed. Check the engine logs.").await;
            }
        }
    });

    StatusCode::ACCEPTED
}

#[derive(Serialize)]
struct OrphanResponse {
    success: bool,
    orphaned_files: Vec<String>,
}

async fn handle_orphan_scan(State(state): State<Arc<AppState>>) -> Json<OrphanResponse> {
    log::info!("Received request to run Orphaned File Scan.");
    
    match diagnostics::run_orphan_scan(state.db.clone()).await {
        Ok(orphans) => {
            log::info!("Manual Orphan Scan complete. Found {} orphaned files.", orphans.len());
            Json(OrphanResponse { success: true, orphaned_files: orphans })
        },
        Err(e) => {
            log::error!("❌ Orphan Scan failed: {:?}", e);
            Json(OrphanResponse { success: false, orphaned_files: vec![] })
        }
    }
}

async fn handle_integrity_scan(State(state): State<Arc<AppState>>) -> StatusCode {
    log::info!("Received request to run Archive Integrity Scan.");

    tokio::spawn(async move {
        let db = state.db.clone();
        let start_time = std::time::Instant::now();

        match diagnostics::run_integrity_scan(db.clone()).await {
            Ok((_, _, details)) => {
                let duration = start_time.elapsed().as_millis() as i32;
                log::info!("{}", details);

                let _ = sqlx::query(
                    r#"INSERT INTO "JobLog" (id, "jobType", status, "durationMs", message, "createdAt", attempts)
                       VALUES ($1, 'DIAGNOSTICS', 'COMPLETED', $2, $3, NOW(), 1)"#
                )
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(duration)
                .bind(details)
                .execute(&db).await;
            }
            Err(e) => {
                log::error!("❌ Archive Integrity Scan failed: {:?}", e);
                write_failed_joblog(&db, "DIAGNOSTICS", start_time.elapsed().as_millis() as i32, format!("Integrity scan failed: {:?}", e)).await;
            }
        }
    });

    StatusCode::ACCEPTED
}