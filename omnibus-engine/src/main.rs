mod api_usage;
mod converter;
mod db;
mod scanner;
mod metadata;
mod prowlarr;
mod search_engine;
mod getcomics;
mod annas_archive;
mod rate_limiter;
mod metadata_writer;
mod watched_sync;
mod backup;
mod diagnostics;
mod manga_detector;
mod matcher;
mod metadata_cache;
mod engine_config;
mod discover;
mod monitor;
mod download;
mod log_forward;
mod renamer;
mod secret_crypto;

use axum::{routing::{get, post}, Router, Json, extract::{State, Request}, http::{StatusCode, header}, middleware::{self, Next}, response::Response};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use sqlx::Row;
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
            // Complete browser UA — the old value stopped mid-token at AppleWebKit/537.36 (no
            // Chrome/ or Safari/ suffix), a bot-fingerprint signature that invited challenges.
            // Keep in sync with download.rs DEFAULT_UA.
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")
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
    // Human-readable reason for a stall_for_review, shown in the admin alert (e.g. multi-edition vs
    // multi-pack ambiguity need different guidance). None → Node falls back to its generic message.
    #[serde(skip_serializing_if = "Option::is_none")]
    stall_reason: Option<String>,
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
    // Anna's Archive results (protocol "ddl", indexer "Anna's Archive"). Empty when the source is
    // disabled for interactive search (the default) — see annas_archive::is_interactive_enabled.
    #[serde(default)]
    annas_archive: Vec<prowlarr::ProwlarrResult>,
}

struct AppState {
    // The runtime-selected (Postgres/SQLite) database — see src/db.rs.
    db: db::Db,
    limiter: Arc<rate_limiter::RateLimiter>,
    // Shared secret (Node's NEXTAUTH_SECRET) required in the X-Internal-Secret header on every
    // request. `None` when unset → endpoints are open (dev/localhost); a startup warning is logged.
    internal_secret: Option<String>,
}

/// Known throwaway secrets shipped in the example compose files. Treated as "no secret configured"
/// so a deployer who never overrode them cannot run with a value that is public in the repo.
pub(crate) fn is_placeholder_secret(s: &str) -> bool {
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
            match db::Db::connect(&db_url, 1).await {
                Ok(d) => {
                    let c = engine_config::EngineConfig::load(&d.pool).await;
                    d.pool.close().await;
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

/// Connects to the database (Postgres or SQLite, selected by DATABASE_URL — src/db.rs), retrying
/// with backoff for up to ~90s before giving up. The engine and DB often share a Docker bridge
/// whose ports take time to start forwarding (e.g. STP forward-delay on a QNAP virtual switch adds
/// a ~15-30s dead window when a container's interface first joins), and the DB container may still
/// be starting. Without this, the process would exit on the first failure and `restart: always`
/// would reset the bridge port — a loop that can never outlast the window.
async fn connect_with_retry(db_url: &str, max_connections: u32) -> anyhow::Result<db::Db> {
    const MAX_ATTEMPTS: u32 = 30;
    const DELAY_SECS: u64 = 3;
    let mut attempt = 1;
    loop {
        log::info!("Connecting to the database (attempt {}/{})...", attempt, MAX_ATTEMPTS);
        match db::Db::connect(db_url, max_connections).await {
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
                return Err(e);
            }
        }
    }
}

/// Async entrypoint. The runtime is built manually in `main` so its size honors EngineConfig.
async fn run(db_url: String, db_connections: u32) -> anyhow::Result<()> {
    // Start draining buffered log lines to the Node app now that the runtime exists. Any lines
    // emitted during startup (preflight, the DB-connect retries below) were buffered and flush here.
    log_forward::spawn_forwarder();

    let db = connect_with_retry(&db_url, db_connections).await?;

    log::info!("✅ Connected to the database ({:?})!", db.dialect);

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
    let shared_state = Arc::new(AppState { db, limiter, internal_secret });

    let api = Router::new()
        .route("/api/repack", post(handle_repack))
        .route("/api/scan", post(handle_scan))
        .route("/api/converter/cbr-sweep", post(handle_cbr_sweep))
        .route("/api/converter/convert-file", post(handle_convert_file))
        .route("/api/converter/extract-cover", post(handle_extract_cover))
        .route("/api/importer/nested", post(handle_nested_archives))
        .route("/api/library/rename", post(handle_bulk_rename))
        .route("/api/reader/page", post(handle_reader_page))
        .route("/api/reader/entries", post(handle_reader_entries))
        .route("/api/archive/remove-pages", post(handle_remove_pages))
        .route("/api/archive/find-page", post(handle_find_page))
        .route("/api/watched-sync", post(handle_watched_sync))
        .route("/api/matcher/sweep", post(handle_matcher_sweep))
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
        .route("/api/getcomics/scrape", post(handle_getcomics_scrape))
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
async fn write_failed_joblog(db: &db::Db, job_type: &str, duration_ms: i32, message: String) {
    write_joblog(db, job_type, "FAILED", duration_ms, message).await;
}

/// Records a JobLog row via the per-dialect "now" expression (src/db.rs). All handler success/
/// failure logging funnels through here so the dialect handling lives in one place.
async fn write_joblog(db: &db::Db, job_type: &str, status: &str, duration_ms: i32, message: String) {
    if let Err(e) = sqlx::query(&format!(
        r#"INSERT INTO "JobLog" (id, "jobType", status, "durationMs", message, "createdAt", attempts)
           VALUES ($1, $2, $3, $4, $5, {now}, 1)"#,
        now = db.now_expr()
    ))
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(job_type)
    .bind(status)
    .bind(duration_ms)
    .bind(message)
    .execute(&db.pool)
    .await
    {
        log::error!("Failed to write {} JobLog for {}: {:?}", status, job_type, e);
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

                write_joblog(&db, "CBR_CONVERTER", status, duration, msg).await;
            },
            Err(e) => {
                log::error!("❌ Background CBR Sweep failed: {:?}", e);
                write_failed_joblog(&db, "CBR_CONVERTER", start_time.elapsed().as_millis() as i32, format!("CBR sweep failed: {:?}", e)).await;
            },
        }
    });

    StatusCode::ACCEPTED
}

#[derive(Deserialize)]
struct ExtractCoverRequest {
    path: String,
}

/// Lightweight guard for the trusted internal cover endpoint: require an ABSOLUTE path with no `..`
/// components. Node (the only authenticated caller) already admin-gates the request and range-checks
/// the path against the library/unmatched roots, then resolves it to absolute before calling. The
/// engine deliberately does NOT re-derive those roots: it can run from a different working directory
/// than Node (dev: separate processes; prod: separate containers), so a relative root (e.g. an
/// unmatched dir) can't be resolved to the same absolute path on both sides — which is exactly what
/// made an earlier canonicalize-based check reject valid paths. Absolute + no-`..` blocks the obvious
/// abuses (cwd-relative tricks, traversal) without that cwd dependency, and matches how the other
/// engine endpoints (scan, download, embed) already trust Node-supplied paths behind the shared secret.
fn is_absolute_non_traversing(path: &str) -> bool {
    use std::path::{Component, Path};
    let p = Path::new(path);
    p.is_absolute() && !p.components().any(|c| matches!(c, Component::ParentDir))
}

/// On-demand first-page extraction for the Smart Matcher (hybrid design): the engine reuses the same
/// multi-format `extract_first_image` the scanner uses — so CBR/RAR/CB7 work, unlike a Node-only
/// adm-zip path — and returns the RAW page bytes; the Node /api/library/archive-cover route resizes
/// them with sharp. Synchronous (Node awaits the bytes). Node admin-gates + range-checks the path and
/// sends it absolute; here we only require absolute + no `..` (see is_absolute_non_traversing).
async fn handle_extract_cover(
    Json(req): Json<ExtractCoverRequest>,
) -> Result<Response, StatusCode> {
    if !is_absolute_non_traversing(&req.path) {
        log::warn!("[Cover Extract] Rejected non-absolute or traversing path: {}", req.path);
        return Err(StatusCode::FORBIDDEN);
    }

    // extract_first_image reads the archive and shells out to unrar/unar for RAR — blocking work, so
    // it runs on the blocking pool to keep the async runtime free.
    let path = req.path.clone();
    let extracted = tokio::task::spawn_blocking(move || converter::extract_first_image(std::path::Path::new(&path)))
        .await
        .map_err(|e| { log::error!("[Cover Extract] join error: {:?}", e); StatusCode::INTERNAL_SERVER_ERROR })?
        .map_err(|e| { log::warn!("[Cover Extract] extraction failed for {}: {:?}", req.path, e); StatusCode::INTERNAL_SERVER_ERROR })?;

    match extracted {
        Some((bytes, ext)) => {
            let content_type = match ext.as_str() {
                "jpg" | "jpeg" => "image/jpeg",
                "png" => "image/png",
                "webp" => "image/webp",
                "gif" => "image/gif",
                "bmp" => "image/bmp",
                _ => "application/octet-stream",
            };
            Response::builder()
                .header(header::CONTENT_TYPE, content_type)
                .body(axum::body::Body::from(bytes))
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
        }
        None => Err(StatusCode::NOT_FOUND),
    }
}

#[derive(serde::Deserialize)]
struct ReaderEntriesRequest {
    path: String,
}

/// Page LIST for the web reader: image entry names in reader order for any natively readable
/// archive (zip directly, RAR via unrar). Node's reader/pages route has no RAR reader, so it asks
/// here for non-zip archives instead of telling the user to wait for conversion.
/// Same path trust model as the page endpoint below.
async fn handle_reader_entries(
    Json(req): Json<ReaderEntriesRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !is_absolute_non_traversing(&req.path) {
        log::warn!("[Reader Entries] Rejected non-absolute or traversing path: {}", req.path);
        return Err(StatusCode::FORBIDDEN);
    }
    let path = req.path.clone();
    let pages = tokio::task::spawn_blocking(move || converter::list_image_entries(std::path::Path::new(&path)))
        .await
        .map_err(|e| { log::error!("[Reader Entries] join error: {:?}", e); StatusCode::INTERNAL_SERVER_ERROR })?
        .map_err(|e| { log::warn!("[Reader Entries] listing failed for {}: {:?}", req.path, e); StatusCode::INTERNAL_SERVER_ERROR })?;
    Ok(Json(serde_json::json!({ "pages": pages })))
}

#[derive(serde::Deserialize)]
struct RemovePagesRequest {
    file_path: String,
    entry_names: Vec<String>,
}

/// Page removal (issue #189): rewrites an archive without the named page entries. CBZ rewrites in
/// place; RAR/7z are repacked as a sibling .cbz (write-back impossible) and the original retired —
/// `new_file_path` tells the caller where the file lives now. Destructive — the heavy lifting
/// (name verification, at-least-one-page floor, temp-write + verify + atomic swap) lives in
/// converter::remove_pages_from_archive; failures leave the original file untouched. The Node
/// route resolves issueId → path and owns the DB fixups; this endpoint trusts the internal caller
/// like every other path-taking route behind require_internal_auth.
async fn handle_remove_pages(
    Json(req): Json<RemovePagesRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let err = |code: StatusCode, msg: String| (code, Json(serde_json::json!({ "error": msg })));
    if !is_absolute_non_traversing(&req.file_path) {
        log::warn!("[Remove Pages] Rejected non-absolute or traversing path: {}", req.file_path);
        return Err(err(StatusCode::FORBIDDEN, "Invalid path.".to_string()));
    }
    let path = req.file_path.clone();
    let names = req.entry_names.clone();
    let removed_count = names.len();
    let (final_path, new_count) = tokio::task::spawn_blocking(move || {
        converter::remove_pages_from_archive(std::path::Path::new(&path), &names)
    })
    .await
    .map_err(|e| {
        log::error!("[Remove Pages] join error: {:?}", e);
        err(StatusCode::INTERNAL_SERVER_ERROR, "Internal error.".to_string())
    })?
    .map_err(|e| {
        log::warn!("[Remove Pages] rewrite refused/failed for {}: {}", req.file_path, e);
        // The converter's messages are operator-actionable (stale list, last page, unsupported
        // format) — surface them verbatim as a client error so the UI can show the real reason.
        err(StatusCode::UNPROCESSABLE_ENTITY, e.to_string())
    })?;
    log::info!(
        "[Remove Pages] Removed {} page(s) from {} — {} page(s) remain at {} (issue #189).",
        removed_count, req.file_path, new_count, final_path.display()
    );
    Ok(Json(serde_json::json!({
        "new_page_count": new_count,
        "removed": removed_count,
        "new_file_path": final_path.to_string_lossy(),
    })))
}

#[derive(serde::Deserialize)]
struct FindPageRequest {
    source_path: String,
    source_entry: String,
    candidate_paths: Vec<String>,
}

/// Series page sweep, scan step (issue #189 Phase 3): fingerprints one page and reports every
/// byte-identical copy across a BATCH of candidate archives. Read-only. CBZ candidates use the
/// central-directory size prefilter (fast); non-zip candidates are reported as skipped — the
/// caller shows a convert-first note (hashing a RAR page-by-page would spawn one unrar per page).
/// Per-candidate failures land in `errors` without failing the batch.
async fn handle_find_page(
    Json(req): Json<FindPageRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let err = |code: StatusCode, msg: String| (code, Json(serde_json::json!({ "error": msg })));
    if !is_absolute_non_traversing(&req.source_path) {
        return Err(err(StatusCode::FORBIDDEN, "Invalid source path.".to_string()));
    }
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let (hash, size) = converter::hash_archive_entry(
            std::path::Path::new(&req.source_path), &req.source_entry,
        )?;
        let mut matches: Vec<serde_json::Value> = Vec::new();
        let mut skipped: Vec<serde_json::Value> = Vec::new();
        let mut errors: Vec<serde_json::Value> = Vec::new();
        for cand in &req.candidate_paths {
            if !is_absolute_non_traversing(cand) {
                errors.push(serde_json::json!({ "path": cand, "error": "invalid path" }));
                continue;
            }
            let p = std::path::Path::new(cand);
            if !converter::is_zip_archive(p) {
                skipped.push(serde_json::json!({ "path": cand, "reason": "not_cbz" }));
                continue;
            }
            match converter::find_matching_pages_in_cbz(p, &hash, size) {
                Ok(found) => {
                    for (entry_name, index) in found {
                        matches.push(serde_json::json!({ "path": cand, "entry_name": entry_name, "index": index }));
                    }
                }
                Err(e) => errors.push(serde_json::json!({ "path": cand, "error": e.to_string() })),
            }
        }
        Ok(serde_json::json!({
            "source_hash": hash, "source_size": size,
            "matches": matches, "skipped": skipped, "errors": errors,
        }))
    })
    .await
    .map_err(|e| {
        log::error!("[Find Page] join error: {:?}", e);
        err(StatusCode::INTERNAL_SERVER_ERROR, "Internal error.".to_string())
    })?
    .map_err(|e| {
        log::warn!("[Find Page] scan failed: {}", e);
        err(StatusCode::UNPROCESSABLE_ENTITY, e.to_string())
    })?;
    Ok(Json(result))
}

#[derive(serde::Deserialize)]
struct ReaderPageRequest {
    path: String,
    /// The zip entry name of the page (the reader already knows it from the page list).
    entry: Option<String>,
    /// 0-based natural-sort page index — the OPDS-PSE addressing mode. Ignored when `entry` is set.
    index: Option<u32>,
    #[serde(default = "default_reader_width")]
    width: u32,
    #[serde(default = "default_reader_quality")]
    quality: f32,
}
fn default_reader_width() -> u32 { 1600 }
fn default_reader_quality() -> f32 { 80.0 }

/// On-demand reader page: extract a page from a cbz/zip (by entry name for the web reader, by
/// natural-sort index for OPDS-PSE), resize to `width`, and return WebP bytes — moving the
/// whole-archive buffer + image work off the Node event loop. Node keeps a local fallback for both
/// callers (and owns the auto-crop path), so this only needs to serve the common case.
/// Same path trust model as the cover endpoint (absolute, no `..`; Node auth-gates + range-checks).
async fn handle_reader_page(
    Json(req): Json<ReaderPageRequest>,
) -> Result<Response, StatusCode> {
    if !is_absolute_non_traversing(&req.path) {
        log::warn!("[Reader Page] Rejected non-absolute or traversing path: {}", req.path);
        return Err(StatusCode::FORBIDDEN);
    }
    if req.entry.is_none() && req.index.is_none() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let path = req.path.clone();
    let entry = req.entry.clone();
    let index = req.index;
    let width = req.width.clamp(1, 10_000);
    let quality = req.quality.clamp(1.0, 100.0);

    let out = tokio::task::spawn_blocking(move || {
        match entry {
            Some(entry) => converter::extract_page_webp(std::path::Path::new(&path), &entry, width, quality),
            None => converter::extract_page_index_webp(std::path::Path::new(&path), index.unwrap_or(0) as usize, width, quality),
        }
    })
    .await
    .map_err(|e| { log::error!("[Reader Page] join error: {:?}", e); StatusCode::INTERNAL_SERVER_ERROR })?
    .map_err(|e| { log::warn!("[Reader Page] extraction failed for {}: {:?}", req.path, e); StatusCode::INTERNAL_SERVER_ERROR })?;

    match out {
        Some(bytes) => Response::builder()
            .header(header::CONTENT_TYPE, "image/webp")
            .body(axum::body::Body::from(bytes))
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR),
        None => Err(StatusCode::NOT_FOUND),
    }
}

#[derive(serde::Deserialize)]
struct NestedArchivesRequest {
    path: String,
    /// Extraction destination (the WATCHED dir). Omitted = list-only mode, which is how the
    /// importer detects a batch payload without loading the pack into the Node heap.
    dest_dir: Option<String>,
}

/// Importer nested-pack offload: list (detection) or extract (routing to WATCHED) the comic
/// archives nested inside a batch zip, streaming entry-by-entry instead of buffering the whole
/// pack. Node keeps its AdmZip path as a full fallback, so failures here just mean a slower import.
async fn handle_nested_archives(
    Json(req): Json<NestedArchivesRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !is_absolute_non_traversing(&req.path)
        || !req.dest_dir.as_deref().is_none_or(is_absolute_non_traversing)
    {
        log::warn!("[Importer Nested] Rejected non-absolute or traversing path: {}", req.path);
        return Err(StatusCode::FORBIDDEN);
    }
    let path = req.path.clone();
    let dest_dir = req.dest_dir.clone();

    let result = tokio::task::spawn_blocking(move || {
        let archive = std::path::Path::new(&path);
        match dest_dir {
            None => converter::list_nested_archives(archive)
                .map(|entries| serde_json::json!({ "count": entries.len(), "entries": entries })),
            Some(dest) => converter::extract_nested_archives(archive, std::path::Path::new(&dest))
                .map(|files| {
                    let files: Vec<String> = files.iter().map(|p| p.to_string_lossy().to_string()).collect();
                    serde_json::json!({ "count": files.len(), "files": files })
                }),
        }
    })
    .await
    .map_err(|e| { log::error!("[Importer Nested] join error: {:?}", e); StatusCode::INTERNAL_SERVER_ERROR })?
    .map_err(|e| { log::warn!("[Importer Nested] failed for {}: {:?}", req.path, e); StatusCode::INTERNAL_SERVER_ERROR })?;

    Ok(Json(result))
}

#[derive(serde::Deserialize)]
struct BulkRenameRequest {
    series_ids: Vec<String>,
    folder_pattern: String,
    file_pattern: String,
    /// Manga series use this template when present (worklist item 8); absent = comic pattern for all.
    #[serde(default)]
    manga_file_pattern: Option<String>,
}

/// Bulk rename / standardize, ported from the Node route. Runs SYNCHRONOUSLY (Node calls it via
/// engineFetchLong and passes the summary straight back to the UI, which navigates to `newPath`),
/// so this responds only when every move + DB update has finished. Node admin-gates the route and
/// keeps its local loop as the fallback.
async fn handle_bulk_rename(
    State(state): State<Arc<AppState>>,
    Json(req): Json<BulkRenameRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if req.series_ids.is_empty() || req.folder_pattern.trim().is_empty() || req.file_pattern.trim().is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    match renamer::run_bulk_rename(&state.db, &req.series_ids, &req.folder_pattern, &req.file_pattern, req.manga_file_pattern.as_deref()).await {
        Ok(summary) => Ok(Json(serde_json::json!({
            "filesRenamed": summary.files_renamed,
            "foldersRenamed": summary.folders_renamed,
            "conflicts": summary.conflicts,
            "newPath": summary.last_path,
        }))),
        Err(e) => {
            log::error!("[Renamer] Bulk rename failed: {:?}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

#[derive(serde::Deserialize)]
struct ConvertFileRequest {
    path: String,
}

/// Path-based CBR→CBZ conversion for the importer, which converts files BEFORE their Issue row
/// exists (so the issue-id based cbr-sweep can't serve it). Honors the user's WebP settings and,
/// like the Node converter, repoints any Issue row that already references the old path.
async fn handle_convert_file(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ConvertFileRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !is_absolute_non_traversing(&req.path) {
        log::warn!("[Convert File] Rejected non-absolute or traversing path: {}", req.path);
        return Err(StatusCode::FORBIDDEN);
    }
    let (convert_to_webp, webp_quality) = converter::get_webp_settings(&state.db.pool).await;
    let path = req.path.clone();

    let new_path = tokio::task::spawn_blocking(move || {
        converter::process_archive(std::path::Path::new(&path), convert_to_webp, webp_quality)
    })
    .await
    .map_err(|e| { log::error!("[Convert File] join error: {:?}", e); StatusCode::INTERNAL_SERVER_ERROR })?
    .map_err(|e| { log::warn!("[Convert File] conversion failed for {}: {:?}", req.path, e); StatusCode::INTERNAL_SERVER_ERROR })?;

    let new_path_str = new_path.to_string_lossy().to_string();
    // Parity with Node convertCbrToCbz: an Issue already pointing at the old file follows it —
    // and gains its now-countable page count (OPDS-PSE pse:count).
    let pages = converter::count_zip_pages(&new_path).unwrap_or(0);
    if let Err(e) = sqlx::query(
        r#"UPDATE "Issue" SET "filePath" = $1,
               "pageCount" = CASE WHEN $2 > 0 THEN $2 ELSE "pageCount" END
           WHERE "filePath" = $3"#
    )
        .bind(&new_path_str)
        .bind(pages)
        .bind(&req.path)
        .execute(&state.db.pool)
        .await
    {
        log::error!("[Convert File] Converted {} but failed to update its database path: {:?}", new_path_str, e);
    }

    Ok(Json(serde_json::json!({ "path": new_path_str })))
}

#[cfg(test)]
mod path_guard_tests {
    use super::is_absolute_non_traversing;

    #[test]
    fn requires_absolute_and_rejects_traversal() {
        // An absolute path (temp_dir is absolute on every platform) is accepted.
        let abs = std::env::temp_dir().join("series 01.cbz");
        assert!(is_absolute_non_traversing(&abs.to_string_lossy()));

        // Relative paths are rejected — Node resolves to absolute before calling the engine.
        assert!(!is_absolute_non_traversing("unmatched/series 01.cbz"));
        assert!(!is_absolute_non_traversing(""));

        // `..` is rejected even on an otherwise-absolute path.
        let traversal = std::env::temp_dir().join("..").join("etc");
        assert!(!is_absolute_non_traversing(&traversal.to_string_lossy()));
    }
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
        let (convert_to_webp, webp_quality) = converter::get_webp_settings(&db.pool).await;
        log::info!("[Repack] WebP conversion: {} (quality {})", convert_to_webp, webp_quality);

        // Collect every issue across all requested series, then process them through one bounded pool.
        // This fixes the previously strictly-sequential repack (P-2) without going unbounded (P-1).
        let mut targets: Vec<(String, String)> = Vec::new();
        for series_id in &payload.series_ids {
            let issues = sqlx::query(r#"SELECT id, "filePath" FROM "Issue" WHERE "seriesId" = $1 AND "filePath" IS NOT NULL"#)
                .bind(series_id)
                .fetch_all(&db.pool)
                .await
                .unwrap_or_default();
            for issue in issues {
                targets.push((issue.get("id"), issue.get("filePath")));
            }
        }
        log::info!("[Repack] Processing {} archives across {} series.", targets.len(), payload.series_ids.len());

        let cfg = engine_config::EngineConfig::load(&db.pool).await;
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
                    // Flattening can drop junk entries, so refresh the pageCount the OPDS feed
                    // advertises (parity with Node repackArchive); the CASE keeps an unreadable
                    // result from zeroing a previously-known count.
                    let count_path = new_path.clone();
                    let pages = tokio::task::spawn_blocking(move || converter::count_zip_pages(&count_path))
                        .await.ok().flatten().unwrap_or(0);
                    let mut db_ok = true;
                    // process_archive already deleted the original and renamed the .cbz, so a failed
                    // UPDATE would orphan the Issue row pointing at a now-deleted path — surface it.
                    if let Err(e) = sqlx::query(
                        r#"UPDATE "Issue" SET "filePath" = $1,
                               "pageCount" = CASE WHEN $2 > 0 THEN $2 ELSE "pageCount" END
                           WHERE id = $3"#
                    )
                        .bind(&new_path_str)
                        .bind(pages)
                        .bind(&issue_id)
                        .execute(&db.pool)
                        .await
                    {
                        log::error!("[Repack] Repacked {} on disk but failed to update its database record: {:?}", file_path, e);
                        db_ok = false;
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

        write_joblog(&db, "REPACK_ARCHIVES", status, duration_ms, message.clone()).await;

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
        match sqlx::query(&format!(
            r#"INSERT INTO "JobLock" (id, "lockedAt") VALUES ($1, {now})
               ON CONFLICT (id) DO UPDATE SET "lockedAt" = {now}
               WHERE {stale}"#,
            now = db.now_expr(),
            stale = db.older_than(r#""JobLock"."lockedAt""#, 600)
        ))
        .bind(&lock_id)
        .execute(&db.pool)
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
        let _ = sqlx::query(r#"DELETE FROM "JobLock" WHERE id = $1"#).bind(&lock_id).execute(&db.pool).await;
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
        match metadata::sync_metadata(state.db.clone(), payload.series_ids).await {
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

        match metadata_writer::process_embed_job(state.db.clone(), payload).await {
            Ok((success, fail, json_count)) => {
                let duration = start_time.elapsed().as_millis() as i32;
                let status = if fail > 0 { "COMPLETED_WITH_ERRORS" } else { "COMPLETED" };
                let msg = format!("Metadata embedding complete. Updated {} files. Failed: {}. Exported {} series.json files.", success, fail, json_count);
                
                log::info!("{}", msg);

                write_joblog(&db, "EMBED_METADATA", status, duration, msg).await;
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
        .fetch_optional(&state.db.pool).await.ok().flatten().as_deref() == Some("true");
    let global_prioritize = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'prioritize_packs'"#)
        .fetch_optional(&state.db.pool).await.ok().flatten().as_deref() == Some("true");
    let use_packs = global_allow_bulk && payload.allow_packs.unwrap_or(false);
    let prioritize_packs = global_prioritize && use_packs;

    let acronyms = search_engine::get_custom_acronyms(&state.db.pool).await.unwrap_or_default();
    let year_str = req_year.clone().unwrap_or_default();
    let mut queries = search_engine::generate_search_queries(&payload.name, &year_str, &acronyms, prioritize_packs, use_packs);

    if !queries.contains(&payload.name) {
        queries.insert(0, payload.name.clone());
    }

    // Resolve the admin-configured source order (default: GetComics → Prowlarr; Anna's Archive opt-in).
    // skip_indexers (DDL-only requests) drops Prowlarr from the order.
    let ssp: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'search_source_priority'"#)
        .fetch_optional(&state.db.pool).await.ok().flatten();
    let mut source_order = search_engine::parse_search_source_order(ssp.as_deref());
    if skip_indexers {
        log::info!("skip_indexers set — excluding Prowlarr from the source order.");
        source_order.retain(|s| s != "prowlarr");
    }
    log::info!("Search source order for {}: [{}]", payload.name, source_order.join(", "));

    let run_get = source_order.iter().any(|s| s == "getcomics");
    let run_annas = source_order.iter().any(|s| s == "annas_archive");
    let run_prow = source_order.iter().any(|s| s == "prowlarr");

    // Search every enabled source concurrently; the priority loop below picks the first that yields a
    // downloadable match.
    let (get_res_raw, annas_res_raw, prow_res_raw) = tokio::join!(
        async { if run_get {
            getcomics::search(&state.db.pool, &state.limiter, &queries, false, &payload.name, req_year.as_deref(), series_year.as_deref(), is_manga, Some(use_packs)).await
        } else { Ok::<Vec<prowlarr::ProwlarrResult>, anyhow::Error>(Vec::new()) } },
        async { if run_annas {
            annas_archive::search(&state.db.pool, &state.limiter, &queries, false, is_manga).await
        } else { Ok::<Vec<prowlarr::ProwlarrResult>, anyhow::Error>(Vec::new()) } },
        async { if run_prow {
            prowlarr::search(&state.db.pool, &state.limiter, &queries, is_manga, true).await
        } else { Ok::<Vec<prowlarr::ProwlarrResult>, anyhow::Error>(Vec::new()) } }
    );

    // Drop blocklisted releases (previously-failed downloads) before stall counting + scoring (parity
    // with automation.ts failedItems): blocked if the list contains its title, download URL, GUID, or
    // info-hash (the latter cover Prowlarr's trackingHash = infoHash||guid||downloadUrl).
    let blocklist = payload.failed_links.clone().unwrap_or_default();
    let not_blocked = |r: &prowlarr::ProwlarrResult| -> bool {
        !blocklist.iter().any(|f| {
            f == &r.title || f == &r.download_url || f == &r.guid || r.info_hash.as_deref() == Some(f.as_str())
        })
    };
    let get_res: Vec<prowlarr::ProwlarrResult> = get_res_raw.unwrap_or_default().into_iter().filter(|r| not_blocked(r)).collect();
    let annas_res: Vec<prowlarr::ProwlarrResult> = annas_res_raw.unwrap_or_default().into_iter().filter(|r| not_blocked(r)).collect();
    let prow_res: Vec<prowlarr::ProwlarrResult> = prow_res_raw.unwrap_or_default().into_iter().filter(|r| not_blocked(r)).collect();

    let mut best_match: Option<prowlarr::ProwlarrResult> = None;
    // A GetComics match whose only hosters are user-disabled is held here, then surfaced as a MANUAL_DDL
    // link if nothing else wins (parity with automation.ts fallbackManualUrl).
    let mut manual_fallback: Option<(String, String)> = None;
    // Ranked DDL links for the chosen match — Node tries them in order at download time.
    let mut ddl_candidates: Vec<DdlCandidate> = Vec::new();

    // Section-target a multi-pack GetComics article to the requested issue (node main beta.047): only
    // when the request explicitly names an issue (same marker rule as Node's caller); the dynamic
    // per-issue year disambiguates same-numbered issues across volumes. Derived once, outside the
    // source loop (it depends only on the request itself).
    let re_target_issue = regex::Regex::new(r"(?i)(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(-?\d+(?:\.\d+)?)").unwrap();
    let dl_target = re_target_issue.captures(&payload.name)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<f32>().ok())
        .map(|n| getcomics::DeepLinkTarget { issue_num: n, year: req_year.clone() });

    // Evaluate sources in the configured priority order; the first downloadable match wins.
    for source in &source_order {
        match source.as_str() {
            "getcomics" => {
                if get_res.is_empty() { continue; }

                // Multiple distinct GetComics editions for one request → stall for human review. This is
                // a GetComics-specific ambiguity (curated articles); Anna's Archive routinely returns
                // many results and is resolved by scoring instead, so the stall doesn't apply there.
                let editions: std::collections::HashSet<String> =
                    get_res.iter().map(|r| search_engine::normalize_edition_title(&r.title)).collect();
                if get_res.len() > 1 && editions.len() > 1 {
                    log::warn!("Multiple distinct DDL editions found for {}. Stalling for admin review.", payload.name);
                    return Json(SearchResponse { success: false, best_match: None, stall_for_review: true, stall_reason: None, manual_ddl: None, ddl_candidates: Vec::new() });
                }

                // GetComics results are already relevance-filtered in getcomics::search → operator
                // junk/exclude lists + scoring only (skip_relevance = true).
                if let Ok(Some(mut best_ddl)) = search_engine::filter_and_score(
                    &state.db.pool, get_res.clone(), &payload.name, is_manga, req_year.clone(), series_year.clone(), true, Some(use_packs)
                ).await {
                    // Resolve the article to concrete hoster links; scrape_deep_link drops disabled
                    // hosters, so an empty list means no enabled hoster can serve this match.
                    let outcome = getcomics::scrape_deep_link(&state.db.pool, &state.limiter, &best_ddl.download_url, dl_target.as_ref())
                        .await.unwrap_or(getcomics::DeepLinkOutcome::Links(Vec::new()));
                    let candidates = match outcome {
                        getcomics::DeepLinkOutcome::Ambiguous => {
                            // Multi-pack page and no single archive cleanly contains the requested issue —
                            // grabbing an arbitrary archive would download the wrong volume, so stall for
                            // the admin to pick via Interactive Search (parity with automation.ts beta.047).
                            log::warn!("[GetComics] \"{}\" is a multi-pack page and no single archive cleanly matched {}. Stalling for admin review.", best_ddl.title, payload.name);
                            return Json(SearchResponse {
                                success: false,
                                best_match: None,
                                stall_for_review: true,
                                stall_reason: Some(format!(
                                    "GetComics lists **{}** only on a multi-pack page with several separate archives, and none cleanly contains the requested issue. Please use Interactive Search in the Active Downloads queue to select the correct archive.",
                                    payload.name
                                )),
                                manual_ddl: None,
                                ddl_candidates: Vec::new(),
                            });
                        }
                        getcomics::DeepLinkOutcome::Links(c) => c,
                    };
                    if let Some(top) = candidates.first() {
                        log::info!("[GetComics] Matched a Direct Download for {}.", payload.name);
                        best_ddl.download_url = top.url.clone();
                        best_ddl.indexer = top.hoster.clone();
                        ddl_candidates = candidates.iter()
                            .map(|c| DdlCandidate { url: c.url.clone(), hoster: c.hoster.clone() })
                            .collect();
                        best_match = Some(best_ddl);
                        break;
                    } else if manual_fallback.is_none() {
                        log::warn!("[GetComics] Best match for {} has no enabled hoster. Holding the manual link and trying the next source...", payload.name);
                        manual_fallback = Some((best_ddl.download_url.clone(), best_ddl.title.clone()));
                    }
                }
            }
            "annas_archive" => {
                if annas_res.is_empty() { continue; }
                // Anna's Archive results aren't pre-filtered (unlike GetComics) → full relevance scoring.
                if let Ok(Some(mut best_aa)) = search_engine::filter_and_score(
                    &state.db.pool, annas_res.clone(), &payload.name, is_manga, req_year.clone(), series_year.clone(), false, Some(use_packs)
                ).await {
                    // The result's download_url is already the resolvable /md5/ link — emit one candidate
                    // tagged for the existing Node resolver (premium key → stream; keyless → MANUAL_DDL).
                    log::info!("[Anna's Archive] Matched a result for {}.", payload.name);
                    ddl_candidates = vec![DdlCandidate { url: best_aa.download_url.clone(), hoster: "annas_archive".to_string() }];
                    best_aa.indexer = "annas_archive".to_string();
                    best_match = Some(best_aa);
                    break;
                }
            }
            "prowlarr" => {
                if prow_res.is_empty() { continue; }
                if let Ok(Some(best_prow)) = search_engine::filter_and_score(
                    &state.db.pool, prow_res.clone(), &payload.name, is_manga, req_year.clone(), series_year.clone(), false, Some(use_packs)
                ).await {
                    log::info!("[Prowlarr] Matched an indexer release for {}.", payload.name);
                    best_match = Some(best_prow);
                    break;
                }
            }
            _ => {}
        }
    }

    // DDL deep-links are already resolved above; Prowlarr results are torrents/usenet, returned as-is.
    if let Some(best) = best_match {
        return Json(SearchResponse { success: true, best_match: Some(best), stall_for_review: false, stall_reason: None, manual_ddl: None, ddl_candidates });
    }

    // Nothing auto-downloadable. If we held a GetComics link and GetComics is an enabled hoster, surface
    // it for manual download (parity with the automation.ts MANUAL_DDL fallback).
    if let Some((url, name)) = manual_fallback {
        if getcomics::is_getcomics_enabled(&state.db.pool).await {
            log::warn!("No downloadable release for {}. Reverting to the GetComics manual DDL fallback.", payload.name);
            return Json(SearchResponse { success: false, best_match: None, stall_for_review: false, stall_reason: None, manual_ddl: Some(ManualDdl { url, name }), ddl_candidates: Vec::new() });
        }
    }

    log::warn!("No valid release found for {} after checking all sources.", payload.name);
    Json(SearchResponse { success: false, best_match: None, stall_for_review: false, stall_reason: None, manual_ddl: None, ddl_candidates: Vec::new() })
}

async fn handle_interactive_search(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<InteractiveSearchQuery>,
) -> Json<InteractiveResponse> {
    log::info!("Received Interactive Search request for: {}", payload.query);
    
    // Prowlarr gets a specific→broad query ladder walked in first-hit mode: the raw modal term
    // alone ("…49 2026") misses zero-padded scene names ("…049…") and year-less tracker names
    // entirely, because newznab free-text search AND-matches every token (field report on
    // SIKTC #49). GetComics and Anna's keep the single raw query — both fan out / paginate
    // internally (getcomics::interactive_query_variants incl. de-pad; Anna's aggregates every
    // page per query), so handing them the ladder would multiply their anti-ban throttles.
    let ladder = search_engine::interactive_search_ladder(&payload.query, payload.year.as_deref());
    log::info!("[Interactive] Prowlarr query ladder ({} rung(s)): {:?}", ladder.len(), ladder);
    let queries = vec![payload.query.clone()];
    let is_manga = payload.is_manga.unwrap_or(false);

    // Anna's Archive is key-free for interactive search but OFF by default — only query it when the
    // admin has opted in. The empty-on-disabled future keeps all three sources in one concurrent join.
    let annas_enabled = annas_archive::is_interactive_enabled(&state.db.pool).await;

    let (prow_res, get_res, annas_res) = tokio::join!(
        prowlarr::search(&state.db.pool, &state.limiter, &ladder, is_manga, false),
        getcomics::search(&state.db.pool, &state.limiter, &queries, true, &payload.query, payload.year.as_deref(), payload.year.as_deref(), is_manga, None),
        async {
            if annas_enabled {
                annas_archive::search(&state.db.pool, &state.limiter, &queries, true, is_manga).await
            } else {
                Ok(Vec::new())
            }
        }
    );

    Json(InteractiveResponse {
        prowlarr: prow_res.unwrap_or_default(),
        getcomics: get_res.unwrap_or_default(),
        annas_archive: annas_res.unwrap_or_default(),
    })
}

#[derive(serde::Deserialize)]
struct ScrapeRequest {
    url: String,
    /// The requested issue number, when the request names one — enables multi-pack section targeting.
    #[serde(default)]
    issue_num: Option<f32>,
    /// Dynamic per-issue year, to disambiguate same-numbered issues across volumes.
    #[serde(default)]
    year: Option<String>,
}

#[derive(serde::Serialize)]
struct ScrapeResponse {
    success: bool,
    /// True when the article is a multi-pack page and no single archive cleanly contains the requested
    /// issue — the caller should NOT grab an arbitrary archive (it may be the wrong volume).
    ambiguous: bool,
    /// Ranked enabled-hoster links (highest priority first); empty when none resolved.
    links: Vec<getcomics::DeepLinkResult>,
}

/// Resolve a GetComics article page to concrete, enabled-hoster download links — the same
/// section-targeting logic the automated search uses. Node's retry/manual routes forward here instead
/// of their own flat scraper so a multi-pack article can't hand back the wrong volume's archive.
async fn handle_getcomics_scrape(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ScrapeRequest>,
) -> Json<ScrapeResponse> {
    let target = payload.issue_num.map(|n| getcomics::DeepLinkTarget { issue_num: n, year: payload.year.clone() });
    match getcomics::scrape_deep_link(&state.db.pool, &state.limiter, &payload.url, target.as_ref()).await {
        Ok(getcomics::DeepLinkOutcome::Links(links)) => Json(ScrapeResponse { success: true, ambiguous: false, links }),
        Ok(getcomics::DeepLinkOutcome::Ambiguous) => Json(ScrapeResponse { success: false, ambiguous: true, links: Vec::new() }),
        Err(e) => {
            log::warn!("[GetComics] scrape endpoint failed for {}: {:?}", payload.url, e);
            Json(ScrapeResponse { success: false, ambiguous: false, links: Vec::new() })
        }
    }
}

async fn handle_matcher_sweep(State(state): State<Arc<AppState>>) -> StatusCode {
    log::info!("Received request to run the unmatched-series retry sweep.");

    tokio::spawn(async move {
        let db = state.db.clone();
        let start_time = std::time::Instant::now();
        match matcher::run_unmatched_sweep(state.db.clone()).await {
            Ok(outcome) => {
                let duration = start_time.elapsed().as_millis() as i32;
                write_joblog(&db, "UNMATCHED_SWEEP", "COMPLETED", duration, outcome.summary.clone()).await;
                // Notify only when the sweep actually matched something — an hourly "nothing to do"
                // would train admins to ignore the event entirely.
                if outcome.matched > 0 {
                    notify_node("job_unmatched_sweep", outcome.summary.trim_start_matches("[Matcher] ")).await;
                }
            }
            Err(e) => {
                let duration = start_time.elapsed().as_millis() as i32;
                log::error!("[Matcher] Unmatched sweep failed: {:?}", e);
                matcher::record_sweep_result(&db, serde_json::json!({
                    "status": "FAILED", "error": e.to_string(), "finishedAt": matcher::now_ms(),
                })).await;
                write_joblog(&db, "UNMATCHED_SWEEP", "FAILED", duration, format!("Unmatched sweep failed: {}", e)).await;
                notify_node("job_unmatched_sweep", "The unmatched-series sweep failed. Check the engine logs.").await;
            }
        }
    });

    StatusCode::OK
}

async fn handle_watched_sync(State(state): State<Arc<AppState>>) -> StatusCode {
    log::info!("Received request to process Watched Folder.");

    tokio::spawn(async move {
        let db = state.db.clone();
        let start_time = std::time::Instant::now();

        match watched_sync::process_watched_folder(state.db.clone()).await {
            Ok((_success, _unmatched, details)) => {
                let duration = start_time.elapsed().as_millis() as i32;
                log::info!("{}", details);

                write_joblog(&db, "WATCHED_FOLDER_SYNC", "COMPLETED", duration, details).await;
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

                write_joblog(&db, "DATABASE_BACKUP", "COMPLETED", duration, details).await;
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

        match discover::run_discover_sync(state.db.clone()).await {
            Ok((_count, details)) => {
                let duration = start_time.elapsed().as_millis() as i32;
                log::info!("{}", details);

                write_joblog(&db, "DISCOVER_SYNC", "COMPLETED", duration, details).await;
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
    match download::stream_download(&state.db.pool, req).await {
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

                write_joblog(&db, "DIAGNOSTICS", "COMPLETED", duration, details).await;
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

                write_joblog(&db, "STORAGE_SCAN", "COMPLETED", duration, details).await;
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

                write_joblog(&db, "DIAGNOSTICS", "COMPLETED", duration, details).await;
            }
            Err(e) => {
                log::error!("❌ Archive Integrity Scan failed: {:?}", e);
                write_failed_joblog(&db, "DIAGNOSTICS", start_time.elapsed().as_millis() as i32, format!("Integrity scan failed: {:?}", e)).await;
            }
        }
    });

    StatusCode::ACCEPTED
}