use reqwest::Client;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};

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
}

pub async fn search(db: &PgPool, limiter: &crate::rate_limiter::RateLimiter, queries: &[String], is_manga: bool) -> anyhow::Result<Vec<ProwlarrResult>> {    let prowlarr_url: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'prowlarr_url'"#).fetch_optional(db).await?;
    let prowlarr_key: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'prowlarr_key'"#).fetch_optional(db).await?;
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
    let categories: Vec<String> = cats_raw
        .split(',')
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .filter(|c| is_manga || c != "8030")
        .collect();

    // Restrict the search to the user's configured indexers (parity with prowlarr.ts indexerIds).
    let indexer_ids: Vec<i32> = sqlx::query(r#"SELECT id FROM "Indexer""#)
        .fetch_all(db)
        .await
        .unwrap_or_default()
        .iter()
        .map(|r| r.get::<i32, _>("id"))
        .collect();

    let custom_headers = sqlx::query(r#"SELECT key, value FROM "CustomHeader""#).fetch_all(db).await.unwrap_or_default();
    let client = Client::new();

    // Loop through the fuzzy queries until we find a match!
    for q in queries {
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

        let mut mapped_results = Vec::new();

        for item in raw_results {
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

            mapped_results.push(ProwlarrResult {
                guid: item.guid.unwrap_or_default(), title: item.title.unwrap_or_default(),
                size: item.size.unwrap_or(0), indexer: item.indexer.unwrap_or_default(),
                seeders: item.seeders.unwrap_or(0), peers: item.leechers.filter(|&n| n != 0).or(item.peers).unwrap_or(0),
                info_url: item.info_url.unwrap_or_default(), download_url,
                protocol: final_protocol.to_string(), publish_date: item.publish_date.unwrap_or_default(),
                info_hash,
            });
        }

        // If we found results, instantly return them!
        if !mapped_results.is_empty() {
            log::info!("[Prowlarr] Found {} mapped results for \"{}\"", mapped_results.len(), q);
            return Ok(mapped_results);
        }
    }

    Ok(vec![])
}