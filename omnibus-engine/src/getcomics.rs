use reqwest::Client;
use scraper::{Html, Selector};
use sqlx::PgPool; 
use std::collections::HashSet;
use crate::prowlarr::ProwlarrResult;
use serde::Serialize;
use base64::{Engine as _, engine::general_purpose::STANDARD};

#[derive(Debug, Serialize, Clone)]
pub struct DeepLinkResult {
    pub url: String,
    pub hoster: String,
}

/// The set of currently-enabled hosters, mirroring automation.ts `enabledHosters` parsing of the
/// `hoster_priority` setting: unset → all defaults; empty array → none; string array → the listed
/// hosters; object array → those not flagged `enabled:false`.
pub async fn enabled_hosters(db: &PgPool) -> Vec<String> {
    let default: Vec<String> = ["mediafire", "getcomics", "mega", "pixeldrain", "rootz", "vikingfile", "terabox", "annas_archive"]
        .iter().map(|s| s.to_string()).collect();
    let hp: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'hoster_priority'"#)
        .fetch_optional(db).await.ok().flatten();
    let Some(val) = hp else { return default; };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&val) else { return default; };
    let Some(arr) = parsed.as_array() else { return default; };
    if arr.is_empty() { return Vec::new(); }
    if arr[0].is_string() {
        arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
    } else if arr[0].is_object() {
        arr.iter()
            .filter(|v| v.get("enabled").and_then(|e| e.as_bool()) != Some(false))
            .filter_map(|v| v.get("hoster").and_then(|h| h.as_str()).map(|s| s.to_string()))
            .collect()
    } else {
        default
    }
}

/// Whether a given hoster is currently enabled — Node's `enabledHosters.includes(hoster)` gate.
pub async fn is_hoster_enabled(db: &PgPool, hoster: &str) -> bool {
    enabled_hosters(db).await.iter().any(|h| h == hoster)
}

/// Records a Cloudflare-block timestamp so the rest of the app can back off / surface it in the UI.
async fn mark_cloudflare_flag(db: &PgPool) {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_default();
    let _ = sqlx::query(
        r#"INSERT INTO "SystemSetting" (key, value) VALUES ('cloudflare_block_time', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"#,
    )
    .bind(now_ms)
    .execute(db)
    .await;
}

async fn fetch_html(client: &Client, db: &PgPool, url: &str, flaresolverr: Option<&str>) -> anyhow::Result<String> {
    let res = client.get(url).send().await?;
    if res.status() == 403 {
        if let Some(flare_url) = flaresolverr.filter(|f| !f.is_empty()) {
            log::warn!("[GetComics] 403 detected for {}; attempting FlareSolverr bypass...", url);
            let target = if flare_url.ends_with("/v1") { flare_url.to_string() } else { format!("{}/v1", flare_url) };
            let payload = serde_json::json!({ "cmd": "request.get", "url": url, "maxTimeout": 60000 });
            log::debug!("[GetComics Debug] FlareSolverr payload: {}", payload);
            match client.post(&target).json(&payload).send().await {
                Ok(flare_res) => {
                    if let Ok(data) = flare_res.json::<serde_json::Value>().await {
                        if let Some(html) = data["solution"]["response"].as_str() {
                            log::info!("[GetComics] FlareSolverr bypass successful for {}", url);
                            log::debug!("[GetComics Debug] FlareSolverr response length: {}", html.len());
                            return Ok(html.to_string());
                        }
                    }
                    mark_cloudflare_flag(db).await;
                }
                Err(e) => {
                    log::warn!("[GetComics] FlareSolverr request failed: {}", e);
                    mark_cloudflare_flag(db).await;
                }
            }
        } else {
            // No FlareSolverr configured — record the block so the app can back off.
            mark_cloudflare_flag(db).await;
        }
    }
    Ok(res.text().await?)
}

/// Searches GetComics across the given queries (parity with getcomics.ts search/performSearch at
/// beta.035). Baseline relevance filters (series-name word enforcement + ±1-year guard) apply to
/// BOTH automated and interactive searches; automation additionally applies the strict
/// pack/TPB/variant/issue-number/annual guards and returns only the single best match for the first
/// query with survivors. Interactive fans each query out into the upstream variant set (raw,
/// symbol-cleaned, year-stripped, issue-stripped), aggregates across ALL pages and queries, and
/// de-dupes by URL. `dynamic_year` is the (possibly issue-release-overridden) request year used for
/// issue queries; `series_year` is the original series year used for pack queries.
/// `allow_packs_override == Some(false)` suppresses pack acceptance for isolated-issue automation.
#[allow(clippy::too_many_arguments)]
pub async fn search(
    db: &PgPool,
    limiter: &crate::rate_limiter::RateLimiter,
    queries: &[String],
    is_interactive: bool,
    original_name: &str,
    dynamic_year: Option<&str>,
    series_year: Option<&str>,
    is_manga: bool,
    allow_packs_override: Option<bool>,
) -> anyhow::Result<Vec<ProwlarrResult>> {
    let ddl_enabled: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'ddl_enabled'"#).fetch_optional(db).await?;
    if ddl_enabled.as_deref() == Some("false") { return Ok(vec![]); }

    let mut allow_bulk_packs = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'allow_bulk_packs'"#)
        .fetch_optional(db).await?.unwrap_or_default() == "true";
    // Automated isolated-issue requests override the global setting (beta.035).
    if !is_interactive && allow_packs_override == Some(false) {
        allow_bulk_packs = false;
    }

    // Admin-tunable page depth (beta.035); safe defaults 4 (interactive) / 5 (automated).
    let interactive_pages: i32 = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'getcomics_interactive_pages'"#)
        .fetch_optional(db).await?.and_then(|v| v.trim().parse().ok()).unwrap_or(4);
    let automated_pages: i32 = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'getcomics_automated_pages'"#)
        .fetch_optional(db).await?.and_then(|v| v.trim().parse().ok()).unwrap_or(5);
    let max_pages = if is_interactive { interactive_pages } else { automated_pages };

    let flare_url: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'flaresolverr_url'"#).fetch_optional(db).await?;
    let client = Client::builder().user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36").build()?;

    let article_sel = Selector::parse("article, .post").unwrap();
    let a_sel = Selector::parse("h1.post-title a, h2.post-title a, h1 a, h2 a, .post-header a").unwrap();

    // ---- Query context derived from the ORIGINAL name (parity with performSearch's cleanOriginal). ----
    let clean_original = original_name.replace([':', '-', '&'], " ")
        .split_whitespace().collect::<Vec<&str>>().join(" ").to_lowercase();
    let stop_words: HashSet<&str> = ["the", "a", "an", "of", "and", "or", "vol", "volume", "issue", "black", "white", "blood"].into_iter().collect();
    let open_variant_keywords = ["variant", "special edition", "director's cut", "directors cut", "facsimile", "black and white", "extended"];
    let bounded_variant_keywords = ["noir", "b&w", "sketch", "blank", "virgin", "uncut"];
    let user_wants_variant = bounded_variant_keywords.iter().any(|k| clean_original.contains(k))
        || open_variant_keywords.iter().any(|k| clean_original.contains(k));

    let req_num = crate::search_engine::extract_number(&clean_original, is_manga, false);

    let mut tpb_terms: Vec<&str> = vec!["omnibus", "tpb", "compendium", "collection", "hc", "hardcover", "trade paperback"];
    if !is_manga { tpb_terms.extend_from_slice(&["vol ", "volume ", "book "]); }
    let pack_terms = ["story arc", "pack", "complete", "collection", "bundle", "run", "chronological"];
    let is_looking_for_omnibus = tpb_terms.iter().any(|t| clean_original.contains(t));
    let is_looking_for_annual = clean_original.contains("annual");

    let original_query_words: Vec<String> = clean_original.chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .filter(|&w| !stop_words.contains(w))
        .map(|s| s.to_string())
        .collect();

    // Interactive: fan each incoming query out into the upstream variant set (performSearch's
    // uniqueSearches): raw, symbol-cleaned, trailing-year-stripped, trailing-issue-stripped.
    let query_list: Vec<String> = if is_interactive {
        let re_trailing_year = regex::Regex::new(r"\s\d{4}$").unwrap();
        let re_trailing_issue = regex::Regex::new(r"\s#?\d+(?:\.\d+)?$").unwrap();
        let clean_sym = |s: &str| s.replace([':', '-', '&'], " ").split_whitespace().collect::<Vec<_>>().join(" ");
        let mut seen: HashSet<String> = HashSet::new();
        let mut list: Vec<String> = Vec::new();
        for q in queries {
            let no_year = re_trailing_year.replace(q, "").trim().to_string();
            let no_issue = re_trailing_issue.replace(&no_year, "").trim().to_string();
            for cand in [q.to_string(), clean_sym(q), no_year.clone(), clean_sym(&no_year), no_issue.clone(), clean_sym(&no_issue)] {
                let c = cand.trim().to_string();
                if !c.is_empty() && seen.insert(c.clone()) { list.push(c); }
            }
        }
        list
    } else {
        queries.to_vec()
    };

    // Detects broad/pack queries (no issue-number marker) so they search against the series year.
    let re_issue_marker = regex::Regex::new(r"(?i)(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*\d+").unwrap();
    let re_word_num = regex::Regex::new(r"\d+(?:\.\d+)?").unwrap();

    let mut results: Vec<ProwlarrResult> = Vec::new();
    let mut seen_urls: HashSet<String> = HashSet::new();

    'queries: for q in &query_list {
        log::info!("[GetComics] Searching for: \"{}\"", q);
        let safe_query_words: Vec<String> = q.to_lowercase().split(' ')
            .filter(|&w| !w.is_empty() && !stop_words.contains(w))
            .map(|s| s.to_string())
            .collect();

        // Pack queries (no issue number) search against the original series year; issue queries
        // use the dynamic (issue-release-overridden) year. Parity with automation.ts activeYear.
        let is_pack_query = !re_issue_marker.is_match(q);
        let active_year = if is_pack_query { series_year } else { dynamic_year };
        let req_year: Option<String> = crate::search_engine::find_title_year(&clean_original)
            .or_else(|| active_year.map(|s| s.to_string()));

        let mut q_results: Vec<ProwlarrResult> = Vec::new();

        for page in 1..=max_pages {
            limiter.enforce("getcomics", if is_interactive { 2500 } else { 4000 }).await;

            let page_path = if page == 1 { "/".to_string() } else { format!("/page/{}/", page) };
            let search_url = format!("https://getcomics.org{}?s={}", page_path, urlencoding::encode(q));
            log::debug!("[GetComics Debug] Searching page {}/{}: {}", page, max_pages, search_url);

            let html = match fetch_html(&client, db, &search_url, flare_url.as_deref()).await {
                Ok(h) => h,
                Err(e) => { log::warn!("[GetComics] Fetch failed for \"{}\": {}", q, e); break; }
            };

            // Extract (title, link) first so the non-Send scraper types are dropped before any await.
            let posts_data: Vec<(String, String)> = {
                let document = Html::parse_document(&html);
                let posts: Vec<_> = document.select(&article_sel).collect();
                if posts.is_empty() { break; } // reached the end of pagination
                posts.iter().filter_map(|article| {
                    article.select(&a_sel).next().map(|a| {
                        (a.inner_html().trim().to_string(), a.value().attr("href").unwrap_or("").to_string())
                    })
                }).filter(|(t, l)| !t.is_empty() && !l.is_empty()).collect()
            };

            for (title, link) in posts_data {
                let title_lower = title.to_lowercase();
                let mut is_relevant = true;

                // --- BASELINE FILTERS (both automated and interactive, beta.035) ---

                // 1. Enforce the core series name: every significant query word must appear. For a
                // single-issue request only the series name (words before the issue number) is
                // enforced, so a subtitle GetComics omitted doesn't fail an otherwise-correct match.
                {
                    let mut words_to_enforce: Vec<String> = if req_num.is_some() && !is_looking_for_omnibus {
                        safe_query_words.clone()
                    } else {
                        original_query_words.clone()
                    };
                    if req_num.is_some() && !is_looking_for_omnibus {
                        if let Some(idx) = safe_query_words.iter().position(|w| {
                            re_word_num.find(w).and_then(|m| m.as_str().parse::<f32>().ok()) == req_num
                        }) {
                            words_to_enforce = safe_query_words[..idx].to_vec();
                        }
                    }
                    for w in &words_to_enforce {
                        if !w.chars().all(char::is_numeric) && !title_lower.contains(w) {
                            is_relevant = false;
                            break;
                        }
                    }
                }

                // 2. Enforce the release year (±1 variance between ComicVine and uploaders).
                if is_relevant {
                    if let Some(ry) = &req_year {
                        if let Some(ty) = crate::search_engine::find_title_year(&title_lower) {
                            if let (Ok(ryn), Ok(tyn)) = (ry.parse::<i32>(), ty.parse::<i32>()) {
                                if (ryn - tyn).abs() > 1 { is_relevant = false; }
                            }
                        }
                    }
                }

                // --- STRICT AUTOMATION-ONLY FILTERS ---
                if !is_interactive && is_relevant {
                    let is_pack = allow_bulk_packs && pack_terms.iter().any(|t| title_lower.contains(t));

                    // TPB guard: reject collected editions when a single issue was requested.
                    if req_num.is_some() && !is_looking_for_omnibus && !is_pack {
                        let has_unexpected_tpb = tpb_terms.iter()
                            .any(|t| !clean_original.contains(*t) && title_lower.contains(*t));
                        if has_unexpected_tpb { is_relevant = false; }
                    }

                    // Variant guard (only when the user didn't ask for a variant).
                    if is_relevant
                        && !user_wants_variant
                        && (open_variant_keywords.iter().any(|k| title_lower.contains(k))
                            || crate::search_engine::matches_bounded_variant(&title_lower))
                    {
                        is_relevant = false;
                    }

                    // Issue-number guard.
                    if is_relevant && !is_looking_for_omnibus && !is_pack {
                        if let Some(rn) = &req_num {
                            match &crate::search_engine::extract_title_number(&title_lower, is_manga) {
                                Some(tn) if tn != rn => is_relevant = false,
                                None => is_relevant = false,
                                _ => {}
                            }
                        }
                    }

                    // Annual guard.
                    if is_relevant && !is_looking_for_annual && title_lower.contains("annual") {
                        is_relevant = false;
                    }
                }

                if is_relevant {
                    q_results.push(ProwlarrResult {
                        guid: link.clone(), title, size: 0, indexer: "GetComics".to_string(),
                        seeders: 100, peers: 0, info_url: link.clone(), download_url: link,
                        protocol: "ddl".to_string(), publish_date: "N/A".to_string(), info_hash: None,
                    });
                }
            }

            // Only halt pagination early for background automation; interactive captures every page.
            if !q_results.is_empty() && !is_interactive {
                log::debug!("[GetComics Debug] Found {} valid matches on page {}. Halting pagination.", q_results.len(), page);
                break;
            }
        }

        // Year-first then shortest-title sort, per query (parity with performSearch's sort).
        q_results.sort_by(|a, b| {
            if let Some(ry) = &req_year {
                let a_has = a.title.contains(ry.as_str());
                let b_has = b.title.contains(ry.as_str());
                if a_has != b_has { return b_has.cmp(&a_has); }
            }
            a.title.len().cmp(&b.title.len())
        });

        if !q_results.is_empty() {
            if !is_interactive {
                // Automation takes the absolute best match instantly (upstream returns [results[0]]).
                log::info!("[GetComics] Found {} relevant result(s) for query: \"{}\" — taking the best.", q_results.len(), q);
                results.push(q_results.remove(0));
                break 'queries;
            }
            // Interactive collects everything, de-duped by URL.
            for r in q_results {
                if seen_urls.insert(r.download_url.clone()) {
                    results.push(r);
                }
            }
        }
    }

    Ok(results)
}

fn get_hoster_from_url(url: &str, is_main_btn: bool) -> String {
    if is_main_btn { return "getcomics".to_string(); }
    if url.contains("comicfiles") || url.contains("comic-files") { return "getcomics".to_string(); }
    if url.contains("mediafire.com") { return "mediafire".to_string(); }
    if url.contains("mega.nz") || url.contains("mega.co.nz") { return "mega".to_string(); }
    if url.contains("pixeldrain.com") { return "pixeldrain".to_string(); }
    if url.contains("terabox.com") || url.contains("teraboxapp.com") { return "terabox".to_string(); }
    if url.contains("rootz") { return "rootz".to_string(); }
    if url.contains("vikingfile") { return "vikingfile".to_string(); }
    if url.contains("zippyshare.com") { return "zippyshare".to_string(); }
    if url.contains("userscloud.com") { return "userscloud".to_string(); }
    
    "unknown".to_string()
}

pub async fn scrape_deep_link(db: &PgPool, limiter: &crate::rate_limiter::RateLimiter, article_url: &str) -> anyhow::Result<DeepLinkResult> {
    limiter.enforce("getcomics", 2500).await;

    let flare_url: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'flaresolverr_url'"#).fetch_optional(db).await?;
    let client = Client::builder().user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36").build()?;

    let html = match fetch_html(&client, db, article_url, flare_url.as_deref()).await {
        Ok(h) => h,
        Err(e) => {
            // Graceful sentinel (parity with Node's catch-all) so the caller keeps the article URL instead of erroring.
            log::warn!("[GetComics] Failed to scrape deep link {}: {}", article_url, e);
            return Ok(DeepLinkResult { url: article_url.to_string(), hoster: "unknown".to_string() });
        }
    };
    let mut found_links = Vec::new();

    {
        let document = Html::parse_document(&html);
        let a_sel = Selector::parse("a").unwrap();

        for a_tag in document.select(&a_sel) {
            let raw_href = a_tag.value().attr("href").unwrap_or("");
            let text = a_tag.text().collect::<Vec<_>>().join(" ").to_lowercase();
            let title_attr = a_tag.value().attr("title").unwrap_or("").to_lowercase();
            let btn_class = a_tag.value().attr("class").unwrap_or("").to_lowercase();

            let mut decoded = raw_href.to_string();
            if let Some(idx) = raw_href.find("go.php-url=") {
                let mut encoded = raw_href[idx + 11..].to_string();
                // The base64 payload ends at the query separator; a trailing &hoster=… suffix is not
                // part of it. Strict base64 would reject the whole string, so truncate first — the
                // correct read of the wrapped URL (Node decoded leniently and kept the leading run).
                if let Some(amp) = encoded.find(['&', '#']) { encoded.truncate(amp); }
                encoded = encoded.replace("%3D", "=").replace("%3d", "=");
                while encoded.len() % 4 != 0 { encoded.push('='); }

                if let Ok(bytes) = STANDARD.decode(&encoded) {
                    if let Ok(s) = String::from_utf8(bytes) { decoded = s; }
                }
            }

            if decoded.is_empty() { continue; }

            let is_main_btn = text.contains("main server") || 
                              title_attr.contains("main server") || 
                              text.contains("download now") || 
                              text.contains("direct download") || 
                              (btn_class.contains("aio-button") && text.contains("download"));
            
            if is_main_btn && !raw_href.contains("go.php") && !decoded.to_lowercase().ends_with(".cbz") && !decoded.to_lowercase().ends_with(".zip") && !decoded.to_lowercase().ends_with(".cbr")
                && !decoded.contains("comicfiles") && !decoded.contains("comic-files") && !decoded.contains("getcomics") { 
                    continue; 
                }

            let hoster = get_hoster_from_url(&decoded, is_main_btn);
            if hoster != "unknown" {
                log::debug!("[GetComics Debug] Decoded deep link -> {} (hoster: {})", decoded, hoster);
                found_links.push(DeepLinkResult { url: decoded, hoster });
            }
        }
    }

    let hp_setting: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'hoster_priority'"#).fetch_optional(db).await?;
    let mut priority_list = vec!["mediafire".to_string(), "getcomics".to_string(), "mega".to_string(), "pixeldrain".to_string(), "rootz".to_string(), "vikingfile".to_string(), "terabox".to_string()];
    let mut disabled_hosters = Vec::new();

    if let Some(val) = hp_setting {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&val) {
            if let Some(arr) = parsed.as_array() {
                if !arr.is_empty() {
                    if arr[0].is_string() {
                        priority_list = arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
                    } else if arr[0].is_object() {
                        priority_list = arr.iter().filter_map(|v| v.get("hoster").and_then(|h| h.as_str()).map(|s| s.to_string())).collect();
                        disabled_hosters = arr.iter().filter(|v| v.get("enabled").and_then(|e| e.as_bool()) == Some(false))
                            .filter_map(|v| v.get("hoster").and_then(|h| h.as_str()).map(|s| s.to_string())).collect();
                    }
                }
            }
        }
    }

    let available: Vec<String> = found_links.iter().map(|l| l.hoster.clone()).collect();
    log::info!("[GetComics] Found {} valid links. Available hosters: {}", found_links.len(), available.join(", "));

    found_links.retain(|l| !disabled_hosters.contains(&l.hoster));
    if found_links.is_empty() { return Ok(DeepLinkResult { url: article_url.to_string(), hoster: "unknown".to_string() }); }

    found_links.sort_by(|a, b| {
        let pos_a = priority_list.iter().position(|x| x == &a.hoster).unwrap_or(99);
        let pos_b = priority_list.iter().position(|x| x == &b.hoster).unwrap_or(99);
        pos_a.cmp(&pos_b)
    });

    // Warn if the top-priority enabled hoster wasn't available and we had to fall back (parity with getcomics.ts).
    let selected = found_links[0].clone();
    if let Some(top) = priority_list.iter().find(|h| !disabled_hosters.contains(h)) {
        if &selected.hoster != top {
            log::warn!("[GetComics] Preferred hoster '{}' not available. Falling back to '{}'.", top, selected.hoster);
        } else {
            log::info!("[GetComics] Selected preferred hoster: {}", selected.hoster);
        }
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pure URL→hoster classifier gating the entire DDL routing.
    #[test]
    fn hoster_classification_from_urls() {
        assert_eq!(get_hoster_from_url("https://anything.example/x", true), "getcomics"); // main button
        assert_eq!(get_hoster_from_url("https://comicfiles.ru/file.cbz", false), "getcomics");
        assert_eq!(get_hoster_from_url("https://www.mediafire.com/file/abc", false), "mediafire");
        assert_eq!(get_hoster_from_url("https://mega.nz/file/xyz", false), "mega");
        assert_eq!(get_hoster_from_url("https://mega.co.nz/#!old", false), "mega");
        assert_eq!(get_hoster_from_url("https://pixeldrain.com/u/abc", false), "pixeldrain");
        assert_eq!(get_hoster_from_url("https://terabox.com/s/abc", false), "terabox");
        assert_eq!(get_hoster_from_url("https://www.teraboxapp.com/s/abc", false), "terabox");
        assert_eq!(get_hoster_from_url("https://rootz.example/abc", false), "rootz");
        assert_eq!(get_hoster_from_url("https://vikingfile.com/f/abc", false), "vikingfile");
        assert_eq!(get_hoster_from_url("https://www.zippyshare.com/v/abc", false), "zippyshare");
        assert_eq!(get_hoster_from_url("https://userscloud.com/abc", false), "userscloud");
        assert_eq!(get_hoster_from_url("https://random-host.io/file", false), "unknown");
    }
}