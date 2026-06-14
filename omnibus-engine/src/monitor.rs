// Series-monitor sync (SERIES_MONITOR) — the heavy half. Ported from queue.ts per the roadmap's
// "partial" split: this engine module does the multi-minute API fetch + match + skeleton-upsert
// (Phase 1 Metron Oracle ≤3000 upcoming issues, Phase 2 ComicVine 25 oldest-monitored series × 30
// issues), and returns the monitored, matched, not-yet-in-library issues as *candidates*. The Node
// worker keeps request creation + searchAndDownload (BullMQ) + the Phase 3 UNRELEASED upgrade sweep.
use anyhow::Result;
use sqlx::{PgPool, Row};
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

use crate::discover::is_released_yet;
use crate::metadata::is_same_issue;

/// A monitored, matched, not-in-library issue the Node worker should create/upgrade a Request for.
#[derive(Serialize)]
pub struct MonitorCandidate {
    pub volume_id: String,
    pub search_name: String,
    pub issue_number: String,
    pub issue_year: String,
    pub is_released: bool,
    pub publisher: String,
    pub is_manga: bool,
    pub image_url: Option<String>,
}

#[derive(Serialize)]
pub struct MonitorOutput {
    pub skeletons_created: i32,
    pub metron_fetched: i32,
    pub notes: Vec<String>,
    pub candidates: Vec<MonitorCandidate>,
}

struct SeriesRec {
    id: String,
    name: String,
    publisher: Option<String>,
    year: i32,
    metadata_id: Option<String>,
    metadata_source: String,
    monitored: bool,
    is_manga: bool,
    cover_url: Option<String>,
}

#[derive(Clone)]
struct IssueRec {
    id: String,
    number: String,
    file_path: Option<String>,
    release_date: Option<String>,
}

/// `str.toLowerCase().replace(/[^a-z0-9]/g, '')` (queue.ts `normalize`).
fn normalize(s: &str) -> String {
    s.to_lowercase().chars().filter(|c| c.is_ascii_digit() || c.is_ascii_lowercase()).collect()
}

/// A `Value` rendered for interpolation: strings as-is, numbers stringified, else None.
fn jstr(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// Inserts a WANTED skeleton Issue. Returns true on success (failures swallowed, parity with `.catch`).
#[allow(clippy::too_many_arguments)]
async fn insert_skeleton(
    db: &PgPool, series_id: &str, metadata_id: &str, source: &str, number: &str,
    name: Option<&str>, description: Option<&str>, release_date: Option<&str>, cover_url: Option<&str>,
) -> Option<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let res = sqlx::query(
        r#"INSERT INTO "Issue" (id, "seriesId", "metadataId", "metadataSource", "matchState", number, name, description, "releaseDate", "coverUrl", status, "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, 'MATCHED', $5, $6, $7, $8, $9, 'WANTED', NOW(), NOW())"#,
    )
    .bind(&id).bind(series_id).bind(metadata_id).bind(source).bind(number)
    .bind(name).bind(description).bind(release_date).bind(cover_url)
    .execute(db).await;
    match res {
        Ok(_) => Some(id),
        Err(e) => { log::warn!("[Series Monitor] Skeleton insert failed (issue #{}): {:?}", number, e); None }
    }
}

async fn update_skeleton_release_date(db: &PgPool, issue_id: &str, release_date: &str) {
    let _ = sqlx::query(r#"UPDATE "Issue" SET "releaseDate" = $1 WHERE id = $2"#)
        .bind(release_date).bind(issue_id).execute(db).await;
}

/// Loads every Series + its issues into memory (parity with `findMany({ include: { issues } })`).
async fn load_state(db: &PgPool) -> Result<(Vec<SeriesRec>, HashMap<String, Vec<IssueRec>>)> {
    let series_rows = sqlx::query(
        r#"SELECT id, name, publisher, year, "metadataId", "metadataSource", monitored, "isManga", "coverUrl" FROM "Series""#,
    ).fetch_all(db).await?;
    let series: Vec<SeriesRec> = series_rows.iter().map(|r| SeriesRec {
        id: r.get("id"),
        name: r.get("name"),
        publisher: r.get("publisher"),
        year: r.get("year"),
        metadata_id: r.get("metadataId"),
        metadata_source: r.get("metadataSource"),
        monitored: r.get::<Option<bool>, _>("monitored").unwrap_or(false),
        is_manga: r.get("isManga"),
        cover_url: r.get("coverUrl"),
    }).collect();

    let issue_rows = sqlx::query(r#"SELECT id, "seriesId", number, "filePath", "releaseDate" FROM "Issue""#).fetch_all(db).await?;
    let mut issues: HashMap<String, Vec<IssueRec>> = HashMap::new();
    for r in &issue_rows {
        let sid: String = r.get("seriesId");
        issues.entry(sid).or_default().push(IssueRec {
            id: r.get("id"),
            number: r.get("number"),
            file_path: r.get("filePath"),
            release_date: r.get("releaseDate"),
        });
    }
    Ok((series, issues))
}

fn is_already_in_library(issues: &[IssueRec], num: &str) -> bool {
    issues.iter().any(|i| is_same_issue(&i.number, num) && i.file_path.as_deref().map(|p| !p.is_empty()).unwrap_or(false))
}

/// Phase 1 — Metron Oracle: paginate global upcoming issues, match to local series, upsert skeletons,
/// and emit candidates for monitored series. Errors are captured into `notes` (Phase 2 still runs).
#[allow(clippy::too_many_arguments)]
async fn phase1_metron(
    db: &PgPool, client: &Client, user: &str, pass: &str,
    series: &[SeriesRec], issues: &mut HashMap<String, Vec<IssueRec>>,
    skeletons_created: &mut i32, candidates: &mut Vec<MonitorCandidate>, notes: &mut Vec<String>,
) {
    use chrono::{Duration, Utc};
    let today = Utc::now().date_naive();
    let past_str = (today - Duration::days(14)).format("%Y-%m-%d").to_string();
    let future_str = (today + Duration::days(90)).format("%Y-%m-%d").to_string();

    let mut next_url = Some(format!("https://metron.cloud/api/issue/?store_date_range_after={}&store_date_range_before={}", past_str, future_str));
    let mut metron_issues: Vec<Value> = Vec::new();
    let mut guard = 0;

    'fetch: while let Some(url) = next_url.clone() {
        if metron_issues.len() >= 3000 { break; }
        guard += 1;
        if guard > 1000 { notes.push("[Phase 1] Metron Oracle aborted: pagination guard tripped.".to_string()); break; }

        let resp = match client.get(&url)
            .basic_auth(user, Some(pass))
            .header("User-Agent", "Omnibus/1.0")
            .timeout(std::time::Duration::from_secs(15))
            .send().await
        {
            Ok(r) => r,
            Err(e) => { notes.push(format!("[Phase 1] Metron Oracle failed: {}", e)); break 'fetch; }
        };

        let status = resp.status();
        if status.as_u16() == 429 {
            let retry_after: u64 = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok()).unwrap_or(60);
            tokio::time::sleep(std::time::Duration::from_millis((retry_after + 1) * 1000)).await;
            continue;
        }
        if status.as_u16() >= 500 {
            notes.push(format!("[Phase 1] Metron Oracle failed: HTTP {}", status.as_u16()));
            break 'fetch;
        }

        // Burst-rate-limit headers (read before consuming the body).
        let burst_remaining: i64 = resp.headers().get("x-ratelimit-burst-remaining").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok()).unwrap_or(20);
        let burst_reset: i64 = resp.headers().get("x-ratelimit-burst-reset").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok()).unwrap_or(0);

        let data: Value = match resp.json().await {
            Ok(d) => d,
            Err(e) => { notes.push(format!("[Phase 1] Metron Oracle failed: {}", e)); break 'fetch; }
        };
        if let Some(results) = data.get("results").and_then(|v| v.as_array()) {
            metron_issues.extend(results.iter().cloned());
        }
        next_url = data.get("next").and_then(|v| v.as_str()).map(|s| s.to_string());

        // Pace to respect the burst budget (parity with the Node sleeps).
        if burst_remaining <= 2 {
            if burst_reset > 0 {
                let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
                let sleep_ms = ((burst_reset * 1000) - now_ms).max(0) + 500;
                tokio::time::sleep(std::time::Duration::from_millis(sleep_ms as u64)).await;
            } else {
                tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
            }
        } else if next_url.is_some() {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    }

    notes.push(format!("[Phase 1] Metron Oracle fetched {} global upcoming releases.", metron_issues.len()));

    for m in &metron_issues {
        let m_series_id = jstr(m.pointer("/series/id"));
        let m_series_name = normalize(m.pointer("/series/name").and_then(|v| v.as_str()).unwrap_or(""));
        let m_pub_name = normalize(
            m.pointer("/publisher/name").and_then(|v| v.as_str())
                .or_else(|| m.pointer("/series/publisher/name").and_then(|v| v.as_str()))
                .unwrap_or(""),
        );
        let m_num_str = match jstr(m.get("number")).or_else(|| jstr(m.get("issue"))) {
            Some(s) => s,
            None => continue,
        };
        let m_num: f64 = match m_num_str.parse() { Ok(n) => n, Err(_) => continue };

        // Match by Metron id, else by normalized name (+ publisher when present).
        let matched_idx = m_series_id.as_ref()
            .and_then(|msid| series.iter().position(|s| s.metadata_source == "METRON" && s.metadata_id.as_deref() == Some(msid.as_str())))
            .or_else(|| {
                if m_series_name.is_empty() { return None; }
                series.iter().position(|s| {
                    normalize(&s.name) == m_series_name
                        && (m_pub_name.is_empty() || normalize(s.publisher.as_deref().unwrap_or("")) == m_pub_name)
                })
            });

        let Some(idx) = matched_idx else { continue };
        let s = &series[idx];
        let issue_date = m.get("store_date").and_then(|v| v.as_str()).filter(|x| !x.is_empty())
            .or_else(|| m.get("cover_date").and_then(|v| v.as_str()).filter(|x| !x.is_empty()))
            .map(|x| x.to_string());
        let is_released = is_released_yet(m.get("store_date").and_then(|v| v.as_str()), m.get("cover_date").and_then(|v| v.as_str()));

        // Skeleton upsert (matched series, monitored or not — calendar entries). Find by float equality.
        let bucket = issues.entry(s.id.clone()).or_default();
        let existing_pos = bucket.iter().position(|i| i.number.parse::<f64>().ok() == Some(m_num));
        match existing_pos {
            None => {
                let m_id = jstr(m.get("id")).unwrap_or_default();
                let name = m.get("name").and_then(|v| v.as_str()).or_else(|| m.get("issue_name").and_then(|v| v.as_str()));
                let desc = m.get("desc").and_then(|v| v.as_str()).or_else(|| m.get("description").and_then(|v| v.as_str()));
                let cover = m.get("image").and_then(|v| v.as_str());
                if let Some(new_id) = insert_skeleton(db, &s.id, &m_id, "METRON", &m_num_str, name, desc, issue_date.as_deref(), cover).await {
                    bucket.push(IssueRec { id: new_id, number: m_num_str.clone(), file_path: None, release_date: issue_date.clone() });
                    *skeletons_created += 1;
                }
            }
            Some(pos) => {
                if let Some(date) = &issue_date {
                    if bucket[pos].release_date.as_deref() != Some(date.as_str()) {
                        let iid = bucket[pos].id.clone();
                        update_skeleton_release_date(db, &iid, date).await;
                        bucket[pos].release_date = Some(date.clone());
                    }
                }
            }
        }

        // Candidate emission (monitored + not already in library).
        if s.monitored && !is_already_in_library(bucket, &m_num_str) {
            let issue_year = issue_date.as_deref().and_then(|d| d.split('-').next()).filter(|y| !y.is_empty())
                .map(|y| y.to_string()).unwrap_or_else(|| s.year.to_string());
            let image_url = m.get("image").and_then(|v| v.as_str()).map(|s| s.to_string()).or_else(|| s.cover_url.clone());
            candidates.push(MonitorCandidate {
                volume_id: s.metadata_id.clone().unwrap_or_else(|| s.id.clone()),
                search_name: format!("{} #{}", s.name, m_num_str),
                issue_number: m_num_str.clone(),
                issue_year,
                is_released,
                publisher: s.publisher.clone().unwrap_or_else(|| "Unknown".to_string()),
                is_manga: s.is_manga,
                image_url,
            });
        }
    }
}

/// Phase 2 — ComicVine: for the 25 oldest monitored CV series, fetch their latest 30 issues, upsert
/// skeletons for not-in-library issues, emit candidates, and bump the series' updatedAt (rotates the window).
async fn phase2_comicvine(
    db: &PgPool, client: &Client, cv_api_key: &str,
    issues: &mut HashMap<String, Vec<IssueRec>>,
    skeletons_created: &mut i32, candidates: &mut Vec<MonitorCandidate>,
) -> Result<()> {
    let rows = sqlx::query(
        r#"SELECT id, name, publisher, year, "metadataId", "isManga", "coverUrl" FROM "Series"
           WHERE monitored = true AND "metadataSource" = 'COMICVINE' ORDER BY "updatedAt" ASC LIMIT 25"#,
    ).fetch_all(db).await?;

    for row in &rows {
        let series_id: String = row.get("id");
        let series_name: String = row.get("name");
        let publisher: Option<String> = row.get("publisher");
        let year: i32 = row.get("year");
        let cv_id: Option<String> = row.get("metadataId");
        let is_manga: bool = row.get("isManga");
        let cover_url: Option<String> = row.get("coverUrl");

        let Some(cv_id) = cv_id else { continue };

        let resp = client.get("https://comicvine.gamespot.com/api/issues/")
            .query(&[
                ("api_key", cv_api_key),
                ("format", "json"),
                ("filter", &format!("volume:{}", cv_id)),
                ("sort", "issue_number:desc"),
                ("limit", "30"),
                ("field_list", "id,name,issue_number,cover_date,store_date,image,deck,description"),
            ])
            .header("User-Agent", "Omnibus/1.0")
            .timeout(std::time::Duration::from_secs(10))
            .send().await;

        let data: Value = match resp.and_then(|r| r.error_for_status()) {
            Ok(r) => match r.json().await { Ok(d) => d, Err(_) => continue },
            Err(_) => continue, // Node swallows per-series CV errors.
        };
        let cv_issues = data.get("results").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        for cv in &cv_issues {
            let cv_num_str = match jstr(cv.get("issue_number")) { Some(s) => s, None => continue };

            let bucket = issues.entry(series_id.clone()).or_default();
            let already_in_library = is_already_in_library(bucket, &cv_num_str);

            // Pad partial CV dates (year-only / year-month) before storing (parity with queue.ts).
            let mut issue_date = cv.get("store_date").and_then(|v| v.as_str()).filter(|x| !x.is_empty())
                .or_else(|| cv.get("cover_date").and_then(|v| v.as_str()).filter(|x| !x.is_empty()))
                .map(|x| x.to_string());
            if let Some(d) = issue_date.as_mut() {
                if d.len() == 4 { d.push_str("-01-01"); } else if d.len() == 7 { d.push_str("-28"); }
            }
            let is_released = is_released_yet(cv.get("store_date").and_then(|v| v.as_str()), cv.get("cover_date").and_then(|v| v.as_str()));

            if !already_in_library {
                let existing_pos = bucket.iter().position(|i| is_same_issue(&i.number, &cv_num_str));
                match existing_pos {
                    None => {
                        let cv_issue_id = jstr(cv.get("id")).unwrap_or_default();
                        let name = cv.get("name").and_then(|v| v.as_str());
                        let desc = cv.get("description").and_then(|v| v.as_str()).or_else(|| cv.get("deck").and_then(|v| v.as_str()));
                        let cover = cv.pointer("/image/medium_url").and_then(|v| v.as_str()).or_else(|| cv.pointer("/image/small_url").and_then(|v| v.as_str()));
                        let number = jstr(cv.get("issue_number")).unwrap_or_else(|| "0".to_string());
                        if let Some(new_id) = insert_skeleton(db, &series_id, &cv_issue_id, "COMICVINE", &number, name, desc, issue_date.as_deref(), cover).await {
                            bucket.push(IssueRec { id: new_id, number, file_path: None, release_date: issue_date.clone() });
                        }
                        *skeletons_created += 1; // parity: Node increments on attempt, not just success
                    }
                    Some(pos) => {
                        if let Some(date) = &issue_date {
                            if bucket[pos].release_date.as_deref() != Some(date.as_str()) {
                                let iid = bucket[pos].id.clone();
                                update_skeleton_release_date(db, &iid, date).await;
                                bucket[pos].release_date = Some(date.clone());
                            }
                        }
                    }
                }
            }

            if already_in_library { continue; }

            let issue_year = issue_date.as_deref().and_then(|d| d.split('-').next()).filter(|y| !y.is_empty())
                .map(|y| y.to_string()).unwrap_or_else(|| year.to_string());
            let image_url = cv.pointer("/image/medium_url").and_then(|v| v.as_str()).map(|s| s.to_string()).or_else(|| cover_url.clone());
            candidates.push(MonitorCandidate {
                volume_id: cv_id.clone(),
                search_name: format!("{} #{}", series_name, cv_num_str),
                issue_number: cv_num_str.clone(),
                issue_year,
                is_released,
                publisher: publisher.clone().unwrap_or_else(|| "Unknown".to_string()),
                is_manga,
                image_url,
            });
        }

        let _ = sqlx::query(r#"UPDATE "Series" SET "updatedAt" = NOW() WHERE id = $1"#).bind(&series_id).execute(db).await;
        tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
    }
    Ok(())
}

pub async fn run_series_monitor(db: PgPool) -> Result<MonitorOutput> {
    let (series, mut issues) = load_state(&db).await?;
    let client = Client::builder().build()?;

    let mut skeletons_created = 0;
    let mut candidates: Vec<MonitorCandidate> = Vec::new();
    let mut notes: Vec<String> = Vec::new();

    // Phase 1 — Metron (only when credentials are present).
    let creds = sqlx::query(r#"SELECT key, value FROM "SystemSetting" WHERE key IN ('metron_user','metron_pass')"#).fetch_all(&db).await?;
    let mut metron_user = String::new();
    let mut metron_pass = String::new();
    for r in &creds {
        let k: String = r.get("key");
        let v: String = r.get("value");
        if k == "metron_user" { metron_user = v; } else if k == "metron_pass" { metron_pass = v; }
    }
    if !metron_user.is_empty() && !metron_pass.is_empty() {
        phase1_metron(&db, &client, &metron_user, &metron_pass, &series, &mut issues, &mut skeletons_created, &mut candidates, &mut notes).await;
    }

    // Phase 2 — ComicVine (only when a key is present).
    let cv_api_key: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'cv_api_key'"#)
        .fetch_optional(&db).await?.filter(|s: &String| !s.is_empty());
    if let Some(key) = cv_api_key {
        if let Err(e) = phase2_comicvine(&db, &client, &key, &mut issues, &mut skeletons_created, &mut candidates).await {
            notes.push(format!("[Phase 2] ComicVine sync error: {}", e));
        }
    }

    let metron_fetched = notes.iter()
        .find_map(|n| n.strip_prefix("[Phase 1] Metron Oracle fetched ").and_then(|s| s.split(' ').next()).and_then(|s| s.parse().ok()))
        .unwrap_or(0);

    Ok(MonitorOutput { skeletons_created, metron_fetched, notes, candidates })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_to_lower_alnum() {
        assert_eq!(normalize("The Amazing Spider-Man (2018)!"), "theamazingspiderman2018");
        assert_eq!(normalize("X-Men: Red"), "xmenred");
        assert_eq!(normalize(""), "");
    }

    fn issue(number: &str, file_path: Option<&str>) -> IssueRec {
        IssueRec { id: "i".into(), number: number.into(), file_path: file_path.map(|s| s.into()), release_date: None }
    }

    #[test]
    fn already_in_library_requires_match_and_nonempty_path() {
        let issues = vec![
            issue("012", Some("/lib/Saga 012.cbz")),  // downloaded
            issue("13", None),                         // skeleton, no file
            issue("14", Some("")),                     // empty path
        ];
        // #12 matches "012" by isSameIssue AND has a real file → in library.
        assert!(is_already_in_library(&issues, "12"));
        // #13 has no file → not in library (just a skeleton).
        assert!(!is_already_in_library(&issues, "13"));
        // #14 has an empty path → not in library.
        assert!(!is_already_in_library(&issues, "14"));
        // #99 not present at all.
        assert!(!is_already_in_library(&issues, "99"));
    }

    #[test]
    fn jstr_renders_strings_and_numbers() {
        assert_eq!(jstr(Some(&serde_json::json!("5"))), Some("5".to_string()));
        assert_eq!(jstr(Some(&serde_json::json!(7))), Some("7".to_string()));
        assert_eq!(jstr(Some(&serde_json::json!(""))), None);
        assert_eq!(jstr(Some(&serde_json::Value::Null)), None);
        assert_eq!(jstr(None), None);
    }
}
