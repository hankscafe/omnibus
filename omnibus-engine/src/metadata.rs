use crate::db::Db;
use sqlx::Row;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use regex::Regex;
use reqwest::Client;

/// SQL predicate (embeddable in a WHERE, table referenced as "Series") matching a FILE-COMPLETE
/// series — one whose local files already supplied everything a provider sync would add
/// (discussion #182, local-first ingest): a description, at least one owned issue, and every
/// owned issue enrichment-complete (DEEP_SYNCED — stamped by the scanner/watched-sync when the
/// file's ComicInfo carried credits, by view-time enrichment, or by metron_detail_credits).
/// The scheduled sweep EXCLUDES these; a targeted/manual refresh never applies this predicate.
pub(crate) fn file_complete_predicate() -> &'static str {
    r#"("Series".description IS NOT NULL AND "Series".description <> ''
        AND EXISTS (SELECT 1 FROM "Issue" fi WHERE fi."seriesId" = "Series".id AND fi."filePath" IS NOT NULL)
        AND NOT EXISTS (
            SELECT 1 FROM "Issue" fi WHERE fi."seriesId" = "Series".id AND fi."filePath" IS NOT NULL
              AND (fi."matchState" IS NULL OR fi."matchState" <> 'DEEP_SYNCED')
        ))"#
}

/// WHERE fragment matching issue rows that have never been provider-paired: scanner-born rows
/// carry `unmatched_<uuid>` ids (scanner.rs) until a sync's number-anchored pairing links them,
/// and provider-created rows always carry a real id. `_` is a LIKE wildcard, hence the ESCAPE.
pub(crate) fn unenriched_issue_predicate() -> &'static str {
    r#"("metadataId" IS NULL OR "metadataId" LIKE 'unmatched!_%' ESCAPE '!')"#
}

/// How many times a rate-limit-halted batch re-queues itself before giving up. The scheduled
/// sweep is the durable backstop either way — with the Ended-complete skip gated on enrichment,
/// nothing is stranded by giving up here.
pub(crate) const MAX_RATE_LIMIT_RETRIES: u32 = 2;
/// Delay before a halted batch retries — CV's budget window is hourly, so half of it lets the
/// window meaningfully refill without pushing the heal past the next sweep anyway.
pub(crate) const RATE_LIMIT_RETRY_DELAY_SECS: u64 = 30 * 60;

/// Retry plan for a rate-limit-halted batch: the series that hit the limit plus everything after
/// it in batch order, or None when the attempt cap is reached (or there is nothing to retry).
pub(crate) fn plan_rate_limit_retry(all_ids: &[String], halt_index: usize, attempt: u32) -> Option<Vec<String>> {
    if attempt >= MAX_RATE_LIMIT_RETRIES {
        return None;
    }
    let ids = all_ids.get(halt_index..)?;
    if ids.is_empty() {
        return None;
    }
    Some(ids.to_vec())
}

/// Series ids with a metadata sync currently in flight, shared across every spawned sync task.
/// Two concurrent syncs of the same series interleave non-idempotent issue upserts and can
/// cross-pair rows (issue #194) — the later trigger is always redundant, so it skips the series.
fn in_flight_syncs() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// RAII claim on a series id in [`in_flight_syncs`]; released when the claim drops, including
/// on error/early-continue paths.
pub(crate) struct SyncClaim(String);

impl SyncClaim {
    /// Claims the series for syncing, or None when a sync for it is already in flight.
    pub(crate) fn try_acquire(series_id: &str) -> Option<SyncClaim> {
        let mut set = in_flight_syncs().lock().unwrap_or_else(|p| p.into_inner());
        if set.insert(series_id.to_string()) {
            Some(SyncClaim(series_id.to_string()))
        } else {
            None
        }
    }
}

impl Drop for SyncClaim {
    fn drop(&mut self) {
        in_flight_syncs().lock().unwrap_or_else(|p| p.into_inner()).remove(&self.0);
    }
}

pub async fn sync_metadata(db: Db, series_ids: Option<Vec<String>>) -> anyhow::Result<()> {
    sync_metadata_attempt(db, series_ids, 0).await
}

/// Boxed indirection for the retry recursion — an async fn cannot await itself directly; the
/// erased concrete return type breaks the Send-inference cycle.
fn sync_metadata_attempt_boxed(
    db: Db,
    series_ids: Option<Vec<String>>,
    attempt: u32,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + Send>> {
    Box::pin(sync_metadata_attempt(db, series_ids, attempt))
}

/// Body of [`sync_metadata`]. `rate_limit_attempt` counts how many times this batch has already
/// re-queued itself after a provider rate-limit halt (0 = the original request).
async fn sync_metadata_attempt(db: Db, series_ids: Option<Vec<String>>, rate_limit_attempt: u32) -> anyhow::Result<()> {
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
            // Local-first ingest (discussion #182): the scheduled sweep skips series whose FILES
            // already provided everything — for a fully-tagged library the recurring sync cost
            // drops to zero API calls. Gaps and untagged series keep syncing exactly as before,
            // and a manual "Refresh Metadata" (series_ids given) always fetches live.
            let skipped: i64 = sqlx::query_scalar(&format!(
                r#"SELECT COUNT(*) FROM "Series" WHERE "metadataId" IS NOT NULL AND {fc}"#,
                fc = file_complete_predicate()
            ))
            .fetch_one(&db.pool)
            .await
            .unwrap_or(0);
            if skipped > 0 {
                log::info!("[Metadata] Scheduled sync skipping {} file-complete series (local metadata already covers them).", skipped);
            }
            let sql = format!(
                r#"{series_select} WHERE "metadataId" IS NOT NULL AND NOT {fc} ORDER BY "updatedAt" ASC LIMIT 15"#,
                fc = file_complete_predicate()
            );
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

    // file_metadata_priority (discussion #177): provider syncs only fill blanks; embedded-file
    // metadata (ComicInfo.xml / series.json) is never overwritten unless the admin turns this off.
    let file_priority: bool = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'file_metadata_priority'"#)
        .fetch_optional(&db.pool).await.ok().flatten().as_deref() == Some("true");

    // metron_detail_credits (opt-in, quota-heavy): fetch per-issue credits via Metron detail calls —
    // one /issue/{id}/ call per not-yet-deep-synced issue, gated against the 5,000/day window.
    let metron_detail_credits: bool = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'metron_detail_credits'"#)
        .fetch_optional(&db.pool).await.ok().flatten().as_deref() == Some("true");

    let mut ok_count = 0usize;
    let mut fail_count = 0usize;
    // Batch order snapshot — on a rate-limit halt, the tail from the halted series onward is
    // re-queued (best-effort, in-process; the scheduled sweep is the durable backstop).
    let all_ids: Vec<String> = series_list.iter().map(|r| r.get::<String, _>("id")).collect();
    let mut halted_at: Option<usize> = None;
    for (series_idx, series) in series_list.iter().enumerate() {
        let series_id: String = series.get("id");
        let series_name: String = series.get("name");

        // Issue #194: a second trigger for a series mid-sync (double-queue, sweep overlap,
        // double-click) must not race the first — interleaved upserts cross-pair issue rows.
        // `_claim` (not `_`, which would drop immediately) holds until the end of this iteration.
        let _claim = match SyncClaim::try_acquire(&series_id) {
            Some(claim) => claim,
            None => {
                log::warn!("[Metadata] Sync already in flight for {} — skipping duplicate trigger.", series_name);
                continue;
            }
        };

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
                        &db, &client, key, &series_id, &series_name, &metadata_id, &folder_path, current_year, current_cover, full_fetch, has_custom_cover, &cover_source, file_priority,
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
                    last_sync.as_deref(), full_fetch, has_custom_cover, &cover_source, file_priority, metron_detail_credits,
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
                halted_at = Some(series_idx);
                break;
            }
            log::error!("[Metadata] {} fetch failed for {}: {:?}", metadata_source, series_name, e);
            // Non-fatal: don't re-embed stale data for this series; move on to the next one.
            fail_count += 1;
            continue;
        }
        ok_count += 1;

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

    // 2026-07-26 (worklist item 10 follow-up): a halted batch used to evaporate — the BullMQ job
    // completes as soon as the engine ACCEPTs, so nothing upstream ever retries. Re-queue the
    // unfinished tail here (delayed, attempt-capped). A retried batch runs as TARGETED
    // (Some(ids) ⇒ full_fetch): the original semantics for the match-time case, and a bounded
    // upgrade for a halted sweep tail (≤15 ids, ≤MAX attempts).
    if let Some(idx) = halted_at {
        match plan_rate_limit_retry(&all_ids, idx, rate_limit_attempt) {
            Some(retry_ids) => {
                let attempt = rate_limit_attempt + 1;
                let retry_db = db.clone();
                log::info!(
                    "[Metadata Sync] Re-queuing {} rate-limit-halted series in {}s (attempt {}/{}).",
                    retry_ids.len(), RATE_LIMIT_RETRY_DELAY_SECS, attempt, MAX_RATE_LIMIT_RETRIES
                );
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(RATE_LIMIT_RETRY_DELAY_SECS)).await;
                    if let Err(e) = sync_metadata_attempt_boxed(retry_db, Some(retry_ids), attempt).await {
                        log::error!("[Metadata Sync] Rate-limit retry attempt {} failed: {:?}", attempt, e);
                    }
                });
            }
            None => log::warn!(
                "[Metadata Sync] Rate-limit halt left {} series unfinished and the retry cap ({}) is spent — the scheduled sweep will finish them.",
                all_ids.len() - idx, MAX_RATE_LIMIT_RETRIES
            ),
        }
    }

    log::info!("[Metadata] Sync batch complete: {} series synced, {} failed.", ok_count, fail_count);
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
    file_priority: bool,
) -> anyhow::Result<i32> {
    // ---- 1. Volume details ----
    let vol_url = format!("https://comicvine.gamespot.com/api/volume/4050-{}/", metadata_id);
    log::debug!("[Metadata Fetcher Debug] Requesting ComicVine Volume: {}", vol_url);

    let vol_req = client
        .get(&vol_url)
        .query(&[
            ("api_key", api_key),
            ("format", "json"),
            ("field_list", "image,description,deck,publisher,start_year,name,person_credits,character_credits,concepts,end_year,count_of_issues"),
        ])
        .header("User-Agent", "Omnibus/1.0")
        .timeout(Duration::from_secs(15))
        .build()?;
    let vol_full_url = vol_req.url().to_string();

    // Shared response cache (metadata_cache_enabled): a hit is not an upstream call, so usage
    // logging and 429 handling only run on the real-fetch path.
    let vol_json: serde_json::Value = match crate::metadata_cache::get(db, "comicvine", &vol_full_url).await {
        Some(hit) => hit,
        None => {
            let vol_resp = client.execute(vol_req).await?;
            crate::api_usage::log(&db.pool, "comicvine", &vol_url).await;
            if vol_resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                mark_flag(db, "cv_rate_limit_time").await;
                anyhow::bail!("ComicVine rate limited (429) on volume fetch");
            }
            let j: serde_json::Value = vol_resp.json().await?;
            crate::metadata_cache::put(db, "comicvine", &vol_full_url, &j).await;
            j
        }
    };
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
    let update_res = if series_is_locked(db, series_id).await || file_priority {
        // Locked OR file-priority: narrative fields stay as the files/admin set them; the cover and
        // blank-fills (incl. description/status, which the files may not have carried) still apply.
        sqlx::query(
            r#"UPDATE "Series" SET "coverUrl"=$1,
               "remoteCoverUrl"=COALESCE($2, "remoteCoverUrl"),
               "bookType"=COALESCE("bookType", $3),
               genres=COALESCE(genres, $4),
               description=COALESCE(description, $5),
               status=COALESCE(status, $6)
               WHERE id=$7"#,
        )
        .bind(&final_cover)
        .bind(&image_url)
        .bind(guessed_book_type)
        .bind(&vol_genres_json)
        .bind(&description)
        .bind(status)
        .bind(series_id)
        .execute(&db.pool)
        .await
    } else {
        sqlx::query(
            r#"UPDATE "Series" SET name=$1, publisher=$2, year=$3, description=$4, "coverUrl"=$5, status=$6,
               "remoteCoverUrl"=COALESCE($7, "remoteCoverUrl"),
               "bookType"=COALESCE("bookType", $8),
               genres=COALESCE($9, genres)
               WHERE id=$10"#,
        )
        .bind(&name)
        .bind(&publisher)
        .bind(year)
        .bind(&description)
        .bind(&final_cover)
        .bind(status)
        .bind(&image_url)
        .bind(guessed_book_type)
        .bind(&vol_genres_json)
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
    // Local-first caveat (2026-07-26, worklist item 10 follow-up): scanner-born rows make the count
    // look complete without ever having been provider-paired — a match-time sync halted by a 429
    // leaves exactly that state. The shortcut is only safe once every row is enriched; until then
    // THIS fetch is what finishes the pairing (per-issue covers included), so it must run.
    let cv_total = vol_data["count_of_issues"].as_i64().unwrap_or(0);
    if !full_fetch && status == "Ended" && cv_total > 0 {
        let local_count: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM "Issue" WHERE "seriesId" = $1"#)
            .bind(series_id).fetch_one(&db.pool).await.unwrap_or(0);
        if local_count >= cv_total {
            let unenriched: i64 = sqlx::query_scalar(&format!(
                r#"SELECT COUNT(*) FROM "Issue" WHERE "seriesId" = $1 AND {}"#,
                unenriched_issue_predicate()
            ))
            .bind(series_id)
            .fetch_one(&db.pool)
            .await
            .unwrap_or(1); // on a read error, err toward fetching — never re-strand the series
            if unenriched == 0 {
                log::info!("[Metadata] {} is Ended and complete ({}/{}) — skipping ComicVine issue fetch.", series_name, local_count, cv_total);
                return Ok(0);
            }
            log::info!("[Metadata] {} is Ended and complete by count ({}/{}) but {} rows were never provider-paired — running the issue fetch.", series_name, local_count, cv_total, unenriched);
        }
    }

    // ---- 2. Paginated issues ----
    let mut offset: i32 = 0;
    let mut total_results: i32 = 1;
    let mut loop_count = 0;
    let mut synced_count = 0;
    let mut latest_date_ms: i64 = 0;
    // One write per row per SYNC (not per page): a duplicate provider number on a later page must
    // not overwrite a pairing made on an earlier one (issue #194 (c1) claim set). inserted_nums
    // guards the same-page dup case, where the fresh row isn't in the snapshot yet.
    let mut claimed: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut inserted_nums: Vec<String> = Vec::new();

    while offset < total_results && loop_count < 20 {
        log::debug!("[Metadata Fetcher Debug] Fetching issues for volume {} (Offset: {}, Limit: 100)", metadata_id, offset);

        let filter_val = format!("volume:{}", metadata_id);
        let offset_str = offset.to_string();
        let issue_req = client
            .get("https://comicvine.gamespot.com/api/issues/")
            .query(&[
                ("api_key", api_key),
                ("format", "json"),
                ("filter", filter_val.as_str()),
                ("sort", "issue_number:asc"),
                ("limit", "100"),
                ("offset", offset_str.as_str()),
                // person/character/team/location credits ride along in the SAME list call (no extra
                // API budget) so per-issue credits populate without per-issue detail fetches (issue #179).
                ("field_list", "id,name,issue_number,store_date,cover_date,image,deck,description,person_credits,character_credits,team_credits,location_credits"),
            ])
            .header("User-Agent", "Omnibus/1.0")
            .timeout(Duration::from_secs(15))
            .build()?;
        let issue_full_url = issue_req.url().to_string();

        let issue_json: serde_json::Value = match crate::metadata_cache::get(db, "comicvine", &issue_full_url).await {
            Some(hit) => hit,
            None => {
                let issue_resp = client.execute(issue_req).await?;
                crate::api_usage::log(&db.pool, "comicvine", "https://comicvine.gamespot.com/api/issues/").await;
                if issue_resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                    mark_flag(db, "cv_rate_limit_time").await;
                    anyhow::bail!("ComicVine rate limited (429) on issues fetch");
                }
                let j: serde_json::Value = issue_resp.json().await?;
                crate::metadata_cache::put(db, "comicvine", &issue_full_url, &j).await;
                j
            }
        };
        if offset == 0 {
            total_results = issue_json["number_of_total_results"].as_i64().unwrap_or(0) as i32;
        }
        if issue_json.get("results").and_then(|v| v.as_array()).is_none() {
            log::warn!("[Metadata] ComicVine issues response for {} (offset {}) carried no results array -- page treated as empty.", series_name, offset);
        }
        let cv_issues = issue_json["results"].as_array().cloned().unwrap_or_default();

        // Diagnostic (issue #179): ComicVine's docs list the credit fields as detail-only, but in
        // practice the list endpoint has returned person_credits (Discover depends on it). Log which
        // reality this instance sees, once per sync, so operators can tell where credits come from.
        if offset == 0 && !cv_issues.is_empty() {
            let has_credit_fields = cv_issues.iter().any(|i| i.get("person_credits").map(|v| !v.is_null()).unwrap_or(false));
            if !has_credit_fields {
                log::info!("[Metadata] ComicVine issues list carried no credit fields for {} — per-issue credits will populate via view-time enrichment instead.", series_name);
            }
        }

        // Re-fetch the series' issues each page so issues created on earlier pages are visible to
        // isSameIssue. Bool columns are CAST for the Any driver (no SQLite BOOLEAN mapping).
        // metadataId rides along for the number-anchored pairing (issue #194 (c1)).
        let existing_issues = sqlx::query(
            r#"SELECT id, number, "metadataId", CAST("hasCustomMetadata" AS INTEGER) AS "hasCustomMetadata", name, "releaseDate", genres, description, CAST("hasCustomCover" AS INTEGER) AS "hasCustomCover", "coverUrl", "matchState", writers, artists, "coverArtists", colorists, letterers, characters, teams, locations FROM "Issue" WHERE "seriesId" = $1"#,
        )
        .bind(series_id)
        .fetch_all(&db.pool)
        .await?;

        // Pairing snapshot for resolve_pair_target: (row id, number, stored metadataId).
        let pair_snapshot: Vec<(String, String, Option<String>)> = existing_issues.iter().map(|r| (
            r.get::<String, _>("id"),
            r.get::<String, _>("number"),
            r.try_get::<Option<String>, _>("metadataId").unwrap_or(None),
        )).collect();

        // Cross-series id matches only (rows in THIS series pair via the number-anchored snapshot).
        // Kept for the legit adoption case — a request-created skeleton that predates this series —
        // and only honored by the resolver when the row's number ALSO agrees (issue #194: a global
        // id match with a disagreeing number is a mispair, never a steal target).
        let page_cv_ids: Vec<String> = cv_issues.iter()
            .filter_map(|i| i["id"].as_i64().map(|n| n.to_string()))
            .collect();
        let mut by_cv: std::collections::HashMap<String, sqlx::any::AnyRow> = std::collections::HashMap::new();
        if !page_cv_ids.is_empty() {
            let sql = format!(
                r#"SELECT id, number, "seriesId", name, "releaseDate", CAST("hasCustomMetadata" AS INTEGER) AS "hasCustomMetadata", genres, description, "metadataId", CAST("hasCustomCover" AS INTEGER) AS "hasCustomCover", "coverUrl", "matchState", writers, artists, "coverArtists", colorists, letterers, characters, teams, locations FROM "Issue" WHERE "metadataId" IN ({}) AND "metadataSource" = 'COMICVINE' AND "seriesId" <> $1"#,
                Db::in_placeholders(2, page_cv_ids.len())
            );
            let mut q = sqlx::query(&sql).bind(series_id);
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

            // Number-anchored pairing (issue #194 (c1)): the resolver honors a stored id only when
            // the row's number agrees; otherwise the number wins and the id gets healed below.
            let cross = by_cv.get(&cv_id_str).map(|r| (r.get::<String, _>("id"), r.get::<String, _>("number")));
            let target = resolve_pair_target(
                &cv_id_str, &issue_num, &pair_snapshot,
                cross.as_ref().map(|(a, b)| (a.as_str(), b.as_str())),
                &claimed,
            );

            let (target_row, heal_id) = match &target {
                PairTarget::Update { row_id, heal_id, cross_series } => {
                    if *cross_series {
                        (by_cv.get(&cv_id_str), *heal_id)
                    } else {
                        (existing_issues.iter().find(|r| &r.get::<String, _>("id") == row_id), *heal_id)
                    }
                }
                PairTarget::Skip => {
                    log::info!("[Metadata] Duplicate provider number #{} ({}) for {} — first listing wins, skipping.", issue_num, cv_id_str, series_name);
                    continue;
                }
                PairTarget::Insert => (None, false),
            };

            // Lock + existing fields from the resolved target. On a heal (id changed) the row's
            // enrichment-era fields belonged to the WRONG issue — treat them as absent so the
            // provider payload replaces them instead of merging with wrong-issue leftovers.
            // EXCEPTION: a locked (hasCustomMetadata) row heals its id but keeps its curated
            // content — the lock outranks the reset.
            let is_locked = target_row
                .map(|r| r.try_get::<i64, _>("hasCustomMetadata").map(|v| v != 0).unwrap_or(false))
                .unwrap_or(false);
            let reset_stale = heal_id && !is_locked;
            let (existing_name, existing_release, existing_genres, existing_desc, has_custom_cover, existing_cover) = if let Some(r) = target_row {
                (
                    if reset_stale { None } else { r.try_get::<Option<String>, _>("name").unwrap_or(None) },
                    if reset_stale { None } else { r.try_get::<Option<String>, _>("releaseDate").unwrap_or(None) },
                    if reset_stale { None } else { r.try_get::<Option<String>, _>("genres").unwrap_or(None) },
                    if reset_stale { None } else { r.try_get::<Option<String>, _>("description").unwrap_or(None) },
                    r.try_get::<i64, _>("hasCustomCover").map(|v| v != 0).unwrap_or(false),
                    r.try_get::<Option<String>, _>("coverUrl").unwrap_or(None),
                )
            } else {
                (None, None, None, None, false, None)
            };

            // #199 round 3: shared resolver — a null/generic provider name can no longer wipe a
            // real story title; lock + file-priority semantics unchanged (Node parity).
            let name_val = resolve_synced_name(existing_name, cv_name, &issue_num, is_locked, file_priority);
            let release_val = if is_locked { existing_release } else { issue_date.clone() };
            // A locked (manually edited) issue keeps its description; file-priority keeps a non-empty
            // ComicInfo-derived one; otherwise take the provider's.
            let desc_val = prefer_existing(existing_desc, cv_desc.clone(), is_locked, file_priority);
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

            // Per-issue credits/appearances from the list item (issue #179). merge_credit_json keeps
            // the existing column whenever the provider supplied nothing — a re-sync can never wipe
            // ComicInfo.xml-derived or manually added credits with '[]'. On a heal the existing
            // credits belonged to the wrong issue, so they read as absent (reset_stale) and the
            // guarded view-time enrichment refills them for the CORRECT id.
            let credits = cv_issue_credits(cv_issue);
            let existing_col = |col: &str| -> Option<String> {
                if reset_stale { return None; }
                target_row.and_then(|r| r.try_get::<Option<String>, _>(col).unwrap_or(None))
            };
            // A healed row drops DEEP_SYNCED — its deep data belonged to the old id.
            let match_state_val = if heal_id { "MATCHED" } else { next_match_state(existing_col("matchState")) };
            let writers_val = merge_credit_json(existing_col("writers"), &credits.writers, is_locked, file_priority);
            let artists_val = merge_credit_json(existing_col("artists"), &credits.artists, is_locked, file_priority);
            let cover_artists_val = merge_credit_json(existing_col("coverArtists"), &credits.cover_artists, is_locked, file_priority);
            let colorists_val = merge_credit_json(existing_col("colorists"), &credits.colorists, is_locked, file_priority);
            let letterers_val = merge_credit_json(existing_col("letterers"), &credits.letterers, is_locked, file_priority);
            let characters_val = merge_credit_json(existing_col("characters"), &credits.characters, is_locked, file_priority);
            let teams_val = merge_credit_json(existing_col("teams"), &credits.teams, is_locked, file_priority);
            let locations_val = merge_credit_json(existing_col("locations"), &credits.locations, is_locked, file_priority);
            let inker_val = merge_credit_json(existing_col("inker"), &credits.inkers, is_locked, file_priority);
            let editor_val = merge_credit_json(existing_col("editor"), &credits.editors, is_locked, file_priority);
            let translator_val = merge_credit_json(existing_col("translator"), &credits.translators, is_locked, file_priority);

            let res = if let PairTarget::Update { row_id, cross_series, .. } = &target {
                if heal_id {
                    log::info!("[Metadata] Healing issue #{} of {} — stored id disagreed with its number, re-linking to {} (issue #194).", issue_num, series_name, cv_id_str);
                }
                // ONE update shape for in-series and adoption: seriesId+metadataId always written
                // (agreeing values are no-ops), the row's NUMBER is never touched — number is the
                // identity anchor and only ever set at insert (issue #194: the old id-match branch
                // rewrote number and could turn row "1" into a second "4").
                let q = sqlx::query(
                    r#"UPDATE "Issue" SET "seriesId"=$1, "metadataId"=$2, "metadataSource"='COMICVINE', name=$3, "releaseDate"=$4, description=$5, "coverUrl"=$6, "matchState"=$16, genres=$7,
                       writers=$8, artists=$9, "coverArtists"=$10, colorists=$11, letterers=$12, characters=$13, teams=$14, locations=$15, inker=$18, editor=$19, translator=$20 WHERE id=$17"#,
                )
                .bind(series_id).bind(&cv_id_str).bind(&name_val).bind(&release_val)
                .bind(&desc_val).bind(&cover_val).bind(&genres_val)
                .bind(&writers_val).bind(&artists_val).bind(&cover_artists_val).bind(&colorists_val)
                .bind(&letterers_val).bind(&characters_val).bind(&teams_val).bind(&locations_val)
                .bind(match_state_val).bind(row_id)
                .bind(&inker_val).bind(&editor_val).bind(&translator_val)
                .execute(&db.pool).await;
                if q.is_ok() {
                    claimed.insert(row_id.clone());
                    if *cross_series {
                        log::info!("[Metadata] Adopted issue #{} ({}) into {} from another series (id+number agree).", issue_num, cv_id_str, series_name);
                    }
                }
                q
            } else {
                // Insert — also guarded against a same-page duplicate provider number (the fresh
                // row isn't in the snapshot yet, so the resolver can't see it).
                if inserted_nums.iter().any(|n| is_same_issue(n, &issue_num)) {
                    log::info!("[Metadata] Duplicate provider number #{} ({}) for {} — first listing wins, skipping.", issue_num, cv_id_str, series_name);
                    continue;
                }
                let new_id = uuid::Uuid::new_v4().to_string();
                let q = sqlx::query(&format!(
                    r#"INSERT INTO "Issue"
                       (id, "seriesId", "metadataId", "metadataSource", number, status, name, "releaseDate", description, "coverUrl", "matchState", genres,
                        writers, artists, "coverArtists", colorists, letterers, characters, teams, locations, inker, editor, translator, "createdAt", "updatedAt")
                       VALUES ($1,$2,$3,'COMICVINE',$4,'WANTED',$5,$6,$7,$8,'MATCHED',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, {now}, {now})"#,
                    now = db.now_expr()
                ))
                .bind(&new_id).bind(series_id).bind(&cv_id_str).bind(&issue_num)
                .bind(&name_val).bind(&release_val).bind(&cv_desc).bind(&cv_cover).bind(&genres_val)
                .bind(&writers_val).bind(&artists_val).bind(&cover_artists_val).bind(&colorists_val)
                .bind(&letterers_val).bind(&characters_val).bind(&teams_val).bind(&locations_val)
                .bind(&inker_val).bind(&editor_val).bind(&translator_val)
                .execute(&db.pool).await;
                if q.is_ok() { inserted_nums.push(issue_num.clone()); }
                q
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
                if let Err(e) = sqlx::query(r#"UPDATE "Series" SET status='Ended' WHERE id=$1"#).bind(series_id).execute(&db.pool).await {
                    log::error!("[Metadata] Failed to mark {} as Ended: {:?}", series_name, e);
                }
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

/// ISO timestamp ("2026-07-10T12:34:56", space-separated, or fractional/Z variants) -> RFC 7231
/// IMF-fixdate for the If-Modified-Since header. None when unparseable (send no header over a bogus one).
fn iso_to_http_date(iso: &str) -> Option<String> {
    let cleaned = iso.trim().replace(' ', "T");
    let cleaned = cleaned.trim_end_matches('Z');
    let base = cleaned.split('.').next().unwrap_or("");
    let dt = chrono::NaiveDateTime::parse_from_str(base, "%Y-%m-%dT%H:%M:%S").ok()?;
    Some(dt.format("%a, %d %b %Y %H:%M:%S GMT").to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn metron_header_i64(resp: &reqwest::Response, name: &str, default: i64) -> i64 {
    resp.headers().get(name).and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<i64>().ok()).unwrap_or(default)
}

/// Metron HTTP GET with burst-rate-limit handling + retry/backoff (parity with metron.ts fetchWithBackoff).
/// `if_modified_since`: RFC 7231 date for conditional detail requests (metron.cloud best-practices) --
/// the server answers 304 with no body when the resource is unchanged; callers must branch on status.
async fn metron_fetch(db: &Db, client: &Client, auth: &(String, String), url: &str, timeout_secs: u64, max_retries: u32, if_modified_since: Option<&str>) -> anyhow::Result<(u16, serde_json::Value)> {
    // Shared response cache (metadata_cache_enabled): conditional requests bypass it — their whole
    // point is asking Metron "did this change". A hit skips the per-attempt api_usage logging below
    // entirely (it isn't an upstream call).
    if if_modified_since.is_none() {
        if let Some(hit) = crate::metadata_cache::get(db, "metron", url).await {
            return Ok((200, hit));
        }
    }
    log::debug!("[Metron Debug] Executing Fetch: {}{}", url, if if_modified_since.is_some() { " (conditional)" } else { "" });
    for attempt in 0..max_retries {
        let mut req = client
            .get(url)
            .basic_auth(&auth.0, Some(&auth.1))
            .header("User-Agent", "Omnibus/1.0")
            .timeout(Duration::from_secs(timeout_secs));
        if let Some(ims) = if_modified_since {
            req = req.header("If-Modified-Since", ims);
        }
        match req
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                // Every attempt is a real request against the 5,000/day sustained quota — record it
                // so the health panel's Metron counter reflects engine traffic too (unified builds
                // route all sync calls through here).
                crate::api_usage::log(&db.pool, "metron", url).await;
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
                    // Hard 4xx (bad credentials/params) won't improve on retry — metron.cloud's API
                    // best-practices: only 429 and 5xx are retryable. Bail instead of burning quota.
                    if (400..500).contains(&status) {
                        anyhow::bail!("Metron HTTP Error: {} (not retried)", status);
                    }
                    if attempt + 1 == max_retries { anyhow::bail!("Metron HTTP Error: {}", status); }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }

                if status == 204 || status == 304 {
                    return Ok((status, serde_json::Value::Null));
                }
                // A 2xx/404 body that doesn't parse is a real failure -- silently returning Null here
                // let a truncated response overwrite good series data with "Unknown" fields. Retry it
                // like a network error; bail after max retries.
                match resp.json::<serde_json::Value>().await {
                    Ok(data) => {
                        if status == 200 && if_modified_since.is_none() {
                            crate::metadata_cache::put(db, "metron", url, &data).await;
                        }
                        return Ok((status, data));
                    }
                    Err(e) => {
                        log::warn!("[Metron] Response body for {} did not parse as JSON (attempt {}/{}): {}", url, attempt + 1, max_retries, e);
                        if attempt + 1 == max_retries { anyhow::bail!("Metron returned an unparseable body for {}", url); }
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        continue;
                    }
                }
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
    file_priority: bool,
    detail_credits: bool,
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

    // Conditional fetch on scheduled sweeps (never on a manual refresh): Metron honors
    // If-Modified-Since on detail endpoints with a bodyless 304 (their API best-practices).
    let ims_header = if !full_fetch { last_sync.and_then(iso_to_http_date) } else { None };
    let (status, mut series_data) = metron_fetch(db, client, &auth, &detail_url, 10, 3, ims_header.as_deref()).await?;
    if status == 404 {
        anyhow::bail!("Series {} not found on Metron", metadata_id);
    }
    // 304 = series-level fields unchanged since our last sync. Skip the series update AND the cover
    // re-resolution (the bodyless response has nothing to apply -- writing it would fabricate
    // "Unknown" fields), but still run the incremental issue top-up below for new/changed issues.
    let series_unchanged = status == 304 && is_numeric;
    if series_unchanged {
        log::debug!("[Metron Debug] Series {} unchanged since last sync (304) -- skipping series-level update.", series_name);
    }
    if !is_numeric {
        let results = series_data["results"].as_array().cloned().unwrap_or_default();
        if results.is_empty() {
            anyhow::bail!("Series slug {} returned 0 results on Metron", metadata_id);
        }
        series_data = results[0].clone();
    }

    let real_series_id = series_data["id"].as_i64().map(|i| i.to_string()).unwrap_or_else(|| metadata_id.to_string());

    let issue_list_url = format!("https://metron.cloud/api/series/{}/issue_list/", real_series_id);

    // One first-page fetch serves BOTH the cover (first issue's image) and, on a full walk, the
    // first page of the issue pagination below. The old shape made a throwaway cover-only call
    // (errors silently swallowed, retries=1) and then re-fetched the same page in the walk --
    // a duplicated API call on every full sync. Skipped entirely on a 304 (nothing changed).
    let mut cover_remote: Option<String> = None;
    let mut first_page: Option<serde_json::Value> = None;
    if !series_unchanged {
        let (_, il) = metron_fetch(db, client, &auth, &issue_list_url, 15, 3, None).await?;
        cover_remote = il["results"][0]["image"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string());
        first_page = Some(il);
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

    // Series-level genres from Metron's detail payload (issue #180). On a 304 the bodyless payload
    // yields None, so the COALESCE writes below leave the existing column untouched.
    let series_genres_json = names_json(&series_data, "genres");

    // Metron's series_type is authoritative for the Mylar booktype, but never clobber a manual one.
    let book_type = map_series_type(&series_data["series_type"]);

    if !series_unchanged {
    let final_cover = resolve_cover(client, cover_remote.as_deref(), folder_path, current_cover, has_custom_cover, cover_source).await;

    // A manually curated series keeps its narrative fields; only the cover + blank-fills update.
    let update_res = if series_is_locked(db, series_id).await || file_priority {
        sqlx::query(
            r#"UPDATE "Series" SET "coverUrl"=$1, universe=COALESCE($2, universe),
               "remoteCoverUrl"=COALESCE($3, "remoteCoverUrl"),
               "bookType"=COALESCE("bookType", $4),
               genres=COALESCE(genres, $5),
               description=COALESCE(description, $6),
               status=COALESCE(status, $7)
               WHERE id=$8"#,
        )
        .bind(&final_cover).bind(&universe).bind(&cover_remote).bind(book_type).bind(&series_genres_json)
        .bind(&description).bind(status_str).bind(series_id)
        .execute(&db.pool).await
    } else {
        sqlx::query(
            r#"UPDATE "Series" SET name=$1, publisher=$2, year=$3, description=$4, "coverUrl"=$5, status=$6, universe=COALESCE($7, universe),
               "remoteCoverUrl"=COALESCE($8, "remoteCoverUrl"),
               "bookType"=COALESCE("bookType", $9),
               genres=COALESCE($10, genres)
               WHERE id=$11"#,
        )
        .bind(&name).bind(&publisher).bind(year).bind(&description).bind(&final_cover).bind(status_str).bind(&universe)
        .bind(&cover_remote).bind(book_type).bind(&series_genres_json).bind(series_id)
        .execute(&db.pool).await
    };
    if let Err(e) = update_res {
        log::error!("[Metadata] Failed to update Metron series {}: {:?}", series_name, e);
    }
    }

    let local_count: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM "Issue" WHERE "seriesId" = $1"#)
        .bind(series_id).fetch_one(&db.pool).await.unwrap_or(0);

    // API-call reduction: an Ended series we already hold in full has no new issues to page — skip the
    // issue_list pagination (issue_count from the series detail above; status from status_str). The
    // cheap series-detail + cover calls already ran, so series-level fields are still refreshed.
    let metron_total = series_data["issue_count"].as_i64().unwrap_or(0);
    if !full_fetch && status_str == "Ended" && metron_total > 0 && local_count >= metron_total {
        log::info!("[Metadata] {} is Ended and complete ({}/{}) — skipping Metron issue fetch.", series_name, local_count, metron_total);
        // Detail enrichment still runs on this shortcut path — otherwise an Ended-and-complete
        // series could never be backfilled after the admin enables metron_detail_credits.
        // full_fetch (targeted match-time syncs) always qualifies — see the main-path gate below.
        if detail_credits || full_fetch {
            metron_detail_credits_nonfatal(db, client, &auth, series_id, series_name, file_priority).await?;
        }
        return Ok(0);
    }

    // ---- 2. All issues (follow the `next` cursor) ----
    // Incremental top-up: once we already hold issues and have a prior sync time, ask Metron for only
    // those modified since (modified_gt — per the project's API best-practices). Full walk when never
    // synced or locally empty; if Metron ignores the param it just returns everything (still correct —
    // the recency-ended check below re-bases on local data, not just this run's results).
    let mut start_url = issue_list_url.clone();
    let mut incremental = false;
    if !full_fetch && local_count > 0 {
        if let Some(since) = last_sync {
            let sep = if start_url.contains('?') { '&' } else { '?' };
            start_url = format!("{}{}modified_gt={}", start_url, sep, urlencoding::encode(since));
            incremental = true;
            log::debug!("[Metron Debug] Incremental issue fetch since {} for {}", since, series_name);
        }
    }
    let mut all_issues: Vec<serde_json::Value> = Vec::new();
    // A full walk starts from the first page already fetched for the cover; incremental walks use
    // their own modified_gt URL (the plain first page would hand back unchanged issues).
    let mut next_url = match (incremental, first_page.take()) {
        (false, Some(fp)) => {
            if let Some(arr) = fp["results"].as_array() { all_issues.extend(arr.clone()); }
            fp["next"].as_str().map(|s| s.to_string())
        }
        _ => Some(start_url),
    };
    while let Some(url) = next_url {
        let (_, data) = metron_fetch(db, client, &auth, &url, 15, 3, None).await?;
        if let Some(arr) = data["results"].as_array() {
            all_issues.extend(arr.clone());
        }
        next_url = data["next"].as_str().map(|s| s.to_string());
    }
    log::debug!("[Metron Debug] Issue walk for {} returned {} issue(s){}.", series_name, all_issues.len(), if incremental { " (incremental)" } else { "" });

    // Bool columns are CAST for the Any driver (no SQLite BOOLEAN mapping). metadataId rides
    // along for the number-anchored pairing (issue #194 (c1)).
    let existing_issues = sqlx::query(
        r#"SELECT id, number, "metadataId", CAST("hasCustomMetadata" AS INTEGER) AS "hasCustomMetadata", name, "releaseDate", CAST("hasCustomCover" AS INTEGER) AS "hasCustomCover", "coverUrl", "matchState", genres FROM "Issue" WHERE "seriesId" = $1"#,
    )
    .bind(series_id)
    .fetch_all(&db.pool)
    .await?;

    // Pairing snapshot for resolve_pair_target: (row id, number, stored metadataId).
    let pair_snapshot: Vec<(String, String, Option<String>)> = existing_issues.iter().map(|r| (
        r.get::<String, _>("id"),
        r.get::<String, _>("number"),
        r.try_get::<Option<String>, _>("metadataId").unwrap_or(None),
    )).collect();

    // Cross-series id matches only — the resolver honors them solely when the number also agrees
    // (issue #194: a global id match with a disagreeing number is a mispair, never a steal target).
    let all_meta_ids: Vec<String> = all_issues.iter()
        .filter_map(|i| i["id"].as_i64().map(|n| n.to_string()))
        .collect();
    let mut by_meta: std::collections::HashMap<String, sqlx::any::AnyRow> = std::collections::HashMap::new();
    if !all_meta_ids.is_empty() {
        let sql = format!(
            r#"SELECT id, number, name, "releaseDate", CAST("hasCustomMetadata" AS INTEGER) AS "hasCustomMetadata", "metadataId", "matchState", genres FROM "Issue" WHERE "metadataId" IN ({}) AND "metadataSource" = 'METRON' AND "seriesId" <> $1"#,
            Db::in_placeholders(2, all_meta_ids.len())
        );
        let mut q = sqlx::query(&sql).bind(series_id);
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
    // Claim set + same-batch insert-number guard (issue #194 (c1)) — one write per row per sync.
    let mut claimed: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut inserted_nums: Vec<String> = Vec::new();

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

        // Number-anchored pairing (issue #194 (c1)) — same contract as the CV branch.
        let cross = by_meta.get(&source_id).map(|r| (r.get::<String, _>("id"), r.get::<String, _>("number")));
        let target = resolve_pair_target(
            &source_id, &issue_num, &pair_snapshot,
            cross.as_ref().map(|(a, b)| (a.as_str(), b.as_str())),
            &claimed,
        );

        let (target_row, heal_id) = match &target {
            PairTarget::Update { row_id, heal_id, cross_series } => {
                if *cross_series {
                    (by_meta.get(&source_id), *heal_id)
                } else {
                    (existing_issues.iter().find(|r| &r.get::<String, _>("id") == row_id), *heal_id)
                }
            }
            PairTarget::Skip => {
                log::info!("[Metadata] Duplicate provider number #{} ({}) for {} — first listing wins, skipping.", issue_num, source_id, series_name);
                continue;
            }
            PairTarget::Insert => (None, false),
        };

        let is_locked = target_row
            .map(|r| r.try_get::<i64, _>("hasCustomMetadata").map(|v| v != 0).unwrap_or(false))
            .unwrap_or(false);
        // Healed rows treat wrong-issue fields as absent; a locked row keeps curated content.
        let reset_stale = heal_id && !is_locked;
        let (existing_name, existing_release, has_custom_cover, existing_cover) = if let Some(r) = target_row {
            (
                if reset_stale { None } else { r.try_get::<Option<String>, _>("name").unwrap_or(None) },
                if reset_stale { None } else { r.try_get::<Option<String>, _>("releaseDate").unwrap_or(None) },
                r.try_get::<i64, _>("hasCustomCover").map(|v| v != 0).unwrap_or(false),
                r.try_get::<Option<String>, _>("coverUrl").unwrap_or(None),
            )
        } else {
            (None, None, false, None)
        };

        let metron_existing_state: Option<String> = if reset_stale { None } else {
            target_row.and_then(|r| r.try_get::<Option<String>, _>("matchState").unwrap_or(None))
        };
        let match_state_val = if heal_id { "MATCHED" } else { next_match_state(metron_existing_state) };

        // Issue genres from the series-level Metron genres, fill-blank only (parity with the CV
        // volume-concepts -> issue-genres flow): locked keeps its value; an issue that already has
        // genres keeps them; only a blank column takes the series value.
        let existing_genres: Option<String> = if reset_stale { None } else {
            target_row.and_then(|r| r.try_get::<Option<String>, _>("genres").unwrap_or(None))
        };
        let genres_val: Option<String> = if is_locked {
            existing_genres
        } else if series_genres_json.is_some() && existing_genres.is_none() {
            series_genres_json.clone()
        } else {
            existing_genres
        };

        // #199 round 3: Metron list names are composites ("X-Men (1991) #154") — the shared
        // resolver lets them fill blanks but never clobber a real story title that the detail
        // pass (or a ComicInfo read) already landed. Lock + file priority unchanged.
        let name_val: Option<String> = resolve_synced_name(existing_name, Some(issue_name), &issue_num, is_locked, file_priority);
        let release_val: Option<String> = if is_locked { existing_release } else { issue_date.clone() };
        // A custom issue cover (set in the Smart Matcher) survives every sync; else the provider's wins.
        let cover_val: Option<String> = if has_custom_cover { existing_cover } else { issue_cover.clone() };

        let res = if let PairTarget::Update { row_id, cross_series, .. } = &target {
            if heal_id {
                log::info!("[Metadata] Healing issue #{} of {} — stored id disagreed with its number, re-linking to {} (issue #194).", issue_num, series_name, source_id);
            }
            let q = if is_locked {
                // Manually edited (hasCustomMetadata): heal the linkage but keep name/releaseDate/
                // description and the creator credits — only re-affirm cover + match state.
                sqlx::query(
                    r#"UPDATE "Issue" SET "seriesId"=$1, "metadataId"=$2, "metadataSource"='METRON', "coverUrl"=$3, "matchState"=$4 WHERE id=$5"#,
                )
                .bind(series_id).bind(&source_id).bind(&cover_val).bind(match_state_val).bind(row_id)
                .execute(&db.pool).await
            } else {
                // Credit columns left untouched — Metron's issue_list has no per-issue credits and a
                // literal-'[]' write would wipe ComicInfo-derived data (issue #179). The row's NUMBER
                // is never touched — it's the identity anchor, set only at insert (issue #194).
                sqlx::query(
                    r#"UPDATE "Issue" SET "seriesId"=$1, "metadataId"=$2, "metadataSource"='METRON', name=$3, "releaseDate"=$4, description=$5, "coverUrl"=$6, "matchState"=$7, genres=$8 WHERE id=$9"#,
                )
                .bind(series_id).bind(&source_id).bind(&name_val).bind(&release_val).bind(&issue_desc).bind(&cover_val).bind(match_state_val).bind(&genres_val).bind(row_id)
                .execute(&db.pool).await
            };
            if q.is_ok() {
                claimed.insert(row_id.clone());
                if *cross_series {
                    log::info!("[Metadata] Adopted issue #{} ({}) into {} from another series (id+number agree).", issue_num, source_id, series_name);
                }
            }
            q
        } else {
            if inserted_nums.iter().any(|n| is_same_issue(n, &issue_num)) {
                log::info!("[Metadata] Duplicate provider number #{} ({}) for {} — first listing wins, skipping.", issue_num, source_id, series_name);
                continue;
            }
            let new_id = uuid::Uuid::new_v4().to_string();
            let q = sqlx::query(&format!(
                r#"INSERT INTO "Issue"
                   (id, "seriesId", "metadataId", "metadataSource", number, status, name, "releaseDate", description, "coverUrl", genres, writers, artists, characters, "matchState", "createdAt", "updatedAt")
                   VALUES ($1,$2,$3,'METRON',$4,'WANTED',$5,$6,$7,$8,$9,'[]','[]','[]','MATCHED', {now}, {now})"#,
                now = db.now_expr()
            ))
            .bind(&new_id).bind(series_id).bind(&source_id).bind(&issue_num).bind(&name_val).bind(&release_val).bind(&issue_desc).bind(&issue_cover).bind(&genres_val)
            .execute(&db.pool).await;
            if q.is_ok() { inserted_nums.push(issue_num.clone()); }
            q
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
                if let Err(e) = sqlx::query(r#"UPDATE "Series" SET status='Ended' WHERE id=$1"#).bind(series_id).execute(&db.pool).await {
                    log::error!("[Metadata] Failed to mark {} as Ended: {:?}", series_name, e);
                }
                log::info!("[Metadata] Series \"{}\" marked as Ended after {}+ months without a new issue.", series_name, months);
            }
        }
    }

    // #199 round 3: a targeted (full_fetch) sync always runs the detail pass — that's the
    // match-time path, where the contract is "the right ID brings the real title + credits".
    // The metron_detail_credits opt-in still decides for the scheduled sweep, and the daily
    // budget guard inside the pass applies to both.
    if detail_credits || full_fetch {
        metron_detail_credits_nonfatal(db, client, &auth, series_id, series_name, file_priority).await?;
    }

    log::info!("[Metadata] Successfully synced {} Metron issues for {}.", synced_count, series_name);
    Ok(synced_count)
}

/// Non-fatal wrapper around metron_detail_credit_pass: only a FATAL_RATE_LIMIT (Metron has cut us
/// off — the batch must halt to protect our IP) propagates; any other error just logs, because the
/// series sync itself already succeeded and leftover issues simply retry on the next sync.
async fn metron_detail_credits_nonfatal(
    db: &Db,
    client: &Client,
    auth: &(String, String),
    series_id: &str,
    series_name: &str,
    file_priority: bool,
) -> anyhow::Result<()> {
    match metron_detail_credit_pass(db, client, auth, series_id, series_name, file_priority).await {
        Ok((enriched, deferred)) => {
            if enriched > 0 {
                log::info!(
                    "[Metadata] Enriched {} Metron issue(s) of {} with detail-call credits{}.",
                    enriched, series_name,
                    if deferred > 0 { format!(" ({} deferred on budget)", deferred) } else { String::new() }
                );
            }
            Ok(())
        }
        Err(e) => {
            if e.to_string().contains("FATAL_RATE_LIMIT") {
                return Err(e);
            }
            log::warn!("[Metadata] Metron credit enrichment for {} stopped early: {} — remaining issues retry next sync.", series_name, e);
            Ok(())
        }
    }
}

/// Per-issue Metron detail enrichment — credits AND the story title (#199 round 3), since the
/// issue_list endpoint carries neither; each issue costs one /issue/{id}/ detail call. Runs for
/// every targeted (match-time) sync, and for the scheduled sweep only when the
/// metron_detail_credits opt-in is set. Budget-gated against the
/// 5,000/day Metron window with a reserve so normal syncing never starves — issues left over stay
/// non-DEEP_SYNCED and are picked up on the next sync (same deferral model as the unmatched sweep,
/// discussion #177). Fetched credits merge through the never-wipe policy (issue #179) and the issue
/// is promoted to DEEP_SYNCED, which also stops the view-time lazy fetch from re-paying for it.
/// Returns (enriched, deferred_on_budget).
async fn metron_detail_credit_pass(
    db: &Db,
    client: &Client,
    auth: &(String, String),
    series_id: &str,
    series_name: &str,
    file_priority: bool,
) -> anyhow::Result<(usize, usize)> {
    const METRON_DAILY_LIMIT: usize = 5000;
    const METRON_RESERVE: usize = 500;

    // Locked (hasCustomMetadata) issues are excluded outright: the merge policy would keep every
    // existing column anyway, so the detail call would be a pure quota burn.
    let rows = sqlx::query(
        r#"SELECT id, "metadataId", number, name, writers, artists, "coverArtists", colorists, letterers, characters, teams, "storyArcs"
           FROM "Issue"
           WHERE "seriesId" = $1 AND "metadataSource" = 'METRON' AND "metadataId" IS NOT NULL
             AND "matchState" <> 'DEEP_SYNCED' AND CAST("hasCustomMetadata" AS INTEGER) = 0"#,
    )
    .bind(series_id)
    .fetch_all(&db.pool)
    .await?;

    if rows.is_empty() {
        return Ok((0, 0));
    }

    let mut enriched = 0usize;
    for (i, row) in rows.iter().enumerate() {
        let calls = crate::api_usage::metron_calls_last_day(&db.pool).await;
        if crate::matcher::budget_exhausted(calls, METRON_DAILY_LIMIT, METRON_RESERVE) {
            let deferred = rows.len() - i;
            log::info!("[Metadata] Metron daily budget reached ({} calls) — deferring credit enrichment for {} issue(s) of {} to the next sync.", calls, deferred, series_name);
            return Ok((enriched, deferred));
        }

        let issue_id: String = row.get("id");
        let meta_id: String = row.get("metadataId");
        let issue_num: String = row.try_get("number").unwrap_or_default();

        let url = format!("https://metron.cloud/api/issue/{}/", meta_id);
        let (status, data) = metron_fetch(db, client, auth, &url, 10, 2, None).await?;
        if status == 404 {
            // Gone from Metron — promote anyway so we never re-pay for a lookup that can't succeed.
            let _ = sqlx::query(r#"UPDATE "Issue" SET "matchState"='DEEP_SYNCED' WHERE id=$1"#)
                .bind(&issue_id).execute(&db.pool).await;
            log::debug!("[Metron Debug] Issue {} (#{}) returned 404 during credit enrichment — marked DEEP_SYNCED.", meta_id, issue_num);
            continue;
        }

        let credits = metron_issue_credits(&data);
        let col = |name: &str| -> Option<String> { row.try_get::<Option<String>, _>(name).unwrap_or(None) };
        // #199 round 3: the story title finally lands with the credits. None → COALESCE keeps
        // the current name (a detail without a real title changes nothing).
        let name_write = detail_name_write(
            col("name").as_deref(),
            metron_detail_story_title(&data),
            &issue_num,
            file_priority,
        );
        let writers_val = merge_credit_json(col("writers"), &credits.writers, false, file_priority);
        let artists_val = merge_credit_json(col("artists"), &credits.artists, false, file_priority);
        let cover_artists_val = merge_credit_json(col("coverArtists"), &credits.cover_artists, false, file_priority);
        let colorists_val = merge_credit_json(col("colorists"), &credits.colorists, false, file_priority);
        let letterers_val = merge_credit_json(col("letterers"), &credits.letterers, false, file_priority);
        let characters_val = merge_credit_json(col("characters"), &credits.characters, false, file_priority);
        let teams_val = merge_credit_json(col("teams"), &credits.teams, false, file_priority);
        let story_arcs_val = merge_credit_json(col("storyArcs"), &credits.story_arcs, false, file_priority);
        let inker_val = merge_credit_json(col("inker"), &credits.inkers, false, file_priority);
        let editor_val = merge_credit_json(col("editor"), &credits.editors, false, file_priority);
        let translator_val = merge_credit_json(col("translator"), &credits.translators, false, file_priority);

        let res = sqlx::query(
            r#"UPDATE "Issue" SET writers=$1, artists=$2, "coverArtists"=$3, colorists=$4, letterers=$5,
               characters=$6, teams=$7, "storyArcs"=$8, inker=$10, editor=$11, translator=$12,
               name=COALESCE($13, name), "matchState"='DEEP_SYNCED' WHERE id=$9"#,
        )
        .bind(&writers_val).bind(&artists_val).bind(&cover_artists_val).bind(&colorists_val)
        .bind(&letterers_val).bind(&characters_val).bind(&teams_val).bind(&story_arcs_val)
        .bind(&issue_id)
        .bind(&inker_val).bind(&editor_val).bind(&translator_val)
        .bind(&name_write)
        .execute(&db.pool).await;

        if let Err(e) = res {
            log::error!("[Metadata] Failed to write Metron detail credits for issue #{} of {}: {:?}", issue_num, series_name, e);
        } else {
            enriched += 1;
        }
    }

    Ok((enriched, 0))
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

pub(crate) async fn mark_flag(db: &Db, key: &str) {
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis().to_string()).unwrap_or_default();
    let _ = sqlx::query(
        r#"INSERT INTO "SystemSetting" (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"#,
    )
    .bind(key)
    .bind(now_ms)
    .execute(&db.pool)
    .await;
}

/// Per-issue credits and key appearances parsed from a provider issue payload (issue #179):
/// ComicVine's /issues/ list items (which return association fields when asked — zero extra API
/// calls) or Metron's /issue/{id}/ detail payload (opt-in, one call per issue).
#[derive(Default)]
pub(crate) struct CvIssueCredits {
    pub writers: Vec<String>,
    pub artists: Vec<String>,
    pub cover_artists: Vec<String>,
    pub colorists: Vec<String>,
    pub letterers: Vec<String>,
    pub characters: Vec<String>,
    pub teams: Vec<String>,
    pub locations: Vec<String>,
    /// Metron detail only — CV's list items don't carry story_arc_credits.
    pub story_arcs: Vec<String>,
    // #199 Call-3 Beta A: the last three credit roles gained per-issue columns.
    pub inkers: Vec<String>,
    pub editors: Vec<String>,
    pub translators: Vec<String>,
}

fn push_unique(vec: &mut Vec<String>, name: &str) {
    if !name.is_empty() && !vec.iter().any(|x| x == name) {
        vec.push(name.to_string());
    }
}

fn credit_names(item: &serde_json::Value, key: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(arr) = item.get(key).and_then(|v| v.as_array()) {
        for e in arr {
            if let Some(n) = e.get("name").and_then(|v| v.as_str()) {
                push_unique(&mut out, n);
            }
        }
    }
    out
}

/// Provider name-array -> JSON array string for a genres-style column (issue #180):
/// [{"name": "Super-Hero"}, ...] -> Some("[\"Super-Hero\",...]"). Absent/empty/name-less entries
/// -> None, so a blank column stays NULL (never a literal '[]').
fn names_json(item: &serde_json::Value, key: &str) -> Option<String> {
    let names = credit_names(item, key);
    if names.is_empty() { None } else { serde_json::to_string(&names).ok() }
}

/// Role taxonomy is exact parity with Node's parseComicVineCredits (src/lib/utils.ts): one person
/// can land in several buckets ("penciler, inker" → artists; "writer" + "cover" → both), and names
/// dedup per bucket preserving first-seen order.
pub(crate) fn cv_issue_credits(item: &serde_json::Value) -> CvIssueCredits {
    let mut c = CvIssueCredits::default();
    if let Some(pc) = item.get("person_credits").and_then(|v| v.as_array()) {
        for p in pc {
            let role = p.get("role").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if role.contains("writer") || role.contains("script") || role.contains("plot") || role.contains("story") { push_unique(&mut c.writers, name); }
            // #199 Call-3 Beta A: inkers split out of the Penciller bucket (parity with Node's
            // parseComicVineCredits) — double-filing would double-credit them on the next embed.
            if role.contains("pencil") || role.contains("artist") || role.contains("illustrator") { push_unique(&mut c.artists, name); }
            if role.contains("ink") { push_unique(&mut c.inkers, name); }
            if role.contains("edit") { push_unique(&mut c.editors, name); }
            if role.contains("translat") { push_unique(&mut c.translators, name); }
            if role.contains("cover") { push_unique(&mut c.cover_artists, name); }
            if role.contains("color") { push_unique(&mut c.colorists, name); }
            if role.contains("letter") { push_unique(&mut c.letterers, name); }
        }
    }
    c.characters = credit_names(item, "character_credits");
    c.teams = credit_names(item, "team_credits");
    c.locations = credit_names(item, "location_credits");
    c
}

/// Per-issue credits parsed from a Metron ISSUE DETAIL payload (/issue/{id}/ — the issue_list
/// endpoint carries no credits at all). Role taxonomy is exact parity with Node's
/// MetronProvider.getIssueDetails: substring match on each role name, one creator can land in
/// several buckets, names dedup per bucket preserving first-seen order.
pub(crate) fn metron_issue_credits(item: &serde_json::Value) -> CvIssueCredits {
    let mut c = CvIssueCredits::default();
    if let Some(credits) = item.get("credits").and_then(|v| v.as_array()) {
        for cr in credits {
            let name = cr.get("creator")
                .map(|v| v.get("name").and_then(|n| n.as_str()).or_else(|| v.as_str()).unwrap_or(""))
                .unwrap_or("");
            let roles: Vec<String> = match cr.get("role") {
                Some(serde_json::Value::Array(arr)) => arr.iter()
                    .map(|r| r.get("name").and_then(|n| n.as_str()).or_else(|| r.as_str()).unwrap_or("").to_lowercase())
                    .collect(),
                Some(serde_json::Value::String(s)) => vec![s.to_lowercase()],
                _ => Vec::new(),
            };
            let has = |needle: &str| roles.iter().any(|r| r.contains(needle));
            if has("writer") { push_unique(&mut c.writers, name); }
            // #199 Call-3 Beta A: inker split (parity with Node's MetronProvider.getIssueDetails).
            if has("artist") || has("penciller") { push_unique(&mut c.artists, name); }
            if has("inker") { push_unique(&mut c.inkers, name); }
            if has("editor") { push_unique(&mut c.editors, name); }
            if has("translator") { push_unique(&mut c.translators, name); }
            if has("cover") { push_unique(&mut c.cover_artists, name); }
            if has("color") { push_unique(&mut c.colorists, name); }
            if has("letter") { push_unique(&mut c.letterers, name); }
        }
    }
    c.characters = credit_names(item, "characters");
    c.teams = credit_names(item, "teams");
    c.story_arcs = credit_names(item, "arcs");
    c
}

/// Which DB row a provider issue should land on (issue #194 (c1) pairing rewrite).
#[derive(Debug, PartialEq)]
pub(crate) enum PairTarget {
    /// Update this row. `heal_id` = the row's stored metadataId was absent or WRONG and must be
    /// (re)written — the caller then also drops DEEP_SYNCED (its deep data belonged to the old id)
    /// and resets provider-refreshable fields instead of merging with wrong-issue leftovers.
    Update { row_id: String, heal_id: bool, cross_series: bool },
    /// No consistent candidate — insert a fresh row.
    Insert,
    /// Every consistent candidate is already claimed by an earlier provider issue this pass
    /// (e.g. a duplicate issue number in the provider listing) — skip, first listing wins.
    Skip,
}

/// Number-anchored pairing (issue #194): within a series, the row's `number` is the identity
/// anchor and the stored provider id is a cache that must AGREE with it. Resolution order:
///   1. in-series row whose stored id matches AND whose number agrees  (already correct)
///   2. in-series row whose number agrees                              (heals a missing/wrong id)
///   3. cross-series row whose stored id matches AND number agrees     (legit adoption: e.g. a
///      request-created skeleton that predates this series)
///   4. Insert
///
/// An id-match with a DISAGREEING number is never honored — that row is mispaired and its own
/// number pairs it correctly later in the pass. This is what lets a crossed library (issue 1
/// wearing issue 4's id) self-heal on the next sync, order-independently. `claimed` guarantees
/// at most one write per row per pass.
pub(crate) fn resolve_pair_target(
    provider_id: &str,
    provider_num: &str,
    in_series: &[(String, String, Option<String>)], // (row id, number, stored metadataId)
    cross_series: Option<(&str, &str)>,             // (row id, number) for a global id match OUTSIDE the series
    claimed: &std::collections::HashSet<String>,
) -> PairTarget {
    // 1. Consistent in-series id match.
    if let Some((rid, _, _)) = in_series.iter().find(|(rid, num, mid)| {
        mid.as_deref() == Some(provider_id) && is_same_issue(num, provider_num) && !claimed.contains(rid)
    }) {
        return PairTarget::Update { row_id: rid.clone(), heal_id: false, cross_series: false };
    }
    // 2. Number match — the heal path. heal_id when the stored id differs (or is absent/unmatched).
    if let Some((rid, _, mid)) = in_series.iter().find(|(rid, num, _)| {
        is_same_issue(num, provider_num) && !claimed.contains(rid)
    }) {
        let heal = mid.as_deref() != Some(provider_id);
        return PairTarget::Update { row_id: rid.clone(), heal_id: heal, cross_series: false };
    }
    // A number match existed but was claimed → duplicate provider number, first listing wins.
    if in_series.iter().any(|(_, num, _)| is_same_issue(num, provider_num)) {
        return PairTarget::Skip;
    }
    // 3. Cross-series adoption, only when id AND number agree.
    if let Some((rid, num)) = cross_series {
        if is_same_issue(num, provider_num) && !claimed.contains(rid) {
            return PairTarget::Update { row_id: rid.to_string(), heal_id: false, cross_series: true };
        }
    }
    PairTarget::Insert
}

/// Match-state a sync upsert should write: an issue the view-time lazy enrichment already deep-
/// fetched keeps DEEP_SYNCED (so it is never redundantly re-fetched); everything else lands on
/// MATCHED as before (issue #179).
pub(crate) fn next_match_state(existing: Option<String>) -> &'static str {
    if existing.as_deref() == Some("DEEP_SYNCED") { "DEEP_SYNCED" } else { "MATCHED" }
}

/// Column-write policy for provider credit syncs (issue #179): a locked (hasCustomMetadata) issue
/// keeps its value; an unlocked issue takes the provider's list only when the provider actually
/// supplied one. An empty fetch NEVER overwrites existing data — the literal-'[]' writes this
/// replaces destroyed ComicInfo.xml-derived credits on every re-sync.
pub(crate) fn merge_credit_json(existing: Option<String>, fetched: &[String], locked: bool, fill_only: bool) -> Option<String> {
    if locked || fetched.is_empty() {
        return existing;
    }
    // file_metadata_priority (discussion #177): provider data only FILLS blanks — a non-empty
    // existing value (ComicInfo/series.json-derived or manual) is never replaced.
    let existing_has_data = existing.as_deref().map(|e| !e.trim().is_empty() && e.trim() != "[]").unwrap_or(false);
    if fill_only && existing_has_data {
        return existing;
    }
    serde_json::to_string(fetched).ok().or(existing)
}

/// Narrative-field write policy: locked keeps existing; file_metadata_priority keeps a non-empty
/// existing value; otherwise the provider's value applies (exact legacy semantics when fill_only=false).
fn prefer_existing(existing: Option<String>, provider: Option<String>, locked: bool, fill_only: bool) -> Option<String> {
    if locked {
        return existing;
    }
    let has = existing.as_deref().map(|e| !e.trim().is_empty()).unwrap_or(false);
    if fill_only && has { existing } else { provider }
}

/// True for an "Issue 154" / "Issue #154" placeholder, any number — the matcher's insert
/// default and Metron's list fallback both produce these, and they carry no story information.
/// A "number-ish" char for generic-name detection: digits, dots, and the vulgar fractions the
/// number pipeline understands (issue #200 — "#½" is a real issue number).
fn numberish(c: char) -> bool {
    c.is_ascii_digit() || c == '.' || c == '½' || c == '¼' || c == '¾'
}

fn issue_placeholder(name: &str) -> bool {
    let rest = match name.get(..5) {
        Some(p) if p.eq_ignore_ascii_case("issue") => name[5..].trim_start(),
        _ => return false,
    };
    let digits = rest.strip_prefix('#').unwrap_or(rest).trim_start();
    !digits.is_empty() && digits.chars().all(numberish)
}

/// #199 round 3: true for names that carry no story information for this row — empty, an
/// "Issue N" placeholder, or a name that merely ENDS with this row's own "#154" (bare or the
/// list composite "X-Men (1991) #154"). A story suffix ("… #154: Lifedeath") is NOT generic.
/// EXACT twin: src/lib/utils/synced-name.ts syncedNameIsGeneric.
fn synced_name_is_generic(name: &str, number: &str) -> bool {
    let n = name.trim();
    if n.is_empty() {
        return true;
    }
    if issue_placeholder(n) {
        return true;
    }
    if let Some(idx) = n.rfind('#') {
        let tail = n[idx + 1..].trim();
        if !tail.is_empty() && tail.chars().all(numberish) && is_same_issue(tail, number) {
            return true;
        }
    }
    false
}

/// #199 round 3: what a LIST sync writes into Issue.name. The Issue.name column holds the raw
/// STORY TITLE (ComicVine's list supplies exactly that), but Metron's issue_list has no story
/// titles — its names are composites, which may fill blanks or replace another generic but
/// must never clobber a real title the detail pass (or a ComicInfo read) already landed.
/// An empty provider name never blanks an existing one (never-wipe, issue #179).
/// EXACT twin: src/lib/utils/synced-name.ts resolveSyncedName.
fn resolve_synced_name(
    existing: Option<String>,
    incoming: Option<String>,
    number: &str,
    locked: bool,
    fill_only: bool,
) -> Option<String> {
    if locked {
        return existing;
    }
    let ex_has = existing.as_deref().map(|e| !e.trim().is_empty()).unwrap_or(false);
    if fill_only && ex_has {
        return existing;
    }
    let inc = match incoming.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => s.to_string(),
        None => return existing,
    };
    if ex_has
        && synced_name_is_generic(&inc, number)
        && !synced_name_is_generic(existing.as_deref().unwrap_or(""), number)
    {
        return existing;
    }
    Some(inc)
}

/// #199 round 3: what the Metron DETAIL pass writes into Issue.name — None means "leave the
/// column alone" (bound through COALESCE). The detail payload is the issue's own id-verified
/// record, so its story title beats a list composite or placeholder; only file priority
/// protecting a REAL existing title (not a placeholder it should be rescuing) stops the write.
/// Locked rows never reach the detail pass. EXACT twin: synced-name.ts detailNameWrite.
fn detail_name_write(
    existing: Option<&str>,
    story_title: Option<String>,
    number: &str,
    fill_only: bool,
) -> Option<String> {
    let story = story_title.as_deref().map(str::trim).filter(|s| !s.is_empty())?.to_string();
    let ex_has = existing.map(|e| !e.trim().is_empty()).unwrap_or(false);
    if fill_only && ex_has && !synced_name_is_generic(existing.unwrap_or(""), number) {
        return None;
    }
    Some(story)
}

/// Story title from a Metron /issue/{id}/ detail payload: `title`, else the first entry of the
/// `name` array (Metron's story-name list), else a plain-string `name`. Placeholders
/// ("Issue 154") and empties yield None. Parity: MetronProvider.getIssueDetails storyTitle.
fn metron_detail_story_title(data: &serde_json::Value) -> Option<String> {
    data["title"]
        .as_str()
        .or_else(|| data["name"].as_array().and_then(|a| a.first()).and_then(|v| v.as_str()))
        .or_else(|| data["name"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && !issue_placeholder(s))
        .map(str::to_string)
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
/// Issue #200: ComicVine numbers half-issues with Unicode vulgar fractions ("½"), invisible to
/// every digit-based rule. Rewrite them as decimals — merged with a glued preceding integer, so
/// "1½" reads 1.5 — before any parse or comparison. Parity twin: issue-parser.ts
/// normalizeFractionNumbers. Conservative set: the three fractions comic numbering actually uses.
pub(crate) fn normalize_fraction_numbers(s: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(\d+)?([½¼¾])").unwrap());
    re.replace_all(s, |c: &regex::Captures| {
        let int = c.get(1).map(|m| m.as_str()).unwrap_or("0");
        let frac = match c.get(2).map(|m| m.as_str()) {
            Some("½") => ".5",
            Some("¼") => ".25",
            Some("¾") => ".75",
            _ => "",
        };
        format!("{int}{frac}")
    }).into_owned()
}

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
    let (n1, s1) = parse_issue(&normalize_fraction_numbers(a));
    let (n2, s2) = parse_issue(&normalize_fraction_numbers(b));
    n1 == n2 && s1 == s2
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==== Issue #194: two concurrent syncs of the same series interleave non-idempotent issue
    // upserts and can cross-pair rows — the in-flight claim makes the later trigger skip. ====

    #[test]
    fn sync_claim_blocks_second_acquire_until_dropped() {
        let claim = SyncClaim::try_acquire("claim-test-194");
        assert!(claim.is_some());
        // A second trigger while the first is in flight is refused…
        assert!(SyncClaim::try_acquire("claim-test-194").is_none());
        // …an unrelated series is unaffected…
        assert!(SyncClaim::try_acquire("claim-test-other").is_some());
        // …and dropping the claim frees the series for the next legitimate sync.
        drop(claim);
        assert!(SyncClaim::try_acquire("claim-test-194").is_some());
    }

    // ==== Discussion #182: the scheduled sync must skip series whose FILES already supplied
    // everything (description + every owned issue DEEP_SYNCED) — zero recurring API cost for a
    // fully-tagged library. Exercised against a real in-memory pool because the predicate is
    // correlated-subquery SQL, not Rust logic.

    #[tokio::test]
    async fn file_complete_predicate_excludes_only_fully_tagged_series() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(sqlx::any::install_default_drivers);
        let pool = sqlx::any::AnyPoolOptions::new()
            .max_connections(1) // each :memory: connection is its own DB — keep exactly one
            .connect("sqlite::memory:").await.unwrap();
        sqlx::query(r#"CREATE TABLE "Series" (id TEXT PRIMARY KEY, description TEXT, "metadataId" TEXT)"#)
            .execute(&pool).await.unwrap();
        sqlx::query(r#"CREATE TABLE "Issue" (id TEXT PRIMARY KEY, "seriesId" TEXT, "filePath" TEXT, "matchState" TEXT)"#)
            .execute(&pool).await.unwrap();

        // s1: file-complete (description + every OWNED issue DEEP_SYNCED)     → skipped.
        // s2: an owned issue still only MATCHED                               → keeps syncing.
        // s3: description but zero owned issues (WANTED skeletons only)       → keeps syncing.
        // s4: issues complete but NO description                              → keeps syncing.
        for (id, desc) in [("s1", Some("d")), ("s2", Some("d")), ("s3", Some("d")), ("s4", None::<&str>)] {
            sqlx::query(r#"INSERT INTO "Series" (id, description, "metadataId") VALUES ($1, $2, '123')"#)
                .bind(id).bind(desc).execute(&pool).await.unwrap();
        }
        for (id, sid, fp, ms) in [
            ("i1", "s1", Some("/a.cbz"), "DEEP_SYNCED"),
            ("i2", "s1", Some("/b.cbz"), "DEEP_SYNCED"),
            ("i3", "s2", Some("/c.cbz"), "MATCHED"),
            ("i4", "s3", None::<&str>, "MATCHED"),
            ("i5", "s4", Some("/d.cbz"), "DEEP_SYNCED"),
        ] {
            sqlx::query(r#"INSERT INTO "Issue" (id, "seriesId", "filePath", "matchState") VALUES ($1, $2, $3, $4)"#)
                .bind(id).bind(sid).bind(fp).bind(ms).execute(&pool).await.unwrap();
        }

        let sql = format!(
            r#"SELECT id FROM "Series" WHERE "metadataId" IS NOT NULL AND NOT {} ORDER BY id"#,
            file_complete_predicate()
        );
        let rows = sqlx::query(&sql).fetch_all(&pool).await.unwrap();
        let ids: Vec<String> = rows.iter().map(|r| r.get::<String, _>("id")).collect();
        assert_eq!(ids, vec!["s2", "s3", "s4"], "only s1 is file-complete");
    }

    // ==== 2026-07-26 (worklist item 10 follow-up): the Ended-complete skip must not hide series
    // whose rows were born from files and never provider-paired — this predicate is the gate.
    // SQL-level test (same rationale as the file_complete test above): LIKE-escape correctness
    // is dialect behavior, not Rust logic.

    #[tokio::test]
    async fn unenriched_predicate_counts_only_unpaired_rows() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(sqlx::any::install_default_drivers);
        let pool = sqlx::any::AnyPoolOptions::new()
            .max_connections(1) // each :memory: connection is its own DB — keep exactly one
            .connect("sqlite::memory:").await.unwrap();
        sqlx::query(r#"CREATE TABLE "Issue" (id TEXT PRIMARY KEY, "seriesId" TEXT, "metadataId" TEXT)"#)
            .execute(&pool).await.unwrap();

        for (id, sid, mid) in [
            ("i1", "s1", Some("4000-123")),        // provider-paired → not counted
            ("i2", "s1", Some("unmatched_abc")),   // scanner-born → counted
            ("i3", "s1", None::<&str>),            // never linked at all → counted
            ("i4", "s1", Some("unmatchedZ99")),    // no literal underscore → must NOT match the escaped pattern
            ("i5", "s2", Some("unmatched_other")), // other series → excluded by the caller's seriesId filter
        ] {
            sqlx::query(r#"INSERT INTO "Issue" (id, "seriesId", "metadataId") VALUES ($1, $2, $3)"#)
                .bind(id).bind(sid).bind(mid).execute(&pool).await.unwrap();
        }

        let sql = format!(
            r#"SELECT COUNT(*) FROM "Issue" WHERE "seriesId" = $1 AND {}"#,
            unenriched_issue_predicate()
        );
        let n: i64 = sqlx::query_scalar(&sql).bind("s1").fetch_one(&pool).await.unwrap();
        assert_eq!(n, 2, "exactly the scanner-born and NULL rows count as unenriched");
    }

    // ==== Rate-limit halt retry plan: the series that hit the limit plus everything after it in
    // the batch re-queue, capped at MAX_RATE_LIMIT_RETRIES attempts.

    #[test]
    fn plan_rate_limit_retry_returns_tail_from_halted_series() {
        let ids: Vec<String> = ["a", "b", "c", "d"].iter().map(|s| s.to_string()).collect();
        assert_eq!(plan_rate_limit_retry(&ids, 2, 0), Some(vec!["c".to_string(), "d".to_string()]));
        assert_eq!(plan_rate_limit_retry(&ids, 0, 1), Some(ids.clone()));
        assert_eq!(plan_rate_limit_retry(&ids, 3, 0), Some(vec!["d".to_string()]));
    }

    #[test]
    fn plan_rate_limit_retry_gives_up_at_cap_and_out_of_range() {
        let ids: Vec<String> = ["a", "b"].iter().map(|s| s.to_string()).collect();
        assert_eq!(plan_rate_limit_retry(&ids, 0, MAX_RATE_LIMIT_RETRIES), None);
        assert_eq!(plan_rate_limit_retry(&ids, 5, 0), None);
        assert_eq!(plan_rate_limit_retry(&[], 0, 0), None);
    }

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
    fn is_same_issue_handles_vulgar_fractions() {
        // Issue #200: CV numbers half-issues "½" (X-Men (1991) "Thrall"); files say "0.5".
        // Mirrors the Node #200 block in issue-parser.test.ts.
        assert!(is_same_issue("½", "0.5"));
        assert!(is_same_issue("½", ".5"));
        assert!(is_same_issue("½", "½"));
        assert!(is_same_issue("1½", "1.5"));
        assert!(is_same_issue("¼", "0.25"));
        assert!(!is_same_issue("½", "1"));
        assert!(!is_same_issue("½", "0.25"));
    }

    #[test]
    fn normalize_fraction_numbers_rewrites_decimals() {
        assert_eq!(normalize_fraction_numbers("½"), "0.5");
        assert_eq!(normalize_fraction_numbers("1½"), "1.5"); // Wizard #1½ is a real comic
        assert_eq!(normalize_fraction_numbers("¾"), "0.75");
        assert_eq!(normalize_fraction_numbers("X-Men #½ (1998)"), "X-Men #0.5 (1998)");
        assert_eq!(normalize_fraction_numbers("no fractions 12.5"), "no fractions 12.5");
    }

    // ==== Issue #194 (c1): number-anchored pairing resolver ====

    fn snap(rows: &[(&str, &str, Option<&str>)]) -> Vec<(String, String, Option<String>)> {
        rows.iter().map(|(a, b, c)| (a.to_string(), b.to_string(), c.map(|s| s.to_string()))).collect()
    }

    #[test]
    fn pairing_heals_crossed_ids_in_both_orders() {
        // The field case: row "1" wears issue 4's id (821401); row "4" has none.
        let rows = snap(&[("r1", "1", Some("821401")), ("r4", "4", None)]);
        let none: std::collections::HashSet<String> = Default::default();

        // cv#1 (819000) pairs to r1 by NUMBER, healing the wrong id…
        assert_eq!(
            resolve_pair_target("819000", "1", &rows, None, &none),
            PairTarget::Update { row_id: "r1".into(), heal_id: true, cross_series: false }
        );
        // …and cv#4 (821401) must NOT honor r1's wrong id — r4 wins by number.
        assert_eq!(
            resolve_pair_target("821401", "4", &rows, None, &none),
            PairTarget::Update { row_id: "r4".into(), heal_id: true, cross_series: false }
        );
        // Order independence: with r1 already claimed by cv#1, cv#4 still lands on r4.
        let mut claimed = std::collections::HashSet::new();
        claimed.insert("r1".to_string());
        assert_eq!(
            resolve_pair_target("821401", "4", &rows, None, &claimed),
            PairTarget::Update { row_id: "r4".into(), heal_id: true, cross_series: false }
        );
    }

    #[test]
    fn pairing_prefers_consistent_id_and_pads_are_equal() {
        let rows = snap(&[("r1", "1", Some("819000"))]);
        assert_eq!(
            resolve_pair_target("819000", "001", &rows, None, &Default::default()),
            PairTarget::Update { row_id: "r1".into(), heal_id: false, cross_series: false }
        );
    }

    #[test]
    fn pairing_unlinked_row_heals_by_number() {
        let rows = snap(&[("r2", "2", None)]);
        assert_eq!(
            resolve_pair_target("555", "2", &rows, None, &Default::default()),
            PairTarget::Update { row_id: "r2".into(), heal_id: true, cross_series: false }
        );
    }

    #[test]
    fn pairing_duplicate_provider_number_skips_after_claim() {
        let rows = snap(&[("r1", "1", None)]);
        let mut claimed = std::collections::HashSet::new();
        claimed.insert("r1".to_string());
        assert_eq!(resolve_pair_target("900", "1", &rows, None, &claimed), PairTarget::Skip);
    }

    #[test]
    fn pairing_cross_series_requires_number_agreement() {
        let rows = snap(&[]);
        // id AND number agree → legit adoption (request skeleton predating the series).
        assert_eq!(
            resolve_pair_target("819000", "1", &rows, Some(("other", "1")), &Default::default()),
            PairTarget::Update { row_id: "other".into(), heal_id: false, cross_series: true }
        );
        // Disagreeing number → that row is mispaired garbage, never stolen: insert fresh.
        assert_eq!(
            resolve_pair_target("819000", "1", &rows, Some(("other", "4")), &Default::default()),
            PairTarget::Insert
        );
    }

    // ==== Issue #179: per-issue credits/appearances from the ComicVine ISSUE LIST response. ====

    #[test]
    fn cv_issue_credits_parses_roles_and_appearances() {
        let issue = serde_json::json!({
            "person_credits": [
                {"name": "Chip Zdarsky", "role": "writer"},
                {"name": "Marco Checchetto", "role": "penciler, inker"},
                {"name": "Frank Martin", "role": "colorist"},
                {"name": "Clayton Cowles", "role": "letterer"},
                {"name": "John Romita Jr.", "role": "cover"},
                {"name": "Devin Lewis", "role": "editor"},
                {"name": "Chip Zdarsky", "role": "script"}
            ],
            "character_credits": [ {"name": "Daredevil"}, {"name": "Kingpin"} ],
            "team_credits": [ {"name": "The Hand"} ],
            "location_credits": [ {"name": "Hell's Kitchen"} ]
        });

        let c = cv_issue_credits(&issue);
        // Role taxonomy is exact parity with Node parseComicVineCredits (utils.ts); a duplicated
        // name across matching roles ("writer" + "script") dedups within the bucket.
        assert_eq!(c.writers, vec!["Chip Zdarsky"]);
        // Call-3 Beta A: "penciler, inker" lands the person in BOTH buckets — penciller work stays
        // in artists, ink work now files under the issue's own inker column.
        assert_eq!(c.artists, vec!["Marco Checchetto"]);
        assert_eq!(c.inkers, vec!["Marco Checchetto"]);
        assert_eq!(c.editors, vec!["Devin Lewis"]);
        assert!(c.translators.is_empty());
        assert_eq!(c.cover_artists, vec!["John Romita Jr."]);
        assert_eq!(c.colorists, vec!["Frank Martin"]);
        assert_eq!(c.letterers, vec!["Clayton Cowles"]);
        assert_eq!(c.characters, vec!["Daredevil", "Kingpin"]);
        assert_eq!(c.teams, vec!["The Hand"]);
        assert_eq!(c.locations, vec!["Hell's Kitchen"]);

        // A list item without credit fields (endpoint didn't return them) parses to all-empty —
        // which the merge policy below treats as "don't touch the existing columns".
        let empty = cv_issue_credits(&serde_json::json!({"id": 1, "issue_number": "3"}));
        assert!(empty.writers.is_empty() && empty.artists.is_empty() && empty.characters.is_empty());
        assert!(empty.teams.is_empty() && empty.locations.is_empty());
    }

    #[test]
    fn metron_issue_credits_parses_detail_payload() {
        // Shape of Metron's /issue/{id}/ detail response: credits carry a creator object and a
        // role ARRAY of {id, name}; appearances are name-object arrays.
        let issue = serde_json::json!({
            "credits": [
                {"creator": {"name": "Chip Zdarsky"}, "role": [{"id": 1, "name": "Writer"}]},
                {"creator": {"name": "Marco Checchetto"}, "role": [{"id": 2, "name": "Penciller"}, {"id": 3, "name": "Inker"}]},
                {"creator": {"name": "Frank Martin"}, "role": [{"id": 4, "name": "Colorist"}]},
                {"creator": {"name": "Clayton Cowles"}, "role": [{"id": 5, "name": "Letterer"}]},
                {"creator": {"name": "John Romita Jr."}, "role": [{"id": 6, "name": "Cover"}]},
                {"creator": {"name": "Devin Lewis"}, "role": [{"id": 7, "name": "Editor"}]}
            ],
            "characters": [ {"name": "Daredevil"}, {"name": "Kingpin"} ],
            "teams": [ {"name": "The Hand"} ],
            "arcs": [ {"name": "Devil's Reign"} ]
        });

        let c = metron_issue_credits(&issue);
        assert_eq!(c.writers, vec!["Chip Zdarsky"]);
        // Call-3 Beta A: Penciller stays in artists, Inker files under the issue's own column.
        assert_eq!(c.artists, vec!["Marco Checchetto"]);
        assert_eq!(c.inkers, vec!["Marco Checchetto"]);
        assert_eq!(c.editors, vec!["Devin Lewis"]);
        assert!(c.translators.is_empty());
        assert_eq!(c.cover_artists, vec!["John Romita Jr."]);
        assert_eq!(c.colorists, vec!["Frank Martin"]);
        assert_eq!(c.letterers, vec!["Clayton Cowles"]);
        assert_eq!(c.characters, vec!["Daredevil", "Kingpin"]);
        assert_eq!(c.teams, vec!["The Hand"]);
        assert_eq!(c.story_arcs, vec!["Devil's Reign"]);
        assert!(!c.writers.contains(&"Devin Lewis".to_string()));

        // Bodyless/creditless payload (e.g. after a 404-guard slip) parses to all-empty, which
        // merge_credit_json treats as "leave the existing columns alone".
        let empty = metron_issue_credits(&serde_json::json!({"id": 9, "number": "3"}));
        assert!(empty.writers.is_empty() && empty.artists.is_empty() && empty.story_arcs.is_empty());
    }

    #[test]
    fn names_json_maps_provider_name_arrays() {
        // Metron series genres: [{"name": "Super-Hero"}, ...] → JSON array string (issue #180).
        let metron = serde_json::json!({"genres": [{"name": "Super-Hero"}, {"name": "Action"}, {"name": "Super-Hero"}]});
        assert_eq!(names_json(&metron, "genres"), Some(r#"["Super-Hero","Action"]"#.to_string()));

        // Absent field / empty array / names-less entries → None (never a literal "[]").
        assert_eq!(names_json(&serde_json::json!({"id": 1}), "genres"), None);
        assert_eq!(names_json(&serde_json::json!({"genres": []}), "genres"), None);
        assert_eq!(names_json(&serde_json::json!({"genres": [{"id": 5}]}), "genres"), None);
    }

    #[test]
    fn iso_to_http_date_formats_for_if_modified_since() {
        // lastMetadataSync arrives as ISO (with either 'T' or space, optionally fractional/Z);
        // the If-Modified-Since header requires an RFC 7231 IMF-fixdate in GMT.
        assert_eq!(iso_to_http_date("2026-07-10T12:34:56"), Some("Fri, 10 Jul 2026 12:34:56 GMT".to_string()));
        assert_eq!(iso_to_http_date("2026-07-10 12:34:56"), Some("Fri, 10 Jul 2026 12:34:56 GMT".to_string()));
        assert_eq!(iso_to_http_date("2026-07-10T12:34:56.789Z"), Some("Fri, 10 Jul 2026 12:34:56 GMT".to_string()));
        // Unparseable input → no header rather than a bogus one.
        assert_eq!(iso_to_http_date("not a date"), None);
        assert_eq!(iso_to_http_date(""), None);
    }

    #[test]
    fn next_match_state_preserves_deep_synced() {
        // The view-time lazy enrichment (library/issue route) marks an issue DEEP_SYNCED after its
        // per-issue detail fetch. A scheduled sync must NOT downgrade that back to MATCHED — doing so
        // re-triggers the deep fetch on every subsequent view, burning ComicVine's 200/hr budget on
        // issues that were already fully enriched (issue #179).
        assert_eq!(next_match_state(Some("DEEP_SYNCED".to_string())), "DEEP_SYNCED");
        assert_eq!(next_match_state(Some("MATCHED".to_string())), "MATCHED");
        assert_eq!(next_match_state(Some("UNMATCHED".to_string())), "MATCHED");
        assert_eq!(next_match_state(None), "MATCHED");
    }

    #[test]
    fn merge_credit_json_never_clobbers_existing_with_empty() {
        let existing = Some(r#"["From ComicInfo.xml"]"#.to_string());

        // Unlocked + provider supplied data → provider wins (normal sync semantics).
        assert_eq!(
            merge_credit_json(existing.clone(), &["A".to_string(), "B".to_string()], false, false),
            Some(r#"["A","B"]"#.to_string())
        );
        // Unlocked + provider has NOTHING → keep what we have. This is the '[]' wipe from
        // issue #179: a re-sync must never destroy ComicInfo-derived or manually added credits.
        assert_eq!(merge_credit_json(existing.clone(), &[], false, false), existing);
        // Locked (hasCustomMetadata) → existing always wins, even against provider data.
        assert_eq!(merge_credit_json(existing.clone(), &["A".to_string()], true, false), existing);
        // Nothing anywhere → stays NULL (never write a literal '[]').
        assert_eq!(merge_credit_json(None, &[], false, false), None);
    }

    #[test]
    fn merge_credit_json_fill_only_prefers_file_metadata() {
        // Discussion #177: with file_metadata_priority ON, provider syncs only FILL blanks —
        // ComicInfo-derived values are never replaced unless the admin refreshes deliberately.
        let existing = Some(r#"["From ComicInfo.xml"]"#.to_string());

        // fill_only + existing non-empty → existing wins even against provider data.
        assert_eq!(merge_credit_json(existing.clone(), &["Provider".to_string()], false, true), existing);
        // fill_only + genuinely blank (NULL or the legacy literal '[]') → provider fills.
        assert_eq!(
            merge_credit_json(None, &["Provider".to_string()], false, true),
            Some(r#"["Provider"]"#.to_string())
        );
        assert_eq!(
            merge_credit_json(Some("[]".to_string()), &["Provider".to_string()], false, true),
            Some(r#"["Provider"]"#.to_string())
        );
        // fill_only + provider empty → keep existing (both protections compose).
        assert_eq!(merge_credit_json(existing.clone(), &[], false, true), existing);
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

    // ==== #199 round 3: story titles must survive list syncs (Metron's issue_list only has
    // composites), and the detail pass must land them in the first place. Twin tests:
    // __tests__/lib/utils/synced-name.test.ts. ====

    #[test]
    fn synced_name_generic_detection() {
        // Placeholders and composites carry no story information for the row…
        assert!(synced_name_is_generic("", "154"));
        assert!(synced_name_is_generic("Issue 154", "154"));
        assert!(synced_name_is_generic("Issue #7", "154")); // any number — a stale placeholder is junk
        assert!(synced_name_is_generic("#154", "154"));
        assert!(synced_name_is_generic("X-Men (1991) #154", "154"));
        assert!(synced_name_is_generic("X-Men (1991) #0154", "154")); // padding-insensitive pairing
        assert!(synced_name_is_generic("Wizard #½", "0.5")); // fraction numbers count too (#200)
        // …a real title, or a composite WITH a story suffix, does.
        assert!(!synced_name_is_generic("Lifedeath", "154"));
        assert!(!synced_name_is_generic("X-Men (1991) #154: Lifedeath", "154"));
        // A different trailing number is not THIS row's composite.
        assert!(!synced_name_is_generic("Uncanny X-Men #500", "154"));
    }

    #[test]
    fn resolve_synced_name_protects_real_titles() {
        let ex = Some("Lifedeath".to_string());
        // A Metron list composite may not clobber a detail-fetched story title…
        assert_eq!(resolve_synced_name(ex.clone(), Some("X-Men (1991) #154".into()), "154", false, false), ex);
        // …but it fills a blank, replaces a placeholder, and a REAL provider title still wins.
        assert_eq!(
            resolve_synced_name(None, Some("X-Men (1991) #154".into()), "154", false, false),
            Some("X-Men (1991) #154".into())
        );
        assert_eq!(
            resolve_synced_name(Some("Issue 154".into()), Some("X-Men (1991) #154".into()), "154", false, false),
            Some("X-Men (1991) #154".into())
        );
        assert_eq!(
            resolve_synced_name(ex.clone(), Some("Lifedeath (Part I)".into()), "154", false, false),
            Some("Lifedeath (Part I)".into())
        );
        // Provider nothing never blanks a name (never-wipe, issue #179).
        assert_eq!(resolve_synced_name(ex.clone(), None, "154", false, false), ex);
        assert_eq!(resolve_synced_name(ex.clone(), Some("  ".into()), "154", false, false), ex);
        // Lock and file-priority outrank everything.
        assert_eq!(resolve_synced_name(ex.clone(), Some("Provider".into()), "154", true, false), ex);
        assert_eq!(resolve_synced_name(ex.clone(), Some("Provider".into()), "154", false, true), ex);
    }

    #[test]
    fn detail_name_write_lands_and_respects_file_priority() {
        // The detail story title lands over a blank, a placeholder, or a list composite…
        assert_eq!(detail_name_write(None, Some("Lifedeath".into()), "154", false), Some("Lifedeath".into()));
        assert_eq!(detail_name_write(Some("Issue 154"), Some("Lifedeath".into()), "154", false), Some("Lifedeath".into()));
        assert_eq!(detail_name_write(Some("X-Men (1991) #154"), Some("Lifedeath".into()), "154", false), Some("Lifedeath".into()));
        // …file priority protects only a REAL existing title, not a placeholder it should rescue.
        assert_eq!(detail_name_write(Some("From ComicInfo"), Some("Lifedeath".into()), "154", true), None);
        assert_eq!(detail_name_write(Some("Issue 154"), Some("Lifedeath".into()), "154", true), Some("Lifedeath".into()));
        // No real title in the detail → leave the column alone (COALESCE keeps the name).
        assert_eq!(detail_name_write(Some("Lifedeath"), None, "154", false), None);
    }

    #[test]
    fn metron_detail_story_title_extraction() {
        // `title` wins; Metron's story-name array is the fallback; placeholders never land.
        assert_eq!(metron_detail_story_title(&serde_json::json!({"title": "Lifedeath"})), Some("Lifedeath".into()));
        assert_eq!(metron_detail_story_title(&serde_json::json!({"name": ["Lifedeath", "Backup Story"]})), Some("Lifedeath".into()));
        assert_eq!(metron_detail_story_title(&serde_json::json!({"name": "Lifedeath"})), Some("Lifedeath".into()));
        assert_eq!(metron_detail_story_title(&serde_json::json!({"title": "Issue 154"})), None);
        assert_eq!(metron_detail_story_title(&serde_json::json!({"name": []})), None);
        assert_eq!(metron_detail_story_title(&serde_json::json!({})), None);
    }
}
