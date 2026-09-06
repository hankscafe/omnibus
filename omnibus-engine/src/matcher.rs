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

/// Aggregate result of one sweep pass: the human-readable summary for the JobLog, plus the count
/// of series the sweep actually matched (drives "only notify when something happened").
pub struct SweepOutcome {
    pub summary: String,
    pub matched: usize,
}

/// Tier-2 sweep history: one JobLog row per series the sweep actually ACTED on, so "what did the
/// background sweep match, and to what?" is answerable from Job History months later. relatedItem
/// carries the series name (the column reserved for exactly this). Only outcomes are recorded —
/// applied matches and id-collisions that need an admin — never skipped/deferred series, so a
/// 100-series pass writes at most 100 rows and a quiet pass writes none.
struct SweepAudit {
    related_item: String,
    status: &'static str, // COMPLETED (match applied) | FAILED (needs admin attention)
    message: String,
}

/// Flushes the audit rows in one short transaction per chunk (scan-write invariant from issue
/// #183: no I/O between begin and commit; never let audit bookkeeping starve the Node app's
/// writes). Best-effort — the sweep's real work is already committed by this point.
async fn flush_sweep_audit(db: &Db, rows: &[SweepAudit]) {
    for chunk in rows.chunks(100) {
        let mut tx = match db.pool.begin().await {
            Ok(t) => t,
            Err(e) => {
                log::warn!("[Matcher] Could not open the sweep-audit transaction: {:?}", e);
                return;
            }
        };
        for r in chunk {
            if let Err(e) = sqlx::query(&format!(
                r#"INSERT INTO "JobLog" (id, "jobType", status, "durationMs", message, "relatedItem", "createdAt", attempts)
                   VALUES ($1, 'SWEEP_MATCH', $2, 0, $3, $4, {now}, 1)"#,
                now = db.now_expr()
            ))
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(r.status)
            .bind(&r.message)
            .bind(&r.related_item)
            .execute(&mut *tx)
            .await
            {
                log::warn!("[Matcher] Could not write a sweep-audit row for \"{}\": {:?}", r.related_item, e);
            }
        }
        if let Err(e) = tx.commit().await {
            log::warn!("[Matcher] Sweep-audit commit failed ({} row(s) lost): {:?}", chunk.len(), e);
        }
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Persists the structured result of the latest sweep (SystemSetting `last_unmatched_sweep_result`)
/// so the Smart Matcher UI can show what the background sweep did without parsing JobLog messages.
/// Best-effort — a write failure never fails the sweep itself.
pub async fn record_sweep_result(db: &Db, value: serde_json::Value) {
    if let Err(e) = sqlx::query(
        r#"INSERT INTO "SystemSetting" (key, value) VALUES ('last_unmatched_sweep_result', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"#,
    )
    .bind(value.to_string())
    .execute(&db.pool)
    .await
    {
        log::warn!("[Matcher] Could not persist the sweep result: {:?}", e);
    }
}

/// One scheduled pass over UNMATCHED series. Returns the human-readable summary for the job log.
/// Budget-aware: free file evidence always runs; API work (issue-id resolution, name search) stops
/// once ComicVine's hourly window nears the wall and RESUMES on the next scheduled run — the fix
/// for "matching just gives up after the rate limit" (discussion #177).
/// The series the automatic sweep is allowed to touch.
///
/// The three OR'd conditions are the historical definition of "not matched yet" — a state of
/// UNMATCHED, no provider id at all, or a placeholder `unmatched_*` id (rows born from a scan).
/// The IGNORED exclusion is the one that needs stating: an admin who marks a series ignored has
/// said "I curated this by hand, stop offering to match it" — but such a series still has a null or
/// placeholder metadataId, so without this clause the very next sweep would pick it up and
/// auto-match it anyway, which is precisely the nagging the state exists to end.
pub(crate) fn unmatched_candidates_sql() -> &'static str {
    r#"SELECT id, name, year, "folderPath" FROM "Series"
       WHERE ("matchState" IS NULL OR "matchState" <> 'IGNORED')
         AND ("matchState" = 'UNMATCHED' OR "metadataId" IS NULL OR "metadataId" LIKE 'unmatched%')
       ORDER BY "updatedAt" ASC LIMIT 100"#
}

pub async fn run_unmatched_sweep(db: Db) -> anyhow::Result<SweepOutcome> {
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
        record_sweep_result(&db, serde_json::json!({
            "status": "SKIPPED", "mode": mode, "finishedAt": now_ms(),
        })).await;
        return Ok(SweepOutcome { summary: msg, matched: 0 });
    }
    let threshold = get_setting("matcher_auto_threshold").await
        .and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(0.90)
        .clamp(0.5, 1.0);
    let cv_key = crate::secret_crypto::decrypt_setting(&db.pool, get_setting("cv_api_key").await).await
        .filter(|k| !k.trim().is_empty());

    let rows = sqlx::query(unmatched_candidates_sql())
    .fetch_all(&db.pool)
    .await?;

    let total = rows.len();
    if total == 0 {
        let msg = "[Matcher] Unmatched sweep: nothing to do.".to_string();
        log::info!("{}", msg);
        record_sweep_result(&db, serde_json::json!({
            "status": "COMPLETED", "mode": mode, "total": 0, "byFile": 0, "bySearch": 0,
            "forAdmin": 0, "deferred": 0, "searches": 0, "finishedAt": now_ms(),
        })).await;
        return Ok(SweepOutcome { summary: msg, matched: 0 });
    }
    log::info!("[Matcher] Unmatched sweep starting: {} series (mode: {}).", total, mode);

    let client = reqwest::Client::new();
    let mut by_file = 0usize;
    let mut by_search = 0usize;
    let mut for_admin = 0usize;
    let mut deferred = 0usize; // budget hit — retried automatically next run
    let mut searches_this_run = 0usize;
    let mut audit: Vec<SweepAudit> = Vec::new(); // Tier-2 history, flushed after the pass
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
                    audit.push(SweepAudit {
                        related_item: name.clone(),
                        status: "COMPLETED",
                        message: format!("Matched from embedded file metadata → {} id {} (zero API cost).", source, id),
                    });
                } else {
                    for_admin += 1; // id collision with another series — needs a human
                    audit.push(SweepAudit {
                        related_item: name.clone(),
                        status: "FAILED",
                        message: format!(
                            "File metadata resolves to {} id {}, but it could not be applied (usually another series already holds that id) — left for the Smart Matcher.",
                            source, id
                        ),
                    });
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
        match cv_search_best(&db, &client, cv_key.as_deref().unwrap_or(""), &name, year).await {
            Ok(Some((vol_id, vol_name, start_year))) => {
                let sim = name_similarity(&name, &vol_name);
                let year_matches = year > 0 && start_year.map(|sy| (sy - year).abs() <= 1).unwrap_or(false);
                if auto_accept(&mode, sim, year_matches, threshold) {
                    if apply_match(&db, &sid, &name, "COMICVINE", &vol_id.to_string(), Some(vol_id), None).await {
                        log::info!("[Matcher] Auto-matched \"{}\" -> CV volume {} (\"{}\" sim {:.2}, year ok: {}).", name, vol_id, vol_name, sim, year_matches);
                        by_search += 1;
                        audit.push(SweepAudit {
                            related_item: name.clone(),
                            status: "COMPLETED",
                            message: format!(
                                "Auto-matched by search → ComicVine volume {} \"{}\" (similarity {:.2}, year {}, mode {}).",
                                vol_id, vol_name, sim, if year_matches { "agrees" } else { "unconfirmed" }, mode
                            ),
                        });
                    } else {
                        for_admin += 1;
                        audit.push(SweepAudit {
                            related_item: name.clone(),
                            status: "FAILED",
                            message: format!(
                                "Search found ComicVine volume {} \"{}\" (similarity {:.2}), but it could not be applied (usually another series already holds that id) — left for the Smart Matcher.",
                                vol_id, vol_name, sim
                            ),
                        });
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

    // Tier-2 history lands before the summary so Job History shows the per-series rows the
    // moment the run's own COMPLETED row appears.
    flush_sweep_audit(&db, &audit).await;

    let processed = by_file + by_search + for_admin + deferred;
    let unprocessed = total.saturating_sub(processed);
    let summary = format!(
        "[Matcher] Unmatched sweep complete: {} matched from file metadata, {} auto-matched by search, {} left for the Smart Matcher, {} deferred to the next run (budget){}.",
        by_file, by_search, for_admin, deferred + unprocessed,
        if searches_this_run > 0 { format!(" — {} CV searches used", searches_this_run) } else { String::new() }
    );
    log::info!("{}", summary);
    record_sweep_result(&db, serde_json::json!({
        "status": "COMPLETED", "mode": mode, "total": total, "byFile": by_file, "bySearch": by_search,
        "forAdmin": for_admin, "deferred": deferred + unprocessed, "searches": searches_this_run,
        "finishedAt": now_ms(),
    })).await;
    Ok(SweepOutcome { summary, matched: by_file + by_search })
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
/// name_similarity plus the year term (see pick_best). Returns (volume_id, volume_name, start_year).
async fn cv_search_best(db: &Db, client: &reqwest::Client, api_key: &str, name: &str, year: i32) -> anyhow::Result<Option<(i32, String, Option<i32>)>> {
    let req = client
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
        .build()?;
    let full_url = req.url().to_string();

    // Shared response cache: a hit costs zero budget, so a cached sweep re-run is free.
    let json: serde_json::Value = match crate::metadata_cache::get(db, "comicvine", &full_url).await {
        Some(hit) => hit,
        None => {
            let resp = client.execute(req).await?;
            crate::api_usage::log(&db.pool, "comicvine", "https://comicvine.gamespot.com/api/search/").await;
            if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                crate::metadata::mark_flag(db, "cv_rate_limit_time").await;
                anyhow::bail!("ComicVine rate limited (429) on matcher search");
            }
            let j: serde_json::Value = resp.json().await?;
            crate::metadata_cache::put(db, "comicvine", &full_url, &j).await;
            j
        }
    };
    let results = json["results"].as_array().cloned().unwrap_or_default();
    let candidates: Vec<(i32, String, Option<i32>)> = results.iter().filter_map(|r| {
        let id = r["id"].as_i64().map(|v| v as i32)?;
        let vol_name = r["name"].as_str().unwrap_or("").to_string();
        if vol_name.is_empty() { return None; }
        let start_year = r["start_year"].as_str().and_then(|s| s.trim().parse::<i32>().ok())
            .or_else(|| r["start_year"].as_i64().map(|v| v as i32));
        Some((id, vol_name, start_year))
    }).collect();
    Ok(pick_best(name, year, candidates))
}

/// The year's contribution to a candidate's score — a tiebreaker-plus, deliberately small next to
/// a full-name match: exact +0.10, off by one +0.05 (ComicVine's start_year and a folder's year
/// disagree by one all the time), further off −0.05, either side unknown 0. EXACT twin of
/// smart-match-search.ts yearTerm: the sweep and the Smart Matcher must rank identically, or the
/// sweep would auto-match what the UI would reject.
///
/// The magnitudes keep the year's whole reach (0.15) under a one-token name difference on a
/// two-token name (0.2), so a folder whose year is wrong by three still resolves to the exact name
/// rather than a same-year near-miss such as its own annual.
pub(crate) fn year_term(candidate_year: Option<i32>, wanted_year: i32) -> f64 {
    let Some(cy) = candidate_year.filter(|y| *y > 0) else { return 0.0 };
    if wanted_year <= 0 { return 0.0; }
    match (cy - wanted_year).abs() {
        0 => 0.10,
        1 => 0.05,
        _ => -0.05,
    }
}

/// Pure ranking over already-parsed candidates (id, name, start_year): the name dominates unless
/// names tie, and then the year decides. Extracted from cv_search_best so it can be tested without
/// HTTP. Ties keep the provider's order (stable: only a strictly better score replaces the best).
pub(crate) fn pick_best(name: &str, year: i32, candidates: Vec<(i32, String, Option<i32>)>) -> Option<(i32, String, Option<i32>)> {
    let mut best: Option<(i32, String, Option<i32>, f64)> = None;
    for (id, vol_name, start_year) in candidates {
        let score = name_similarity(name, &vol_name) + year_term(start_year, year);
        if best.as_ref().map(|(_, _, _, b)| score > *b).unwrap_or(true) {
            best = Some((id, vol_name, start_year, score));
        }
    }
    best.map(|(id, n, y, _)| (id, n, y))
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

    /// The sweep must leave IGNORED series alone — they still carry a null/placeholder metadataId,
    /// so the pre-IGNORED query would have re-offered them on every run (field report from
    /// robotshavehearts2: hand-curated TPBs ComicVine simply doesn't have).
    #[tokio::test]
    async fn sweep_candidates_skip_ignored_but_keep_every_other_unmatched_shape() {
        let base = std::env::temp_dir().join(format!("omnibus_matchsweep_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("create fixture dir");
        let db_file = base.join("sweep.db");
        std::fs::File::create(&db_file).expect("pre-create sqlite file");
        let db_url = format!("file:{}", db_file.to_string_lossy().replace('\\', "/"));
        let db = crate::db::Db::connect(&db_url, 2).await.expect("connect file-backed sqlite");

        sqlx::query(
            r#"CREATE TABLE "Series" (id TEXT PRIMARY KEY, name TEXT, year INTEGER, "folderPath" TEXT,
               "matchState" TEXT, "metadataId" TEXT, "updatedAt" TEXT)"#,
        )
        .execute(&db.pool).await.expect("create schema");

        for (id, state, meta) in [
            ("s_unmatched", Some("UNMATCHED"), None),
            ("s_null_id", Some("MATCHED"), None),                       // no id yet = still a candidate
            ("s_placeholder", Some("MATCHED"), Some("unmatched_abc")),  // scan-born placeholder id
            ("s_ignored", Some("IGNORED"), None),                       // hand-curated: leave it alone
            ("s_matched", Some("MATCHED"), Some("42821")),
        ] {
            sqlx::query(r#"INSERT INTO "Series" (id, name, year, "folderPath", "matchState", "metadataId", "updatedAt") VALUES ($1, $1, 2024, '/c', $2, $3, '2026-08-27')"#)
                .bind(id).bind(state).bind(meta)
                .execute(&db.pool).await.expect("seed series");
        }

        let rows = sqlx::query(unmatched_candidates_sql()).fetch_all(&db.pool).await.expect("candidates");
        let mut ids: Vec<String> = rows.iter().map(|r| r.get::<String, _>("id")).collect();
        ids.sort();
        assert_eq!(ids, vec!["s_null_id", "s_placeholder", "s_unmatched"]);
        assert!(!ids.contains(&"s_ignored".to_string()), "an ignored series must never be swept");

        let _ = std::fs::remove_dir_all(&base);
    }

    // Suggestion ranking (robotshavehearts2's "way off" auto-matches): the year is a
    // tiebreaker-plus, never a sort key. Twin cases live in smart-match-prefill-helpers.test.ts.
    #[test]
    fn year_term_rewards_agreement_modestly_and_ignores_unknowns() {
        assert_eq!(year_term(Some(2024), 2024), 0.10);
        assert_eq!(year_term(Some(2023), 2024), 0.05);
        assert_eq!(year_term(Some(2016), 2011), -0.05);
        assert_eq!(year_term(None, 2024), 0.0);
        assert_eq!(year_term(Some(2024), 0), 0.0);
        assert_eq!(year_term(Some(0), 2024), 0.0);
    }

    #[test]
    fn pick_best_lets_the_name_dominate_and_the_year_break_ties() {
        let c = |id: i32, n: &str, y: Option<i32>| (id, n.to_string(), y);
        // The field report's shape: every 2024 volume used to be pulled ahead of the exact name.
        let cands = vec![
            c(1, "X-Men: From the Ashes Infinity Comic", Some(2024)),
            c(2, "X-Men Annual", Some(2024)),
            c(3, "X-Men", Some(2024)),
            c(4, "X-Men", Some(1991)),
        ];
        assert_eq!(pick_best("X-Men", 2024, cands.clone()).map(|b| b.0), Some(3));
        // A wrong folder year must not hand the win to a same-year wrong name.
        let cands2 = vec![c(1, "Batman Eternal", Some(2014)), c(2, "Batman", Some(2011)), c(3, "Batman", Some(2016))];
        assert_eq!(pick_best("Batman", 2014, cands2.clone()).map(|b| b.0), Some(2));
        // Among equal names, off-by-one beats far-off.
        assert_eq!(pick_best("Batman", 2012, cands2).map(|b| b.0), Some(2));
        // Plain series over its annual when both share the year.
        assert_eq!(pick_best("Batman", 2012, vec![c(1, "Batman Annual", Some(2012)), c(2, "Batman", Some(2012))]).map(|b| b.0), Some(2));
        // Nothing to rank → nothing.
        assert!(pick_best("Batman", 2012, vec![]).is_none());
    }

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

    // ==== Tier-2 sweep history: per-series outcomes must land in JobLog with relatedItem. ====

    #[tokio::test]
    async fn sweep_audit_rows_land_in_joblog_with_related_item() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(sqlx::any::install_default_drivers);
        let pool = sqlx::any::AnyPoolOptions::new()
            .max_connections(1) // each :memory: connection is its own DB — keep exactly one
            .connect("sqlite::memory:").await.unwrap();
        sqlx::query(r#"CREATE TABLE "JobLog" (id TEXT PRIMARY KEY, "jobType" TEXT, status TEXT, "durationMs" INTEGER, message TEXT, "relatedItem" TEXT, "createdAt" INTEGER, attempts INTEGER)"#)
            .execute(&pool).await.unwrap();
        let db = Db { pool, dialect: crate::db::Dialect::Sqlite };

        flush_sweep_audit(&db, &[
            SweepAudit {
                related_item: "Saga (2012)".to_string(),
                status: "COMPLETED",
                message: "Matched from embedded file metadata → COMICVINE id 12345 (zero API cost).".to_string(),
            },
            SweepAudit {
                related_item: "Hack/Slash".to_string(),
                status: "FAILED",
                message: "id collision — left for the Smart Matcher.".to_string(),
            },
        ]).await;

        let rows = sqlx::query(r#"SELECT "jobType", status, "relatedItem", message FROM "JobLog" ORDER BY "relatedItem""#)
            .fetch_all(&db.pool).await.unwrap();
        assert_eq!(rows.len(), 2);
        // Alphabetical: "Hack/Slash" sorts before "Saga (2012)".
        assert_eq!(rows[0].get::<String, _>("jobType"), "SWEEP_MATCH");
        assert_eq!(rows[0].get::<String, _>("status"), "FAILED");
        assert_eq!(rows[0].get::<String, _>("relatedItem"), "Hack/Slash");
        assert_eq!(rows[1].get::<String, _>("jobType"), "SWEEP_MATCH");
        assert_eq!(rows[1].get::<String, _>("status"), "COMPLETED");
        assert_eq!(rows[1].get::<String, _>("relatedItem"), "Saga (2012)");
        assert!(rows[1].get::<String, _>("message").contains("COMICVINE id 12345"));
    }

    #[tokio::test]
    async fn sweep_audit_flush_with_no_rows_writes_nothing() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(sqlx::any::install_default_drivers);
        let pool = sqlx::any::AnyPoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:").await.unwrap();
        sqlx::query(r#"CREATE TABLE "JobLog" (id TEXT PRIMARY KEY, "jobType" TEXT, status TEXT, "durationMs" INTEGER, message TEXT, "relatedItem" TEXT, "createdAt" INTEGER, attempts INTEGER)"#)
            .execute(&pool).await.unwrap();
        let db = Db { pool, dialect: crate::db::Dialect::Sqlite };

        flush_sweep_audit(&db, &[]).await;

        let n: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM "JobLog""#)
            .fetch_one(&db.pool).await.unwrap();
        assert_eq!(n, 0, "a quiet sweep must not write audit rows");
    }
}
