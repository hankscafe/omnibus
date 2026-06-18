// omnibus-engine/src/annas_archive.rs
//
// Anna's Archive as a first-class search source (Phase 1: interactive search).
//
// Anna's Archive (annas-archive.org) is BOTH a search index and a download host. This module is its
// SEARCH half: it scrapes the public /search page (NO API key required) and returns unified
// `ProwlarrResult`s with protocol "ddl". The DOWNLOAD half reuses the existing Node hoster resolver
// (`src/lib/hosters/annas-archive.ts` → the fast_download API) and the engine streamer — so the engine
// never needs the API key here.
//
// Two gotchas, confirmed against six reference scrapers:
//  1. AA lazy-loads each result card INSIDE an HTML comment (`<!-- … -->`); a raw-HTTP parse must strip
//     the comment markers first or it finds zero results (`uncomment`).
//  2. AA sits behind Cloudflare/DDoS-Guard, so fetches reuse the same FlareSolverr/Byparr bypass +
//     browser User-Agent that GetComics uses.

use reqwest::Client;
use scraper::{Html, Selector};
use sqlx::PgPool;
use std::collections::HashSet;
use crate::prowlarr::ProwlarrResult;

// AA rotates domains under takedown pressure: .org was suspended (Jan 2026), .se/.li are gone; .gl is
// the current stable mirror (mid-2026). Admin-overridable via `annas_archive_base_url` for the next one.
const DEFAULT_BASE_URL: &str = "https://annas-archive.gl";
const DEFAULT_FORMATS: &str = "cbz,cbr,pdf,epub";

/// Known Anna's Archive mirror hosts to fail over to when the configured base is unreachable. AA rotates
/// domains under takedown pressure (.org/.se/.li were lost through 2026; .gl is current), so this list is
/// best-effort: the admin can always point `annas_archive_base_url` at the live mirror, and dead domains
/// here just fast-fail via DNS.
const KNOWN_MIRRORS: [&str; 4] = [
    "https://annas-archive.gl",
    "https://annas-archive.se",
    "https://annas-archive.li",
    "https://annas-archive.org",
];

/// Ordered, de-duplicated base URLs to try: the configured base first, then the known mirrors. Pure.
fn mirror_candidates(configured: &str) -> Vec<String> {
    let c = configured.trim().trim_end_matches('/').to_string();
    let mut out: Vec<String> = vec![c];
    for m in KNOWN_MIRRORS {
        if !out.iter().any(|x| x == m) { out.push(m.to_string()); }
    }
    out
}

/// The configured Anna's Archive base URL (default annas-archive.org), trailing slash trimmed. AA
/// rotates mirror domains (.org/.se/.li) under takedown pressure, so it's admin-overridable.
async fn base_url(db: &PgPool) -> String {
    sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'annas_archive_base_url'"#)
        .fetch_optional(db).await.ok().flatten()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

/// The comic file formats to search for (default cbz,cbr,pdf,epub), lowercased + de-dotted.
async fn formats(db: &PgPool) -> Vec<String> {
    let raw = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'annas_archive_formats'"#)
        .fetch_optional(db).await.ok().flatten()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_FORMATS.to_string());
    raw.split(',').map(|s| s.trim().trim_start_matches('.').to_lowercase()).filter(|s| !s.is_empty()).collect()
}

/// Whether Anna's Archive is enabled for INTERACTIVE search. Ungated (no API key needed) and OFF by
/// default — the admin opts in via Settings. Automation enablement is separate + key-gated (Phase 2).
pub async fn is_interactive_enabled(db: &PgPool) -> bool {
    sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'annas_archive_interactive_enabled'"#)
        .fetch_optional(db).await.ok().flatten().as_deref() == Some("true")
}

/// Strip the lazy-load HTML comment markers AA wraps each result card in, so a raw-HTTP parse sees the
/// cards (parity with the milahu/CrazyZard/aapy scrapers, which all do this blunt global replace).
fn uncomment(html: &str) -> String {
    html.replace("<!--", "").replace("-->", "")
}

/// Build the AA search URL. `content=book_comic` is added for comics (omitted for manga, whose AA
/// categorization is inconsistent — the `ext` filter still constrains it). `ext` repeats to OR formats.
fn build_search_url(base: &str, query: &str, formats: &[String], include_comic_content: bool, page: i32) -> String {
    let mut url = format!("{}/search?q={}", base.trim_end_matches('/'), urlencoding::encode(query));
    if include_comic_content { url.push_str("&content=book_comic"); }
    for f in formats { url.push_str(&format!("&ext={}", urlencoding::encode(f))); }
    if page > 1 { url.push_str(&format!("&page={}", page)); }
    url
}

/// Extract the 32-hex md5 from an AA `/md5/<hash>` href (full URL or bare path), lowercased.
fn extract_md5(href: &str) -> Option<String> {
    let idx = href.find("/md5/")?;
    let hash: String = href[idx + 5..].chars().take_while(|c| c.is_ascii_hexdigit()).collect();
    (hash.len() == 32).then(|| hash.to_lowercase())
}

/// First recognized comic/book file-format token in a metadata string, lowercased (".cbz" → "cbz").
fn parse_format(text: &str) -> Option<String> {
    let re = regex::Regex::new(r"(?i)\b(cbz|cbr|cbt|cb7|epub|pdf|mobi|azw3|fb2|djvu)\b").unwrap();
    re.captures(text).and_then(|c| c.get(1)).map(|m| m.as_str().to_lowercase())
}

/// Parse a human-readable size ("12.3MB", "900 KB", "1.5 GB") into bytes (decimal units). None if absent.
fn parse_size(text: &str) -> Option<i64> {
    let re = regex::Regex::new(r"(?i)(\d+(?:\.\d+)?)\s*(tb|gb|mb|kb|b)\b").unwrap();
    let caps = re.captures(text)?;
    let num: f64 = caps.get(1)?.as_str().parse().ok()?;
    let mult = match caps.get(2)?.as_str().to_lowercase().as_str() {
        "tb" => 1e12, "gb" => 1e9, "mb" => 1e6, "kb" => 1e3, _ => 1.0,
    };
    Some((num * mult) as i64)
}

/// Cloudflare/DDoS-Guard-aware fetch, mirroring `getcomics::fetch_html` but tagged for Anna's Archive
/// and reusing the shared `getcomics::solver_config`. On a 403/503 it routes through the configured
/// solver; if that fails (or none is set) it returns the raw (likely-challenge) body so the caller
/// degrades to an empty result list rather than erroring.
async fn fetch_html(client: &Client, db: &PgPool, url: &str, flaresolverr: Option<&str>) -> anyhow::Result<String> {
    let res = client.get(url).send().await?;
    let status = res.status();
    if status == 403 || status == 503 {
        if let Some(flare_url) = flaresolverr.filter(|f| !f.is_empty()) {
            let sc = crate::getcomics::solver_config(db).await;
            log::warn!("[Anna's Archive] HTTP {} for {}; attempting {} bypass...", status.as_u16(), url, sc.kind);
            let target = if flare_url.ends_with("/v1") { flare_url.to_string() } else { format!("{}/v1", flare_url) };
            let payload = serde_json::json!({ "cmd": "request.get", "url": url, "maxTimeout": sc.payload_timeout });
            match client.post(&target).json(&payload).timeout(std::time::Duration::from_millis(sc.http_timeout_ms)).send().await {
                Ok(flare_res) => {
                    if let Ok(data) = flare_res.json::<serde_json::Value>().await {
                        if let Some(html) = data["solution"]["response"].as_str() {
                            log::info!("[Anna's Archive] {} bypass successful for {}", sc.kind, url);
                            return Ok(html.to_string());
                        }
                    }
                    log::warn!("[Anna's Archive] {} returned no usable HTML for {}", sc.kind, url);
                }
                Err(e) => log::warn!("[Anna's Archive] solver request failed: {}", e),
            }
        } else {
            log::warn!("[Anna's Archive] HTTP {} for {} and no Cloudflare solver configured.", status.as_u16(), url);
        }
    }
    Ok(res.text().await?)
}

/// Searches Anna's Archive across the given queries and returns unified DDL results (de-duped by md5
/// across pages/queries). No API key is needed — search scrapes the public page; resolving a result to
/// bytes uses the Node hoster resolver at download time (premium key) or falls to the manual queue.
/// `is_interactive` selects the page depth + rate interval.
pub async fn search(
    db: &PgPool,
    limiter: &crate::rate_limiter::RateLimiter,
    queries: &[String],
    is_interactive: bool,
    is_manga: bool,
) -> anyhow::Result<Vec<ProwlarrResult>> {
    let base = base_url(db).await;
    let allowed_formats = formats(db).await;

    let interactive_pages: i32 = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'annas_archive_interactive_pages'"#)
        .fetch_optional(db).await?.and_then(|v| v.trim().parse().ok()).unwrap_or(1);
    let automated_pages: i32 = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'annas_archive_automated_pages'"#)
        .fetch_optional(db).await?.and_then(|v| v.trim().parse().ok()).unwrap_or(2);
    let max_pages = if is_interactive { interactive_pages } else { automated_pages }.max(1);

    let flare_url: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'flaresolverr_url'"#).fetch_optional(db).await?;
    let client = crate::browser_http_client();
    // Mirror failover: lock onto a reachable host on the first successful fetch; if the configured base
    // is dead (AA rotates domains), fall over to a known mirror and use it for the rest of this call.
    let candidates = mirror_candidates(&base);
    let mut active_base = base.clone();
    let mut base_locked = false;

    let a_sel = Selector::parse("a").unwrap();
    let h3_sel = Selector::parse("h3").unwrap();

    let mut results: Vec<ProwlarrResult> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for q in queries {
        if q.trim().is_empty() { continue; }
        log::info!("[Anna's Archive] Searching for: \"{}\"", q);

        for page in 1..=max_pages {
            limiter.enforce("annas_archive", if is_interactive { 2500 } else { 4000 }).await;

            let html = if base_locked {
                let url = build_search_url(&active_base, q, &allowed_formats, !is_manga, page);
                log::debug!("[Anna's Archive Debug] Searching page {}/{}: {}", page, max_pages, url);
                match fetch_html(&client, db, &url, flare_url.as_deref()).await {
                    Ok(h) => h,
                    Err(e) => { log::warn!("[Anna's Archive] Fetch failed for \"{}\": {}", q, e); break; }
                }
            } else {
                // First fetch: try the configured base, then fail over to known mirrors on connect errors.
                let mut got: Option<String> = None;
                for cand in &candidates {
                    let url = build_search_url(cand, q, &allowed_formats, !is_manga, page);
                    log::debug!("[Anna's Archive Debug] Searching page {}/{}: {}", page, max_pages, url);
                    match fetch_html(&client, db, &url, flare_url.as_deref()).await {
                        Ok(h) => {
                            if cand != &active_base {
                                log::warn!("[Anna's Archive] Configured mirror {} unreachable; switched to {}. Update the Base URL in Settings.", active_base, cand);
                                active_base = cand.clone();
                            }
                            base_locked = true;
                            got = Some(h);
                            break;
                        }
                        Err(e) => log::warn!("[Anna's Archive] Mirror {} unreachable: {}", cand, e),
                    }
                }
                match got {
                    Some(h) => h,
                    None => { log::warn!("[Anna's Archive] All known mirrors unreachable for \"{}\".", q); break; }
                }
            };

            // Extract (md5, title, full-text) first so the non-Send scraper types drop before any await.
            let cards: Vec<(String, String, String)> = {
                let html = uncomment(&html);
                let document = Html::parse_document(&html);
                document.select(&a_sel).filter_map(|a| {
                    let href = a.value().attr("href").unwrap_or("");
                    if !href.contains("/md5/") { return None; }
                    let md5 = extract_md5(href)?;
                    // Title is the card's <h3>; fall back to the anchor's own text. The cover-image link
                    // (same md5, no h3, no text) yields None here and is skipped — the real card wins.
                    let title = a.select(&h3_sel).next()
                        .map(|h| h.text().collect::<Vec<_>>().join(" ").trim().to_string())
                        .filter(|t| !t.is_empty())
                        .or_else(|| {
                            let t = a.text().collect::<Vec<_>>().join(" ").trim().to_string();
                            (!t.is_empty()).then_some(t)
                        })?;
                    let full = a.text().collect::<Vec<_>>().join(" ");
                    Some((md5, title, full))
                }).collect()
            };

            if cards.is_empty() { break; } // end of results / a blocked challenge page

            for (md5, title, full_text) in cards {
                if !seen.insert(md5.clone()) { continue; }
                // Parse metadata from the card text MINUS the title, so a format word in the title isn't
                // misread as the file format.
                let meta = full_text.replacen(&title, " ", 1);
                let fmt = parse_format(&meta);
                if let Some(f) = &fmt {
                    if !allowed_formats.is_empty() && !allowed_formats.contains(f) { continue; }
                }
                let size = parse_size(&meta).unwrap_or(0);
                let clean_title = title.split_whitespace().collect::<Vec<_>>().join(" ");
                // Append the format for interactive display clarity, but keep a clean title for
                // automation so filter_and_score's relevance/issue-number matching isn't skewed.
                let display_title = match &fmt {
                    Some(f) if is_interactive => format!("{} [{}]", clean_title, f),
                    _ => clean_title,
                };
                let md5_url = format!("{}/md5/{}", active_base, md5);
                results.push(ProwlarrResult {
                    guid: md5,
                    title: display_title,
                    size,
                    indexer: "Anna's Archive".to_string(),
                    seeders: 0,
                    peers: 0,
                    info_url: md5_url.clone(),
                    download_url: md5_url,
                    protocol: "ddl".to_string(),
                    publish_date: "N/A".to_string(),
                    info_hash: None,
                });
            }

            // Automation doesn't need every page; stop once we have matches (interactive aggregates all).
            if !is_interactive && !results.is_empty() { break; }
        }
    }

    log::info!("[Anna's Archive] Returning {} result(s).", results.len());
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_md5_lowercased() {
        assert_eq!(extract_md5("/md5/0123456789ABCDEF0123456789abcdef").as_deref(), Some("0123456789abcdef0123456789abcdef"));
        assert_eq!(extract_md5("https://annas-archive.org/md5/0123456789abcdef0123456789abcdef?x=1").as_deref(), Some("0123456789abcdef0123456789abcdef"));
        assert_eq!(extract_md5("/md5/short"), None);
        assert_eq!(extract_md5("/other/0123456789abcdef0123456789abcdef"), None);
    }

    #[test]
    fn uncomment_strips_lazyload_markers() {
        assert_eq!(uncomment("<!-- <a href='/md5/x'>y</a> -->"), " <a href='/md5/x'>y</a> ");
        assert_eq!(uncomment("<div>plain</div>"), "<div>plain</div>");
    }

    #[test]
    fn build_search_url_comics_and_manga() {
        let f = vec!["cbz".to_string(), "cbr".to_string()];
        assert_eq!(build_search_url("https://annas-archive.org", "batman", &f, true, 1),
            "https://annas-archive.org/search?q=batman&content=book_comic&ext=cbz&ext=cbr");
        // Manga: no content filter; page > 1 appends &page.
        assert_eq!(build_search_url("https://annas-archive.org/", "naruto", &f, false, 2),
            "https://annas-archive.org/search?q=naruto&ext=cbz&ext=cbr&page=2");
        // The query is URL-encoded.
        assert!(build_search_url("https://annas-archive.org", "x men", &[], true, 1).contains("q=x%20men"));
    }

    #[test]
    fn parses_format_from_meta() {
        assert_eq!(parse_format("English [en], .cbz, 🚀/zlib, 12.3MB, 📗 Book (comic)").as_deref(), Some("cbz"));
        assert_eq!(parse_format("English [en] · EPUB · 0.7MB").as_deref(), Some("epub"));
        assert_eq!(parse_format("pdf").as_deref(), Some("pdf"));
        assert_eq!(parse_format("no format here"), None);
    }

    #[test]
    fn parses_size_to_bytes() {
        assert_eq!(parse_size("12.3MB"), Some(12_300_000));
        assert_eq!(parse_size("English [en], .cbz, 900 KB"), Some(900_000));
        assert_eq!(parse_size("1.5 GB total"), Some(1_500_000_000));
        assert_eq!(parse_size("no size"), None);
    }

    #[test]
    fn mirror_candidates_dedup_configured_first() {
        let c = mirror_candidates("https://annas-archive.gl");
        assert_eq!(c[0], "https://annas-archive.gl");
        assert_eq!(c.iter().filter(|x| x.as_str() == "https://annas-archive.gl").count(), 1);
        assert!(c.contains(&"https://annas-archive.se".to_string()));
        // A non-standard configured mirror still goes first, with the known mirrors appended after.
        let c2 = mirror_candidates("https://annas-archive.pk/");
        assert_eq!(c2[0], "https://annas-archive.pk");
        assert!(c2.contains(&"https://annas-archive.gl".to_string()));
    }
}
