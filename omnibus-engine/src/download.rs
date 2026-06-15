// Direct-download streaming (the raw byte pump for DDL hosters). Ported from download-clients.ts
// `downloadDirectFile`'s streaming half per the roadmap: the engine owns the chunked stream, the 45s
// stall-watchdog, throttled progress writes, the suspiciously-small-file guard, and the .part→final
// rename. Hoster *resolution* (HosterEngine.resolveLink) and the Mega SDK stream stay in Node, which
// calls this only for plain HTTP(S) URLs and handles the failure alert.
use anyhow::{bail, Result};
use sqlx::PgPool;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tokio::io::AsyncWriteExt;
use futures_util::StreamExt;

const STALL_SECS: u64 = 45;
const DEFAULT_MIN_SIZE: u64 = 500_000;

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

pub async fn stream_download(db: &PgPool, req: StreamRequest) -> Result<String> {
    let part_path = format!("{}.part", req.dest_path);
    let _ = tokio::fs::remove_file(&part_path).await; // clear any stale partial
    if let Some(parent) = Path::new(&req.dest_path).parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    // SSRF guard (defense-in-depth): the URL ultimately comes from a search result a privileged user
    // selected, so reject non-HTTP(S) schemes and hosts that resolve to an internal address.
    validate_download_target(&req.url).await?;

    let client = reqwest::Client::builder().build()?;

    // Up to 3 attempts to establish the stream (parity with the Node retry loop).
    let mut response = None;
    let mut last_err = String::new();
    for attempt in 1..=3 {
        let mut rb = client.get(&req.url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .header("Accept", "application/zip, application/x-rar-compressed, application/octet-stream, */*")
            .header("Referer", "https://getcomics.org/");
        for (k, v) in &req.headers {
            rb = rb.header(k.as_str(), v.as_str());
        }
        match rb.send().await {
            Ok(r) => { response = Some(r); break; }
            Err(e) => {
                last_err = e.to_string();
                log::warn!("[Internal DL] Attempt {} failed ({}). Retrying in 3s...", attempt, last_err);
                if attempt < 3 { tokio::time::sleep(std::time::Duration::from_secs(3)).await; }
            }
        }
    }
    let response = response.ok_or_else(|| anyhow::anyhow!("Failed to connect after 3 attempts: {}", last_err))?;

    // Reject an HTML webpage masquerading as a file (expired/blocked link).
    let content_type = response.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
    if content_type.contains("text/html") {
        bail!("Download URL returned an HTML webpage instead of a comic file.");
    }
    let total = response.content_length().unwrap_or(0);

    // Stream to the .part file. The 45s stall-watchdog is a per-chunk timeout: no data for 45s aborts
    // (Node reset a setTimeout on every 'data' event). Progress is throttled to every 5% / >2s.
    let mut file = tokio::fs::File::create(&part_path).await?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_pct: i64 = -1;
    let mut last_update = std::time::Instant::now();
    let mut first_update = true;

    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(STALL_SECS), stream.next()).await {
            Err(_) => {
                log::error!("[Internal DL] Data stream stalled for {} seconds. Aborting to trigger retry.", STALL_SECS);
                let _ = tokio::fs::remove_file(&part_path).await;
                bail!("Download stalled for {} seconds", STALL_SECS);
            }
            Ok(None) => break, // stream finished
            Ok(Some(Err(e))) => {
                let _ = tokio::fs::remove_file(&part_path).await;
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

    // Reject suspiciously small files (a failed/blocked download often yields a tiny error page).
    let size = tokio::fs::metadata(&part_path).await?.len();
    let min_size = req.min_size_bytes.unwrap_or(DEFAULT_MIN_SIZE);
    if size < min_size {
        let _ = tokio::fs::remove_file(&part_path).await;
        bail!("Downloaded file is suspiciously small ({}kb). Aborting.", size / 1024);
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
