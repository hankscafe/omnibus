use crate::db::Db;
use sqlx::Row;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;
use regex::Regex;
use reqwest::Client;

pub async fn sync_metadata(db: Db, series_ids: Option<Vec<String>>) -> anyhow::Result<()> {
    // ComicVine API key (Metron series don't need it, so this is optional).
    let cv_api_key: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'cv_api_key'"#)
        .fetch_optional(&db.pool)
        .await?;
    let cv_api_key = crate::secret_crypto::decrypt_setting(&db.pool, cv_api_key).await;

    // Global cover-source preference: 'metadata' (provider wins, default) | 'archive' (keep an
    // extracted/local cover, don't overwrite with the provider) | 'metadata_only'. A custom-uploaded
    // cover (hasCustomCover) always wins regardless of this.
    let cover_source: String = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'cover_source'"#)
        .fetch_optional(&db.pool).await.ok().flatten().unwrap_or_else(|| "metadata".to_string());

    // Resolve target series records. hasCustomCover is CAST and lastMetadataSync read via the
    // per-dialect ISO expression — SQLite's BOOLEAN/DATETIME decltypes have no Any-driver mapping.
    let series_select = format!(
        r#"SELECT id, name, "metadataId", "metadataSource", "folderPath", year, "coverUrl", CAST("hasCustomCover" AS INTEGER) AS "hasCustomCover", {last_sync} as "lastMetadataSync" FROM "Series""#,
        last_sync = db.iso_utc_expr(r#""lastMetadataSync""#)
    );
    let series_list = match &series_ids {
        // Empty id list → no series (matches the old `= ANY('{}')`); `IN ()` is invalid SQL.
        Some(ids) if ids.is_empty() => Vec::new(),
        Some(ids) => {
            let sql = format!(
                r#"{series_select} WHERE id IN ({}) AND "metadataId" IS NOT NULL"#,
                Db::in_placeholders(1, ids.len())
            );
            let mut q = sqlx::query(&sql);
            for id in ids {
                q = q.bind(id);
            }
            q.fetch_all(&db.pool).await?
        }
        None => {
            let sql = format!(r#"{series_select} WHERE "metadataId" IS NOT NULL ORDER BY "updatedAt" ASC LIMIT 15"#);
            sqlx::query(&sql)
                .fetch_all(&db.pool)
                .await?
        }
    };

    log::info!("Starting Rust Metadata Sync for {} series...", series_list.len());
    let client = Client::new();

    // A TARGETED sync (series_ids given — i.e. an admin "Refresh Metadata", a bulk refresh, or
    // post-import enrichment) ALWAYS does a complete fetch: it never skips issue pagination for
    // "Ended" series and never uses incremental (modified_gt). Only the scheduled maintenance sweep
    // (series_ids = None) gets the call-reduction optimizations. This guarantees a human-requested
    // refresh always re-checks every issue, even on a finished series.
    let full_fetch = series_ids.is_some();

    for series in series_list {
        let series_id: String = series.get("id");
        let series_name: String = series.get("name");
        let metadata_id: String = series.get("metadataId");
        let metadata_source: String = series.try_get("metadataSource").unwrap_or_else(|_| "COMICVINE".to_string());
        let folder_path: String = series.try_get("folderPath").unwrap_or_default();
        let current_year: i32 = series.try_get("year").unwrap_or(0);
        let current_cover: Option<String> = series.try_get("coverUrl").unwrap_or(None);
        let has_custom_cover: bool = series.try_get::<i64, _>("hasCustomCover").map(|v| v != 0).unwrap_or(false);
        // ISO timestamp of the last successful sync (UTC) — keys incremental fetches. None = never synced.
        let last_sync: Option<String> = series.try_get("lastMetadataSync").unwrap_or(None);

        log::info!("Syncing metadata for: {} ({} ID: {})", series_name, metadata_source, metadata_id);

        let fetch_result: anyhow::Result<i32> = match metadata_source.as_str() {
            "COMICVINE" => match &cv_api_key {
                Some(key) if !key.is_empty() => {
                    fetch_comicvine(
                        &db, &client, key, &series_id, &series_name, &metadata_id, &folder_path, current_year, current_cover, full_fetch, has_custom_cover, &cover_source,
                    ).await
                }
                Some(_) => {
                    log::warn!("[Metadata] cv_api_key is empty; skipping ComicVine fetch for {}", series_name);
                    Ok(0)
                }
                None => {
                    log::warn!("[Metadata] Missing cv_api_key; skipping ComicVine fetch for {}", series_name);
                    Ok(0)
                }
            },
            "METRON" => {
                fetch_metron(
                    &db, &client, &series_id, &series_name, &metadata_id, &folder_path, current_year, current_cover,
                    last_sync.as_deref(), full_fetch, has_custom_cover, &cover_source,
                ).await
            }
            other => {
                log::debug!("[Metadata] No provider fetch for source '{}' ({})", other, series_name);
                Ok(0)
            }
        };

        if let Err(e) = fetch_result {
            let msg = e.to_string();
            // Mirror Node's METADATA_SYNC batch halt: a ComicVine 429 or Metron FATAL_RATE_LIMIT means the
            // provider has cut us off, so stop the entire batch to protect our IP instead of hammering the
            // just-blocked API for every remaining series.
            if msg.contains("FATAL_RATE_LIMIT") || msg.contains("429") {
                log::warn!("[Metadata Sync] Halted batch due to rate limits to protect IP. ({})", msg);
                break;
            }
            log::error!("[Metadata] {} fetch failed for {}: {:?}", metadata_source, series_name, e);
            // Non-fatal: don't re-embed stale data for this series; move on to the next one.
            continue;
        }

        // Embed the (now-refreshed) DB values into the archives via the full-tag writer
        // (unified on metadata_writer::process_embed_job — no more duplicate 4-tag writer).
        let embed_payload = crate::metadata_writer::EmbedRequest { series_id: Some(series_id.clone()), issue_ids: None };
        if let Err(e) = crate::metadata_writer::process_embed_job(db.clone(), embed_payload).await {
            log::error!("[Metadata] Embed failed for {}: {:?}", series_name, e);
        }

        if let Err(e) = sqlx::query(&format!(
            r#"UPDATE "Series" SET "updatedAt" = {now}, "lastMetadataSync" = {now_utc} WHERE id = $1"#,
            now = db.now_expr(),
            now_utc = db.now_utc_ts_expr()
        ))
            .bind(&series_id)
            .execute(&db.pool)
            .await
        {
            log::error!("[Metadata] Failed to bump updatedAt for {}: {:?}", series_name, e);
        }
    }

    Ok(())
}

/// True when a series was manually curated in the metadata editor — auto-sync must then leave its
/// narrative fields (name/publisher/year/description/status/universe) alone and only refresh the
/// cover + fill blank bookType/remoteCoverUrl.
async fn series_is_locked(db: &Db, series_id: &str) -> bool {
    // CAST for the Any driver — SQLite's BOOLEAN decltype has no mapping.
    sqlx::query_scalar::<_, i64>(r#"SELECT CAST("hasCustomMetadata" AS INTEGER) FROM "Series" WHERE id=$1"#)
        .bind(series_id)
        .fetch_optional(&db.pool)
        .await
        .ok()
        .flatten()
        .map(|v| v != 0)
        .unwrap_or(false)
}

/// Fetches the ComicVine volume + issues and upserts them into the database.
/// Parity with metadata-fetcher.ts (ComicVine branch).
#[allow(clippy::too_many_arguments)]
async fn fetch_comicvine(
    db: &Db,
    client: &Client,
    api_key: &str,
    series_id: &str,
    series_name: &str,
    metadata_id: &str,
    folder_path: &str,
    current_year: i32,
    current_cover: Option<String>,
    full_fetch: bool,
    has_custom_cover: bool,
    cover_source: &str,
) -> anyhow::Result<i32> {
    // ---- 1. Volume details ----
    let vol_url = format!("https://comicvine.gamespot.com/api/volume/4050-{}/", metadata_id);
    log::debug!("[Metadata Fetcher Debug] Requesting ComicVine Volume: {}", vol_url);

    let vol_resp = client
        .get(&vol_url)
        .query(&[
            ("api_key", api_key),
            ("format", "json"),
            ("field_list", "image,description,deck,publisher,start_year,name,person_credits,character_credits,concepts,end_year,count_of_issues"),
        ])
        .header("User-Agent", "Omnibus/1.0")
        .timeout(Duration::from_secs(15))
        .send()
        .await?;

    if vol_resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        mark_flag(db, "cv_rate_limit_time").await;
        anyhow::bail!("ComicVine rate limited (429) on volume fetch");
    }

    let vol_json: serde_json::Value = vol_resp.json().await?;
    let vol_data = &vol_json["results"];
    if vol_data.is_null() {
        anyhow::bail!("Volume data not found on ComicVine for {}", metadata_id);
    }

    let name = vol_data["name"].as_str().filter(|s| !s.is_empty()).unwrap_or(series_name).to_string();
    let publisher = vol_data["publisher"]["name"].as_str().filter(|s| !s.is_empty()).unwrap_or("Other").to_string();
    let year = vol_data["start_year"].as_str().and_then(|s| s.trim().parse::<i32>().ok()).filter(|y| *y != 0).unwrap_or(current_year);
    let description = vol_data["description"].as_str().or_else(|| vol_data["deck"].as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
    let image_url = vol_data["image"]["medium_url"].as_str().or_else(|| vol_data["image"]["super_url"].as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
    let status = if cv_is_ended(&vol_data["end_year"]) { "Ended" } else { "Ongoing" };

    // Genres from the volume's concepts (parity with parseComicVineCredits).
    let mut vol_genres: Vec<String> = Vec::new();
    if let Some(arr) = vol_data["concepts"].as_array() {
        for c in arr {
            if let Some(n) = c["name"].as_str() {
                if !n.is_empty() && !vol_genres.contains(&n.to_string()) {
                    vol_genres.push(n.to_string());
                }
            }
        }
    }
    let vol_genres_json = if vol_genres.is_empty() { None } else { serde_json::to_string(&vol_genres).ok() };

    // ComicVine has no format field, so book type is a conservative guess (beta.032): explicit
    // format hints in the volume name, or a finished single-issue volume = one-shot.
    let guessed_book_type: Option<&str> = {
        static RE_GN: OnceLock<Regex> = OnceLock::new();
        static RE_TPB: OnceLock<Regex> = OnceLock::new();
        let re_gn = RE_GN.get_or_init(|| Regex::new(r"(?i)graphic novel|\bOGN\b").unwrap());
        let re_tpb = RE_TPB.get_or_init(|| Regex::new(r"(?i)\bTPB\b|trade paperback|\bHC\b|hardcover").unwrap());
        let vol_name = vol_data["name"].as_str().unwrap_or("");
        if re_gn.is_match(vol_name) {
            Some("GN")
        } else if re_tpb.is_match(vol_name) {
            Some("TPB")
        } else if vol_data["count_of_issues"].as_i64() == Some(1) && cv_is_ended(&vol_data["end_year"]) {
            Some("OneShot")
        } else {
            None
        }
    };

    let final_cover = resolve_cover(client, image_url.as_deref(), folder_path, current_cover, has_custom_cover, cover_source).await;

    // remoteCoverUrl keeps the original provider URL for external consumers (series.json) —
    // coverUrl becomes a local path. The bookType heuristic only fills a blank (never clobbers
    // a manual categorization). Parity with metadata-fetcher.ts (beta.032-034).
    // A manually curated series keeps its narrative fields; only the cover + blank-fills update.
    let update_res = if series_is_locked(db, series_id).await {
        sqlx::query(
            r#"UPDATE "Series" SET "coverUrl"=$1,
               "remoteCoverUrl"=COALESCE($2, "remoteCoverUrl"),
               "bookType"=COALESCE("bookType", $3)
               WHERE id=$4"#,
        )
        .bind(&final_cover)
        .bind(&image_url)
        .bind(guessed_book_type)
        .bind(series_id)
        .execute(&db.pool)
        .await
    } else {
        sqlx::query(
            r#"UPDATE "Series" SET name=$1, publisher=$2, year=$3, description=$4, "coverUrl"=$5, status=$6,
               "remoteCoverUrl"=COALESCE($7, "remoteCoverUrl"),
               "bookType"=COALESCE("bookType", $8)
               WHERE id=$9"#,
        )
        .bind(&name)
        .bind(&publisher)
        .bind(year)
        .bind(&description)
        .bind(&final_cover)
        .bind(status)
        .bind(&image_url)
        .bind(guessed_book_type)
        .bind(series_id)
        .execute(&db.pool)
        .await
    };
    if let Err(e) = update_res {
        log::error!("[Metadata] Failed to update series {}: {:?}", series_name, e);
    }

    tokio::time::sleep(Duration::from_secs(3)).await;

    // API-call reduction: an Ended series we already hold in full has no new issues to page, so skip
    // the entire /issues/ pagination (the bulk of the calls). The cheap volume call above still ran,
    // so series-level fields are refreshed. count_of_issues comes from the volume; status from end_year.
    let cv_total = vol_data["count_of_issues"].as_i64().unwrap_or(0);
    if !full_fetch && status == "Ended" && cv_total > 0 {
        let local_count: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM "Issue" WHERE "seriesId" = $1"#)
            .bind(series_id).fetch_one(&db.pool).await.unwrap_or(0);
        if local_count >= cv_total {
            log::info!("[Metadata] {} is Ended and complete ({}/{}) — skipping ComicVine issue fetch.", series_name, local_count, cv_total);
            return Ok(0);
        }
    }

    // ---- 2. Paginated issues ----
    let mut offset: i32 = 0;
    let mut total_results: i32 = 1;
    let mut loop_count = 0;
    let mut synced_count = 0;
    let mut latest_date_ms: i64 = 0;

    while offset < total_results && loop_count < 20 {
        log::debug!("[Metadata Fetcher Debug] Fetching issues for volume {} (Offset: {}, Limit: 100)", metadata_id, offset);

        let filter_val = format!("volume:{}", metadata_id);
        let offset_str = offset.to_string();
        let issue_resp = client
            .get("https://comicvine.gamespot.com/api/issues/")
            .query(&[
                ("api_key", api_key),
                ("format", "json"),
                ("filter", filter_val.as_str()),
                ("sort", "issue_number:asc"),
                ("limit", "100"),
                ("offset", offset_str.as_str()),
                ("field_list", "id,name,issue_number,store_date,cover_date,image,deck,description"),
            ])
            .header("User-Agent", "Omnibus/1.0")
            .timeout(Duration::from_secs(15))
            .send()
            .await?;

        if issue_resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            mark_flag(db, "cv_rate_limit_time").await;
            anyhow::bail!("ComicVine rate limited (429) on issues fetch");
        }

        let issue_json: serde_json::Value = issue_resp.json().await?;
        if offset == 0 {
            total_results = issue_json["number_of_total_results"].as_i64().unwrap_or(0) as i32;
        }
        let cv_issues = issue_json["results"].as_array().cloned().unwrap_or_default();

        // Re-fetch the series' issues each page so issues created on earlier pages are visible to
        // isSameIssue. Bool columns are CAST for the Any driver (no SQLite BOOLEAN mapping).
        let existing_issues = sqlx::query(
            r#"SELECT id, number, CAST("hasCustomMetadata" AS INTEGER) AS "hasCustomMetadata", name, "releaseDate", genres, description, CAST("hasCustomCover" AS INTEGER) AS "hasCustomCover", "coverUrl" FROM "Issue" WHERE "seriesId" = $1"#,
        )
        .bind(series_id)
        .fetch_all(&db.pool)
        .await?;

        // Batch the GLOBAL existing-by-cvId lookups for the whole page into ONE query (was 1 query per
        // issue — a 100x N+1). Still a global match (an issue can live under a different series), just
        // resolved in-memory from a per-page HashMap keyed by metadataId.
        let page_cv_ids: Vec<String> = cv_issues.iter()
            .filter_map(|i| i["id"].as_i64().map(|n| n.to_string()))
            .collect();
        let mut by_cv: std::collections::HashMap<String, sqlx::any::AnyRow> = std::collections::HashMap::new();
        if !page_cv_ids.is_empty() {
            let sql = format!(
                r#"SELECT id, name, "releaseDate", CAST("hasCustomMetadata" AS INTEGER) AS "hasCustomMetadata", genres, description, "metadataId" FROM "Issue" WHERE "metadataId" IN ({}) AND "metadataSource" = 'COMICVINE'"#,
                Db::in_placeholders(1, page_cv_ids.len())
            );
            let mut q = sqlx::query(&sql);
            for id in &page_cv_ids {
                q = q.bind(id);
            }
            let rows = q
            .fetch_all(&db.pool)
            .await?;
            for row in rows {
                if let Ok(Some(mid)) = row.try_get::<Option<String>, _>("metadataId") {
                    by_cv.insert(mid, row);
                }
            }
        }

        for cv_issue in &cv_issues {
            let issue_num = json_num_string(&cv_issue["issue_number"]).unwrap_or_else(|| "0".to_string());
            let cv_id_str = match cv_issue["id"].as_i64() {
                Some(id) => id.to_string(),
                None => continue, // can't dedupe without an id
            };

            let issue_date = cv_issue["store_date"].as_str().filter(|s| !s.is_empty())
                .or_else(|| cv_issue["cover_date"].as_str().filter(|s| !s.is_empty()))
                .map(|s| s.to_string());
            if let Some(d) = &issue_date {
                if let Some(ms) = parse_date_ms(d) {
                    if ms > latest_date_ms { latest_date_ms = ms; }
                }
            }

            let cv_name = cv_issue["name"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string());
            let cv_desc = cv_issue["description"].as_str().or_else(|| cv_issue["deck"].as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
            let cv_cover = cv_issue["image"]["medium_url"].as_str().or_else(|| cv_issue["image"]["small_url"].as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());

            // existing-by-cvId is a GLOBAL lookup (matches Node findFirst; can move an issue across
            // series), now resolved from the per-page batch instead of a per-issue query.
            let existing_by_cv = by_cv.get(&cv_id_str);

            // existing-by-number is scoped to this series.
            let existing_by_num = existing_issues.iter().find(|r| {
                let n: String = r.get("number");
                is_same_issue(&n, &issue_num)
            });

            // Determine the lock + existing fields from whichever record we'll target.
            let (is_locked, existing_name, existing_release, existing_genres, existing_desc, has_custom_cover, existing_cover) = if let Some(r) = existing_by_cv {
                (
                    r.try_get::<i64, _>("hasCustomMetadata").map(|v| v != 0).unwrap_or(false),
                    r.try_get::<Option<String>, _>("name").unwrap_or(None),
                    r.try_get::<Option<String>, _>("releaseDate").unwrap_or(None),
                    r.try_get::<Option<String>, _>("genres").unwrap_or(None),
                    r.try_get::<Option<String>, _>("description").unwrap_or(None),
                    r.try_get::<i64, _>("hasCustomCover").map(|v| v != 0).unwrap_or(false),
                    r.try_get::<Option<String>, _>("coverUrl").unwrap_or(None),
                )
            } else if let Some(r) = existing_by_num {
                (
                    r.try_get::<i64, _>("hasCustomMetadata").map(|v| v != 0).unwrap_or(false),
                    r.try_get::<Option<String>, _>("name").unwrap_or(None),
                    r.try_get::<Option<String>, _>("releaseDate").unwrap_or(None),
                    r.try_get::<Option<String>, _>("genres").unwrap_or(None),
                    r.try_get::<Option<String>, _>("description").unwrap_or(None),
                    r.try_get::<i64, _>("hasCustomCover").map(|v| v != 0).unwrap_or(false),
                    r.try_get::<Option<String>, _>("coverUrl").unwrap_or(None),
                )
            } else {
                (false, None, None, None, None, false, None)
            };

            let name_val = if is_locked { existing_name } else { cv_name };
            let release_val = if is_locked { existing_release } else { issue_date.clone() };
            // A locked (manually edited) issue keeps its description; otherwise take the provider's.
            let desc_val = if is_locked { existing_desc } else { cv_desc.clone() };
            // A custom issue cover (set in the Smart Matcher) survives every sync; else the provider's wins.
            let cover_val = if has_custom_cover { existing_cover } else { cv_cover.clone() };
            // When locked keep existing genres; otherwise only (re)write when the volume has them and the issue doesn't yet.
            let genres_val = if is_locked {
                existing_genres
            } else if vol_genres_json.is_some() && existing_genres.is_none() {
                vol_genres_json.clone()
            } else {
                existing_genres
            };

            let res = if let Some(r) = existing_by_cv {
                let id: String = r.get("id");
                sqlx::query(
                    r#"UPDATE "Issue" SET "seriesId"=$1, number=$2, name=$3, "releaseDate"=$4, description=$5, "coverUrl"=$6, "matchState"='MATCHED', genres=$7 WHERE id=$8"#,
                )
                .bind(series_id).bind(&issue_num).bind(&name_val).bind(&release_val)
                .bind(&desc_val).bind(&cover_val).bind(&genres_val).bind(&id)
                .execute(&db.pool).await
            } else if let Some(r) = existing_by_num {
                let id: String = r.get("id");
                sqlx::query(
                    r#"UPDATE "Issue" SET "metadataId"=$1, "metadataSource"='COMICVINE', name=$2, "releaseDate"=$3, description=$4, "coverUrl"=$5, "matchState"='MATCHED', genres=$6 WHERE id=$7"#,
                )
                .bind(&cv_id_str).bind(&name_val).bind(&release_val)
                .bind(&desc_val).bind(&cover_val).bind(&genres_val).bind(&id)
                .execute(&db.pool).await
            } else {
                let new_id = uuid::Uuid::new_v4().to_string();
                sqlx::query(&format!(
                    r#"INSERT INTO "Issue"
                       (id, "seriesId", "metadataId", "metadataSource", number, status, name, "releaseDate", description, "coverUrl", "matchState", genres, "createdAt", "updatedAt")
                       VALUES ($1,$2,$3,'COMICVINE',$4,'WANTED',$5,$6,$7,$8,'MATCHED',$9, {now}, {now})"#,
                    now = db.now_expr()
                ))
                .bind(&new_id).bind(series_id).bind(&cv_id_str).bind(&issue_num)
                .bind(&name_val).bind(&release_val).bind(&cv_desc).bind(&cv_cover).bind(&genres_val)
                .execute(&db.pool).await
            };

            if let Err(e) = res {
                log::error!("[Metadata] Failed to upsert issue #{} for {}: {:?}", issue_num, series_name, e);
            } else {
                synced_count += 1;
            }
        }

        offset += 100;
        loop_count += 1;
        tokio::time::sleep(Duration::from_secs(3)).await;
    }

    // "Ended" after the admin-configured inactivity window (only if not already flagged by end_year).
    if status != "Ended" && latest_date_ms > 0 {
        if let Some((cutoff_ms, months)) = get_series_ended_cutoff(db).await {
            if latest_date_ms < cutoff_ms {
                let _ = sqlx::query(r#"UPDATE "Series" SET status='Ended' WHERE id=$1"#).bind(series_id).execute(&db.pool).await;
                log::info!("[Metadata] Series \"{}\" marked as Ended after {}+ months without a new issue.", series_name, months);
            }
        }
    }

    log::info!("[Metadata] Successfully synced {} ComicVine issues for {}.", synced_count, series_name);
    Ok(synced_count)
}

/// Providers rarely report when a series ends, so Omnibus guesses: no new issue within the
/// admin-configured window (months) = Ended. Returns None when the guess is disabled (window
/// of 0 / "Never"). Parity with metadata-fetcher.ts getSeriesEndedCutoff (beta.034).
async fn get_series_ended_cutoff(db: &Db) -> Option<(i64, i32)> {
    let raw = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'series_ended_months'"#)
        .fetch_optional(&db.pool)
        .await
        .ok()
        .flatten();
    let months = raw.as_deref().and_then(|v| v.trim().parse::<i32>().ok()).unwrap_or(18);
    if months <= 0 {
        return None;
    }
    let window_ms = (months as f64 * 30.44 * 24.0 * 60.0 * 60.0 * 1000.0).round() as i64;
    Some((chrono::Utc::now().timestamp_millis() - window_ms, months))
}

pub(crate) async fn metron_auth(db: &sqlx::AnyPool) -> Option<(String, String)> {
    let rows = sqlx::query(r#"SELECT key, value FROM "SystemSetting" WHERE key IN ('metron_user','metron_pass')"#)
        .fetch_all(db).await.unwrap_or_default();
    let mut user = String::new();
    let mut pass = String::new();
    for row in rows {
        let k: String = row.get("key");
        let v: String = row.get("value");
        if k == "metron_user" { user = v; } else if k == "metron_pass" { pass = v; }
    }
    // metron_pass is stored encrypted at rest (parity with Node); metron_user is not a secret.
    let pass = crate::secret_crypto::decrypt_setting(db, Some(pass)).await.unwrap_or_default();
    if user.is_empty() || pass.is_empty() || pass == "********" { None } else { Some((user, pass)) }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn metron_header_i64(resp: &reqwest::Response, name: &str, default: i64) -> i64 {
    resp.headers().get(name).and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<i64>().ok()).unwrap_or(default)
}

/// Metron HTTP GET with burst-rate-limit handling + retry/backoff (parity with metron.ts fetchWithBackoff).
async fn metron_fetch(db: &Db, client: &Client, auth: &(String, String), url: &str, timeout_secs: u64, max_retries: u32) -> anyhow::Result<(u16, serde_json::Value)> {
    log::debug!("[Metron Debug] Executing Fetch: {}", url);
    for attempt in 0..max_retries {
        match client
            .get(url)
            .basic_auth(&auth.0, Some(&auth.1))
            .header("User-Agent", "Omnibus/1.0")
            .timeout(Duration::from_secs(timeout_secs))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let remaining = metron_header_i64(&resp, "x-ratelimit-burst-remaining", 20);
                log::debug!("[Metron Debug] Rate Limit Status -> Burst Remaining: {}", remaining);

                if remaining <= 2 {
                    let reset = metron_header_i64(&resp, "x-ratelimit-burst-reset", 0);
                    if reset > 0 {
                        let sleep_ms = ((reset * 1000) - now_ms()).max(0) + 500;
                        if sleep_ms > 0 { tokio::time::sleep(Duration::from_millis(sleep_ms as u64)).await; }
                    }
                }

                if status == 429 {
                    let retry_after = metron_header_i64(&resp, "retry-after", 60);
                    if retry_after > 60 {
                        // Flag the throttle so the UI shows a "Metron rate-limited" banner. Parity with
                        // metadata-fetcher.ts, which flags only when a 429 propagates (a FATAL block) —
                        // not a transient 429 that the backoff loop below recovers from.
                        mark_flag(db, "metron_rate_limit_time").await;
                        log::error!("[Metron] FATAL Rate Limit Hit. IP blocked for {}s.", retry_after);
                        anyhow::bail!("FATAL_RATE_LIMIT");
                    }
                    log::warn!("[Metron] Rate Limit Hit. Waiting {}s before retrying...", retry_after);
                    tokio::time::sleep(Duration::from_secs((retry_after + 1).max(0) as u64)).await;
                    continue;
                }

                let valid = (200..300).contains(&status) || status == 304 || status == 404;
                if !valid {
                    if attempt + 1 == max_retries { anyhow::bail!("Metron HTTP Error: {}", status); }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }

                let data = if status != 204 && status != 304 {
                    resp.json::<serde_json::Value>().await.unwrap_or(serde_json::Value::Null)
                } else {
                    serde_json::Value::Null
                };
                return Ok((status, data));
            }
            Err(e) => {
                log::debug!("[Metron Debug] Fetch Attempt {} Failed: {}", attempt + 1, e);
                if attempt + 1 == max_retries { return Err(e.into()); }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    anyhow::bail!("Metron max retries reached")
}

/// Builds the issue display name (parity with metron.ts getSeriesIssues name logic).
fn metron_issue_name(issue: &serde_json::Value, number: &str) -> String {
    let series_name = issue["series"].as_str().map(|s| s.to_string())
        .or_else(|| issue["series"]["name"].as_str().map(|s| s.to_string()))
        .unwrap_or_default();
    let issue_name = issue["title"].as_str()
        .or_else(|| issue["issue_name"].as_str())
        .or_else(|| issue["issue"].as_str())
        .unwrap_or("")
        .to_string();

    let mut full_name = if !series_name.is_empty() {
        format!("{} #{}", series_name, number)
    } else {
        format!("Issue #{}", number)
    };

    static RE_GENERIC: OnceLock<Regex> = OnceLock::new();
    let re_generic = RE_GENERIC.get_or_init(|| Regex::new(r"(?i)^Issue\s*#?\s*\d+$").unwrap());
    let is_generic = re_generic.is_match(&issue_name);
    let hash_num = format!("#{}", number);

    if !issue_name.is_empty() && issue_name != series_name && !issue_name.contains(&hash_num) && !is_generic {
        full_name = format!("{}: {}", full_name, issue_name);
    } else if !issue_name.is_empty() && issue_name.contains(&hash_num) && !is_generic {
        full_name = issue_name;
    }
    full_name
}

/// Fetches the Metron series + issues and upserts them. Parity with metadata-fetcher.ts (METRON branch).
/// Note: Metron's issue_list returns no per-issue credits, so writers/artists/characters are stored as "[]"
/// (matching the Node behavior — richer credits would require per-issue getIssueDetails calls).
#[allow(clippy::too_many_arguments)]
async fn fetch_metron(
    db: &Db,
    client: &Client,
    series_id: &str,
    series_name: &str,
    metadata_id: &str,
    folder_path: &str,
    current_year: i32,
    current_cover: Option<String>,
    last_sync: Option<&str>,
    full_fetch: bool,
    has_custom_cover: bool,
    cover_source: &str,
) -> anyhow::Result<i32> {
    let auth = match metron_auth(&db.pool).await {
        Some(a) => a,
        None => {
            log::warn!("[Metadata] Metron credentials missing; skipping {}", series_name);
            return Ok(0);
        }
    };

    // ---- 1. Series details (numeric id → /series/{id}/, slug → /series/?name=) ----
    let is_numeric = metadata_id.trim().parse::<i64>().is_ok();
    let detail_url = if is_numeric {
        format!("https://metron.cloud/api/series/{}/", metadata_id)
    } else {
        format!("https://metron.cloud/api/series/?name={}", urlencoding::encode(metadata_id))
    };

    let (status, mut series_data) = metron_fetch(db, client, &auth, &detail_url, 10, 3).await?;
    if status == 404 {
        anyhow::bail!("Series {} not found on Metron", metadata_id);
    }
    if !is_numeric {
        let results = series_data["results"].as_array().cloned().unwrap_or_default();
        if results.is_empty() {
            anyhow::bail!("Series slug {} returned 0 results on Metron", metadata_id);
        }
        series_data = results[0].clone();
    }

    let real_series_id = series_data["id"].as_i64().map(|i| i.to_string()).unwrap_or_else(|| metadata_id.to_string());

    // Cover: first image from the issue_list.
    let issue_list_url = format!("https://metron.cloud/api/series/{}/issue_list/", real_series_id);
    let mut cover_remote: Option<String> = None;
    if let Ok((_, il)) = metron_fetch(db, client, &auth, &issue_list_url, 5, 1).await {
        cover_remote = il["results"][0]["image"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string());
    }

    let name = series_data["series"].as_str().or_else(|| series_data["name"].as_str()).filter(|s| !s.is_empty()).unwrap_or("Unknown").to_string();
    let year = series_data["year_began"].as_i64().map(|y| y as i32).filter(|y| *y != 0).unwrap_or(current_year);
    let publisher = series_data["publisher"]["name"].as_str().or_else(|| series_data["publisher"].as_str()).filter(|s| !s.is_empty()).unwrap_or("Unknown").to_string();
    let description = series_data["desc"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string());
    let status_str = if series_data["status"]["name"].as_str() == Some("Ended") { "Ended" } else { "Ongoing" };
    // Universe (e.g. an imprint) — Metron maps series.universe?.name. Parity with metadata-fetcher.ts.
    let universe = series_data["universe"]["name"].as_str()
        .or_else(|| series_data["universe"].as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    // Metron's series_type is authoritative for the Mylar booktype, but never clobber a manual one.
    let book_type = map_series_type(&series_data["series_type"]);

    let final_cover = resolve_cover(client, cover_remote.as_deref(), folder_path, current_cover, has_custom_cover, cover_source).await;

    // A manually curated series keeps its narrative fields; only the cover + blank-fills update.
    let update_res = if series_is_locked(db, series_id).await {
        sqlx::query(
            r#"UPDATE "Series" SET "coverUrl"=$1, universe=COALESCE($2, universe),
               "remoteCoverUrl"=COALESCE($3, "remoteCoverUrl"),
               "bookType"=COALESCE("bookType", $4)
               WHERE id=$5"#,
        )
        .bind(&final_cover).bind(&universe).bind(&cover_remote).bind(book_type).bind(series_id)
        .execute(&db.pool).await
    } else {
        sqlx::query(
            r#"UPDATE "Series" SET name=$1, publisher=$2, year=$3, description=$4, "coverUrl"=$5, status=$6, universe=COALESCE($7, universe),
               "remoteCoverUrl"=COALESCE($8, "remoteCoverUrl"),
               "bookType"=COALESCE("bookType", $9)
               WHERE id=$10"#,
        )
        .bind(&name).bind(&publisher).bind(year).bind(&description).bind(&final_cover).bind(status_str).bind(&universe)
        .bind(&cover_remote).bind(book_type).bind(series_id)
        .execute(&db.pool).await
    };
    if let Err(e) = update_res {
        log::error!("[Metadata] Failed to update Metron series {}: {:?}", series_name, e);
    }

    let local_count: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM "Issue" WHERE "seriesId" = $1"#)
        .bind(series_id).fetch_one(&db.pool).await.unwrap_or(0);

    // API-call reduction: an Ended series we already hold in full has no new issues to page — skip the
    // issue_list pagination (issue_count from the series detail above; status from status_str). The
    // cheap series-detail + cover calls already ran, so series-level fields are still refreshed.
    let metron_total = series_data["issue_count"].as_i64().unwrap_or(0);
    if !full_fetch && status_str == "Ended" && metron_total > 0 && local_count >= metron_total {
        log::info!("[Metadata] {} is Ended and complete ({}/{}) — skipping Metron issue fetch.", series_name, local_count, metron_total);
        return Ok(0);
    }

    // ---- 2. All issues (follow the `next` cursor) ----
    // Incremental top-up: once we already hold issues and have a prior sync time, ask Metron for only
    // those modified since (modified_gt — per the project's API best-practices). Full walk when never
    // synced or locally empty; if Metron ignores the param it just returns everything (still correct —
    // the recency-ended check below re-bases on local data, not just this run's results).
    let mut start_url = issue_list_url.clone();
    if !full_fetch && local_count > 0 {
        if let Some(since) = last_sync {
            let sep = if start_url.contains('?') { '&' } else { '?' };
            start_url = format!("{}{}modified_gt={}", start_url, sep, urlencoding::encode(since));
            log::debug!("[Metron Debug] Incremental issue fetch since {} for {}", since, series_name);
        }
    }
    let mut all_issues: Vec<serde_json::Value> = Vec::new();
    let mut next_url = Some(start_url);
    while let Some(url) = next_url {
        let (_, data) = metron_fetch(db, client, &auth, &url, 15, 3).await?;
        if let Some(arr) = data["results"].as_array() {
            all_issues.extend(arr.clone());
        }
        next_url = data["next"].as_str().map(|s| s.to_string());
    }

    // Bool columns are CAST for the Any driver (no SQLite BOOLEAN mapping).
    let existing_issues = sqlx::query(
        r#"SELECT id, number, CAST("hasCustomMetadata" AS INTEGER) AS "hasCustomMetadata", name, "releaseDate", CAST("hasCustomCover" AS INTEGER) AS "hasCustomCover", "coverUrl" FROM "Issue" WHERE "seriesId" = $1"#,
    )
    .bind(series_id)
    .fetch_all(&db.pool)
    .await?;

    // Batch the GLOBAL existing-by-metadataId lookups for every issue into ONE query (was 1 query per
    // issue — an N+1 across the full issue list). Still a global match, resolved from a HashMap.
    let all_meta_ids: Vec<String> = all_issues.iter()
        .filter_map(|i| i["id"].as_i64().map(|n| n.to_string()))
        .collect();
    let mut by_meta: std::collections::HashMap<String, sqlx::any::AnyRow> = std::collections::HashMap::new();
    if !all_meta_ids.is_empty() {
        let sql = format!(
            r#"SELECT id, name, "releaseDate", CAST("hasCustomMetadata" AS INTEGER) AS "hasCustomMetadata", "metadataId" FROM "Issue" WHERE "metadataId" IN ({}) AND "metadataSource" = 'METRON'"#,
            Db::in_placeholders(1, all_meta_ids.len())
        );
        let mut q = sqlx::query(&sql);
        for id in &all_meta_ids {
            q = q.bind(id);
        }
        let rows = q
        .fetch_all(&db.pool)
        .await?;
        for row in rows {
            if let Ok(Some(mid)) = row.try_get::<Option<String>, _>("metadataId") {
                by_meta.insert(mid, row);
            }
        }
    }

    let mut synced_count = 0;
    let mut latest_date_ms: i64 = 0;

    for issue in &all_issues {
        let source_id = match issue["id"].as_i64() {
            Some(id) => id.to_string(),
            None => continue,
        };
        let issue_num = json_num_string(&issue["number"]).unwrap_or_else(|| "0".to_string());
        let issue_date = issue["store_date"].as_str().filter(|s| !s.is_empty())
            .or_else(|| issue["cover_date"].as_str().filter(|s| !s.is_empty()))
            .map(|s| s.to_string());
        if let Some(d) = &issue_date {
            if let Some(ms) = parse_date_ms(d) {
                if ms > latest_date_ms { latest_date_ms = ms; }
            }
        }

        let issue_name = metron_issue_name(issue, &issue_num);
        let issue_desc = issue["desc"].as_str().or_else(|| issue["description"].as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
        let issue_cover = issue["image"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string());

        let existing_by_meta = by_meta.get(&source_id);

        let existing_by_num = existing_issues.iter().find(|r| {
            let n: String = r.get("number");
            is_same_issue(&n, &issue_num)
        });

        let (is_locked, existing_name, existing_release, has_custom_cover, existing_cover) = if let Some(r) = existing_by_meta {
            (
                r.try_get::<i64, _>("hasCustomMetadata").map(|v| v != 0).unwrap_or(false),
                r.try_get::<Option<String>, _>("name").unwrap_or(None),
                r.try_get::<Option<String>, _>("releaseDate").unwrap_or(None),
                r.try_get::<i64, _>("hasCustomCover").map(|v| v != 0).unwrap_or(false),
                r.try_get::<Option<String>, _>("coverUrl").unwrap_or(None),
            )
        } else if let Some(r) = existing_by_num {
            (
                r.try_get::<i64, _>("hasCustomMetadata").map(|v| v != 0).unwrap_or(false),
                r.try_get::<Option<String>, _>("name").unwrap_or(None),
                r.try_get::<Option<String>, _>("releaseDate").unwrap_or(None),
                r.try_get::<i64, _>("hasCustomCover").map(|v| v != 0).unwrap_or(false),
                r.try_get::<Option<String>, _>("coverUrl").unwrap_or(None),
            )
        } else {
            (false, None, None, false, None)
        };

        let name_val: Option<String> = if is_locked { existing_name } else { Some(issue_name) };
        let release_val: Option<String> = if is_locked { existing_release } else { issue_date.clone() };
        // A custom issue cover (set in the Smart Matcher) survives every sync; else the provider's wins.
        let cover_val: Option<String> = if has_custom_cover { existing_cover } else { issue_cover.clone() };

        let res = if let Some(r) = existing_by_meta {
            let id: String = r.get("id");
            if is_locked {
                // Manually edited (hasCustomMetadata): keep name/releaseDate/description and the
                // creator credits — only re-affirm the cover + match state. NOTE: the unlocked path
                // resets writers/artists/characters to '[]' because Metron's issue_list carries no
                // per-issue credits (they're lazy-loaded), which would otherwise wipe a manual edit.
                sqlx::query(
                    r#"UPDATE "Issue" SET "seriesId"=$1, number=$2, "coverUrl"=$3, "matchState"='MATCHED' WHERE id=$4"#,
                )
                .bind(series_id).bind(&issue_num).bind(&cover_val).bind(&id)
                .execute(&db.pool).await
            } else {
                sqlx::query(
                    r#"UPDATE "Issue" SET "seriesId"=$1, number=$2, name=$3, "releaseDate"=$4, description=$5, "coverUrl"=$6, writers='[]', artists='[]', characters='[]', "matchState"='MATCHED' WHERE id=$7"#,
                )
                .bind(series_id).bind(&issue_num).bind(&name_val).bind(&release_val).bind(&issue_desc).bind(&cover_val).bind(&id)
                .execute(&db.pool).await
            }
        } else if let Some(r) = existing_by_num {
            let id: String = r.get("id");
            if is_locked {
                // Link the Metron id but preserve the manually entered name/description/credits.
                sqlx::query(
                    r#"UPDATE "Issue" SET "metadataId"=$1, "metadataSource"='METRON', "coverUrl"=$2, "matchState"='MATCHED' WHERE id=$3"#,
                )
                .bind(&source_id).bind(&cover_val).bind(&id)
                .execute(&db.pool).await
            } else {
                sqlx::query(
                    r#"UPDATE "Issue" SET "metadataId"=$1, "metadataSource"='METRON', name=$2, "releaseDate"=$3, description=$4, "coverUrl"=$5, writers='[]', artists='[]', characters='[]', "matchState"='MATCHED' WHERE id=$6"#,
                )
                .bind(&source_id).bind(&name_val).bind(&release_val).bind(&issue_desc).bind(&cover_val).bind(&id)
                .execute(&db.pool).await
            }
        } else {
            let new_id = uuid::Uuid::new_v4().to_string();
            sqlx::query(&format!(
                r#"INSERT INTO "Issue"
                   (id, "seriesId", "metadataId", "metadataSource", number, status, name, "releaseDate", description, "coverUrl", writers, artists, characters, "matchState", "createdAt", "updatedAt")
                   VALUES ($1,$2,$3,'METRON',$4,'WANTED',$5,$6,$7,$8,'[]','[]','[]','MATCHED', {now}, {now})"#,
                now = db.now_expr()
            ))
            .bind(&new_id).bind(series_id).bind(&source_id).bind(&issue_num).bind(&name_val).bind(&release_val).bind(&issue_desc).bind(&issue_cover)
            .execute(&db.pool).await
        };

        if let Err(e) = res {
            log::error!("[Metadata] Failed to upsert Metron issue #{} for {}: {:?}", issue_num, series_name, e);
        } else {
            synced_count += 1;
        }
    }

    // Recency-ended re-bases on the latest release date we hold LOCALLY (not just this run's results),
    // so an incremental (modified_gt) fetch that returned nothing new can't falsely keep a long-stale
    // series "Ongoing". Falls back to a DB MAX only when this run surfaced no dated issue.
    let mut effective_latest = latest_date_ms;
    if effective_latest == 0 {
        if let Ok(Some(d)) = sqlx::query_scalar::<_, Option<String>>(
            r#"SELECT MAX("releaseDate") FROM "Issue" WHERE "seriesId" = $1 AND "releaseDate" IS NOT NULL AND "releaseDate" <> ''"#,
        ).bind(series_id).fetch_one(&db.pool).await {
            if let Some(ms) = parse_date_ms(&d) { effective_latest = ms; }
        }
    }
    if status_str != "Ended" && effective_latest > 0 {
        if let Some((cutoff_ms, months)) = get_series_ended_cutoff(db).await {
            if effective_latest < cutoff_ms {
                let _ = sqlx::query(r#"UPDATE "Series" SET status='Ended' WHERE id=$1"#).bind(series_id).execute(&db.pool).await;
                log::info!("[Metadata] Series \"{}\" marked as Ended after {}+ months without a new issue.", series_name, months);
            }
        }
    }

    log::info!("[Metadata] Successfully synced {} Metron issues for {}.", synced_count, series_name);
    Ok(synced_count)
}

/// Maps Metron's series_type (e.g. "One-Shot", "Trade Paperback", "Ongoing Series") to the
/// Mylar booktype values used in series.json. Parity with providers/metron.ts mapSeriesType.
fn map_series_type(v: &serde_json::Value) -> Option<&'static str> {
    let name = v["name"].as_str().or_else(|| v.as_str()).unwrap_or("").to_lowercase();
    if name.is_empty() {
        return None;
    }
    if name.contains("one-shot") || name.contains("one shot") || name.contains("single issue") {
        return Some("OneShot");
    }
    if name.contains("trade paperback") || name.contains("omnibus") || name.contains("hard cover") || name.contains("hardcover") {
        return Some("TPB");
    }
    if name.contains("graphic novel") {
        return Some("GN");
    }
    // Ongoing, Limited, Annual, Digital Chapters, etc. are all standard print series
    Some("Print")
}

/// Downloads the cover to `<folder>/cover.<ext>` and returns the `/api/library/cover` URL,
/// falling back to an existing cover file or the prior cover. Parity with metadata-fetcher.ts.
async fn resolve_cover(client: &Client, image_url: Option<&str>, folder_path: &str, current_cover: Option<String>, has_custom_cover: bool, cover_source: &str) -> Option<String> {
    let mut fallback = image_url.map(|s| s.to_string()).or(current_cover);

    let mut local_cover_exists = false;
    if !folder_path.trim().is_empty() {
        let _ = std::fs::create_dir_all(folder_path);
        for pc in ["cover.jpg", "cover.jpeg", "cover.png", "cover.webp", "folder.jpg", "Cover.jpg", "Cover.png", "folder.png"] {
            let p = Path::new(folder_path).join(pc);
            if p.exists() {
                fallback = Some(format!("/api/library/cover?path={}", urlencoding::encode(&p.to_string_lossy())));
                local_cover_exists = true;
                break;
            }
        }
    }

    // A custom-uploaded cover is never overwritten. In 'archive' mode an existing local/extracted cover
    // also wins over the provider — keep it and skip the download.
    if has_custom_cover || (cover_source == "archive" && local_cover_exists) {
        return fallback;
    }

    if let Some(url) = image_url {
        if !folder_path.trim().is_empty() && Path::new(folder_path).exists() {
            match client.get(url).timeout(Duration::from_secs(15)).send().await {
                Ok(resp) => {
                    let content_type = resp.headers().get(reqwest::header::CONTENT_TYPE)
                        .and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
                    match resp.bytes().await {
                        Ok(bytes) => {
                            if content_type.contains("text/html") || bytes.len() < 1000 {
                                log::warn!("[Metadata] Invalid cover payload (type: {}, size: {}); keeping fallback.", content_type, bytes.len());
                            } else {
                                let ext = if content_type.contains("image/png") { ".png" }
                                    else if content_type.contains("image/webp") { ".webp" }
                                    else { ".jpg" };
                                let cover_path = Path::new(folder_path).join(format!("cover{}", ext));
                                if std::fs::write(&cover_path, &bytes).is_ok() {
                                    return Some(format!("/api/library/cover?path={}", urlencoding::encode(&cover_path.to_string_lossy())));
                                }
                            }
                        }
                        Err(e) => log::warn!("[Metadata] Failed to read cover bytes: {}; keeping fallback.", e),
                    }
                }
                Err(e) => log::warn!("[Metadata] Failed to download cover: {}; keeping fallback.", e),
            }
        }
    }

    fallback
}

async fn mark_flag(db: &Db, key: &str) {
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis().to_string()).unwrap_or_default();
    let _ = sqlx::query(
        r#"INSERT INTO "SystemSetting" (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"#,
    )
    .bind(key)
    .bind(now_ms)
    .execute(&db.pool)
    .await;
}

fn cv_is_ended(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Null => false,
        serde_json::Value::String(s) => !s.is_empty(),
        serde_json::Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        _ => false,
    }
}

fn json_num_string(v: &serde_json::Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return if s.is_empty() { None } else { Some(s.to_string()) };
    }
    if let Some(i) = v.as_i64() {
        return Some(i.to_string());
    }
    if let Some(f) = v.as_f64() {
        return Some(f.to_string());
    }
    None
}

/// Parses YYYY / YYYY-MM / YYYY-MM-DD into epoch milliseconds (UTC midnight).
fn parse_date_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let full = match s.len() {
        4 => format!("{}-01-01", s),
        7 => format!("{}-01", s),
        _ => s.to_string(),
    };
    chrono::NaiveDate::parse_from_str(&full, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|dt| dt.and_utc().timestamp_millis())
}

/// Leading-zero / decimal / suffix-aware issue comparison (parity with isSameIssue in the Node code).
/// Captures an optional leading negative sign natively: "-1" and "1" are NOT the same issue.
pub(crate) fn is_same_issue(a: &str, b: &str) -> bool {
    fn parse_issue(s: &str) -> (f64, String) {
        static RE: OnceLock<Regex> = OnceLock::new();
        let re = RE.get_or_init(|| Regex::new(r"^(-?)0*(\d*(?:\.\d+)?)(.*)$").unwrap());
        let t = s.trim();
        match re.captures(t) {
            Some(c) => {
                let sign = c.get(1).map(|m| m.as_str()).unwrap_or("");
                let num_str = c.get(2).map(|m| m.as_str()).unwrap_or("");
                let num = if num_str.is_empty() {
                    0.0
                } else {
                    format!("{sign}{num_str}").parse::<f64>().unwrap_or(0.0)
                };
                let suffix = c.get(3).map(|m| m.as_str()).unwrap_or("").to_uppercase().trim().to_string();
                (num, suffix)
            }
            None => (0.0, t.to_uppercase()),
        }
    }
    let (n1, s1) = parse_issue(a);
    let (n2, s2) = parse_issue(b);
    n1 == n2 && s1 == s2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_same_issue_handles_zeros_decimals_suffixes() {
        assert!(is_same_issue("001", "1"));
        assert!(is_same_issue("1", "1"));
        assert!(is_same_issue("1.5", "01.5"));
        assert!(is_same_issue("1A", "1a"));
        assert!(!is_same_issue("1", "2"));
        assert!(!is_same_issue("1", "1A"));
        assert!(!is_same_issue("1.5", "1"));
    }

    #[test]
    fn is_same_issue_handles_negatives() {
        // Mirrors Node __tests__/lib/utils/issue-parser.test.ts
        assert!(is_same_issue("-1", "-001"));
        assert!(is_same_issue("-2.5", "-2.50"));
        assert!(!is_same_issue("-1", "1"));
        assert!(is_same_issue("-1A", "-001a"));
    }

    #[test]
    fn series_type_maps_to_mylar_booktypes() {
        assert_eq!(map_series_type(&serde_json::json!({"name": "One-Shot"})), Some("OneShot"));
        assert_eq!(map_series_type(&serde_json::json!({"name": "Trade Paperback"})), Some("TPB"));
        assert_eq!(map_series_type(&serde_json::json!({"name": "Omnibus"})), Some("TPB"));
        assert_eq!(map_series_type(&serde_json::json!({"name": "Hard Cover"})), Some("TPB"));
        assert_eq!(map_series_type(&serde_json::json!({"name": "Graphic Novel"})), Some("GN"));
        assert_eq!(map_series_type(&serde_json::json!({"name": "Ongoing Series"})), Some("Print"));
        assert_eq!(map_series_type(&serde_json::json!({"name": "Limited Series"})), Some("Print"));
        assert_eq!(map_series_type(&serde_json::json!("Single Issue")), Some("OneShot"));
        assert_eq!(map_series_type(&serde_json::Value::Null), None);
        assert_eq!(map_series_type(&serde_json::json!({"name": ""})), None);
    }

    #[test]
    fn cv_is_ended_truthiness() {
        assert!(cv_is_ended(&serde_json::json!("2015")));
        assert!(!cv_is_ended(&serde_json::json!("")));
        assert!(!cv_is_ended(&serde_json::Value::Null));
        assert!(cv_is_ended(&serde_json::json!(2015)));
    }

    #[test]
    fn parse_date_ms_handles_partials() {
        assert!(parse_date_ms("2020-05-01").is_some());
        assert!(parse_date_ms("2020-05").is_some());
        assert!(parse_date_ms("2020").is_some());
        assert!(parse_date_ms("not-a-date").is_none());
        // Ordering sanity: later date is greater.
        assert!(parse_date_ms("2021-01-01").unwrap() > parse_date_ms("2020-01-01").unwrap());
    }

    #[test]
    fn json_num_string_handles_string_and_number() {
        assert_eq!(json_num_string(&serde_json::json!("5")), Some("5".to_string()));
        assert_eq!(json_num_string(&serde_json::json!(5)), Some("5".to_string()));
        assert_eq!(json_num_string(&serde_json::json!("")), None);
        assert_eq!(json_num_string(&serde_json::Value::Null), None);
    }

    #[test]
    fn metron_issue_name_formats() {
        let with_title = serde_json::json!({"series": "Batman", "title": "The Long Halloween"});
        assert_eq!(metron_issue_name(&with_title, "1"), "Batman #1: The Long Halloween");
        // A generic "Issue #N" title is ignored.
        let generic = serde_json::json!({"series": "Batman", "issue": "Issue #5"});
        assert_eq!(metron_issue_name(&generic, "5"), "Batman #5");
        // No title -> just "Series #N".
        let bare = serde_json::json!({"series": "Saga"});
        assert_eq!(metron_issue_name(&bare, "12"), "Saga #12");
        // series as an object with a name.
        let obj_series = serde_json::json!({"series": {"name": "X-Men"}});
        assert_eq!(metron_issue_name(&obj_series, "7"), "X-Men #7");
    }
}
