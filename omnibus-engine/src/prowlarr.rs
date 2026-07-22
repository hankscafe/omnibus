use serde::{Deserialize, Serialize};
use sqlx::Row;

#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RawProwlarrResult {
    pub guid: Option<String>,
    pub title: Option<String>,
    pub size: Option<i64>,
    pub indexer: Option<String>,
    pub seeders: Option<i32>,
    pub leechers: Option<i32>,
    pub peers: Option<i32>,
    pub info_url: Option<String>,
    pub download_url: Option<String>,
    pub magnet_url: Option<String>,
    pub protocol: Option<String>,
    pub publish_date: Option<String>,
    pub info_hash: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProwlarrResult {
    pub guid: String,
    pub title: String,
    pub size: i64,
    pub indexer: String,
    pub seeders: i32,
    pub peers: i32,
    pub info_url: String,
    pub download_url: String,
    pub protocol: String,
    pub publish_date: String,
    pub info_hash: Option<String>,
    // Which query produced this hit and its position in the caller's ladder (0 = most specific).
    // Set only on Prowlarr results; the interactive UI badges query_rung > 0 as "via broadened
    // search". Absent (skipped) for GetComics/Anna's results, which share this struct.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_rung: Option<u8>,
}

/// Parse the comma-separated Prowlarr category list, dropping the manga category (8030) for comic
/// searches (parity with prowlarr.ts). Pure — unit-tested.
fn parse_categories(cats_raw: &str, is_manga: bool) -> Vec<String> {
    cats_raw
        .split(',')
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .filter(|c| is_manga || c != "8030")
        .collect()
}

/// Map a raw Prowlarr indexer hit to our normalized result: protocol normalization, the empty-string
/// downloadUrl→magnet fallback, the leechers(≠0)→peers fallback, and btih hash extraction from the
/// magnet. Mirrors prowlarr.ts; pure — unit-tested as a drift guard.
fn map_raw_result(item: RawProwlarrResult) -> ProwlarrResult {
    let protocol = item.protocol.unwrap_or_else(|| "torrent".to_string()).to_lowercase();
    let final_protocol = if protocol == "usenet" || protocol == "nzb" { "usenet" } else { "torrent" };

    // Treat an empty-string downloadUrl as absent and fall back to magnet (parity with Node's
    // `item.downloadUrl || item.magnetUrl`, where "" is falsy).
    let download_url = item.download_url.filter(|s| !s.is_empty()).or(item.magnet_url.clone()).unwrap_or_default();

    let mut info_hash = item.info_hash;
    if info_hash.is_none() {
        if let Some(mag) = &item.magnet_url {
            if let Some(start) = mag.find("urn:btih:") {
                let hash_part = &mag[start + 9..];
                let hash = hash_part.split('&').next().unwrap_or("").to_lowercase();
                if !hash.is_empty() { info_hash = Some(hash); }
            }
        }
    }

    ProwlarrResult {
        guid: item.guid.unwrap_or_default(), title: item.title.unwrap_or_default(),
        size: item.size.unwrap_or(0), indexer: item.indexer.unwrap_or_default(),
        seeders: item.seeders.unwrap_or(0), peers: item.leechers.filter(|&n| n != 0).or(item.peers).unwrap_or(0),
        info_url: item.info_url.unwrap_or_default(), download_url,
        protocol: final_protocol.to_string(), publish_date: item.publish_date.unwrap_or_default(),
        info_hash,
        matched_query: None, query_rung: None,
    }
}

/// `exhaustive`: when true (automated search), results are accumulated + deduped across EVERY query
/// so the downstream relevance filter (`filter_and_score`) sees the full pool — otherwise a first
/// query that returns only irrelevant hits would shadow a later, more-specific query and yield no
/// match at all (the queries are ordered specific-first, so the good query often comes later). When
/// false (interactive search), the first non-empty query wins to keep the UI response fast.
pub async fn search(db: &sqlx::AnyPool, limiter: &crate::rate_limiter::RateLimiter, queries: &[String], is_manga: bool, exhaustive: bool) -> anyhow::Result<Vec<ProwlarrResult>> {    let prowlarr_url: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'prowlarr_url'"#).fetch_optional(db).await?;
    let prowlarr_key: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'prowlarr_key'"#).fetch_optional(db).await?;
    let prowlarr_key = crate::secret_crypto::decrypt_setting(db, prowlarr_key).await;
    let prowlarr_cats: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'prowlarr_categories'"#).fetch_optional(db).await?;
    
    let (url, key) = match (prowlarr_url, prowlarr_key) {
        (Some(u), Some(k)) if !u.is_empty() && !k.is_empty() => (u, k),
        _ => {
            log::warn!("Prowlarr not configured in database.");
            return Ok(vec![]);
        }
    };

    let clean_url = url.trim_end_matches('/');
    let cats_raw = prowlarr_cats.unwrap_or_else(|| "7030".to_string());
    // Drop the manga category (8030) for comic searches, matching prowlarr.ts:44-46.
    let categories: Vec<String> = parse_categories(&cats_raw, is_manga);

    // Restrict the search to the user's configured indexers (parity with prowlarr.ts indexerIds).
    let indexer_ids: Vec<i32> = sqlx::query(r#"SELECT id FROM "Indexer""#)
        .fetch_all(db)
        .await
        .unwrap_or_default()
        .iter()
        .map(|r| r.get::<i32, _>("id"))
        .collect();

    let custom_headers = sqlx::query(r#"SELECT key, value FROM "CustomHeader""#).fetch_all(db).await.unwrap_or_default();
    let client = crate::shared_http_client();

    // Loop through the fuzzy queries. In exhaustive mode we visit every query and accumulate a deduped
    // pool; otherwise we return the first query that yields any results.
    let mut combined: Vec<ProwlarrResult> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (rung, q) in queries.iter().enumerate() {
        log::info!("[Prowlarr] Searching for: \"{}\"", q);
        let mut req_url = format!("{}/api/v1/search?query={}&type=search&limit=100&offset=0", clean_url, urlencoding::encode(q));

        for c in &categories {
            req_url.push_str(&format!("&categories={}", c));
        }
        for id in &indexer_ids {
            req_url.push_str(&format!("&indexerIds={}", id));
        }
        log::debug!("[Prowlarr Debug] Hitting endpoint: {}", req_url);

        let mut request_builder = client.get(&req_url)
            .header("X-Api-Key", &key)
            .header("Accept", "application/json");

        for row in &custom_headers {
            let h_key: String = row.get("key");
            let h_val: String = row.get("value");
            if !h_key.is_empty() && !h_val.is_empty() {
                request_builder = request_builder.header(h_key, h_val);
            }
        }

        limiter.enforce("prowlarr", 500).await; 
        
        let res = match request_builder.send().await {
            Ok(r) => r,
            Err(e) => {
                log::warn!("[Prowlarr] Request failed for \"{}\": {}", q, e);
                continue;
            }
        };

        if !res.status().is_success() {
            log::warn!("[Prowlarr] Indexer returned status {} for \"{}\"", res.status(), q);
            continue;
        }

        let raw_text = res.text().await.unwrap_or_default();
        let raw_results: Vec<RawProwlarrResult> = match serde_json::from_str(&raw_text) {
            Ok(r) => r,
            Err(e) => {
                log::warn!("[Prowlarr] Failed to parse response for \"{}\": {}", q, e);
                continue;
            }
        };

        let mut mapped_results: Vec<ProwlarrResult> = raw_results.into_iter().map(map_raw_result).collect();

        if mapped_results.is_empty() {
            continue;
        }
        log::info!("[Prowlarr] Found {} mapped results for \"{}\"", mapped_results.len(), q);

        // Stamp which ladder rung found these — the interactive UI badges rung > 0 as a
        // broadened-query match and sorts exact-term hits first.
        for r in &mut mapped_results {
            r.matched_query = Some(q.clone());
            r.query_rung = Some(rung.min(u8::MAX as usize) as u8);
        }

        // Interactive: first non-empty query wins (fast response).
        if !exhaustive {
            return Ok(mapped_results);
        }

        // Automated: accumulate across all queries, deduping on guid → downloadUrl → title so the
        // same release surfacing under overlapping queries isn't counted twice.
        for r in mapped_results {
            let dedup_key = if !r.guid.is_empty() {
                r.guid.clone()
            } else if !r.download_url.is_empty() {
                r.download_url.clone()
            } else {
                r.title.clone()
            };
            if seen.insert(dedup_key) {
                combined.push(r);
            }
        }
    }

    if exhaustive && !combined.is_empty() {
        log::info!("[Prowlarr] Accumulated {} deduped results across {} queries.", combined.len(), queries.len());
    }
    Ok(combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categories_drop_manga_for_comics_only() {
        assert_eq!(
            parse_categories("7030, 8030", false).iter().map(String::as_str).collect::<Vec<&str>>(),
            vec!["7030"]
        );
        assert_eq!(
            parse_categories("7030, 8030", true).iter().map(String::as_str).collect::<Vec<&str>>(),
            vec!["7030", "8030"]
        );
        assert_eq!(
            parse_categories(" 7030 ,, 7020 ", false).iter().map(String::as_str).collect::<Vec<&str>>(),
            vec!["7030", "7020"]
        );
    }

    fn raw(title: &str) -> RawProwlarrResult {
        RawProwlarrResult { title: Some(title.into()), ..Default::default() }
    }

    #[test]
    fn empty_download_url_falls_back_to_magnet_and_extracts_hash() {
        let mut r = raw("Comic");
        r.download_url = Some(String::new());
        r.magnet_url = Some("magnet:?xt=urn:btih:ABCDEF123&dn=x".into());
        let m = map_raw_result(r);
        assert_eq!(m.download_url, "magnet:?xt=urn:btih:ABCDEF123&dn=x");
        assert_eq!(m.info_hash.as_deref(), Some("abcdef123")); // parsed out of the magnet + lowercased
    }

    #[test]
    fn peers_prefers_nonzero_leechers_then_peers() {
        let mut r = raw("X"); r.leechers = Some(5); r.peers = Some(9);
        assert_eq!(map_raw_result(r).peers, 5);
        let mut r = raw("X"); r.leechers = Some(0); r.peers = Some(9);
        assert_eq!(map_raw_result(r).peers, 9); // leechers == 0 falls through to peers
        let mut r = raw("X"); r.leechers = None; r.peers = Some(7);
        assert_eq!(map_raw_result(r).peers, 7);
    }

    #[test]
    fn protocol_normalizes_usenet_and_torrent() {
        let mut r = raw("X"); r.protocol = Some("Usenet".into());
        assert_eq!(map_raw_result(r).protocol, "usenet");
        let mut r = raw("X"); r.protocol = Some("nzb".into());
        assert_eq!(map_raw_result(r).protocol, "usenet");
        let mut r = raw("X"); r.protocol = Some("Torrent".into());
        assert_eq!(map_raw_result(r).protocol, "torrent");
        assert_eq!(map_raw_result(raw("X")).protocol, "torrent"); // None defaults to torrent
    }
}