use reqwest::Client;
use sqlx::{PgPool, Row};
use std::time::Duration;

// Built-in fallbacks (parity with manga-detector.ts).
const DEFAULT_MANGA_PUBLISHERS: &[&str] = &[
    "viz media", "kodansha", "yen press", "seven seas", "shueisha", "shogakukan", "tokyopop",
    "dark horse manga", "vertical", "ghost ship", "denpa", "fakku", "j-novel club", "sublime",
    "kuma", "ize press", "square enix", "hakusensha", "lezhin",
];
const DEFAULT_WESTERN_PUBLISHERS: &[&str] = &[
    "marvel", "dc comics", "image comics", "idw publishing", "dynamite", "boom! studios", "valiant",
    "archie", "oni press", "titan comics", "vault comics", "awa studios", "humanoids", "2000 ad", "zenescope",
];

/// Fetches the manga / western publisher lists from settings (or the built-in defaults).
/// Fetch once per scan and pass the lists into `detect_manga` to avoid N+1 queries.
pub async fn get_detector_settings(db: &PgPool) -> (Vec<String>, Vec<String>) {
    let rows = sqlx::query(r#"SELECT key, value FROM "SystemSetting" WHERE key IN ('manga_publishers', 'western_publishers')"#)
        .fetch_all(db)
        .await
        .unwrap_or_default();

    let mut manga: Option<Vec<String>> = None;
    let mut western: Option<Vec<String>> = None;
    for row in rows {
        let k: String = row.get("key");
        let v: String = row.get("value");
        let list: Vec<String> = v.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
        if !list.is_empty() {
            if k == "manga_publishers" { manga = Some(list); }
            else if k == "western_publishers" { western = Some(list); }
        }
    }

    let manga = manga.unwrap_or_else(|| DEFAULT_MANGA_PUBLISHERS.iter().map(|s| s.to_string()).collect());
    let western = western.unwrap_or_else(|| DEFAULT_WESTERN_PUBLISHERS.iter().map(|s| s.to_string()).collect());
    (manga, western)
}

/// Manga-detection waterfall (parity with manga-detector.ts, scanner context):
/// manga-publisher list → western-publisher bypass → AniList API cross-reference.
/// The ComicInfo `Manga` tag and the library `isManga` flag are handled by the caller before this.
pub async fn detect_manga(client: &Client, name: &str, publisher: &str, year: i32, manga_pubs: &[String], western_pubs: &[String]) -> bool {
    let pub_lower = publisher.to_lowercase();

    // Step 1: known manga publisher.
    if manga_pubs.iter().any(|mp| pub_lower.contains(mp.as_str())) {
        log::info!("[Manga Engine] Identified via Publisher: {}", publisher);
        return true;
    }

    // Step 2: known western publisher → not manga; skip the AniList call.
    if western_pubs.iter().any(|wp| pub_lower.contains(wp.as_str())) {
        log::info!("[Manga Engine] Bypassing AniList due to Western Publisher: {}", publisher);
        return false;
    }

    if name.is_empty() {
        return false;
    }

    // Step 3: AniList GraphQL cross-reference.
    match check_anilist(client, name, year).await {
        Ok(true) => {
            log::info!("[Manga Engine] Identified via AniList API Match for \"{}\"", name);
            true
        }
        Ok(false) => false,
        Err(e) => {
            log::warn!("[Manga Engine] AniList check failed for \"{}\": {}", name, e);
            false
        }
    }
}

async fn check_anilist(client: &Client, title: &str, release_year: i32) -> anyhow::Result<bool> {
    log::debug!("[Manga Engine Debug] Querying AniList GraphQL API for title: \"{}\"", title);

    let query = r#"query ($search: String) { Page(page: 1, perPage: 3) { media(search: $search, type: MANGA) { title { romaji english } startDate { year } format } } }"#;
    let body = serde_json::json!({ "query": query, "variables": { "search": title } });

    let resp = client
        .post("https://graphql.anilist.co")
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(10))
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        return Ok(false);
    }

    let data: serde_json::Value = resp.json().await?;
    let media = data["data"]["Page"]["media"].as_array().cloned().unwrap_or_default();
    let search_title = title.trim().to_lowercase();

    for m in &media {
        let eng = m["title"]["english"].as_str().map(|s| s.trim().to_lowercase()).unwrap_or_default();
        let romaji = m["title"]["romaji"].as_str().map(|s| s.trim().to_lowercase()).unwrap_or_default();

        if search_title == eng || search_title == romaji {
            // Fuzzy year guard: a same-title match more than 4 years off is likely a different work.
            if release_year > 0 {
                if let Some(jp_year) = m["startDate"]["year"].as_i64() {
                    if (release_year as i64 - jp_year).abs() > 4 {
                        log::info!("[Manga Engine] AniList match rejected due to year mismatch ({} vs JP {})", release_year, jp_year);
                        continue;
                    }
                }
            }
            return Ok(true);
        }
    }

    Ok(false)
}
