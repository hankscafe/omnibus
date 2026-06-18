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

/// One hoster's slot in the priority list (order preserved, plus its enabled flag).
#[derive(Debug, Clone)]
pub struct HosterPref {
    pub hoster: String,
    pub enabled: bool,
}

/// Default hoster order. Both GetComics variants sit at the TOP — `getcomics_direct` (the comicfiles
/// CDN) first, then `getcomics_main` (the getcomics.org/dls/ "main server"). The /dls/ direct download
/// succeeds for the majority of issues; only the subset behind a live Cloudflare challenge falls
/// through to the download-time manual-hold. It deliberately outranks the third-party mirrors because
/// those (rootz/vikingfile/terabox) are far less reliable to resolve. This matches the original single
/// `getcomics`-first ordering. Mirrors the Node `DEFAULT_HOSTER_ORDER`.
fn default_hoster_prefs() -> Vec<HosterPref> {
    // rootz/vikingfile/terabox are listed but DISABLED by default — they're Cloudflare/JS/app-gated and
    // can't be resolved by scraping, so they're off out of the box (kept toggleable so a user can try).
    [("getcomics_direct", true), ("getcomics_main", true), ("mediafire", true), ("mega", true),
     ("pixeldrain", true), ("rootz", false), ("vikingfile", false), ("terabox", false)]
        .iter().map(|(h, en)| HosterPref { hoster: h.to_string(), enabled: *en }).collect()
}

/// Migrates a legacy single `getcomics` entry into the split scheme: `getcomics_direct` keeps the
/// original slot + enabled flag, and the gated `getcomics_main` is inserted right after it (same
/// enabled flag, so both stay high-priority — the legacy `getcomics` was first). Idempotent; configs
/// already on the split scheme pass through untouched. Mirrors the Node `migrateHosterPrefs`.
fn migrate_legacy_getcomics(prefs: &mut Vec<HosterPref>) {
    if let Some(idx) = prefs.iter().position(|p| p.hoster == "getcomics") {
        let enabled = prefs[idx].enabled;
        prefs[idx].hoster = "getcomics_direct".to_string();
        if !prefs.iter().any(|p| p.hoster == "getcomics_main") {
            prefs.insert(idx + 1, HosterPref { hoster: "getcomics_main".to_string(), enabled });
        }
    }
}

/// Parses the `hoster_priority` setting into an ordered, migrated preference list (mirrors the Node
/// `enabledHostersFromSetting`/`migrateHosterPrefs` helpers): unset → defaults; empty array → none;
/// string array → all enabled in that order; object array → each entry's `enabled` flag (default true).
pub async fn hoster_prefs(db: &PgPool) -> Vec<HosterPref> {
    let hp: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'hoster_priority'"#)
        .fetch_optional(db).await.ok().flatten();
    let Some(val) = hp else { return default_hoster_prefs(); };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&val) else { return default_hoster_prefs(); };
    let Some(arr) = parsed.as_array() else { return default_hoster_prefs(); };
    if arr.is_empty() { return Vec::new(); }
    let mut prefs: Vec<HosterPref> = if arr[0].is_string() {
        arr.iter().filter_map(|v| v.as_str().map(|s| HosterPref { hoster: s.to_string(), enabled: true })).collect()
    } else {
        arr.iter().filter_map(|v| {
            let h = v.get("hoster").and_then(|h| h.as_str())?.to_string();
            let enabled = v.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true);
            Some(HosterPref { hoster: h, enabled })
        }).collect()
    };
    migrate_legacy_getcomics(&mut prefs);
    prefs
}

/// The set of currently-enabled hosters, priority order preserved (Node's `enabledHosters`).
pub async fn enabled_hosters(db: &PgPool) -> Vec<String> {
    hoster_prefs(db).await.into_iter().filter(|p| p.enabled).map(|p| p.hoster).collect()
}

/// Whether GetComics is usable as a source at all — either the fast direct CDN (`getcomics_direct`)
/// or the gated main server (`getcomics_main`) is enabled. The split replaced the single legacy
/// `getcomics` key, which is still accepted for un-migrated callers.
pub async fn is_getcomics_enabled(db: &PgPool) -> bool {
    enabled_hosters(db).await.iter().any(|h| h == "getcomics_direct" || h == "getcomics_main" || h == "getcomics")
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

/// Which Cloudflare solver the engine talks to. FlareSolverr and Byparr share the `/v1` request
/// shape, but differ in the `maxTimeout` UNIT: FlareSolverr expects milliseconds, Byparr expects
/// seconds. `solver_config` encodes that difference so the rest of the engine doesn't have to.
#[derive(Debug, Clone)]
pub struct SolverConfig {
    /// "flaresolverr" | "byparr".
    pub kind: String,
    /// Value to place in the `maxTimeout` JSON field (ms for FlareSolverr, seconds for Byparr).
    pub payload_timeout: u64,
    /// How long the engine waits for the solver's HTTP response (always real wall-clock ms).
    pub http_timeout_ms: u64,
}

/// Reads the solver type + solve budget and derives the per-solver request parameters.
/// `flaresolverr_timeout` is in seconds (admin-tunable, clamped 30–600); `solver_type` selects the
/// backend (default `flaresolverr`). GetComics' Cloudflare Turnstile can need far longer than the old
/// 60s, so the default budget is 300s. For Byparr the payload `maxTimeout` is in SECONDS; for
/// FlareSolverr it's MILLISECONDS — sending the wrong unit to Byparr would read 300000 as ~83 hours.
/// The engine's own HTTP timeout always uses real milliseconds + a 15s margin so it never cuts the
/// solver off before its own budget elapses.
pub async fn solver_config(db: &PgPool) -> SolverConfig {
    let secs = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'flaresolverr_timeout'"#)
        .fetch_optional(db).await.ok().flatten()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(300)
        .clamp(30, 600);
    let kind = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'solver_type'"#)
        .fetch_optional(db).await.ok().flatten()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| s == "byparr" || s == "flaresolverr")
        .unwrap_or_else(|| "flaresolverr".to_string());
    let payload_timeout = if kind == "byparr" { secs } else { secs * 1000 };
    SolverConfig { kind, payload_timeout, http_timeout_ms: secs * 1000 + 15_000 }
}

async fn fetch_html(client: &Client, db: &PgPool, url: &str, flaresolverr: Option<&str>) -> anyhow::Result<String> {
    let res = client.get(url).send().await?;
    if res.status() == 403 {
        if let Some(flare_url) = flaresolverr.filter(|f| !f.is_empty()) {
            let sc = solver_config(db).await;
            log::warn!("[GetComics] 403 detected for {}; attempting {} bypass...", url, sc.kind);
            let target = if flare_url.ends_with("/v1") { flare_url.to_string() } else { format!("{}/v1", flare_url) };
            let payload = serde_json::json!({ "cmd": "request.get", "url": url, "maxTimeout": sc.payload_timeout });
            log::debug!("[GetComics Debug] {} payload: {}", sc.kind, payload);
            match client.post(&target).json(&payload).timeout(std::time::Duration::from_millis(sc.http_timeout_ms)).send().await {
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

/// Extracts the cookie header (cf_clearance et al.) + browser User-Agent from a FlareSolverr
/// `solution` payload. Returns None if no cookies were present. Pure (no I/O) so it can be unit-tested.
fn parse_flaresolverr_clearance(data: &serde_json::Value) -> Option<(String, String)> {
    let solution = data.get("solution")?;
    let ua = solution.get("userAgent").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let cookies = solution.get("cookies")?.as_array()?
        .iter()
        .filter_map(|c| Some(format!("{}={}", c.get("name")?.as_str()?, c.get("value")?.as_str()?)))
        .collect::<Vec<_>>()
        .join("; ");
    if cookies.is_empty() { return None; }
    Some((cookies, ua))
}

/// Solves a Cloudflare challenge for `url` via the configured solver (FlareSolverr or Byparr — they
/// share the `/v1` request shape; `sc` carries the per-solver `maxTimeout` unit) and returns
/// (cookie_header, user_agent) to replay on a direct request. cf_clearance is IP+UA-bound, so the
/// caller MUST send the returned User-Agent and run with the same outbound IP as the solver. Used to
/// download Cloudflare-gated GetComics "main server" links (getcomics.org/dls/…) a raw fetch can't get past.
pub async fn flaresolverr_clearance(client: &Client, flare_url: &str, url: &str, sc: &SolverConfig) -> anyhow::Result<(String, String)> {
    let target = if flare_url.ends_with("/v1") { flare_url.to_string() } else { format!("{}/v1", flare_url) };
    let payload = serde_json::json!({ "cmd": "request.get", "url": url, "maxTimeout": sc.payload_timeout });
    // Wait a bit longer than the solver's own solve budget so the engine doesn't cut it off early.
    let res = client.post(&target)
        .json(&payload)
        .timeout(std::time::Duration::from_millis(sc.http_timeout_ms))
        .send().await?;
    let data: serde_json::Value = res.json().await?;
    match parse_flaresolverr_clearance(&data) {
        Some(c) => Ok(c),
        None => {
            // Surface WHY so an unsolved challenge (status=error, no solution) can be told apart from a
            // solver that returns cookies in an unexpected shape (status=ok but cookies=0) — from the
            // engine log alone. The full raw response goes to debug for deeper inspection.
            let status = data.get("status").and_then(|v| v.as_str()).unwrap_or("none");
            let message = data.get("message").and_then(|v| v.as_str()).unwrap_or("");
            let cookie_count = data.get("solution").and_then(|s| s.get("cookies")).and_then(|c| c.as_array()).map(|a| a.len());
            log::debug!("[GetComics Debug] FlareSolverr clearance response (no usable cookies): {}",
                serde_json::to_string(&data).map(|s| s.chars().take(600).collect::<String>()).unwrap_or_default());
            Err(anyhow::anyhow!(
                "FlareSolverr returned no usable cookies (status={status}, cookies={cookie_count:?}{})",
                if message.is_empty() { String::new() } else { format!(", message=\"{message}\"") }
            ))
        }
    }
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
    let client = crate::browser_http_client();

    let article_sel = Selector::parse("article, .post").unwrap();
    let a_sel = Selector::parse("h1.post-title a, h2.post-title a, h1 a, h2 a, .post-header a").unwrap();

    // ---- Query context derived from the ORIGINAL name (parity with performSearch's cleanOriginal). ----
    // Normalize first ("#1: Book One" -> "#1", "….cbz" -> "…"): otherwise a subtitle keyword like "Book"
    // flips this single-issue request into omnibus mode, and a leaked file extension ("cbz") or subtitle
    // word gets enforced as a required title word — rejecting every real single-issue file.
    let core_original = crate::search_engine::normalize_request_name(original_name);
    let clean_original = core_original.replace([':', '-', '&'], " ")
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

/// Classifies a decoded download URL into a hoster key. GetComics is split into two:
/// `getcomics_direct` (the comicfiles CDN — fast, no Cloudflare challenge) and `getcomics_main`
/// (getcomics.org/dls/… — the "main server" endpoint that sits behind Cloudflare and needs a solver).
/// URL-based checks win over `is_main_btn` so a "Download Now" button pointing at comicfiles is still
/// classed direct; a main-server button we can't otherwise classify defaults to the gated path.
/// Kept in lock-step with the Node `getHosterFromUrl`.
fn get_hoster_from_url(url: &str, is_main_btn: bool) -> String {
    let u = url.to_lowercase();
    // Fast GetComics file CDN — never Cloudflare-gated. Keep high priority.
    if u.contains("comicfiles") || u.contains("comic-files") { return "getcomics_direct".to_string(); }
    // GetComics' own "main server" endpoint sits behind Cloudflare. Last resort.
    if u.contains("/dls/") && u.contains("getcomics") { return "getcomics_main".to_string(); }
    if u.contains("mediafire.com") { return "mediafire".to_string(); }
    if u.contains("mega.nz") || u.contains("mega.co.nz") { return "mega".to_string(); }
    if u.contains("pixeldrain.com") { return "pixeldrain".to_string(); }
    if u.contains("terabox.com") || u.contains("teraboxapp.com") { return "terabox".to_string(); }
    if u.contains("rootz") { return "rootz".to_string(); }
    if u.contains("vikingfile") { return "vikingfile".to_string(); }
    // A "main server / download now" button we couldn't classify by URL is GetComics' gated path.
    if is_main_btn { return "getcomics_main".to_string(); }

    "unknown".to_string()
}

/// Scrapes an article for download links and returns the ranked candidate list (one link per hoster,
/// highest-priority first). Returning the full list — not just the top — lets the caller fall back
/// hoster-by-hoster at download time when the preferred one fails. Empty = no enabled hoster found.
pub async fn scrape_deep_link(db: &PgPool, limiter: &crate::rate_limiter::RateLimiter, article_url: &str) -> anyhow::Result<Vec<DeepLinkResult>> {
    limiter.enforce("getcomics", 2500).await;

    let flare_url: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'flaresolverr_url'"#).fetch_optional(db).await?;
    let client = crate::browser_http_client();

    let html = match fetch_html(&client, db, article_url, flare_url.as_deref()).await {
        Ok(h) => h,
        Err(e) => {
            // Graceful empty list (parity with Node's catch-all) so the caller falls back to a manual
            // hold / Prowlarr instead of erroring.
            log::warn!("[GetComics] Failed to scrape deep link {}: {}", article_url, e);
            return Ok(Vec::new());
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

    // Parse + legacy `getcomics` → `getcomics_direct`/`getcomics_main` migration. Only hosters that are
    // PRESENT and ENABLED in the priority list are eligible — a hoster toggled off, OR absent from the
    // list entirely, is never tried. An explicit empty array means "no preference", so fall back to the
    // default order.
    let prefs = hoster_prefs(db).await;
    let prefs = if prefs.is_empty() { default_hoster_prefs() } else { prefs };
    let enabled_order: Vec<String> = prefs.iter().filter(|p| p.enabled).map(|p| p.hoster.clone()).collect();

    let available: Vec<String> = found_links.iter().map(|l| l.hoster.clone()).collect();
    log::info!("[GetComics] Found {} valid links. Available hosters: {}", found_links.len(), available.join(", "));
    log::debug!("[GetComics Debug] Enabled hoster priority: [{}]", enabled_order.join(", "));

    // Keep only links from an explicitly present+enabled hoster (drops both disabled and unlisted ones).
    found_links.retain(|l| enabled_order.contains(&l.hoster));
    if found_links.is_empty() { return Ok(Vec::new()); }

    // Sort by enabled-priority position. getcomics_main (the /dls/ main server) sits high by default
    // because its direct download succeeds for most issues; only the subset behind a live Cloudflare
    // challenge falls through to the download-time manual-hold.
    found_links.sort_by(|a, b| {
        let pos_a = enabled_order.iter().position(|x| x == &a.hoster).unwrap_or(usize::MAX);
        let pos_b = enabled_order.iter().position(|x| x == &b.hoster).unwrap_or(usize::MAX);
        pos_a.cmp(&pos_b)
    });

    // De-dupe to one link per hoster (keep the highest-priority occurrence). The caller tries these in
    // order at download time, so one-per-hoster avoids re-attempting several Cloudflare-gated
    // getcomics.org/dls/ links (each can cost a 300s solve) while still giving real mirror fallbacks.
    let mut seen_hosters: HashSet<String> = HashSet::new();
    let candidates: Vec<DeepLinkResult> = found_links.into_iter()
        .filter(|l| seen_hosters.insert(l.hoster.clone()))
        .collect();

    if let (Some(top), Some(pref)) = (candidates.first(), enabled_order.first()) {
        if &top.hoster != pref {
            log::warn!("[GetComics] Preferred hoster '{}' not available; top candidate '{}' (+{} fallback(s)).", pref, top.hoster, candidates.len() - 1);
        } else {
            log::info!("[GetComics] Selected hoster: {} (+{} fallback(s)).", top.hoster, candidates.len() - 1);
        }
    }
    Ok(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Builds the Cookie header + UA the engine replays to get past Cloudflare on a getcomics.org/dls/ download.
    #[test]
    fn parses_flaresolverr_clearance_cookies_and_ua() {
        let data = serde_json::json!({
            "solution": {
                "userAgent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/120",
                "cookies": [
                    { "name": "cf_clearance", "value": "abc123" },
                    { "name": "__cf_bm", "value": "xyz789" }
                ]
            }
        });
        let (cookie, ua) = parse_flaresolverr_clearance(&data).unwrap();
        assert_eq!(cookie, "cf_clearance=abc123; __cf_bm=xyz789");
        assert_eq!(ua, "Mozilla/5.0 (X11; Linux x86_64) Chrome/120");
        // No cookies (or no solution) -> None, so the caller falls back to a direct fetch.
        assert!(parse_flaresolverr_clearance(&serde_json::json!({ "solution": { "cookies": [] } })).is_none());
        assert!(parse_flaresolverr_clearance(&serde_json::json!({ "status": "error" })).is_none());
    }

    // Pure URL→hoster classifier gating the entire DDL routing.
    #[test]
    fn hoster_classification_from_urls() {
        // A main-server button with an unclassifiable URL is GetComics' Cloudflare-gated path.
        assert_eq!(get_hoster_from_url("https://anything.example/x", true), "getcomics_main");
        // getcomics.org/dls/ "main server" links are gated, regardless of the button flag.
        assert_eq!(get_hoster_from_url("https://getcomics.org/dls/12345/", true), "getcomics_main");
        assert_eq!(get_hoster_from_url("https://getcomics.org/dls/12345/", false), "getcomics_main");
        // The comicfiles CDN is the fast, non-gated direct download — even on a main-server button.
        assert_eq!(get_hoster_from_url("https://comicfiles.ru/file.cbz", false), "getcomics_direct");
        assert_eq!(get_hoster_from_url("https://comicfiles.ru/file.cbz", true), "getcomics_direct");
        assert_eq!(get_hoster_from_url("https://www.mediafire.com/file/abc", false), "mediafire");
        assert_eq!(get_hoster_from_url("https://mega.nz/file/xyz", false), "mega");
        assert_eq!(get_hoster_from_url("https://mega.co.nz/#!old", false), "mega");
        assert_eq!(get_hoster_from_url("https://pixeldrain.com/u/abc", false), "pixeldrain");
        assert_eq!(get_hoster_from_url("https://terabox.com/s/abc", false), "terabox");
        assert_eq!(get_hoster_from_url("https://www.teraboxapp.com/s/abc", false), "terabox");
        assert_eq!(get_hoster_from_url("https://rootz.example/abc", false), "rootz");
        assert_eq!(get_hoster_from_url("https://vikingfile.com/f/abc", false), "vikingfile");
        // zippyshare (defunct) and userscloud (no resolver) are no longer classified.
        assert_eq!(get_hoster_from_url("https://www.zippyshare.com/v/abc", false), "unknown");
        assert_eq!(get_hoster_from_url("https://userscloud.com/abc", false), "unknown");
        assert_eq!(get_hoster_from_url("https://random-host.io/file", false), "unknown");
    }

    // Legacy single `getcomics` entry splits into direct (in place) + gated main (appended last).
    #[test]
    fn migrates_legacy_getcomics_to_split() {
        let mut prefs = vec![
            HosterPref { hoster: "getcomics".into(), enabled: true },
            HosterPref { hoster: "mediafire".into(), enabled: false },
        ];
        migrate_legacy_getcomics(&mut prefs);
        // getcomics_direct keeps the slot; getcomics_main is inserted right after it (both high-priority).
        assert_eq!(prefs[0].hoster, "getcomics_direct");
        assert!(prefs[0].enabled);
        assert_eq!(prefs[1].hoster, "getcomics_main");
        assert!(prefs[1].enabled);
        assert_eq!(prefs[2].hoster, "mediafire");
        // Idempotent: a second pass changes nothing.
        let before: Vec<_> = prefs.iter().map(|p| (p.hoster.clone(), p.enabled)).collect();
        migrate_legacy_getcomics(&mut prefs);
        let after: Vec<_> = prefs.iter().map(|p| (p.hoster.clone(), p.enabled)).collect();
        assert_eq!(before, after);
    }

    // The migration preserves the legacy entry's enabled flag on BOTH split keys.
    #[test]
    fn migrate_preserves_disabled_getcomics() {
        let mut prefs = vec![HosterPref { hoster: "getcomics".into(), enabled: false }];
        migrate_legacy_getcomics(&mut prefs);
        assert_eq!(prefs[0].hoster, "getcomics_direct");
        assert!(!prefs[0].enabled);
        assert_eq!(prefs[1].hoster, "getcomics_main");
        assert!(!prefs[1].enabled);
    }

    // A config already on the split scheme is left untouched (no duplicate keys, order preserved).
    #[test]
    fn migrate_leaves_split_scheme_untouched() {
        let mut prefs = vec![
            HosterPref { hoster: "getcomics_direct".into(), enabled: true },
            HosterPref { hoster: "mega".into(), enabled: true },
            HosterPref { hoster: "getcomics_main".into(), enabled: false },
        ];
        let before: Vec<_> = prefs.iter().map(|p| (p.hoster.clone(), p.enabled)).collect();
        migrate_legacy_getcomics(&mut prefs);
        let after: Vec<_> = prefs.iter().map(|p| (p.hoster.clone(), p.enabled)).collect();
        assert_eq!(before, after);
    }
}