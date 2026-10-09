// Direct-download streaming (the raw byte pump for DDL hosters). Ported from download-clients.ts
// `downloadDirectFile`'s streaming half per the roadmap: the engine owns the chunked stream, the 45s
// stall-watchdog, throttled progress writes, the suspiciously-small-file guard, and the .part→final
// rename. Hoster *resolution* (HosterEngine.resolveLink) and the Mega SDK stream stay in Node, which
// calls this only for plain HTTP(S) URLs and handles the failure alert.
use anyhow::{anyhow, bail, Result};
 
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use std::sync::OnceLock;
use futures_util::StreamExt;

const STALL_SECS: u64 = 45;
const DEFAULT_MIN_SIZE: u64 = 500_000;

/// How long a FlareSolverr-obtained Cloudflare clearance is reused before re-solving. cf_clearance
/// usually lasts much longer; a conservative window keeps it fresh while collapsing a burst of downloads
/// onto a single solve. A stale cookie is also caught at use-time (re-solve on a fresh challenge).
const CLEARANCE_TTL: std::time::Duration = std::time::Duration::from_secs(600);

struct CachedClearance {
    cookie: String,
    user_agent: String,
    fetched_at: std::time::Instant,
}

fn clearance_cache() -> &'static Mutex<Option<CachedClearance>> {
    static CACHE: OnceLock<Mutex<Option<CachedClearance>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Returns a Cloudflare clearance (cookie header, User-Agent), reusing a cached one within the TTL.
/// The solve runs WHILE HOLDING THE LOCK, so a burst of concurrent GetComics downloads triggers ONE
/// FlareSolverr solve — the rest wait on the lock and reuse the result — instead of stampeding a
/// single-browser FlareSolverr into "no usable cookies" / timeouts.
async fn get_clearance(client: &reqwest::Client, db: &sqlx::AnyPool, flare_url: &str, url: &str, sc: &crate::getcomics::SolverConfig) -> Result<(String, String)> {
    let mut guard = clearance_cache().lock().await;
    if let Some(c) = guard.as_ref() {
        if c.fetched_at.elapsed() < CLEARANCE_TTL {
            return Ok((c.cookie.clone(), c.user_agent.clone()));
        }
    }
    let c = crate::getcomics::flaresolverr_clearance(client, db, flare_url, url, sc).await?;
    *guard = Some(CachedClearance { cookie: c.cookie.clone(), user_agent: c.user_agent.clone(), fetched_at: std::time::Instant::now() });
    Ok((c.cookie, c.user_agent))
}

/// A FRESH solve of `url` itself (never served from cache) returning the full clearance including
/// the solver's landed URL. Used when the cached-cookie replay still answers with a challenge: the
/// landed URL is per-solve and per-link, so only a fresh solve of THIS url can produce it. Updates
/// the shared cache so followers still benefit from the new cookie.
async fn get_clearance_full(client: &reqwest::Client, db: &sqlx::AnyPool, flare_url: &str, url: &str, sc: &crate::getcomics::SolverConfig) -> Result<crate::getcomics::SolverClearance> {
    let mut guard = clearance_cache().lock().await;
    let c = crate::getcomics::flaresolverr_clearance(client, db, flare_url, url, sc).await?;
    *guard = Some(CachedClearance { cookie: c.cookie.clone(), user_agent: c.user_agent.clone(), fetched_at: std::time::Instant::now() });
    Ok(c)
}

/// The scheme://host/ origin of a URL (e.g. https://getcomics.org/), falling back to getcomics.org if
/// it can't be parsed. Used as the HTML page to solve the Cloudflare challenge against, and for the
/// warm-up visit.
fn site_origin(url: &str) -> String {
    reqwest::Url::parse(url).ok()
        .and_then(|u| u.host_str().map(|h| format!("{}://{}/", u.scheme(), h)))
        .unwrap_or_else(|| "https://getcomics.org/".to_string())
}

/// Joins a response's Set-Cookie headers into one Cookie request-header value ("a=1; b=2"), taking
/// just the `name=value` before each cookie's attributes. Used by the warm-up below.
fn collect_set_cookies(resp: &reqwest::Response) -> String {
    resp.headers().get_all(reqwest::header::SET_COOKIE).iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|c| c.split(';').next())
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect::<Vec<_>>()
        .join("; ")
}

/// Lever #2 — Cloudflare cookie warm-up. Before paying for a FlareSolverr/Byparr solve, visit the
/// site origin so Cloudflare's `__cf_bm` bot-management cookie (and an existing `cf_clearance`, when
/// the host hands one out without a full interactive challenge) is captured, then re-request the gated
/// URL carrying those cookies + a referer. This clears the *light* challenge variant — the kind a
/// browser passes invisibly — without involving a solver at all. Best-effort: a hard interactive
/// Turnstile won't be cleared this way (the engine runs no JS), so the solver fallback still runs when
/// this doesn't get past it. Returns the retried response (which the caller re-checks for HTML).
async fn warm_up_and_retry(client: &reqwest::Client, req: &StreamRequest) -> Result<reqwest::Response> {
    let origin = site_origin(&req.url);
    log::info!("[Internal DL] Cloudflare cookie warm-up: visiting {} to seed cf cookies.", origin);
    let warm_cookies = match client.get(&origin)
        .header("User-Agent", DEFAULT_UA)
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .timeout(std::time::Duration::from_secs(20))
        .send().await
    {
        Ok(r) => collect_set_cookies(&r),
        Err(e) => { log::debug!("[Internal DL] warm-up origin visit failed: {e}"); String::new() }
    };
    if warm_cookies.is_empty() {
        bail!("warm-up obtained no cookies");
    }
    establish_stream(client, req, &req.url, Some(&warm_cookies), DEFAULT_UA, None).await
}

#[derive(Deserialize)]
pub struct StreamRequest {
    pub request_id: String,
    pub url: String,
    /// Extra request headers from the Node hoster resolver (e.g. cookies/referer).
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Final destination path (the Issue/Request filePath Node computed).
    pub dest_path: String,
    #[serde(default)]
    pub min_size_bytes: Option<u64>,
    /// Extension used for the timestamped rename fallback when the final path is locked.
    #[serde(default)]
    pub ext: Option<String>,
}

#[derive(Serialize)]
pub struct StreamResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// True when an IP is in a range that should never be a download target (loopback, RFC-1918,
/// link-local, CGNAT, ULA, etc.) — blocks SSRF to internal services.
fn is_blocked_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified()
                || v4.is_broadcast() || v4.is_documentation()
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 0x40) // CGNAT 100.64/10
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // unique-local fc00::/7
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
        }
    }
}

/// Rejects non-HTTP(S) schemes and hosts that resolve to an internal address before any request is
/// made. Best-effort (DNS can change before the real connect), but it closes the obvious SSRF paths.
async fn validate_download_target(url_str: &str) -> Result<()> {
    let url = reqwest::Url::parse(url_str).map_err(|_| anyhow::anyhow!("Invalid download URL"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => bail!("Refusing to download from non-HTTP(S) scheme: {other}"),
    }
    let host = url.host_str().ok_or_else(|| anyhow::anyhow!("Download URL has no host"))?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| anyhow::anyhow!("Could not resolve download host {host}: {e}"))?;
    for addr in addrs {
        if is_blocked_ip(&addr.ip()) {
            bail!("Refusing to download from internal address ({})", addr.ip());
        }
    }
    Ok(())
}

/// A COMPLETE browser UA. The old value stopped mid-token at "AppleWebKit/537.36" (no Chrome/ or
/// Safari/ suffix) — a classic bot-fingerprint signature that invited the very challenges the solver
/// then had to clear (2026-07 Kapowarr review, hygiene item). Keep in sync with main.rs
/// browser_http_client.
const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

/// 429 is a throttle, not a challenge — it must never burn a 300s solver run.
fn is_rate_limited(status: u16) -> bool { status == 429 }

// #240: what a finished transfer must prove before the importer sees it. Three outcomes, three
// retry behaviours (download_with_retries):
//   - TRUNCATED: fewer bytes than announced - the banked bytes are a good prefix, resume them;
//   - RESTART:   the bytes on disk can't be trusted (a resume answered from the wrong offset, more
//                bytes than announced, an archive that doesn't open after a body of unknown length)
//                - drop them and re-fetch from zero;
//   - CORRUPT:   every announced byte arrived and the archive still doesn't open - the file itself
//                is bad, so the same URL won't do better: stop, and let Node try the next hoster.
const ERR_TRUNCATED: &str = "Download truncated";
const ERR_RESTART: &str = "restarting from zero";
const ERR_CORRUPT: &str = "Downloaded archive is corrupt";
const ERR_INCOMPLETE: &str = "Downloaded archive is incomplete";

/// The download-integrity failures above. For a getcomics link these are NOT "manual download
/// required" - the file came through and was bad - so they pass through for the next hoster.
fn is_integrity_failure(err: &str) -> bool {
    [ERR_TRUNCATED, ERR_RESTART, ERR_CORRUPT, ERR_INCOMPLETE].iter().any(|m| err.contains(m))
}

/// A getcomics failure becomes the "manual download required" hold unless it is a 429 throttle (the
/// user would click into the same throttle) or an integrity failure (the file arrived and was bad).
fn holds_for_manual_download(err: &str) -> bool {
    !err.contains("rate limited") && !is_integrity_failure(err)
}

/// `Content-Range: bytes <start>-<end>/<total|*>` → (start, total).
fn parse_content_range(value: &str) -> Option<(u64, Option<u64>)> {
    let rest = value.trim().strip_prefix("bytes")?.trim();
    let (range, total) = rest.split_once('/')?;
    let (start, _end) = range.trim().split_once('-')?;
    let start = start.trim().parse::<u64>().ok()?;
    let total = match total.trim() {
        "*" => None,
        t => Some(t.parse::<u64>().ok()?),
    };
    Some((start, total))
}

/// How a response body relates to the bytes already banked in the .part file.
#[derive(Debug, PartialEq)]
struct BodyPlan {
    /// Append after the banked bytes (a 206 that starts exactly where they end).
    append: bool,
    already_have: u64,
    /// The whole file's size, when the server said: Content-Range's total, or the Content-Length.
    expected_total: Option<u64>,
}

/// A 206 must start exactly where the banked bytes end - appending a body that starts anywhere else
/// silently corrupts the file. Any other 2xx is a full body: truncate and count from zero.
fn plan_body(requested_resume: u64, partial: bool, content_length: Option<u64>, content_range: Option<&str>) -> Result<BodyPlan> {
    if !partial {
        return Ok(BodyPlan { append: false, already_have: 0, expected_total: content_length.filter(|l| *l > 0) });
    }
    let Some((start, total)) = content_range.and_then(parse_content_range) else {
        bail!("Partial response without a usable Content-Range; {}", ERR_RESTART);
    };
    if start != requested_resume {
        bail!("Range resume answered from byte {} instead of {}; {}", start, requested_resume, ERR_RESTART);
    }
    Ok(BodyPlan {
        append: requested_resume > 0,
        already_have: requested_resume,
        expected_total: total.or_else(|| content_length.map(|l| requested_resume + l)),
    })
}

/// A ZIP must open: its end record and central directory - the last bytes written - are what a cut
/// transfer loses first, and reading them doesn't touch the pages. RAR/7z are left to the length
/// checks (never judge unrar by its exit code; testing a GB-sized pack is too slow).
fn check_archive(path: &Path) -> std::result::Result<(), String> {
    if !crate::converter::is_zip_signature(&crate::converter::read_file_signature(path)) {
        return Ok(());
    }
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    zip::ZipArchive::new(file).map(|_| ()).map_err(|e| e.to_string())
}

/// Lower-cased Content-Type of a response (empty string if absent).
fn response_content_type(response: &reqwest::Response) -> String {
    response.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase()
}

/// Builds the outgoing header set with each header present exactly once. reqwest's `.header()`
/// APPENDS, so the old builder chain could emit duplicate Cookie/User-Agent headers whenever Node
/// passed its own — a bot signal on a Cloudflare-fronted host. Precedence: defaults < Node-supplied
/// < clearance (the cf_clearance cookie is IP+UA-bound to the solver, so when present it and the
/// solver's UA must win).
fn build_stream_headers(
    node_headers: &HashMap<String, String>,
    clearance_cookie: Option<&str>,
    user_agent: &str,
    resume_from: Option<u64>,
) -> reqwest::header::HeaderMap {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, COOKIE, RANGE, REFERER, USER_AGENT};
    let mut map = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(user_agent) { map.insert(USER_AGENT, v); }
    map.insert(ACCEPT, HeaderValue::from_static("application/zip, application/x-rar-compressed, application/octet-stream, */*"));
    map.insert(REFERER, HeaderValue::from_static("https://getcomics.org/"));
    for (k, v) in node_headers {
        if let (Ok(name), Ok(val)) = (k.parse::<HeaderName>(), HeaderValue::from_str(v)) {
            map.insert(name, val);
        }
    }
    if let Some(c) = clearance_cookie {
        if let Ok(v) = HeaderValue::from_str(c) { map.insert(COOKIE, v); }
        // The clearance cookie only validates alongside the exact UA the solver used.
        if let Ok(v) = HeaderValue::from_str(user_agent) { map.insert(USER_AGENT, v); }
    }
    if let Some(offset) = resume_from {
        if let Ok(v) = HeaderValue::from_str(&format!("bytes={}-", offset)) { map.insert(RANGE, v); }
    }
    map
}

/// Bytes already banked in the .part file are only resumable against the SAME url that wrote them —
/// switching targets (e.g. to the solver's landed URL) restarts from zero.
fn resume_offset(hint: &Option<(String, u64)>, target_url: &str) -> Option<u64> {
    match hint {
        Some((url, bytes)) if url == target_url && *bytes > 0 => Some(*bytes),
        _ => None,
    }
}

/// Establishes the download stream with up to 3 connection attempts (parity with the Node retry loop),
/// sending the deduplicated browser headers plus an optional Cloudflare clearance and Range resume.
/// `target_url` may differ from req.url when streaming from the solver's landed URL.
async fn establish_stream(
    client: &reqwest::Client,
    req: &StreamRequest,
    target_url: &str,
    cookie: Option<&str>,
    user_agent: &str,
    resume_from: Option<u64>,
) -> Result<reqwest::Response> {
    let headers = build_stream_headers(&req.headers, cookie, user_agent, resume_from);
    let mut last_err = String::new();
    for attempt in 1..=3 {
        match client.get(target_url).headers(headers.clone()).send().await {
            Ok(r) => return Ok(r),
            Err(e) => {
                last_err = e.to_string();
                log::warn!("[Internal DL] Attempt {} failed ({}). Retrying in 3s...", attempt, last_err);
                if attempt < 3 { tokio::time::sleep(std::time::Duration::from_secs(3)).await; }
            }
        }
    }
    bail!("Failed to connect after 3 attempts: {}", last_err)
}

pub async fn stream_download(db: &sqlx::AnyPool, req: StreamRequest) -> Result<String> {
    // For a getcomics.org /dls/ link, ANY failure to deliver the file automatically — an unsolved
    // Cloudflare challenge, OR a stalled/empty stream because the solver consumed getcomics' one-shot
    // signed download in its own browser (cookie-replay can't re-fetch it) — is best handed to the user
    // as a one-click manual download. Map every such failure to the "manual download required" marker so
    // Node holds the request as MANUAL_DDL instead of grinding to STALLED. Non-getcomics hosts keep their
    // original error (retry/stall as before).
    let is_getcomics = req.url.contains("getcomics.org");
    match run_stream_download(db, &req).await {
        Ok(path) => Ok(path),
        // A 429 throttle is NOT a "couldn't get past Cloudflare" situation — holding it for manual
        // download would just have the user click into the same throttle. Let it surface as a normal
        // retryable failure so the request lifecycle (retry route / dead-request sweep) re-fires it
        // once the window passes. Neither is a file that arrived truncated or corrupt (#240): that
        // error passes through so Node tries the next hoster (it still holds a getcomics link for
        // manual download if every hoster fails).
        Err(e) if is_getcomics && holds_for_manual_download(&e.to_string()) => {
            log::warn!("[Internal DL] GetComics download couldn't be completed automatically ({e}); holding for manual download.");
            bail!("GetComics download couldn't be completed automatically; manual download required.")
        }
        Err(e) => Err(e),
    }
}

async fn run_stream_download(db: &sqlx::AnyPool, req: &StreamRequest) -> Result<String> {
    let part_path = format!("{}.part", req.dest_path);
    let _ = tokio::fs::remove_file(&part_path).await; // clear any stale partial
    if let Some(parent) = Path::new(&req.dest_path).parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    // SSRF guard (defense-in-depth): the URL ultimately comes from a search result a privileged user
    // selected, so reject non-HTTP(S) schemes and hosts that resolve to an internal address.
    validate_download_target(&req.url).await?;

    // Re-validate every redirect hop. validate_download_target only checks the INITIAL url; the default
    // reqwest policy would otherwise follow a `302 Location: http://169.254.169.254/…` straight past the
    // guard. This synchronous hook rejects non-HTTP(S) schemes and internal IP-literal targets and caps
    // the chain. (A redirect to an internal *hostname* can't be DNS-resolved in this sync closure — the
    // common cloud-metadata / RFC-1918-literal vectors are the ones closed here.)
    let redirect_policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > 10 {
            return attempt.error(std::io::Error::other("too many redirects"));
        }
        let url = attempt.url();
        if !matches!(url.scheme(), "http" | "https") {
            return attempt.error(std::io::Error::other("redirect to non-HTTP(S) scheme blocked"));
        }
        if let Some(host) = url.host_str() {
            let host = host.trim_start_matches('[').trim_end_matches(']');
            if let Ok(ip) = host.parse::<std::net::IpAddr>() {
                if is_blocked_ip(&ip) {
                    return attempt.error(std::io::Error::other("redirect to internal address blocked"));
                }
            }
        }
        attempt.follow()
    });
    let client = reqwest::Client::builder().redirect(redirect_policy).build()?;

    download_with_retries(db, &client, req, &part_path).await?;

    // Overwrite any existing final file, then rename .part → final (timestamped fallback if locked).
    let _ = tokio::fs::remove_file(&req.dest_path).await;
    if tokio::fs::rename(&part_path, &req.dest_path).await.is_ok() {
        return Ok(req.dest_path.clone());
    }
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let ts_path = match &req.ext {
        Some(ext) if req.dest_path.ends_with(&format!(".{}", ext)) => {
            let stem = &req.dest_path[..req.dest_path.len() - ext.len() - 1];
            format!("{}_{}.{}", stem, ms, ext)
        }
        _ => format!("{}_{}", req.dest_path, ms),
    };
    tokio::fs::rename(&part_path, &ts_path).await?;
    Ok(ts_path)
}

/// Pause between attempts (short under test so retry paths don't slow the suite).
#[cfg(not(test))]
const RETRY_PAUSE: std::time::Duration = std::time::Duration::from_secs(3);
#[cfg(test)]
const RETRY_PAUSE: std::time::Duration = std::time::Duration::from_millis(10);

/// Runs up to three attempts and leaves the completed bytes at `part_path` on success (the .part is
/// removed on failure). Each attempt re-establishes the stream AND runs the transfer to completion: a
/// mid-stream 45s stall (or a truncated/too-small file, or an HTML error/challenge page) consumes a
/// retry instead of failing outright. Kapowarr-parity: partial bytes are BANKED between attempts — a
/// retry against the same URL asks for `Range: bytes=N-` and appends, so a 300MB stall doesn't restart
/// from zero (their client resumes as a matter of course; a 200 answer on the retry truncates and restarts).
async fn download_with_retries(db: &sqlx::AnyPool, client: &reqwest::Client, req: &StreamRequest, part_path: &str) -> Result<()> {
    const MAX_ATTEMPTS: u32 = 3;
    let mut last_err = anyhow!("download failed before any attempt");
    let mut resume_hint: Option<(String, u64)> = None;
    for attempt in 1..=MAX_ATTEMPTS {
        let (result, streamed_url) = attempt_stream_to_part(db, client, req, part_path, &resume_hint).await;
        match result {
            Ok(()) => return Ok(()),
            Err(e) => {
                let msg = e.to_string();
                // A 429 means the source will refuse the NEXT attempt too — stop burning retries. So
                // does a file that arrived whole and is still corrupt (#240): the same URL serves the
                // same bad bytes, so Node moves on to the next hoster instead.
                let is_throttle = msg.contains("rate limited");
                let is_corrupt = msg.contains(ERR_CORRUPT);
                // Bytes that can't be trusted are never resumed (#240): re-fetch from zero.
                let restart = msg.contains(ERR_RESTART);
                let part_len = tokio::fs::metadata(part_path).await.map(|m| m.len()).unwrap_or(0);
                resume_hint = if restart { None } else { streamed_url.filter(|_| part_len > 0).map(|u| (u, part_len)) };
                if resume_hint.is_none() {
                    let _ = tokio::fs::remove_file(part_path).await;
                }
                log::warn!(
                    "[Internal DL] Attempt {}/{} failed ({}){}.",
                    attempt, MAX_ATTEMPTS, e,
                    resume_hint.as_ref().map(|(_, n)| format!("; {} bytes banked for a Range resume", n)).unwrap_or_default()
                );
                last_err = e;
                if is_throttle || is_corrupt {
                    break;
                }
                if attempt < MAX_ATTEMPTS {
                    tokio::time::sleep(RETRY_PAUSE).await;
                }
            }
        }
    }
    let _ = tokio::fs::remove_file(part_path).await;
    Err(last_err)
}

/// A single download attempt. Returns the inner result PLUS the URL the attempt actually streamed
/// from (None when it failed before any body arrived) so the caller can bank partial bytes for a
/// same-URL Range resume on the next attempt.
async fn attempt_stream_to_part(
    db: &sqlx::AnyPool,
    client: &reqwest::Client,
    req: &StreamRequest,
    part_path: &str,
    resume_hint: &Option<(String, u64)>,
) -> (Result<()>, Option<String>) {
    let mut streamed_from: Option<String> = None;
    let result = attempt_stream_inner(db, client, req, part_path, resume_hint, &mut streamed_from).await;
    (result, streamed_from)
}

/// The attempt body: establish the stream (with the getcomics Cloudflare warm-up/solver dance),
/// reject an HTML page, stream to `part_path` under the 45s stall-watchdog, and reject a too-small
/// file. Leaves the completed bytes at `part_path` on success; any failure returns Err so the caller
/// can retry (with a Range resume when the same URL wrote partial bytes).
async fn attempt_stream_inner(
    db: &sqlx::AnyPool,
    client: &reqwest::Client,
    req: &StreamRequest,
    part_path: &str,
    resume_hint: &Option<(String, u64)>,
    streamed_from: &mut Option<String>,
) -> Result<()> {
    let is_getcomics = req.url.contains("getcomics.org");

    // First, a plain direct fetch. comicfiles / resolved-hoster URLs — and any getcomics.org link that
    // isn't actually behind a challenge — serve the file straight away and stream with zero FlareSolverr
    // overhead. A prior attempt's partial bytes resume here when the URL matches.
    let mut target_url = req.url.clone();
    let mut response = establish_stream(client, req, &target_url, None, DEFAULT_UA, resume_offset(resume_hint, &target_url)).await?;
    let mut content_type = response_content_type(&response);

    // A 429 is a throttle, not a challenge: solving it would burn a 300s solver run on a page that
    // isn't a challenge at all, and "manual download" would just hand the user the same throttle.
    // Flag it for the health panel and surface a distinct, retryable error.
    if is_rate_limited(response.status().as_u16()) && is_getcomics {
        crate::getcomics::mark_getcomics_rate_limit_flag(db).await;
        bail!("GetComics rate limited (429) the download link; deferring for a later retry.");
    }

    // When a getcomics.org link answers with an HTML page — the Cloudflare challenge on the /dls/
    // main-server links — try to get past it. First (lever #2) a cheap cookie warm-up that clears the
    // light challenge variant with no solver; only if that fails do we pay for a FlareSolverr/Byparr
    // solve. A non-challenged download never enters this branch.
    if content_type.contains("text/html") && is_getcomics {
        match warm_up_and_retry(client, req).await {
            Ok(warmed) => {
                let warmed_ct = response_content_type(&warmed);
                if !warmed_ct.contains("text/html") {
                    log::info!("[Internal DL] Cloudflare cookie warm-up cleared the challenge without a solver.");
                    response = warmed;
                    content_type = warmed_ct;
                }
            }
            Err(e) => log::debug!("[Internal DL] Cloudflare cookie warm-up did not clear the challenge ({e}); falling back to the solver."),
        }
    }

    // Still a challenge after the warm-up → solve it via FlareSolverr/Byparr. The cached-cookie
    // replay is tried first (cheap, collapses bursts onto one solve). When that still answers with a
    // challenge, a FRESH solve of THIS url runs — and Kapowarr-parity, the stream then goes to the
    // solver's LANDED URL when it reports one: for getcomics' one-shot signed /dls/ links the solve
    // itself may consume the original hop, so wherever the solver's browser ended up (post-redirect,
    // post-challenge) is the fetchable target, with the original URL kept as the fallback.
    if content_type.contains("text/html") && is_getcomics {
        let flare: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'flaresolverr_url'"#)
            .fetch_optional(db).await.ok().flatten().filter(|s: &String| !s.trim().is_empty());
        match flare {
            Some(flare_url) => {
                let sc = crate::getcomics::solver_config(db).await;
                match get_clearance(client, db, &flare_url, &req.url, &sc).await {
                    Ok((cookie, ua)) => {
                        log::info!("[Internal DL] GetComics Cloudflare challenge solved via {}; replaying the clearance on the download.", sc.kind);
                        let ua_eff = if ua.is_empty() { DEFAULT_UA.to_string() } else { ua };
                        response = establish_stream(client, req, &target_url, Some(&cookie), &ua_eff, resume_offset(resume_hint, &target_url)).await?;
                        content_type = response_content_type(&response);
                        // Cached cookie stale (or the original hop already consumed) → one fresh solve
                        // of THIS url, then prefer its landed URL for the stream.
                        if content_type.contains("text/html") {
                            match get_clearance_full(client, db, &flare_url, &req.url, &sc).await {
                                Ok(clearance) => {
                                    let ua_eff = if clearance.user_agent.is_empty() { DEFAULT_UA.to_string() } else { clearance.user_agent.clone() };
                                    // Only chase the landed URL when the solver's browser actually
                                    // reached it (2xx there; unknown status = still worth trying).
                                    let landed_reachable = clearance.solved_status.map(|s| (200..300).contains(&s)).unwrap_or(true);
                                    if let Some(landed) = clearance.solved_url.as_deref().filter(|u| *u != req.url && landed_reachable) {
                                        log::info!("[Internal DL] Streaming from the solver's landed URL instead of the original /dls/ hop.");
                                        let landed_resp = establish_stream(client, req, landed, Some(&clearance.cookie), &ua_eff, resume_offset(resume_hint, landed)).await?;
                                        let landed_ct = response_content_type(&landed_resp);
                                        if !landed_ct.contains("text/html") {
                                            target_url = landed.to_string();
                                            response = landed_resp;
                                            content_type = landed_ct;
                                        }
                                    } else if !landed_reachable {
                                        log::debug!("[Internal DL] Solver landed on a non-2xx page (status {:?}); keeping the original URL.", clearance.solved_status);
                                    }
                                    if content_type.contains("text/html") {
                                        response = establish_stream(client, req, &target_url, Some(&clearance.cookie), &ua_eff, resume_offset(resume_hint, &target_url)).await?;
                                        content_type = response_content_type(&response);
                                    }
                                }
                                Err(e) => log::warn!("[Internal DL] fresh {} solve failed ({e}).", sc.kind),
                            }
                        }
                    }
                    Err(e) => log::warn!("[Internal DL] {} clearance failed ({e}).", sc.kind),
                }
            }
            None => log::warn!("[Internal DL] GetComics returned a Cloudflare challenge but no solver URL is set."),
        }
    }

    // Reject an HTML webpage masquerading as a file (expired/blocked link, or an unsolved challenge).
    // For a getcomics.org link the outer wrapper turns this (and any later stall/small-file failure)
    // into the "manual download required" signal that holds the request as MANUAL_DDL.
    if content_type.contains("text/html") {
        bail!("Download URL returned an HTML webpage instead of a comic file.");
    }

    // #240: an error status is never the file (its body used to be saved as one). A 416 on a resume
    // means the banked bytes don't fit what the server has: start over.
    let requested_resume = resume_offset(resume_hint, &target_url).unwrap_or(0);
    let status = response.status();
    if !status.is_success() {
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && requested_resume > 0 {
            bail!("Download URL refused the resume (HTTP {}); {}", status, ERR_RESTART);
        }
        bail!("Download URL answered HTTP {}", status);
    }

    // From here on bytes may land in the .part file — record where they came from for resume banking.
    *streamed_from = Some(target_url.clone());

    // 206 = the server honored the Range resume: append after the banked bytes, but only when its
    // Content-Range starts exactly there (#240). Any 200 (even when a resume was requested) means a
    // full body: truncate and restart the count from zero.
    let content_range = response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let plan = plan_body(
        requested_resume,
        status == reqwest::StatusCode::PARTIAL_CONTENT,
        response.content_length(),
        content_range.as_deref(),
    )?;
    let total = plan.expected_total.unwrap_or(0);

    // Stream to the .part file. The 45s stall-watchdog is a per-chunk timeout: no data for 45s aborts
    // (Node reset a setTimeout on every 'data' event). Progress is throttled to every 5% / >2s.
    let mut file = if plan.append {
        tokio::fs::OpenOptions::new().append(true).open(part_path).await?
    } else {
        tokio::fs::File::create(part_path).await?
    };
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = plan.already_have;
    let mut last_pct: i64 = -1;
    let mut last_update = std::time::Instant::now();
    let mut first_update = true;

    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(STALL_SECS), stream.next()).await {
            Err(_) => {
                log::error!("[Internal DL] Data stream stalled for {} seconds. Aborting to trigger retry.", STALL_SECS);
                bail!("Download stalled for {} seconds", STALL_SECS);
            }
            Ok(None) => break, // stream finished
            Ok(Some(Err(e))) => {
                bail!("Stream error: {}", e);
            }
            Ok(Some(Ok(chunk))) => {
                file.write_all(&chunk).await?;
                downloaded += chunk.len() as u64;
                if total > 0 {
                    let pct = ((downloaded as f64 / total as f64) * 100.0) as i64;
                    if pct % 5 == 0 && pct != last_pct && (first_update || last_update.elapsed().as_millis() > 2000) {
                        first_update = false;
                        last_pct = pct;
                        last_update = std::time::Instant::now();
                        let _ = sqlx::query(r#"UPDATE "Request" SET progress = $1 WHERE id = $2"#)
                            .bind(pct as i32).bind(&req.request_id).execute(db).await;
                    }
                }
            }
        }
    }
    file.flush().await?;
    drop(file);

    // #240: a clean end of stream is not proof of a whole file - compare with what was announced.
    if let Some(expected) = plan.expected_total {
        if downloaded < expected {
            bail!("{}: received {} of {} bytes", ERR_TRUNCATED, downloaded, expected);
        }
        if downloaded > expected {
            bail!("Received {} bytes but the server announced {}; {}", downloaded, expected, ERR_RESTART);
        }
    }

    // Reject suspiciously small files (a failed/blocked download often yields a tiny error page). The
    // caller cleans up the partial and retries (or, for getcomics, hands it to the manual-hold wrapper).
    let size = tokio::fs::metadata(part_path).await?.len();
    let min_size = req.min_size_bytes.unwrap_or(DEFAULT_MIN_SIZE);
    if size < min_size {
        bail!("Downloaded file is suspiciously small ({}kb). Aborting.", size / 1024);
    }

    // #240: a ZIP that doesn't open never reaches the importer (a 1.2 GB pack cut short was imported
    // as one issue with 0 pages). With the full announced length on disk the file itself is bad;
    // with no length to compare against, the transfer may simply have been cut - re-fetch it.
    let path = std::path::PathBuf::from(part_path);
    let verdict = tokio::task::spawn_blocking(move || check_archive(&path)).await?;
    if let Err(reason) = verdict {
        if plan.expected_total.is_some() {
            bail!("{} ({}); every announced byte arrived, so the file itself is bad", ERR_CORRUPT, reason);
        }
        bail!("{} ({}); {}", ERR_INCOMPLETE, reason, ERR_RESTART);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn blocks_internal_ipv4_ranges() {
        for s in [
            "127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.5.5", "172.31.255.255",
            "169.254.1.1", "0.0.0.0", "100.64.0.1", "100.127.255.255", "255.255.255.255",
        ] {
            assert!(is_blocked_ip(&ip(s)), "{s} should be blocked");
        }
    }

    #[test]
    fn allows_public_ipv4() {
        // 172.15/172.32 are outside the private 172.16-31 block; 100.63/100.128 outside CGNAT.
        for s in ["8.8.8.8", "1.1.1.1", "104.18.0.1", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.0"] {
            assert!(!is_blocked_ip(&ip(s)), "{s} should be allowed");
        }
    }

    #[test]
    fn blocks_internal_ipv6_allows_public() {
        assert!(is_blocked_ip(&ip("::1"))); // loopback
        assert!(is_blocked_ip(&ip("::"))); // unspecified
        assert!(is_blocked_ip(&ip("fe80::1"))); // link-local
        assert!(is_blocked_ip(&ip("fc00::1"))); // unique-local
        assert!(is_blocked_ip(&ip("fd12:3456::1"))); // unique-local
        assert!(!is_blocked_ip(&ip("2606:4700:4700::1111"))); // public (Cloudflare DNS)
    }

    #[tokio::test]
    async fn validate_rejects_bad_scheme_and_internal_literals() {
        assert!(validate_download_target("ftp://example.com/file").await.is_err());
        assert!(validate_download_target("file:///etc/passwd").await.is_err());
        assert!(validate_download_target("not a url").await.is_err());
        assert!(validate_download_target("http://127.0.0.1/x").await.is_err());
        assert!(validate_download_target("http://192.168.1.1/x").await.is_err());
        assert!(validate_download_target("http://[::1]/x").await.is_err());
        // A public literal IP resolves to itself (no DNS) and is allowed.
        assert!(validate_download_target("http://1.1.1.1/x").await.is_ok());
    }

    // The stream request must carry each header exactly once: reqwest's .header() APPENDS, so the old
    // builder chain could send duplicate Cookie/User-Agent headers when Node passed its own — a
    // Cloudflare bot signal. The clearance cookie/UA must WIN over both defaults and Node headers.
    #[test]
    fn stream_headers_are_deduplicated_and_clearance_wins() {
        let mut node_headers = HashMap::new();
        node_headers.insert("User-Agent".to_string(), "NodeUA/1.0".to_string());
        node_headers.insert("Cookie".to_string(), "node=1".to_string());
        node_headers.insert("X-Custom".to_string(), "keep".to_string());

        let map = build_stream_headers(&node_headers, Some("cf_clearance=abc"), "SolverUA/2.0", None);
        assert_eq!(map.get_all(reqwest::header::COOKIE).iter().count(), 1);
        assert_eq!(map.get_all(reqwest::header::USER_AGENT).iter().count(), 1);
        assert_eq!(map.get(reqwest::header::COOKIE).unwrap(), "cf_clearance=abc");
        assert_eq!(map.get(reqwest::header::USER_AGENT).unwrap(), "SolverUA/2.0");
        assert_eq!(map.get("X-Custom").unwrap(), "keep");
        // Without a clearance, Node's own headers override the defaults (still exactly once each).
        let map2 = build_stream_headers(&node_headers, None, DEFAULT_UA, None);
        assert_eq!(map2.get(reqwest::header::USER_AGENT).unwrap(), "NodeUA/1.0");
        assert_eq!(map2.get(reqwest::header::COOKIE).unwrap(), "node=1");
        // A resume offset adds a single Range header.
        let map3 = build_stream_headers(&HashMap::new(), None, DEFAULT_UA, Some(1024));
        assert_eq!(map3.get(reqwest::header::RANGE).unwrap(), "bytes=1024-");
    }

    // Range resume only applies when re-fetching the SAME url that wrote the partial bytes —
    // switching to the solver's landed URL (or any other target) must restart from zero.
    #[test]
    fn resume_offset_requires_matching_url() {
        let hint = Some(("https://getcomics.org/dls/x".to_string(), 4096u64));
        assert_eq!(resume_offset(&hint, "https://getcomics.org/dls/x"), Some(4096));
        assert_eq!(resume_offset(&hint, "https://cdn.example.net/landed"), None);
        assert_eq!(resume_offset(&None, "https://getcomics.org/dls/x"), None);
        // Zero bytes is not a resume.
        let zero = Some(("https://getcomics.org/dls/x".to_string(), 0u64));
        assert_eq!(resume_offset(&zero, "https://getcomics.org/dls/x"), None);
    }

    // The pre-solve UA must be a COMPLETE browser string: the old value stopped mid-token at
    // "AppleWebKit/537.36" (no Chrome/ or Safari/ suffix), a classic bot-fingerprint signature that
    // invites the very challenges the solver then has to clear.
    #[test]
    fn default_ua_is_a_complete_browser_string() {
        assert!(DEFAULT_UA.contains("Chrome/"), "UA should carry a Chrome token: {DEFAULT_UA}");
        assert!(DEFAULT_UA.ends_with("Safari/537.36"), "UA should end with the Safari token: {DEFAULT_UA}");
    }

    // ==== #240 finding 4: a truncated pack was declared complete. The stream loop ended on any clean
    // EOF and never compared what it received with what the server announced; a resume's 206 was
    // appended whatever range it carried; the HTTP status was never checked; and nothing looked at
    // the archive before it was handed to the importer.

    /// A raw HTTP server: each accepted connection gets the next canned response written verbatim,
    /// then the socket closes - so a response without Content-Length is a close-delimited body that
    /// can end anywhere (what a framework won't produce). Records each request's header block.
    async fn fake_server(responses: Vec<Vec<u8>>) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_by_server = seen.clone();
        tokio::spawn(async move {
            for resp in responses {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let mut head = Vec::new();
                let mut buf = [0u8; 1024];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => head.extend_from_slice(&buf[..n]),
                    }
                }
                seen_by_server.lock().unwrap().push(String::from_utf8_lossy(&head).to_lowercase());
                let _ = sock.write_all(&resp).await;
                let _ = sock.shutdown().await;
            }
        });
        (format!("http://{}/Pack.cbz", addr), seen)
    }

    fn http(status: &str, headers: &[(&str, String)], body: &[u8]) -> Vec<u8> {
        let mut head = format!("HTTP/1.1 {}\r\nConnection: close\r\nContent-Type: application/octet-stream\r\n", status);
        for (k, v) in headers {
            head.push_str(&format!("{}: {}\r\n", k, v));
        }
        head.push_str("\r\n");
        let mut out = head.into_bytes();
        out.extend_from_slice(body);
        out
    }

    /// A small valid CBZ (stored entries, so its length is predictable).
    fn zip_bytes() -> Vec<u8> {
        use std::io::Write;
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::FileOptions = zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for i in 0..4u8 {
                zw.start_file(format!("{:02}.jpg", i), opts).unwrap();
                zw.write_all(&vec![i; 4096]).unwrap();
            }
            zw.finish().unwrap();
        }
        buf
    }

    async fn dl_fixture(url: &str) -> (std::path::PathBuf, crate::db::Db, StreamRequest, String) {
        let dir = std::env::temp_dir().join(format!("omnibus_dl_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_file = dir.join("dl.db");
        std::fs::File::create(&db_file).unwrap();
        let db = crate::db::Db::connect(&format!("file:{}", db_file.to_string_lossy().replace('\\', "/")), 2).await.unwrap();
        let dest = dir.join("Pack.cbz").to_string_lossy().to_string();
        let req = StreamRequest {
            request_id: "req_1".into(), url: url.into(), headers: HashMap::new(),
            dest_path: dest.clone(), min_size_bytes: Some(1), ext: Some("cbz".into()),
        };
        (dir, db, req, format!("{}.part", dest))
    }

    #[tokio::test]
    async fn a_truncated_pack_without_a_length_is_never_accepted() {
        let zip = zip_bytes();
        let half = zip[..zip.len() / 2].to_vec();
        // The connection just closes mid-archive, three times over: no Content-Length, no error.
        let (url, seen) = fake_server(vec![http("200 OK", &[], &half), http("200 OK", &[], &half), http("200 OK", &[], &half)]).await;
        let (dir, db, req, part) = dl_fixture(&url).await;

        let err = download_with_retries(&db.pool, &reqwest::Client::new(), &req, &part).await.unwrap_err();

        assert!(err.to_string().contains("incomplete"), "{err}");
        assert!(!Path::new(&part).exists(), "no partial left behind");
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 3, "an incomplete download is retried");
        assert!(seen.iter().all(|h| !h.contains("range:")), "an archive that may be corrupt is re-fetched from zero, not resumed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_complete_but_corrupt_archive_fails_without_retrying_the_same_url() {
        let mut corrupt = zip_bytes();
        let n = corrupt.len();
        for b in &mut corrupt[n - 22..] { *b = 0; } // the end-of-central-directory record is gone
        let len = corrupt.len().to_string();
        let good = zip_bytes();
        let good_len = good.len().to_string();
        // Every announced byte arrives, and the archive is still unreadable: the file itself is bad.
        let (url, seen) = fake_server(vec![
            http("200 OK", &[("Content-Length", len)], &corrupt),
            http("200 OK", &[("Content-Length", good_len)], &good),
        ]).await;
        let (dir, db, req, part) = dl_fixture(&url).await;

        let err = download_with_retries(&db.pool, &reqwest::Client::new(), &req, &part).await.unwrap_err();

        assert!(err.to_string().contains("corrupt"), "{err}");
        assert_eq!(seen.lock().unwrap().len(), 1, "re-downloading a bad file from the same URL is pointless - the next hoster gets the next try");
        assert!(!Path::new(&part).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_resume_answered_from_the_wrong_offset_restarts_from_zero() {
        let zip = zip_bytes();
        let total = zip.len();
        let half = total / 2;
        let (url, seen) = fake_server(vec![
            // 1. The announced body stops halfway: half is banked for a resume.
            http("200 OK", &[("Content-Length", total.to_string())], &zip[..half]),
            // 2. The Range resume is answered from byte 0 - appending that would corrupt the file.
            http("206 Partial Content", &[("Content-Length", total.to_string()), ("Content-Range", format!("bytes 0-{}/{}", total - 1, total))], &zip),
            // 3. A plain re-fetch delivers the whole file.
            http("200 OK", &[("Content-Length", total.to_string())], &zip),
        ]).await;
        let (dir, db, req, part) = dl_fixture(&url).await;

        download_with_retries(&db.pool, &reqwest::Client::new(), &req, &part).await.unwrap();

        assert_eq!(std::fs::read(&part).unwrap(), zip, "the finished file is the archive, not half + whole");
        let seen = seen.lock().unwrap().clone();
        assert!(seen[1].contains(&format!("range: bytes={}-", half)), "attempt 2 resumed: {}", seen[1]);
        assert!(!seen[2].contains("range:"), "attempt 3 restarted from zero: {}", seen[2]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_correct_resume_appends_and_completes() {
        let zip = zip_bytes();
        let total = zip.len();
        let half = total / 2;
        let (url, _seen) = fake_server(vec![
            http("200 OK", &[("Content-Length", total.to_string())], &zip[..half]),
            http("206 Partial Content", &[("Content-Length", (total - half).to_string()), ("Content-Range", format!("bytes {}-{}/{}", half, total - 1, total))], &zip[half..]),
        ]).await;
        let (dir, db, req, part) = dl_fixture(&url).await;

        download_with_retries(&db.pool, &reqwest::Client::new(), &req, &part).await.unwrap();

        assert_eq!(std::fs::read(&part).unwrap(), zip);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_short_resume_is_truncation_keeps_its_bytes_and_resumes_again() {
        let zip = zip_bytes();
        let total = zip.len();
        let (half, three_q) = (total / 2, total * 3 / 4);
        let (url, seen) = fake_server(vec![
            http("200 OK", &[("Content-Length", total.to_string())], &zip[..half]),
            // A capped range: the server sends a quarter but says the file is `total` long.
            http("206 Partial Content", &[("Content-Length", (three_q - half).to_string()), ("Content-Range", format!("bytes {}-{}/{}", half, three_q - 1, total))], &zip[half..three_q]),
            http("206 Partial Content", &[("Content-Length", (total - three_q).to_string()), ("Content-Range", format!("bytes {}-{}/{}", three_q, total - 1, total))], &zip[three_q..]),
        ]).await;
        let (dir, db, req, part) = dl_fixture(&url).await;

        download_with_retries(&db.pool, &reqwest::Client::new(), &req, &part).await.unwrap();

        assert_eq!(std::fs::read(&part).unwrap(), zip);
        assert!(seen.lock().unwrap()[2].contains(&format!("range: bytes={}-", three_q)), "the truncated attempt's bytes were kept and resumed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn content_range_and_body_plans() {
        assert_eq!(parse_content_range("bytes 100-199/200"), Some((100, Some(200))));
        assert_eq!(parse_content_range("bytes 0-99/*"), Some((0, None)));
        assert_eq!(parse_content_range("items 0-1/2"), None);
        assert_eq!(parse_content_range("bytes oops"), None);

        // A full body: count from zero; the Content-Length is the whole file.
        assert_eq!(plan_body(0, false, Some(500), None).unwrap(), BodyPlan { append: false, already_have: 0, expected_total: Some(500) });
        assert_eq!(plan_body(4096, false, None, None).unwrap(), BodyPlan { append: false, already_have: 0, expected_total: None });
        // A resume that starts where the bank ends appends; the total comes from Content-Range.
        assert_eq!(plan_body(100, true, Some(100), Some("bytes 100-199/200")).unwrap(), BodyPlan { append: true, already_have: 100, expected_total: Some(200) });
        assert_eq!(plan_body(100, true, Some(100), Some("bytes 100-199/*")).unwrap().expected_total, Some(200));
        // Anywhere else, or no Content-Range at all: the bank can't be trusted.
        assert!(plan_body(100, true, Some(200), Some("bytes 0-199/200")).unwrap_err().to_string().contains(ERR_RESTART));
        assert!(plan_body(100, true, Some(100), None).unwrap_err().to_string().contains(ERR_RESTART));
    }

    #[test]
    fn integrity_failures_are_not_held_for_manual_download() {
        // Challenges, stalls and tiny error pages on a getcomics link still become the manual hold...
        assert!(holds_for_manual_download("Download URL returned an HTML webpage instead of a comic file."));
        assert!(holds_for_manual_download("Download stalled for 45 seconds"));
        assert!(holds_for_manual_download("Downloaded file is suspiciously small (3kb). Aborting."));
        // ...but a throttle, or a file that arrived and was bad, goes to the next hoster.
        assert!(!holds_for_manual_download("GetComics rate limited (429) the download link; deferring for a later retry."));
        assert!(!holds_for_manual_download("Download truncated: received 10 of 20 bytes"));
        assert!(!holds_for_manual_download("Downloaded archive is corrupt (invalid Zip archive); every announced byte arrived, so the file itself is bad"));
        assert!(!holds_for_manual_download("Downloaded archive is incomplete (invalid Zip archive); restarting from zero"));
    }

    #[tokio::test]
    async fn complete_archives_and_non_zip_files_still_download() {
        // A whole CBZ with no Content-Length (close-delimited) is fine.
        let zip = zip_bytes();
        let (url, _) = fake_server(vec![http("200 OK", &[], &zip)]).await;
        let (dir, db, req, part) = dl_fixture(&url).await;
        download_with_retries(&db.pool, &reqwest::Client::new(), &req, &part).await.unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), zip);
        let _ = std::fs::remove_dir_all(&dir);

        // RAR/7z can't be checked cheaply (never judge unrar by exit code; `unrar t` on a GB-sized
        // pack is too slow) - those rely on the length checks alone.
        let mut rar = b"Rar!\x1a\x07\x01\x00".to_vec();
        rar.extend_from_slice(&[7u8; 4096]);
        let (url, _) = fake_server(vec![http("200 OK", &[], &rar)]).await;
        let (dir, db, req, part) = dl_fixture(&url).await;
        download_with_retries(&db.pool, &reqwest::Client::new(), &req, &part).await.unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), rar);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_http_error_status_is_never_saved_as_the_file() {
        let body = vec![1u8; 4096];
        let (url, _) = fake_server(vec![
            http("404 Not Found", &[("Content-Length", body.len().to_string())], &body),
            http("404 Not Found", &[("Content-Length", body.len().to_string())], &body),
            http("404 Not Found", &[("Content-Length", body.len().to_string())], &body),
        ]).await;
        let (dir, db, req, part) = dl_fixture(&url).await;

        let err = download_with_retries(&db.pool, &reqwest::Client::new(), &req, &part).await.unwrap_err();

        assert!(err.to_string().contains("404"), "{err}");
        assert!(!Path::new(&part).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 429 is a throttle, not a challenge: it must be classified as rate-limited (skip/defer) rather
    // than burning a 300s solver run on a page that isn't a challenge at all.
    #[test]
    fn rate_limit_is_not_a_challenge() {
        assert!(is_rate_limited(429));
        assert!(!is_rate_limited(403));
        assert!(!is_rate_limited(200));
    }
}
