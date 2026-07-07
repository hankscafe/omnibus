use reqwest::Client;
use sqlx::Row;
use std::time::Duration;

// Built-in fallbacks (parity with manga-detector.ts).
const DEFAULT_MANGA_PUBLISHERS: &[&str] = &[
    "viz media", "kodansha", "yen press", "seven seas", "shueisha", "shogakukan", "tokyopop",
    "dark horse manga", "vertical", "ghost ship", "denpa", "fakku", "j-novel club", "sublime",
    "kuma", "ize press", "square enix", "hakusensha", "lezhin", "kadokawa", "futabasha", "houbunsha",
    "takeshobo", "mag garden", "akita shoten", "shonen gahosha", "nihon bungeisha", "coamix",
    "gee-whiz", "suiseisha", "ascii media works", "ichijinsha", "project-h", "irodori", "eros comix",
];
const DEFAULT_WESTERN_PUBLISHERS: &[&str] = &[
    "marvel", "dc comics", "image comics", "idw publishing", "dynamite", "boom! studios", "valiant",
    "archie", "oni press", "titan comics", "vault comics", "awa studios", "humanoids", "2000 ad", "zenescope",
];

/// Fetches the manga / western publisher lists from settings (or the built-in defaults).
/// Fetch once per scan and pass the lists into `detect_manga` to avoid N+1 queries.
pub async fn get_detector_settings(db: &sqlx::AnyPool) -> (Vec<String>, Vec<String>) {
    let rows = sqlx::query(r#"SELECT key, value FROM "SystemSetting" WHERE key IN ('manga_publishers', 'western_publishers')"#)
        .fetch_all(db)
        .await
        .unwrap_or_default();
    resolve_detector_lists(rows.iter().map(|r| (r.get("key"), r.get("value"))).collect())
}

fn resolve_detector_lists(kv: Vec<(String, String)>) -> (Vec<String>, Vec<String>) {
    let mut manga: Option<Vec<String>> = None;
    let mut western: Option<Vec<String>> = None;
    for (k, v) in kv {
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
    Ok(anilist_media_matches(&media, title, release_year))
}

/// True if any AniList media entry's English/Romaji title equals the search title (case-insensitive),
/// within a ±4-year window of the release year — a same-title match further off is likely a different
/// work. Split out from the HTTP call so the title/year matching can be unit-tested.
fn anilist_media_matches(media: &[serde_json::Value], title: &str, release_year: i32) -> bool {
    let search_title = title.trim().to_lowercase();
    for m in media {
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
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn anilist_matcher_honors_title_and_year_window() {
        let media = vec![json!({ "title": { "english": "Berserk", "romaji": "Berserk" }, "startDate": { "year": 1989 } })];
        // Exact title, no year constraint → match.
        assert!(anilist_media_matches(&media, "berserk", 0));
        // Within ±4 years → match.
        assert!(anilist_media_matches(&media, "Berserk", 1991));
        // Same title but >4 years off → rejected (likely a different work).
        assert!(!anilist_media_matches(&media, "Berserk", 2010));
        // Different title → no match.
        assert!(!anilist_media_matches(&media, "Naruto", 0));
        // Romaji-only match still counts.
        let romaji_only = vec![json!({ "title": { "english": null, "romaji": "Kingdom" }, "startDate": { "year": 2006 } })];
        assert!(anilist_media_matches(&romaji_only, "kingdom", 2007));
    }

    #[tokio::test]
    async fn detect_manga_short_circuits_on_known_publishers() {
        let client = reqwest::Client::new();
        let manga = vec!["viz media".to_string(), "kodansha".to_string()];
        let western = vec!["marvel".to_string(), "dc comics".to_string()];
        // Known manga publisher → true without hitting AniList.
        assert!(detect_manga(&client, "Any Title", "VIZ Media LLC", 2020, &manga, &western).await);
        // Known western publisher → false (AniList bypassed).
        assert!(!detect_manga(&client, "Any Title", "Marvel Comics", 2020, &manga, &western).await);
    }
}
