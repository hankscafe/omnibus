// Discover-feed sync (DISCOVER_SYNC). Ported from queue.ts: rebuilds the `discover_cache_new` /
// `discover_cache_popular` SystemSetting caches the Discover dashboard reads. ComicVine path paginates
// /api/issues/ (two sort orders), batch-fetches /api/volumes/ for publisher+concepts, applies the
// publisher/keyword/manga filters, and formats each item. Metron path paginates recent issues,
// resolving missing series ids via a cached name search. Pure fetch→filter→cache; no downloads.
use anyhow::Result;
use sqlx::{PgPool, Row};
use reqwest::Client;
use std::collections::{HashMap, HashSet};
use serde_json::{json, Value};
use regex::Regex;
use std::sync::OnceLock;

/// Default manga-publisher list (parity with queue.ts DEFAULT_MANGA_PUBLISHERS).
const DEFAULT_MANGA_PUBLISHERS: &[&str] = &[
    "viz media", "kodansha", "yen press", "seven seas", "shueisha", "shogakukan", "tokyopop",
    "dark horse manga", "vertical", "ghost ship", "denpa", "fakku", "j-novel club", "sublime",
    "kuma", "ize press", "square enix", "hakusensha", "lezhin", "suiseisha", "nihon bungeisha",
    "takeshobo", "futabasha", "kadokawa", "akita shoten",
];

const MANGA_CONCEPTS: &[&str] = &["manga", "shonen", "seinen", "shojo", "josei", "manhwa", "manhua", "webtoon"];

fn re_year_paren() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\(\d{4}\)").unwrap())
}

/// Strips HTML tags (parity with formatItem's `.replace(/(<([^>]+)>)/gi, '')`).
fn strip_html_tags(s: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    re.replace_all(s, "").to_string()
}

/// `isReleasedYet(storeDate, coverDate)` (utils.ts): store_date ≤ today; else cover_date ≤ today+45d
/// (cover dates run ~1-2 months ahead of release); else assume released. Unparseable dates → false,
/// mirroring `new Date("invalid") <= now`.
pub(crate) fn is_released_yet(store_date: Option<&str>, cover_date: Option<&str>) -> bool {
    use chrono::{NaiveDate, Utc};
    let today = Utc::now().date_naive();
    if let Some(sd) = store_date.filter(|s| !s.is_empty()) {
        return NaiveDate::parse_from_str(sd, "%Y-%m-%d").map(|d| d <= today).unwrap_or(false);
    }
    if let Some(cd) = cover_date.filter(|s| !s.is_empty()) {
        let buffer = today + chrono::Duration::days(45);
        return NaiveDate::parse_from_str(cd, "%Y-%m-%d").map(|d| d <= buffer).unwrap_or(false);
    }
    true
}

/// A `Value` rendered for string interpolation: strings as-is, numbers stringified, else empty.
fn value_to_display(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// Dedupe preserving insertion order, then take the first 3 (parity with `[...new Set(x)].slice(0,3)`).
fn dedup_take3(v: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    v.into_iter().filter(|x| seen.insert(x.clone())).take(3).collect()
}

struct DiscoverConfig {
    cv_api_key: String,
    filter_enabled: bool,
    blocked_publishers: Vec<String>,
    blocked_keywords: Vec<String>,
    manga_filter_mode: String,
    allowed_manga_pubs: Vec<String>,
    manga_publishers: Vec<String>,
}

impl DiscoverConfig {
    /// Publisher/keyword blocklist + manga-mode filtering (parity with queue.ts `isValid`).
    fn is_valid(&self, item: &Value) -> bool {
        let pub_name = item.pointer("/volume/publisher/name").and_then(|v| v.as_str()).unwrap_or("").trim().to_lowercase();
        let vol_name = item.pointer("/volume/name").and_then(|v| v.as_str()).unwrap_or("").trim().to_lowercase();
        let empty: Vec<Value> = Vec::new();
        let concepts = item.pointer("/volume/concepts").and_then(|v| v.as_array()).unwrap_or(&empty);

        if self.filter_enabled {
            if !self.blocked_publishers.is_empty() && self.blocked_publishers.iter().any(|bp| pub_name.contains(bp.as_str())) {
                log::debug!("[Discover Sync Debug] Filtered out \"{}\" due to blocked publisher: {}", vol_name, pub_name);
                return false;
            }
            if !self.blocked_keywords.is_empty() && self.blocked_keywords.iter().any(|bk| vol_name.contains(bk.as_str())) {
                log::debug!("[Discover Sync Debug] Filtered out \"{}\" due to blocked keyword", vol_name);
                return false;
            }
        }

        let is_manga_pub = self.manga_publishers.iter().any(|mp| pub_name.contains(mp.as_str()));
        let has_manga_concept = concepts.iter().any(|c| {
            let n = c.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            MANGA_CONCEPTS.contains(&n.as_str())
        });

        if is_manga_pub || has_manga_concept {
            if self.manga_filter_mode == "HIDE_ALL" { return false; }
            if self.manga_filter_mode == "ALLOWED_ONLY" {
                let allowed = !self.allowed_manga_pubs.is_empty()
                    && self.allowed_manga_pubs.iter().any(|amp| pub_name.contains(amp.as_str()) || vol_name.contains(amp.as_str()));
                if !allowed { return false; }
            }
        }
        true
    }

    /// Builds the cached ComicVine item (parity with queue.ts `formatItem`).
    fn format_item(item: &Value) -> Value {
        let deck = item.get("deck").and_then(|v| v.as_str()).unwrap_or("");
        let desc = if !deck.is_empty() {
            deck.to_string()
        } else if let Some(d) = item.get("description").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            let stripped = strip_html_tags(d);
            if stripped.chars().count() > 800 {
                format!("{}...", stripped.chars().take(800).collect::<String>())
            } else {
                stripped
            }
        } else {
            String::new()
        };
        let description = if desc.is_empty() { "No description available.".to_string() } else { desc };

        let mut writers = Vec::new();
        let mut artists = Vec::new();
        let mut cover_artists = Vec::new();
        if let Some(pc) = item.get("person_credits").and_then(|v| v.as_array()) {
            for p in pc {
                let role = p.get("role").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
                let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if role.contains("writer") || role.contains("script") || role.contains("plot") || role.contains("story") { writers.push(name.clone()); }
                if role.contains("pencil") || role.contains("ink") || role.contains("artist") || role.contains("color") || role.contains("illustrator") { artists.push(name.clone()); }
                if role.contains("cover") { cover_artists.push(name); }
            }
        }

        let date_str = item.get("store_date").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
            .or_else(|| item.get("cover_date").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
            .unwrap_or("");
        let year = date_str.split('-').next().filter(|s| !s.is_empty()).unwrap_or("????");
        let vol_name = item.pointer("/volume/name").and_then(|v| v.as_str()).unwrap_or("");

        json!({
            "id": item.get("id").cloned().unwrap_or(Value::Null),
            "volumeId": item.pointer("/volume/id").cloned().unwrap_or(Value::Null),
            "name": format!("{} #{}", vol_name, value_to_display(item.get("issue_number"))),
            "issueNumber": item.get("issue_number").cloned().unwrap_or(json!("")),
            "isReleased": is_released_yet(item.get("store_date").and_then(|v| v.as_str()), item.get("cover_date").and_then(|v| v.as_str())),
            "year": year,
            "publisher": item.pointer("/volume/publisher/name").cloned().unwrap_or(Value::Null),
            "image": item.pointer("/image/medium_url").cloned().unwrap_or(Value::Null),
            "description": description,
            "siteUrl": item.get("site_detail_url").cloned().unwrap_or(Value::Null),
            "writers": dedup_take3(writers),
            "artists": dedup_take3(artists),
            "coverArtists": dedup_take3(cover_artists),
            "metadataSource": "COMICVINE",
        })
    }

    /// Paginates ComicVine /api/issues/ for one sort order, enriching each item's volume with
    /// publisher+concepts (batched /api/volumes/), until 112 valid items or 15 API calls.
    async fn fetch_category(&self, client: &Client, sort: &str) -> Result<Vec<Value>> {
        let mut valid_items: Vec<Value> = Vec::new();
        let mut offset = 0i64;
        let mut api_calls = 0;

        while valid_items.len() < 112 && api_calls < 15 {
            let offset_str = offset.to_string();
            let resp = client.get("https://comicvine.gamespot.com/api/issues/")
                .query(&[
                    ("api_key", self.cv_api_key.as_str()),
                    ("format", "json"),
                    ("limit", "100"),
                    ("offset", offset_str.as_str()),
                    ("sort", sort),
                    ("field_list", "id,name,issue_number,store_date,cover_date,image,deck,description,volume,person_credits,site_detail_url"),
                ])
                .header("User-Agent", "Omnibus/1.0")
                .send().await?;
            api_calls += 1;
            let data: Value = resp.error_for_status()?.json().await?;

            let mut items = data.get("results").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            if items.is_empty() { break; }
            offset += 100;

            // Distinct volume ids, insertion-ordered (parity with [...new Set(...)]).
            let vol_ids: Vec<i64> = {
                let mut seen = HashSet::new();
                items.iter()
                    .filter_map(|i| i.pointer("/volume/id").and_then(|v| v.as_i64()))
                    .filter(|id| seen.insert(*id))
                    .collect()
            };

            let mut volumes_map: HashMap<i64, Value> = HashMap::new();
            if !vol_ids.is_empty() {
                'chunks: for chunk in vol_ids.chunks(50) {
                    let vol_id_string = chunk.iter().map(|x| x.to_string()).collect::<Vec<_>>().join("|");
                    let filter = format!("id:{}", vol_id_string);
                    match client.get("https://comicvine.gamespot.com/api/volumes/")
                        .query(&[
                            ("api_key", self.cv_api_key.as_str()),
                            ("format", "json"),
                            ("filter", filter.as_str()),
                            ("field_list", "id,publisher,concepts"),
                        ])
                        .header("User-Agent", "Omnibus/1.0")
                        .send().await
                    {
                        Ok(vr) => {
                            api_calls += 1;
                            if let Ok(vd) = vr.json::<Value>().await {
                                if let Some(results) = vd.get("results") {
                                    let arr = if results.is_array() {
                                        results.as_array().cloned().unwrap_or_default()
                                    } else {
                                        vec![results.clone()]
                                    };
                                    for v in arr {
                                        if let Some(id) = v.get("id").and_then(|x| x.as_i64()) {
                                            volumes_map.insert(id, v);
                                        }
                                    }
                                }
                            }
                        }
                        // Node wraps the whole chunk loop in one try/catch → first error abandons the rest.
                        Err(_) => break 'chunks,
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }

            for item in items.iter_mut() {
                if let Some(vid) = item.pointer("/volume/id").and_then(|v| v.as_i64()) {
                    if let Some(vol) = volumes_map.get(&vid) {
                        if let Some(volume_obj) = item.get_mut("volume").and_then(|v| v.as_object_mut()) {
                            if let Some(pubv) = vol.get("publisher") { volume_obj.insert("publisher".to_string(), pubv.clone()); }
                            if let Some(con) = vol.get("concepts") { volume_obj.insert("concepts".to_string(), con.clone()); }
                        }
                    }
                }
                if self.is_valid(item) {
                    valid_items.push(Self::format_item(item));
                }
                if valid_items.len() == 112 { break; }
            }
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        }
        Ok(valid_items)
    }
}

async fn upsert_setting(db: &PgPool, key: &str, value: &str) -> Result<()> {
    sqlx::query(r#"INSERT INTO "SystemSetting" (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"#)
        .bind(key)
        .bind(value)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn run_discover_sync(db: PgPool) -> Result<(i32, String)> {
    // Load all settings into a map (parity with the config object).
    let rows = sqlx::query(r#"SELECT key, value FROM "SystemSetting""#).fetch_all(&db).await?;
    let config: HashMap<String, String> = rows.iter()
        .map(|r| (r.get::<String, _>("key"), r.get::<String, _>("value")))
        .collect();
    let get = |k: &str| config.get(k).map(|s| s.as_str()).unwrap_or("");
    let split_lower = |s: &str| -> Vec<String> {
        s.split(',').map(|x| x.trim().to_lowercase()).filter(|x| !x.is_empty()).collect()
    };

    let primary_source = if get("primary_metadata_source").is_empty() { "COMICVINE" } else { get("primary_metadata_source") };

    // Node requires a CV key up front regardless of source (queue.ts throws before the source branch).
    let cv_api_key = crate::secret_crypto::decrypt_setting(&db, config.get("cv_api_key").cloned()).await
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("CV_API_KEY").ok().filter(|s| !s.is_empty()))
        .unwrap_or_default();
    if cv_api_key.is_empty() {
        anyhow::bail!("Missing ComicVine API Key");
    }

    let filter_enabled = get("filter_enabled") == "true";
    let manga_filter_mode = if get("discover_manga_filter_mode").is_empty() { "SHOW_ALL".to_string() } else { get("discover_manga_filter_mode").to_string() };
    let manga_publishers = if get("manga_publishers").is_empty() {
        DEFAULT_MANGA_PUBLISHERS.iter().map(|s| s.to_string()).collect()
    } else {
        split_lower(get("manga_publishers"))
    };

    let client = Client::builder().user_agent("Omnibus/1.0").build()?;

    let (new_releases, popular): (Vec<Value>, Vec<Value>) = if primary_source == "METRON" {
        let metron_user = config.get("metron_user").cloned().unwrap_or_default();
        let metron_pass = crate::secret_crypto::decrypt_str(&db, config.get("metron_pass").map(|s| s.as_str()).unwrap_or("")).await;
        if metron_user.is_empty() || metron_pass.is_empty() {
            anyhow::bail!("Metron credentials missing for Discover Sync");
        }

        let thirty_days_ago = (chrono::Utc::now().date_naive() - chrono::Duration::days(30)).format("%Y-%m-%d").to_string();
        let mut next_url: Option<String> = Some(format!("https://metron.cloud/api/issue/?store_date_range_after={}", thirty_days_ago));
        let mut releases: Vec<Value> = Vec::new();
        let mut series_name_cache: HashMap<String, i64> = HashMap::new();

        while let Some(url) = next_url.clone() {
            if releases.len() >= 50 { break; }
            let res: Value = client.get(&url)
                .basic_auth(&metron_user, Some(&metron_pass))
                .header("User-Agent", "Omnibus/1.0")
                .send().await?
                .error_for_status()?
                .json().await?;

            for item in res.get("results").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
                // Series id: prefer the nested object / series_id field.
                let mut parsed_series_id: Option<i64> = None;
                if let Some(series_obj) = item.get("series").filter(|v| v.is_object()) {
                    parsed_series_id = series_obj.get("id").and_then(|v| v.as_i64())
                        .or_else(|| series_obj.get("id").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()));
                } else if let Some(sid) = item.get("series_id") {
                    parsed_series_id = sid.as_i64().or_else(|| sid.as_str().and_then(|s| s.parse().ok()));
                }

                let series_name: Option<String> = match item.get("series") {
                    Some(Value::String(s)) => Some(s.clone()),
                    Some(Value::Object(o)) => o.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    _ => None,
                };

                // Resolve a missing series id via a cached name search (rate-limited).
                if parsed_series_id.is_none() {
                    if let Some(name) = &series_name {
                        let clean_name = re_year_paren().replace_all(name, "").trim().to_string();
                        if let Some(cached) = series_name_cache.get(&clean_name) {
                            parsed_series_id = if *cached == 0 { None } else { Some(*cached) };
                        } else {
                            let search_url = format!("https://metron.cloud/api/series/?name={}", urlencoding::encode(&clean_name));
                            // validateStatus:()=>true in Node → don't error on non-2xx; inspect the status.
                            if let Ok(sr) = client.get(&search_url)
                                .basic_auth(&metron_user, Some(&metron_pass))
                                .header("User-Agent", "Omnibus/1.0")
                                .send().await
                            {
                                let status = sr.status();
                                if status.as_u16() == 429 {
                                    tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
                                } else if status.is_success() {
                                    if let Ok(sd) = sr.json::<Value>().await {
                                        let results = sd.get("results").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                                        if !results.is_empty() {
                                            let exact = results.iter().find(|s| {
                                                let n = s.get("name").or_else(|| s.get("series")).and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
                                                n == clean_name.to_lowercase()
                                            });
                                            let chosen = exact.or_else(|| results.first());
                                            if let Some(c) = chosen {
                                                let id = c.get("id").and_then(|v| v.as_i64())
                                                    .or_else(|| c.get("id").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()));
                                                if let Some(idv) = id {
                                                    parsed_series_id = Some(idv);
                                                    series_name_cache.insert(clean_name.clone(), idv);
                                                }
                                            }
                                        } else {
                                            // Cache the miss so we don't re-query a bad name.
                                            series_name_cache.insert(clean_name.clone(), 0);
                                        }
                                    }
                                } else {
                                    series_name_cache.insert(clean_name.clone(), 0);
                                }
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                        }
                    }
                }

                let number_str = value_to_display(item.get("number"));
                let number_display = if number_str.is_empty() { "1".to_string() } else { number_str.clone() };
                let issue_number = if number_str.is_empty() { json!("1") } else { item.get("number").cloned().unwrap_or(json!("1")) };
                let store_date = item.get("store_date").and_then(|v| v.as_str());
                let cover_date = item.get("cover_date").and_then(|v| v.as_str());
                let year = store_date.filter(|s| !s.is_empty()).and_then(|s| s.split('-').next()).unwrap_or("????");
                let publisher = item.pointer("/publisher/name").and_then(|v| v.as_str())
                    .or_else(|| item.pointer("/series/publisher/name").and_then(|v| v.as_str()))
                    .unwrap_or("Metron");
                let series_display = series_name.clone().unwrap_or_else(|| "Unknown".to_string());
                let description = item.get("desc").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("No description available.");

                releases.push(json!({
                    "id": item.get("id").cloned().unwrap_or(Value::Null),
                    "volumeId": parsed_series_id.unwrap_or(0),
                    "issueNumber": issue_number,
                    "isReleased": is_released_yet(store_date, cover_date),
                    "name": format!("{} #{}", series_display, number_display),
                    "year": year,
                    "publisher": publisher,
                    "image": item.get("image").cloned().unwrap_or(Value::Null),
                    "description": description,
                    "siteUrl": format!("https://metron.cloud/issue/{}/", value_to_display(item.get("id"))),
                    "metadataSource": "METRON",
                }));
            }

            next_url = res.get("next").and_then(|v| v.as_str()).map(|s| s.to_string());
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        }

        (releases, Vec::new())
    } else {
        let cfg = DiscoverConfig {
            cv_api_key,
            filter_enabled,
            blocked_publishers: split_lower(get("filter_publishers")),
            blocked_keywords: split_lower(get("filter_keywords")),
            manga_filter_mode: manga_filter_mode.clone(),
            allowed_manga_pubs: split_lower(get("discover_manga_allowed_publishers")),
            manga_publishers,
        };

        // Run both categories concurrently (parity with Promise.all). Either error fails the job.
        let (new_res, pop_res) = tokio::join!(
            cfg.fetch_category(&client, "store_date:desc"),
            cfg.fetch_category(&client, "cover_date:desc")
        );
        (new_res?, pop_res?)
    };

    upsert_setting(&db, "discover_cache_new", &serde_json::to_string(&new_releases)?).await?;
    upsert_setting(&db, "discover_cache_popular", &serde_json::to_string(&popular)?).await?;

    let count = (new_releases.len() + popular.len()) as i32;
    let message = format!(
        "Successfully rebuilt the Discover cache (New & Popular). Filter enabled: {}. Manga Mode: {}",
        filter_enabled, manga_filter_mode
    );
    Ok((count, message))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(mode: &str, filter_enabled: bool) -> DiscoverConfig {
        DiscoverConfig {
            cv_api_key: "k".to_string(),
            filter_enabled,
            blocked_publishers: vec!["evil comics".to_string()],
            blocked_keywords: vec!["adult".to_string()],
            manga_filter_mode: mode.to_string(),
            allowed_manga_pubs: vec!["viz media".to_string()],
            manga_publishers: vec!["viz media".to_string(), "kodansha".to_string()],
        }
    }

    fn item(publisher: &str, vol_name: &str, concepts: &[&str]) -> Value {
        json!({
            "volume": {
                "id": 1,
                "name": vol_name,
                "publisher": { "name": publisher },
                "concepts": concepts.iter().map(|c| json!({"name": c})).collect::<Vec<_>>(),
            }
        })
    }

    #[test]
    fn is_valid_blocks_publishers_and_keywords_only_when_filter_on() {
        let c = cfg("SHOW_ALL", true);
        assert!(!c.is_valid(&item("Evil Comics Inc", "Hero", &[])));   // blocked publisher
        assert!(!c.is_valid(&item("Good", "Adult Swim", &[])));        // blocked keyword
        assert!(c.is_valid(&item("Good", "Hero", &[])));               // clean
        // With the filter off, the blocklist is ignored.
        let off = cfg("SHOW_ALL", false);
        assert!(off.is_valid(&item("Evil Comics Inc", "Adult", &[])));
    }

    #[test]
    fn is_valid_manga_modes() {
        // HIDE_ALL drops anything detected as manga (by publisher or concept).
        let hide = cfg("HIDE_ALL", false);
        assert!(!hide.is_valid(&item("VIZ Media", "Naruto", &[])));         // manga publisher
        assert!(!hide.is_valid(&item("Other", "X", &["Shonen"])));          // manga concept
        assert!(hide.is_valid(&item("Marvel", "Spider-Man", &[])));         // not manga

        // ALLOWED_ONLY keeps manga only from an allowed publisher; SHOW_ALL keeps everything.
        let allowed = cfg("ALLOWED_ONLY", false);
        assert!(allowed.is_valid(&item("VIZ Media", "Naruto", &[])));       // allowed manga pub
        assert!(!allowed.is_valid(&item("Kodansha", "AOT", &["seinen"])));  // manga, not allowed
        let show = cfg("SHOW_ALL", false);
        assert!(show.is_valid(&item("Kodansha", "AOT", &["seinen"])));
    }

    #[test]
    fn format_item_builds_expected_shape() {
        let it = json!({
            "id": 42,
            "issue_number": "7",
            "store_date": "2000-01-15",
            "deck": "",
            "description": "<p>Hello <b>world</b></p>",
            "site_detail_url": "https://cv/issue/42",
            "image": { "medium_url": "http://img/m.jpg" },
            "volume": { "id": 9, "name": "Saga", "publisher": { "name": "Image" } },
            "person_credits": [
                {"role": "writer", "name": "BKV"},
                {"role": "Plot", "name": "BKV"},
                {"role": "penciller", "name": "Fiona"},
                {"role": "Cover", "name": "Fiona"}
            ]
        });
        let out = DiscoverConfig::format_item(&it);
        assert_eq!(out["name"], "Saga #7");
        assert_eq!(out["volumeId"], 9);
        assert_eq!(out["year"], "2000");
        assert_eq!(out["isReleased"], true);                 // 2000 is in the past
        assert_eq!(out["description"], "Hello world");       // HTML stripped
        assert_eq!(out["writers"], json!(["BKV"]));          // deduped
        assert_eq!(out["artists"], json!(["Fiona"]));
        assert_eq!(out["coverArtists"], json!(["Fiona"]));
        assert_eq!(out["metadataSource"], "COMICVINE");
    }

    #[test]
    fn released_logic_matches_node() {
        assert!(is_released_yet(Some("2000-01-01"), None));        // past store date
        assert!(!is_released_yet(Some("2999-01-01"), None));       // future store date
        assert!(!is_released_yet(Some("not-a-date"), None));       // unparseable → false
        assert!(is_released_yet(None, Some("2000-01-01")));        // past cover date
        assert!(!is_released_yet(None, Some("2999-01-01")));       // far-future cover date
        assert!(is_released_yet(None, None));                      // no dates → assume out
    }

    #[test]
    fn dedup_take3_preserves_order_and_caps() {
        let v = vec!["a".into(), "b".into(), "a".into(), "c".into(), "d".into()];
        assert_eq!(dedup_take3(v), vec!["a", "b", "c"]);
    }
}
