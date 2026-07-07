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
/// single-browser FlareSolverr into "no usable cookies" / timeouts. `force` re-solves even if a cached
/// value exists (used when a cached cookie has gone stale).
async fn get_clearance(client: &reqwest::Client, flare_url: &str, url: &str, force: bool, sc: &crate::getcomics::SolverConfig) -> Result<(String, String)> {
    let mut guard = clearance_cache().lock().await;
    if !force {
        if let Some(c) = guard.as_ref() {
            if c.fetched_at.elapsed() < CLEARANCE_TTL {
                return Ok((c.cookie.clone(), c.user_agent.clone()));
            }
        }
    }
    let (cookie, ua) = crate::getcomics::flaresolverr_clearance(client, flare_url, url, sc).await?;
    *guard = Some(CachedClearance { cookie: cookie.clone(), user_agent: ua.clone(), fetched_at: std::time::Instant::now() });
    Ok((cookie, ua))
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
    establish_stream(client, req, Some(&warm_cookies), DEFAULT_UA).await
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

const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

/// Lower-cased Content-Type of a response (empty string if absent).
fn response_content_type(response: &reqwest::Response) -> String {
    response.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase()
}

/// Establishes the download stream with up to 3 connection attempts (parity with the Node retry loop),
/// sending the browser-ish headers plus an optional Cloudflare cookie and an overridable User-Agent.
async fn establish_stream(
    client: &reqwest::Client,
    req: &StreamRequest,
    cookie: Option<&str>,
    user_agent: &str,
) -> Result<reqwest::Response> {
    let mut last_err = String::new();
    for attempt in 1..=3 {
        let mut rb = client.get(&req.url)
            .header("User-Agent", user_agent)
            .header("Accept", "application/zip, application/x-rar-compressed, application/octet-stream, */*")
            .header("Referer", "https://getcomics.org/");
        if let Some(c) = cookie {
            rb = rb.header("Cookie", c);
        }
        for (k, v) in &req.headers {
            rb = rb.header(k.as_str(), v.as_str());
        }
        match rb.send().await {
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
        Err(e) if is_getcomics => {
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

    // Each attempt re-establishes the stream AND runs the transfer to completion: a mid-stream 45s stall
    // (or a truncated/too-small file, or an HTML error/challenge page) now consumes a retry instead of
    // failing outright. Previously only connection establishment was retried and the transfer ran once
    // outside the loop, so a stall rejected with no second chance and landed STALLED.
    const MAX_ATTEMPTS: u32 = 3;
    let mut last_err = anyhow!("download failed before any attempt");
    let mut succeeded = false;
    for attempt in 1..=MAX_ATTEMPTS {
        // A failed prior attempt may have left a partial behind; start each attempt clean.
        let _ = tokio::fs::remove_file(&part_path).await;
        match attempt_stream_to_part(db, &client, req, &part_path).await {
            Ok(()) => {
                succeeded = true;
                break;
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&part_path).await;
                log::warn!("[Internal DL] Attempt {}/{} failed ({}).", attempt, MAX_ATTEMPTS, e);
                last_err = e;
                if attempt < MAX_ATTEMPTS {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                }
            }
        }
    }
    if !succeeded {
        return Err(last_err);
    }

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

/// A single download attempt: establish the stream (with the getcomics Cloudflare warm-up/solver dance),
/// reject an HTML page, stream to `part_path` under the 45s stall-watchdog, and reject a too-small file.
/// Leaves the completed bytes at `part_path` on success; any failure returns Err so the caller can retry.
async fn attempt_stream_to_part(
    db: &sqlx::AnyPool,
    client: &reqwest::Client,
    req: &StreamRequest,
    part_path: &str,
) -> Result<()> {
    // First, a plain direct fetch. comicfiles / resolved-hoster URLs — and any getcomics.org link that
    // isn't actually behind a challenge — serve the file straight away and stream with zero FlareSolverr
    // overhead.
    let mut response = establish_stream(client, req, None, DEFAULT_UA).await?;
    let mut content_type = response_content_type(&response);

    // When a getcomics.org link answers with an HTML page — the Cloudflare "Just a moment…" challenge
    // on the /dls/ main-server links — try to get past it. First (lever #2) a cheap cookie warm-up that
    // clears the light challenge variant with no solver; only if that fails do we pay for a
    // FlareSolverr/Byparr solve. A non-challenged download never enters this branch.
    if content_type.contains("text/html") && req.url.contains("getcomics.org") {
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

    // Still a challenge after the warm-up → solve it via FlareSolverr/Byparr and retry with the
    // cf_clearance cookie + the exact User-Agent the solver used (the cookie is IP+UA-bound, so the
    // solver must share the engine's outbound IP).
    if content_type.contains("text/html") && req.url.contains("getcomics.org") {
        let flare: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'flaresolverr_url'"#)
            .fetch_optional(db).await.ok().flatten().filter(|s: &String| !s.trim().is_empty());
        match flare {
            Some(flare_url) => {
                let sc = crate::getcomics::solver_config(db).await;
                // Solve the challenge on the ACTUAL /dls/ URL — it's the only getcomics.org URL that's
                // Cloudflare-gated (the homepage/browse pages aren't challenged, so solving them yields no
                // cf_clearance). A capable solver (e.g. the experimental FlareSolverr 3.4.0 branch) clears
                // it and returns a domain-wide cf_clearance we replay here. CAVEAT: cookie-replay of a
                // /dls/ download is inherently unreliable — the solver clears the challenge in ITS browser,
                // and getcomics' one-shot signed link can be consumed by that session, so the replay may
                // come back empty/stalled. Any such failure falls through to the manual-hold wrapper.
                match get_clearance(client, &flare_url, &req.url, false, &sc).await {
                    Ok((cookie, ua)) => {
                        log::info!("[Internal DL] GetComics Cloudflare challenge solved via {}; replaying the clearance on the download.", sc.kind);
                        let ua_eff = if ua.is_empty() { DEFAULT_UA.to_string() } else { ua };
                        response = establish_stream(client, req, Some(&cookie), &ua_eff).await?;
                        content_type = response_content_type(&response);
                        // A cached cookie that's gone stale still answers with a challenge — force one fresh
                        // solve and retry before giving up.
                        if content_type.contains("text/html") {
                            if let Ok((cookie, ua)) = get_clearance(client, &flare_url, &req.url, true, &sc).await {
                                let ua_eff = if ua.is_empty() { DEFAULT_UA.to_string() } else { ua };
                                response = establish_stream(client, req, Some(&cookie), &ua_eff).await?;
                                content_type = response_content_type(&response);
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
    let total = response.content_length().unwrap_or(0);

    // Stream to the .part file. The 45s stall-watchdog is a per-chunk timeout: no data for 45s aborts
    // (Node reset a setTimeout on every 'data' event). Progress is throttled to every 5% / >2s.
    let mut file = tokio::fs::File::create(part_path).await?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
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

    // Reject suspiciously small files (a failed/blocked download often yields a tiny error page). The
    // caller cleans up the partial and retries (or, for getcomics, hands it to the manual-hold wrapper).
    let size = tokio::fs::metadata(part_path).await?.len();
    let min_size = req.min_size_bytes.unwrap_or(DEFAULT_MIN_SIZE);
    if size < min_size {
        bail!("Downloaded file is suspiciously small ({}kb). Aborting.", size / 1024);
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
}
