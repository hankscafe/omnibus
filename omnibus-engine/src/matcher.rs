// Unmatched-series retry sweep + match-confidence policy (discussion #177).
//
// A big tagged-library import used to die at ComicVine's 200/hr wall: everything past the limit
// landed UNMATCHED and NOTHING ever retried it — a 2,700-series migration left 2,000+ series in a
// manual click-Accept queue. This module owns:
//   1. run_unmatched_sweep — a scheduled, budget-aware pass over UNMATCHED series: free file
//      evidence first (series.json comicid / ComicInfo ids — including files tagged AFTER the
//      original scan, or libraries scanned by builds that predate the file-evidence readers),
//      then provider name-search under the admin's confidence mode. Stops BEFORE the rate-limit
//      wall and resumes on the next scheduled run, so libraries finish matching themselves.
//   2. The confidence policy (matcher_mode): how much automation the admin trusts.
//
// matcher_mode values (SystemSetting, default "confirm"):
//   trust   — file IDs auto-apply; name-search matches auto-accept at >= matcher_auto_threshold.
//   confirm — file IDs auto-apply; name-search is left to the Smart Matcher UI (no API burn here).
//   auto    — file IDs auto-apply; name-search auto-accepts only near-exact (>= 0.97 + year agrees).
//   custom  — no automation at all; the admin matches by hand / custom ID.

use crate::db::Db;
use sqlx::Row;
use std::path::Path;

/// One scheduled pass over UNMATCHED series. Returns the human-readable summary for the job log.
/// Budget-aware: free file evidence always runs; API work (issue-id resolution, name search) stops
/// once ComicVine's hourly window nears the wall and RESUMES on the next scheduled run — the fix
/// for "matching just gives up after the rate limit" (discussion #177).
pub async fn run_unmatched_sweep(db: Db) -> anyhow::Result<String> {
    let get_setting = |key: &'static str| {
        let pool = db.pool.clone();
        async move {
            sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = $1"#)
                .bind(key)
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten()
        }
    };

    let mode = get_setting("matcher_mode").await.unwrap_or_else(|| "confirm".to_string());
    if mode == "custom" {
        let msg = "[Matcher] matcher_mode=custom — automatic matching disabled; sweep skipped.".to_string();
        log::info!("{}", msg);
        return Ok(msg);
    }
    let threshold = get_setting("matcher_auto_threshold").await
        .and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(0.90)
        .clamp(0.5, 1.0);
    let cv_key = crate::secret_crypto::decrypt_setting(&db.pool, get_setting("cv_api_key").await).await
        .filter(|k| !k.trim().is_empty());

    let rows = sqlx::query(
        r#"SELECT id, name, year, "folderPath" FROM "Series"
           WHERE "matchState" = 'UNMATCHED' OR "metadataId" IS NULL OR "metadataId" LIKE 'unmatched%'
           ORDER BY "updatedAt" ASC LIMIT 100"#,
    )
    .fetch_all(&db.pool)
    .await?;

    let total = rows.len();
    if total == 0 {
        let msg = "[Matcher] Unmatched sweep: nothing to do.".to_string();
        log::info!("{}", msg);
        return Ok(msg);
    }
    log::info!("[Matcher] Unmatched sweep starting: {} series (mode: {}).", total, mode);

    let client = reqwest::Client::new();
    let mut by_file = 0usize;
    let mut by_search = 0usize;
    let mut for_admin = 0usize;
    let mut deferred = 0usize; // budget hit — retried automatically next run
    let mut searches_this_run = 0usize;
    let search_allowed = matches!(mode.as_str(), "trust" | "auto") && cv_key.is_some();

    for row in &rows {
        let sid: String = row.get("id");
        let name: String = row.get("name");
        let year: i32 = row.try_get("year").unwrap_or(0);
        let folder: String = row.try_get("folderPath").unwrap_or_default();

        let calls = crate::api_usage::cv_calls_last_hour(&db.pool).await;
        let allow_api = !budget_exhausted(calls, 200, 30);

        // 1. Free file evidence (series.json / ComicInfo — incl. files tagged after the original
        //    scan, and libraries scanned by builds that predate the file-evidence readers).
        if !folder.trim().is_empty() {
            if let Some((source, id, cv_id, metron_id)) =
                crate::scanner::folder_match_evidence(&db, &client, Path::new(&folder), allow_api).await
            {
                if apply_match(&db, &sid, &name, &source, &id, cv_id, metron_id).await {
                    by_file += 1;
                } else {
                    for_admin += 1; // id collision with another series — needs a human
                }
                continue;
            }
        }

        // 2. Provider name-search, only under an auto-accepting confidence mode.
        if !search_allowed {
            for_admin += 1;
            continue;
        }
        if !allow_api || searches_this_run >= 30 {
            deferred += 1;
            continue;
        }
        searches_this_run += 1;
        match cv_search_best(&db, &client, cv_key.as_deref().unwrap_or(""), &name).await {
            Ok(Some((vol_id, vol_name, start_year))) => {
                let sim = name_similarity(&name, &vol_name);
                let year_matches = year > 0 && start_year.map(|sy| (sy - year).abs() <= 1).unwrap_or(false);
                if auto_accept(&mode, sim, year_matches, threshold) {
                    if apply_match(&db, &sid, &name, "COMICVINE", &vol_id.to_string(), Some(vol_id), None).await {
                        log::info!("[Matcher] Auto-matched \"{}\" -> CV volume {} (\"{}\" sim {:.2}, year ok: {}).", name, vol_id, vol_name, sim, year_matches);
                        by_search += 1;
                    } else {
                        for_admin += 1;
                    }
                } else {
                    log::debug!("[Matcher Debug] Best CV candidate for \"{}\" was \"{}\" (sim {:.2}, year ok: {}) — below the {} bar; leaving for the Smart Matcher.", name, vol_name, sim, year_matches, mode);
                    for_admin += 1;
                }
            }
            Ok(None) => {
                for_admin += 1;
            }
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("429") {
                    log::warn!("[Matcher] ComicVine rate-limited mid-sweep — halting; remaining series retry next run.");
                    deferred += 1;
                    break;
                }
                log::warn!("[Matcher] CV search failed for \"{}\": {} — leaving for the Smart Matcher.", name, msg);
                for_admin += 1;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
    }

    let processed = by_file + by_search + for_admin + deferred;
    let unprocessed = total.saturating_sub(processed);
    let summary = format!(
        "[Matcher] Unmatched sweep complete: {} matched from file metadata, {} auto-matched by search, {} left for the Smart Matcher, {} deferred to the next run (budget){}.",
        by_file, by_search, for_admin, deferred + unprocessed,
        if searches_this_run > 0 { format!(" — {} CV searches used", searches_this_run) } else { String::new() }
    );
    log::info!("{}", summary);
    Ok(summary)
}

/// Applies a match, guarding the (metadataSource, metadataId) unique — a second series already
/// holding the id is a duplicate the admin must merge, not something to clobber.
async fn apply_match(db: &Db, series_id: &str, series_name: &str, source: &str, id: &str, cv_id: Option<i32>, metron_id: Option<i32>) -> bool {
    let taken: Option<String> = sqlx::query_scalar(
        r#"SELECT id FROM "Series" WHERE "metadataSource" = $1 AND "metadataId" = $2 AND id <> $3"#,
    )
    .bind(source).bind(id).bind(series_id)
    .fetch_optional(&db.pool)
    .await
    .ok()
    .flatten();
    if taken.is_some() {
        log::warn!("[Matcher] \"{}\" resolves to {} id {}, but another series already holds it — leaving unmatched for admin review.", series_name, source, id);
        return false;
    }
    match sqlx::query(
        r#"UPDATE "Series" SET "metadataId" = $1, "metadataSource" = $2, "matchState" = 'MATCHED',
           "cvId" = COALESCE($3, "cvId"), "metronId" = COALESCE($4, "metronId") WHERE id = $5"#,
    )
    .bind(id).bind(source).bind(cv_id).bind(metron_id).bind(series_id)
    .execute(&db.pool)
    .await
    {
        Ok(_) => {
            log::info!("[Matcher] Matched \"{}\" -> {} id {} from embedded file metadata.", series_name, source, id);
            true
        }
        Err(e) => {
            log::error!("[Matcher] Failed to apply match for \"{}\": {:?}", series_name, e);
            false
        }
    }
}

/// Best ComicVine volume candidate for a series name: one /search/ call, results ranked by
/// name_similarity. Returns (volume_id, volume_name, start_year).
async fn cv_search_best(db: &Db, client: &reqwest::Client, api_key: &str, name: &str) -> anyhow::Result<Option<(i32, String, Option<i32>)>> {
    let resp = client
        .get("https://comicvine.gamespot.com/api/search/")
        .query(&[
            ("api_key", api_key),
            ("format", "json"),
            ("query", name),
            ("resources", "volume"),
            ("limit", "10"),
            ("field_list", "id,name,start_year"),
        ])
        .header("User-Agent", "Omnibus/1.0")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await?;
    crate::api_usage::log(&db.pool, "comicvine", "https://comicvine.gamespot.com/api/search/").await;

    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        crate::metadata::mark_flag(db, "cv_rate_limit_time").await;
        anyhow::bail!("ComicVine rate limited (429) on matcher search");
    }
    let json: serde_json::Value = resp.json().await?;
    let results = json["results"].as_array().cloned().unwrap_or_default();

    let mut best: Option<(i32, String, Option<i32>, f64)> = None;
    for r in &results {
        let Some(id) = r["id"].as_i64().map(|v| v as i32) else { continue };
        let vol_name = r["name"].as_str().unwrap_or("").to_string();
        if vol_name.is_empty() {
            continue;
        }
        let start_year = r["start_year"].as_str().and_then(|s| s.trim().parse::<i32>().ok())
            .or_else(|| r["start_year"].as_i64().map(|v| v as i32));
        let sim = name_similarity(name, &vol_name);
        if best.as_ref().map(|(_, _, _, b)| sim > *b).unwrap_or(true) {
            best = Some((id, vol_name, start_year, sim));
        }
    }
    Ok(best.map(|(id, n, y, _)| (id, n, y)))
}

/// Name similarity in [0, 1]: case-insensitive token Dice coefficient over alphanumeric words.
/// Symbols fold to spaces, so "Hack/Slash" == "Hack Slash" == "hack slash" (the slash-title case
/// from discussion #177). Token-based, order-insensitive.
pub(crate) fn name_similarity(a: &str, b: &str) -> f64 {
    let tokens = |s: &str| -> Vec<String> {
        s.to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { ' ' })
            .collect::<String>()
            .split_whitespace()
            .map(str::to_string)
            .collect()
    };
    let ta = tokens(a);
    let tb = tokens(b);
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    let common = ta.iter().filter(|t| tb.contains(t)).count();
    (2.0 * common as f64) / (ta.len() + tb.len()) as f64
}

/// The confidence policy: should a name-search candidate be applied WITHOUT admin confirmation?
pub(crate) fn auto_accept(mode: &str, similarity: f64, year_matches: bool, threshold: f64) -> bool {
    match mode {
        "trust" => similarity >= threshold,
        "auto" => similarity >= 0.97 && year_matches,
        _ => false, // confirm / custom / unknown: never auto-apply a guess
    }
}

/// True when the sweep should stop searching to protect the ComicVine budget: calls made in the
/// rolling window have reached `limit - reserve`. Counting is shared with the health check's
/// cv_api_usage accounting.
pub(crate) fn budget_exhausted(calls_last_window: usize, limit: usize, reserve: usize) -> bool {
    calls_last_window + reserve >= limit
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_similarity_folds_symbols_and_scores_tokens() {
        // Exact + case-insensitive.
        assert_eq!(name_similarity("Wolverine", "wolverine"), 1.0);
        // The slash-title report from discussion #177: symbols fold to spaces.
        assert_eq!(name_similarity("Hack/Slash", "Hack Slash"), 1.0);
        assert_eq!(name_similarity("Batman & Robin", "Batman Robin"), 1.0);
        // A prefixed sibling scores well under 1.0 (2 common of 1+2 tokens = 0.666…).
        let sib = name_similarity("Wolverine", "Savage Wolverine");
        assert!(sib > 0.6 && sib < 0.7, "got {sib}");
        // Disjoint titles score 0.
        assert_eq!(name_similarity("Batman", "Superman"), 0.0);
        // Empty input never divides by zero.
        assert_eq!(name_similarity("", "Batman"), 0.0);
    }

    #[test]
    fn auto_accept_honors_confidence_modes() {
        // trust: admin-tunable threshold.
        assert!(auto_accept("trust", 0.92, false, 0.90));
        assert!(!auto_accept("trust", 0.85, true, 0.90));
        // auto: near-exact AND the year must agree.
        assert!(auto_accept("auto", 0.98, true, 0.90));
        assert!(!auto_accept("auto", 0.98, false, 0.90));
        assert!(!auto_accept("auto", 0.92, true, 0.90));
        // confirm / custom: a guess is never applied silently.
        assert!(!auto_accept("confirm", 1.0, true, 0.90));
        assert!(!auto_accept("custom", 1.0, true, 0.90));
    }

    #[test]
    fn budget_gate_stops_before_the_wall() {
        // CV allows 200/hr; with a reserve of 30 the sweep stops at 170 calls.
        assert!(!budget_exhausted(0, 200, 30));
        assert!(!budget_exhausted(169, 200, 30));
        assert!(budget_exhausted(170, 200, 30));
        assert!(budget_exhausted(200, 200, 30));
    }
}
