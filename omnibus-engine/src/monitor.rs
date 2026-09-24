// Series-monitor sync (SERIES_MONITOR) — the heavy half. Ported from queue.ts per the roadmap's
// "partial" split: this engine module does the multi-minute API fetch + match + skeleton-upsert
// (Phase 1 Metron Oracle ≤3000 upcoming issues, Phase 2 ComicVine 25 oldest-monitored series × 30
// issues), and returns the monitored, matched, not-yet-in-library issues as *candidates*. The Node
// worker keeps request creation + searchAndDownload (BullMQ) + the Phase 3 UNRELEASED upgrade sweep.
use anyhow::Result;
use crate::db::Db;
use sqlx::Row;
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

use crate::discover::is_released_yet;
use crate::metadata::is_same_issue;

/// A monitored, matched, not-in-library issue the Node worker should create/upgrade a Request for.
#[derive(Serialize)]
pub struct MonitorCandidate {
    pub volume_id: String,
    // The matched series' provider (COMICVINE/METRON). The Node worker stamps it onto the created Request
    // so the indexer relevance guard can resolve the canonical name by (metadataId, metadataSource);
    // without it, a Metron-monitored series' request defaulted to COMICVINE and the lookup missed.
    pub metadata_source: String,
    pub search_name: String,
    pub issue_number: String,
    pub issue_year: String,
    pub is_released: bool,
    /// Whether the provider supplied ANY release date (store or cover). is_released defaults to
    /// true when no date exists, so the Node worker uses this to park date-less candidates as
    /// AWAITING_RELEASE instead of searching prematurely for a just-solicited issue.
    pub has_date: bool,
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

#[derive(Clone)]
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
    /// The cross-provider Metron series id the matcher stores on a ComicVine-sourced series
    /// (Series.metronId). Lets the Oracle anchor on an id instead of a name for such series (#208).
    metron_id: Option<String>,
}

#[derive(Clone)]
struct IssueRec {
    id: String,
    number: String,
    file_path: Option<String>,
    release_date: Option<String>,
}

/// A file-less, non-lane Issue row the Metron pass created (metadataSource METRON), keyed by its
/// Metron issue id — the rows #208's heal may relocate or drop. A row with a file is never in here.
#[derive(Clone, Debug, PartialEq)]
struct StraySkeleton {
    issue_id: String,
    series_id: String,
    number: String,
}
type StrayMap = HashMap<String, StraySkeleton>;

#[derive(Debug, PartialEq)]
enum StrayAction {
    Relocated,
    Deleted,
    /// Its volume isn't in the library and the host provably isn't it — the row is removed.
    Evicted,
}

/// Which local series a Metron upcoming issue belongs to (#208).
#[derive(Debug, PartialEq)]
enum MetronMatch {
    Matched(usize),
    NoMatch,
    /// A same-name family the year can't settle — skipped, never guessed.
    Ambiguous { candidates: usize },
}

/// Match one Metron issue's series to a local series. Anchors, in order: the Metron id of a
/// Metron-sourced series; the cross-provider metronId the matcher stored on a ComicVine series;
/// then normalized name + publisher (when Metron names one) settled by Metron's `year_began` — an
/// exact start year, else the single sibling within a year. A lone same-name series is accepted when
/// it is within a year (or when either side has no year), and refused when it is clearly another
/// era's volume. Two or more same-name series that the year cannot tell apart are AMBIGUOUS and the
/// issue is skipped: before #208 this took the first row in table order, which filed every upcoming
/// "X-Men" under whichever of seven X-Men volumes was inserted first. A family whose every volume
/// has a recorded year and none is within a year of Metron's is NO MATCH — the volume isn't in the
/// library (his Uncanny X-Men 2013/2016/2019 against the 2024 run's upcoming issues).
fn match_series_for_metron_issue(
    series: &[SeriesRec],
    m_series_id: Option<&str>,
    m_series_name: &str,
    m_pub_name: &str,
    year_began: Option<i32>,
) -> MetronMatch {
    if let Some(msid) = m_series_id.filter(|s| !s.is_empty()) {
        if let Some(idx) = series.iter().position(|s| s.metadata_source == "METRON" && s.metadata_id.as_deref() == Some(msid)) {
            return MetronMatch::Matched(idx);
        }
        if let Some(idx) = series.iter().position(|s| s.metron_id.as_deref() == Some(msid)) {
            return MetronMatch::Matched(idx);
        }
    }
    if m_series_name.is_empty() {
        return MetronMatch::NoMatch;
    }
    let candidates: Vec<usize> = series.iter().enumerate()
        .filter(|(_, s)| normalize(&s.name) == m_series_name
            && (m_pub_name.is_empty() || normalize(s.publisher.as_deref().unwrap_or("")) == m_pub_name))
        .map(|(i, _)| i)
        .collect();
    match (candidates.len(), year_began) {
        (0, _) => MetronMatch::NoMatch,
        (1, None) => MetronMatch::Matched(candidates[0]),
        (1, Some(y)) => {
            let local = series[candidates[0]].year;
            if local == 0 || (local - y).abs() <= 1 { MetronMatch::Matched(candidates[0]) } else { MetronMatch::NoMatch }
        }
        (n, None) => MetronMatch::Ambiguous { candidates: n },
        (n, Some(y)) => {
            let exact: Vec<usize> = candidates.iter().copied().filter(|&i| series[i].year == y).collect();
            if exact.len() == 1 {
                return MetronMatch::Matched(exact[0]);
            }
            if exact.len() > 1 {
                return MetronMatch::Ambiguous { candidates: n };
            }
            let near: Vec<usize> = candidates.iter().copied()
                .filter(|&i| series[i].year != 0 && (series[i].year - y).abs() <= 1)
                .collect();
            match near.len() {
                1 => MetronMatch::Matched(near[0]),
                0 if candidates.iter().all(|&i| series[i].year != 0) => MetronMatch::NoMatch,
                _ => MetronMatch::Ambiguous { candidates: n },
            }
        }
    }
}

/// The Metron series id a local series is known by: its own id when it came from Metron, else the
/// cross-provider metronId the matcher stored. Numeric only — a Metron-sourced series can carry a
/// name slug as its metadataId (the sync resolves it by search), which identifies nothing here.
fn metron_identity(s: &SeriesRec) -> Option<&str> {
    let id = if s.metadata_source == "METRON" { s.metadata_id.as_deref() } else { s.metron_id.as_deref() };
    id.filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
}

/// Is a stray's host series provably NOT the volume the Metron issue belongs to? A Metron identity
/// on both sides decides; otherwise both start years must be known and more than a year apart.
/// Anything short of proof is false — a doubt never deletes a row.
fn stray_host_is_misfiled(host: &SeriesRec, m_series_id: Option<&str>, year_began: Option<i32>) -> bool {
    if let (Some(own), Some(msid)) = (metron_identity(host), m_series_id.filter(|s| !s.is_empty())) {
        return own != msid;
    }
    matches!(year_began, Some(y) if host.year != 0 && (host.year - y).abs() > 1)
}

/// #208 round 2: a Metron issue with no single local home (its volume isn't in the library, or the
/// family can't be settled) whose file-less METRON skeleton sits under a series that provably isn't
/// its volume — the pre-#208 first-in-table guess — is removed. Nothing is re-created in its place:
/// the matcher no longer files the issue anywhere, and if the right volume is added later the
/// monitor fills it there. None = no stray for this issue, or the host can't be proven wrong.
async fn evict_misfiled_stray(
    db: &Db,
    series: &[SeriesRec],
    issues: &mut HashMap<String, Vec<IssueRec>>,
    strays: &mut StrayMap,
    m_id: &str,
    m_series_id: Option<&str>,
    year_began: Option<i32>,
) -> Option<StrayAction> {
    let stray = strays.get(m_id)?.clone();
    let host = series.iter().find(|s| s.id == stray.series_id)?;
    if !stray_host_is_misfiled(host, m_series_id, year_began) {
        return None;
    }
    match sqlx::query(r#"DELETE FROM "Issue" WHERE id = $1"#).bind(&stray.issue_id).execute(&db.pool).await {
        Ok(_) => {
            if let Some(b) = issues.get_mut(&stray.series_id) { b.retain(|i| i.id != stray.issue_id); }
            strays.remove(m_id);
            log::info!("[Series Monitor] Removed stray skeleton #{} (Metron issue {}) from series {}: it belongs to a volume that isn't in the library (#208).", stray.number, m_id, stray.series_id);
            Some(StrayAction::Evicted)
        }
        Err(e) => { log::warn!("[Series Monitor] Could not remove stray skeleton {}: {:?}", stray.issue_id, e); None }
    }
}

/// #208 heal: a file-less METRON skeleton for Metron issue `m_id` that sits under a series other
/// than the one Metron names moves there (the row keeps its id, number, date and cover), or is
/// dropped when the right series already has that number. In-memory buckets follow the row so the
/// upsert and candidate logic that run next see the corrected state. None = nothing to do.
async fn heal_stray_skeleton(
    db: &Db,
    issues: &mut HashMap<String, Vec<IssueRec>>,
    strays: &mut StrayMap,
    m_id: &str,
    target_series_id: &str,
) -> Option<StrayAction> {
    let stray = strays.get(m_id)?.clone();
    if stray.series_id == target_series_id {
        return None;
    }
    let target_has_it = issues.get(target_series_id)
        .map(|b| b.iter().any(|i| is_same_issue(&i.number, &stray.number)))
        .unwrap_or(false);
    if target_has_it {
        match sqlx::query(r#"DELETE FROM "Issue" WHERE id = $1"#).bind(&stray.issue_id).execute(&db.pool).await {
            Ok(_) => {
                if let Some(b) = issues.get_mut(&stray.series_id) { b.retain(|i| i.id != stray.issue_id); }
                strays.remove(m_id);
                log::info!("[Series Monitor] Dropped stray skeleton #{} (Metron issue {}) from series {}: the volume it belongs to already has it (#208).", stray.number, m_id, stray.series_id);
                Some(StrayAction::Deleted)
            }
            Err(e) => { log::warn!("[Series Monitor] Could not drop stray skeleton {}: {:?}", stray.issue_id, e); None }
        }
    } else {
        match sqlx::query(r#"UPDATE "Issue" SET "seriesId" = $1 WHERE id = $2"#).bind(target_series_id).bind(&stray.issue_id).execute(&db.pool).await {
            Ok(_) => {
                let moved = issues.get_mut(&stray.series_id).and_then(|b| {
                    let pos = b.iter().position(|i| i.id == stray.issue_id)?;
                    Some(b.remove(pos))
                });
                let rec = moved.unwrap_or(IssueRec { id: stray.issue_id.clone(), number: stray.number.clone(), file_path: None, release_date: None });
                issues.entry(target_series_id.to_string()).or_default().push(rec);
                if let Some(s) = strays.get_mut(m_id) { s.series_id = target_series_id.to_string(); }
                log::info!("[Series Monitor] Relocated stray skeleton #{} (Metron issue {}) from series {} to {} (#208).", stray.number, m_id, stray.series_id, target_series_id);
                Some(StrayAction::Relocated)
            }
            Err(e) => { log::warn!("[Series Monitor] Could not relocate stray skeleton {}: {:?}", stray.issue_id, e); None }
        }
    }
}

/// The out-of-window stray audit (#208). The pre-#208 name guess could file an upcoming issue under
/// ANY same-name volume — a lone one included (a library with only X-Men 2013 got X-Men 2024's
/// issues) — so every stray the Oracle window didn't cover is audited once. A stray proven at home
/// (or one the fetch can't do better on) is remembered under this key, so the Metron cost is paid
/// once per row instead of every run; the set is pruned to rows that are still strays.
const AUDIT_CHECKED_KEY: &str = "monitor_stray_audit_checked";
/// Metron calls the audit may spend per run (detail fetches and issue_list pages alike).
const AUDIT_BUDGET: usize = 40;
/// A Metron-sourced volume longer than this many issue_list pages is audited stray by stray instead.
const WALK_PAGE_CAP: usize = 10;

/// This run's audit work. `singles`: (Metron issue id, host index) — one detail fetch each;
/// same-name families first (the likeliest mis-files), then by id. `walks`: (host index, the
/// host's Metron series id, its unchecked stray ids) — a Metron-sourced volume's rows come mostly
/// from its own id-anchored sync, so one walk of its issue_list settles them all at once.
#[derive(Debug, Default, PartialEq)]
struct AuditPlan {
    singles: Vec<(String, usize)>,
    walks: Vec<(usize, String, Vec<String>)>,
}

fn plan_stray_audit(series: &[SeriesRec], strays: &StrayMap, seen: &HashSet<String>, checked: &HashSet<String>) -> AuditPlan {
    let mut families: HashMap<String, usize> = HashMap::new();
    for s in series { *families.entry(normalize(&s.name)).or_insert(0) += 1; }
    let in_family = |idx: usize| families.get(&normalize(&series[idx].name)).copied().unwrap_or(0) >= 2;
    let idx_by_id: HashMap<&str, usize> = series.iter().enumerate().map(|(i, s)| (s.id.as_str(), i)).collect();

    let mut singles: Vec<(bool, String, usize)> = Vec::new();
    let mut walks: HashMap<usize, Vec<String>> = HashMap::new();
    for (m_id, st) in strays {
        if seen.contains(m_id) || checked.contains(m_id) { continue; }
        let Some(&idx) = idx_by_id.get(st.series_id.as_str()) else { continue };
        let host = &series[idx];
        if host.metadata_source == "METRON" && metron_identity(host).is_some() {
            walks.entry(idx).or_default().push(m_id.clone());
        } else {
            singles.push((!in_family(idx), m_id.clone(), idx));
        }
    }
    singles.sort();
    let mut walks: Vec<(bool, usize, String, Vec<String>)> = walks.into_iter().map(|(idx, mut ids)| {
        ids.sort();
        (!in_family(idx), idx, series[idx].metadata_id.clone().unwrap_or_default(), ids)
    }).collect();
    walks.sort();
    AuditPlan {
        singles: singles.into_iter().map(|(_, m_id, idx)| (m_id, idx)).collect(),
        walks: walks.into_iter().map(|(_, idx, msid, ids)| (idx, msid, ids)).collect(),
    }
}

/// A walked volume's strays, split by whether its own issue_list contains them (input order kept):
/// the first are at home; the rest are fetched and matched like any other stray.
fn split_walked(m_ids: &[String], own: &HashSet<String>) -> (Vec<String>, Vec<String>) {
    m_ids.iter().cloned().partition(|id| own.contains(id))
}

/// Does an issue_list of `count` issues at `per_page` per page fit under the walk cap?
fn walk_fits(count: i64, per_page: usize) -> bool {
    if per_page == 0 { return true; }
    let pages = (count.max(0) as usize).div_ceil(per_page).max(1);
    pages <= WALK_PAGE_CAP
}

async fn load_audit_checked(db: &Db) -> HashSet<String> {
    let raw: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = $1"#)
        .bind(AUDIT_CHECKED_KEY).fetch_optional(&db.pool).await.ok().flatten();
    raw.and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok()).map(|v| v.into_iter().collect()).unwrap_or_default()
}

/// Persist the checked set, pruned to the ids that are still strays (a downloaded, moved or removed
/// row needs no memory), sorted so the stored value is stable.
async fn save_audit_checked(db: &Db, checked: &HashSet<String>, strays: &StrayMap) {
    let mut ids: Vec<&String> = checked.iter().filter(|id| strays.contains_key(*id)).collect();
    ids.sort();
    let value = serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string());
    if let Err(e) = sqlx::query(r#"INSERT INTO "SystemSetting" (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"#)
        .bind(AUDIT_CHECKED_KEY).bind(value).execute(&db.pool).await
    {
        log::warn!("[Series Monitor] Could not save the stray audit's checked set: {:?}", e);
    }
}

#[derive(Default)]
struct AuditTally {
    calls: usize,
    walked: usize,
    home: usize,
    relocated: usize,
    deleted: usize,
    evicted: usize,
    left: usize,
}

impl AuditTally {
    fn processed(&self) -> usize { self.home + self.relocated + self.deleted + self.evicted + self.left }
}

enum WalkOutcome {
    Own(HashSet<String>),
    /// Over WALK_PAGE_CAP pages, or Metron wouldn't list it (a non-200) — its strays go single.
    Unwalkable,
    OutOfBudget,
}

/// Walk a Metron series' issue_list within `budget` calls. OutOfBudget = stopped before the end
/// (retried next run). Err = the request itself failed; the audit stops for this run.
async fn walk_volume(db: &Db, client: &Client, auth: &(String, String), msid: &str, budget: usize, tally: &mut AuditTally) -> anyhow::Result<WalkOutcome> {
    let mut url = Some(format!("https://metron.cloud/api/series/{}/issue_list/", msid));
    let mut own: HashSet<String> = HashSet::new();
    let (mut used, mut first) = (0usize, true);
    while let Some(u) = url {
        if used >= budget { return Ok(WalkOutcome::OutOfBudget); }
        let (status, data) = crate::metadata::metron_fetch(db, client, auth, &u, 15, 2, None).await?;
        used += 1;
        tally.calls += 1;
        if status != 200 {
            log::warn!("[Series Monitor] issue_list for Metron series {} answered HTTP {}; checking its skeletons one by one.", msid, status);
            return Ok(WalkOutcome::Unwalkable);
        }
        let results = data.get("results").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        if first {
            first = false;
            let count = data.get("count").and_then(|v| v.as_i64()).unwrap_or(results.len() as i64);
            if !walk_fits(count, results.len()) { return Ok(WalkOutcome::Unwalkable); }
            let pages = (count.max(0) as usize).div_ceil(results.len().max(1)).max(1);
            if pages > budget { return Ok(WalkOutcome::OutOfBudget); }
        }
        own.extend(results.iter().filter_map(|r| jstr(r.get("id"))));
        url = data.get("next").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
        if url.is_some() { tokio::time::sleep(std::time::Duration::from_millis(300)).await; }
    }
    Ok(WalkOutcome::Own(own))
}

/// One stray, one detail fetch: relocated or dropped when another local volume is its home, removed
/// when it has none and its host provably isn't it, confirmed when the host is its home. Returns
/// whether to remember it as checked. A row the fetch leaves in doubt stays (deleting on a doubt is
/// how the original defect looked from the other side) and is remembered too — asking again gives
/// the same answer until the library changes.
#[allow(clippy::too_many_arguments)]
async fn audit_single(
    db: &Db, client: &Client, auth: &(String, String), series: &[SeriesRec],
    issues: &mut HashMap<String, Vec<IssueRec>>, strays: &mut StrayMap, m_id: &str, host_idx: usize, tally: &mut AuditTally,
) -> anyhow::Result<bool> {
    let url = format!("https://metron.cloud/api/issue/{}/", m_id);
    let (status, data) = crate::metadata::metron_fetch(db, client, auth, &url, 15, 2, None).await?;
    tally.calls += 1;
    if status != 200 {
        tally.left += 1;
        return Ok(status == 404); // gone from Metron: asking again won't help; anything else: retry next run
    }
    let m_series_id = jstr(data.pointer("/series/id"));
    let m_name = normalize(data.pointer("/series/name").and_then(|v| v.as_str()).unwrap_or(""));
    let m_pub = normalize(data.pointer("/publisher/name").and_then(|v| v.as_str()).unwrap_or(""));
    let year_began = data.pointer("/series/year_began").and_then(|v| v.as_i64()).map(|y| y as i32).filter(|y| *y != 0);
    Ok(match match_series_for_metron_issue(series, m_series_id.as_deref(), &m_name, &m_pub, year_began) {
        MetronMatch::Matched(idx) if idx != host_idx => match heal_stray_skeleton(db, issues, strays, m_id, &series[idx].id).await {
            Some(StrayAction::Relocated) => { tally.relocated += 1; true }
            Some(StrayAction::Deleted) => { tally.deleted += 1; false }
            Some(StrayAction::Evicted) | None => { tally.left += 1; false }
        },
        MetronMatch::Matched(_) => { tally.home += 1; true }
        MetronMatch::NoMatch | MetronMatch::Ambiguous { .. } => {
            match evict_misfiled_stray(db, series, issues, strays, m_id, m_series_id.as_deref(), year_began).await {
                Some(_) => { tally.evicted += 1; false }
                None => { tally.left += 1; true }
            }
        }
    })
}

/// Drain queued single checks within the budget. Err = Metron failed; the audit stops for this run.
#[allow(clippy::too_many_arguments)]
async fn drain_singles(
    db: &Db, client: &Client, auth: &(String, String), series: &[SeriesRec],
    issues: &mut HashMap<String, Vec<IssueRec>>, strays: &mut StrayMap, checked: &mut HashSet<String>,
    queue: &mut std::collections::VecDeque<(String, usize)>, tally: &mut AuditTally,
) -> anyhow::Result<()> {
    while tally.calls < AUDIT_BUDGET {
        let Some((m_id, host_idx)) = queue.pop_front() else { break };
        if audit_single(db, client, auth, series, issues, strays, &m_id, host_idx, tally).await? {
            checked.insert(m_id);
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    Ok(())
}

/// Out-of-window strays (a mis-filed issue that already shipped, say), bounded to AUDIT_BUDGET
/// Metron calls per run through the shared metron_fetch (cache, burst pacing, quota log): single
/// checks first, then Metron-sourced volumes' issue_list walks and the suspects they turn up.
#[allow(clippy::too_many_arguments)]
async fn stray_audit(
    db: &Db, client: &Client, auth: &(String, String),
    series: &[SeriesRec], issues: &mut HashMap<String, Vec<IssueRec>>, strays: &mut StrayMap,
    seen: &HashSet<String>, checked: &mut HashSet<String>, notes: &mut Vec<String>,
) {
    let plan = plan_stray_audit(series, strays, seen, checked);
    let total = plan.singles.len() + plan.walks.iter().map(|w| w.2.len()).sum::<usize>();
    if total == 0 {
        return;
    }
    let mut tally = AuditTally::default();
    let mut queue: std::collections::VecDeque<(String, usize)> = plan.singles.into_iter().collect();
    let mut result = drain_singles(db, client, auth, series, issues, strays, checked, &mut queue, &mut tally).await;
    if result.is_ok() {
        for (host_idx, msid, m_ids) in plan.walks {
            if tally.calls >= AUDIT_BUDGET { break; }
            match walk_volume(db, client, auth, &msid, AUDIT_BUDGET - tally.calls, &mut tally).await {
                Ok(WalkOutcome::Own(own)) => {
                    tally.walked += 1;
                    let (home, suspects) = split_walked(&m_ids, &own);
                    tally.home += home.len();
                    checked.extend(home);
                    queue.extend(suspects.into_iter().map(|id| (id, host_idx)));
                }
                Ok(WalkOutcome::Unwalkable) => queue.extend(m_ids.into_iter().map(|id| (id, host_idx))),
                Ok(WalkOutcome::OutOfBudget) => break,
                Err(e) => { result = Err(e); break; }
            }
            result = drain_singles(db, client, auth, series, issues, strays, checked, &mut queue, &mut tally).await;
            if result.is_err() { break; }
        }
    }
    if let Err(e) = &result {
        notes.push(format!("[Phase 1] #208 audit stopped early: {}", e));
    }
    notes.push(format!(
        "[Phase 1] #208 audit: checked {} of {} unchecked Metron skeleton(s) ({} Metron call(s), {} volume list(s) walked); confirmed {} at home, relocated {}, dropped {}, removed {} (volume not in the library), left {} as they were; {} still to check.",
        tally.processed(), total, tally.calls, tally.walked, tally.home, tally.relocated, tally.deleted, tally.evicted, tally.left,
        total.saturating_sub(tally.processed())
    ));
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
    db: &Db, series_id: &str, metadata_id: &str, source: &str, number: &str,
    name: Option<&str>, description: Option<&str>, release_date: Option<&str>, cover_url: Option<&str>,
) -> Option<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let res = sqlx::query(&format!(
        r#"INSERT INTO "Issue" (id, "seriesId", "metadataId", "metadataSource", "matchState", number, name, description, "releaseDate", "coverUrl", status, "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, 'MATCHED', $5, $6, $7, $8, $9, 'WANTED', {now}, {now})"#,
        now = db.now_expr()
    ))
    .bind(&id).bind(series_id).bind(metadata_id).bind(source).bind(number)
    .bind(name).bind(description).bind(release_date).bind(cover_url)
    .execute(&db.pool).await;
    match res {
        Ok(_) => Some(id),
        Err(e) => { log::warn!("[Series Monitor] Skeleton insert failed (issue #{}): {:?}", number, e); None }
    }
}

async fn update_skeleton_release_date(db: &Db, issue_id: &str, release_date: &str) {
    let _ = sqlx::query(r#"UPDATE "Issue" SET "releaseDate" = $1 WHERE id = $2"#)
        .bind(release_date).bind(issue_id).execute(&db.pool).await;
}

/// Loads every Series + its issues into memory (parity with `findMany({ include: { issues } })`),
/// plus, per series, the run numbers its OWNED collected editions cover (#203 COLLECTED coverage).
async fn load_state(db: &Db) -> Result<(Vec<SeriesRec>, HashMap<String, Vec<IssueRec>>, HashMap<String, Vec<String>>, StrayMap)> {
    let series_rows = sqlx::query(
        // Bool columns are CAST for the Any driver (no SQLite BOOLEAN mapping); nullable monitored
        // is COALESCEd in SQL — the code always treated NULL as false. metronId is an integer column
        // on both dialects; CAST to TEXT reads it uniformly (NULL stays NULL).
        r#"SELECT id, name, publisher, year, "metadataId", "metadataSource", COALESCE(CAST(monitored AS INTEGER), 0) AS monitored, CAST("isManga" AS INTEGER) AS "isManga", "coverUrl", CAST("metronId" AS TEXT) AS "metronId" FROM "Series""#,
    ).fetch_all(&db.pool).await?;
    let series: Vec<SeriesRec> = series_rows.iter().map(|r| SeriesRec {
        id: r.get("id"),
        name: r.get("name"),
        publisher: r.get("publisher"),
        year: r.get("year"),
        metadata_id: r.get("metadataId"),
        metadata_source: r.get("metadataSource"),
        monitored: r.get::<i64, _>("monitored") != 0,
        is_manga: r.get::<i64, _>("isManga") != 0,
        cover_url: r.get("coverUrl"),
        metron_id: r.get::<Option<String>, _>("metronId").filter(|s| !s.is_empty()),
    }).collect();

    // #208: the Metron pass's own file-less rows, by Metron issue id — what the heal may move or drop.
    let stray_rows = sqlx::query(
        r#"SELECT id, "seriesId", "metadataId", number FROM "Issue"
           WHERE "metadataSource" = 'METRON' AND "isAnnual" = false AND "attachedVolumeId" IS NULL
             AND ("filePath" IS NULL OR "filePath" = '') AND "metadataId" IS NOT NULL AND "metadataId" <> ''"#,
    ).fetch_all(&db.pool).await?;
    let mut strays: StrayMap = HashMap::new();
    for r in &stray_rows {
        strays.insert(r.get("metadataId"), StraySkeleton { issue_id: r.get("id"), series_id: r.get("seriesId"), number: r.get("number") });
    }

    // #203: annual rows are invisible to the monitor — its candidates come from the PARENT
    // provider volume, so an owned "Annual #1" must never satisfy an is_already_in_library
    // check for the regular #1 (nor pair with provider skeletons by number). The same holds for
    // every ATTACHED lane row: an owned trade numbered "3" is not issue #3 (#203 COLLECTED).
    let issue_rows = sqlx::query(r#"SELECT id, "seriesId", number, "filePath", "releaseDate" FROM "Issue" WHERE "isAnnual" = false AND "attachedVolumeId" IS NULL"#).fetch_all(&db.pool).await?;
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

    // #203 COLLECTED coverage: which run numbers each series' OWNED collected books reprint. An
    // issue in that set is not a candidate — you have the story — though its skeleton still
    // lives (that row is what the series page's coverage math reads).
    let coverage_rows = sqlx::query(
        r#"SELECT i."seriesId", i."coversIssues" FROM "Issue" i
           JOIN "AttachedVolume" a ON a.id = i."attachedVolumeId"
           WHERE a.kind = 'COLLECTED' AND i."filePath" IS NOT NULL AND i."filePath" <> ''
             AND i."coversIssues" IS NOT NULL AND i."coversIssues" <> ''"#,
    ).fetch_all(&db.pool).await?;
    let mut coverage: HashMap<String, Vec<String>> = HashMap::new();
    for r in &coverage_rows {
        let sid: String = r.get("seriesId");
        let expr: String = r.get("coversIssues");
        let list = coverage.entry(sid).or_default();
        for n in crate::coverage::expand_coverage(&expr) {
            if !list.contains(&n) { list.push(n); }
        }
    }
    coverage.retain(|_, v| !v.is_empty());
    Ok((series, issues, coverage, strays))
}

fn is_already_in_library(issues: &[IssueRec], num: &str) -> bool {
    issues.iter().any(|i| is_same_issue(&i.number, num) && i.file_path.as_deref().map(|p| !p.is_empty()).unwrap_or(false))
}

/// #203 COLLECTED coverage: on disk as a single, OR reprinted in a collected edition that is —
/// either way not something the monitor should ask for. Coverage comes from `load_state`.
fn in_library_or_covered(issues: &[IssueRec], covered: Option<&Vec<String>>, num: &str) -> bool {
    is_already_in_library(issues, num) || covered.is_some_and(|c| crate::coverage::is_covered(num, c))
}

/// Phase 1 — Metron Oracle: paginate global upcoming issues, match to local series, upsert skeletons,
/// and emit candidates for monitored series. Errors are captured into `notes` (Phase 2 still runs).
#[allow(clippy::too_many_arguments)]
async fn phase1_metron(
    db: &Db, client: &Client, user: &str, pass: &str,
    series: &[SeriesRec], issues: &mut HashMap<String, Vec<IssueRec>>, coverage: &HashMap<String, Vec<String>>,
    strays: &mut StrayMap,
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
        crate::api_usage::log(&db.pool, "metron", &url).await;

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

    // #208 bookkeeping: every Metron issue id this window covered (the family audit skips them),
    // the same-name families the year couldn't settle (one note per name+year, not per issue),
    // and what the in-window heal did.
    let mut seen: HashSet<String> = HashSet::new();
    let mut checked = load_audit_checked(db).await;
    let mut skipped: std::collections::BTreeMap<(String, Option<i32>), (usize, usize)> = std::collections::BTreeMap::new();
    let (mut relocated, mut deleted, mut evicted) = (0usize, 0usize, 0usize);

    for m in &metron_issues {
        let m_id = jstr(m.get("id")).unwrap_or_default();
        if !m_id.is_empty() { seen.insert(m_id.clone()); }
        let m_series_id = jstr(m.pointer("/series/id"));
        let m_series_raw = m.pointer("/series/name").and_then(|v| v.as_str()).unwrap_or("");
        let m_series_name = normalize(m_series_raw);
        let m_pub_name = normalize(
            m.pointer("/publisher/name").and_then(|v| v.as_str())
                .or_else(|| m.pointer("/series/publisher/name").and_then(|v| v.as_str()))
                .unwrap_or(""),
        );
        // Metron's issue list nests series {id, name, volume, year_began} — the start year is what
        // tells seven same-name volumes apart.
        let year_began = m.pointer("/series/year_began").and_then(|v| v.as_i64()).map(|y| y as i32).filter(|y| *y != 0);
        let m_num_str = match jstr(m.get("number")).or_else(|| jstr(m.get("issue"))) {
            Some(s) => s,
            None => continue,
        };
        let m_num: f64 = match m_num_str.parse() { Ok(n) => n, Err(_) => continue };

        let idx = match match_series_for_metron_issue(series, m_series_id.as_deref(), &m_series_name, &m_pub_name, year_began) {
            MetronMatch::Matched(idx) => idx,
            unhoused => {
                // No single home: a skeleton the old first-in-table guess filed for it under a volume
                // that provably isn't its own goes (a hash miss for nearly every issue in the list).
                if !m_id.is_empty()
                    && evict_misfiled_stray(db, series, issues, strays, &m_id, m_series_id.as_deref(), year_began).await.is_some()
                {
                    evicted += 1;
                }
                if let MetronMatch::Ambiguous { candidates: n } = unhoused {
                    skipped.entry((m_series_raw.to_string(), year_began)).or_insert((0, n)).0 += 1;
                }
                continue;
            }
        };
        let s = &series[idx];

        // #208 heal: a skeleton for this very Metron issue filed under another series moves here
        // (or goes, if this series already has the number) before the upsert looks at the bucket.
        if !m_id.is_empty() {
            match heal_stray_skeleton(db, issues, strays, &m_id, &s.id).await {
                Some(StrayAction::Relocated) => relocated += 1,
                Some(StrayAction::Deleted) => deleted += 1,
                Some(StrayAction::Evicted) | None => {}
            }
            // Its skeleton now sits under the volume the anchored match names — proven at home for
            // free, so the audit never spends a Metron call on it once it leaves the window.
            if strays.get(&m_id).is_some_and(|st| st.series_id == s.id) {
                checked.insert(m_id.clone());
            }
        }

        let issue_date = m.get("store_date").and_then(|v| v.as_str()).filter(|x| !x.is_empty())
            .or_else(|| m.get("cover_date").and_then(|v| v.as_str()).filter(|x| !x.is_empty()))
            .map(|x| x.to_string());
        let is_released = is_released_yet(m.get("store_date").and_then(|v| v.as_str()), m.get("cover_date").and_then(|v| v.as_str()));

        // Skeleton upsert (matched series, monitored or not — calendar entries). Find by float equality.
        let bucket = issues.entry(s.id.clone()).or_default();
        let existing_pos = bucket.iter().position(|i| i.number.parse::<f64>().ok() == Some(m_num));
        match existing_pos {
            None => {
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

        // Candidate emission (monitored + not already in library, nor covered by an owned trade).
        if s.monitored && !in_library_or_covered(bucket, coverage.get(&s.id), &m_num_str) {
            let issue_year = issue_date.as_deref().and_then(|d| d.split('-').next()).filter(|y| !y.is_empty())
                .map(|y| y.to_string()).unwrap_or_else(|| s.year.to_string());
            let image_url = m.get("image").and_then(|v| v.as_str()).map(|s| s.to_string()).or_else(|| s.cover_url.clone());
            candidates.push(MonitorCandidate {
                volume_id: s.metadata_id.clone().unwrap_or_else(|| s.id.clone()),
                metadata_source: s.metadata_source.clone(),
                search_name: format!("{} #{}", s.name, m_num_str),
                issue_number: m_num_str.clone(),
                issue_year,
                is_released,
                has_date: issue_date.is_some(),
                publisher: s.publisher.clone().unwrap_or_else(|| "Unknown".to_string()),
                is_manga: s.is_manga,
                image_url,
            });
        }
    }

    for ((name, year), (count, n)) in &skipped {
        notes.push(format!(
            "[Phase 1] Skipped {} upcoming issue(s) of \"{}\"{}: {} local series share the name and the start year can't tell them apart (#208).",
            count, name, year.map(|y| format!(" (began {})", y)).unwrap_or_default(), n
        ));
    }
    if relocated + deleted + evicted > 0 {
        notes.push(format!(
            "[Phase 1] #208 heal: relocated {} mis-filed skeleton(s) to the volume Metron names, dropped {} duplicate(s), removed {} belonging to a volume not in the library.",
            relocated, deleted, evicted
        ));
    }
    stray_audit(db, client, &(user.to_string(), pass.to_string()), series, issues, strays, &seen, &mut checked, notes).await;
    save_audit_checked(db, &checked, strays).await;
}

/// Phase 2 — ComicVine: for the 25 oldest monitored CV series, fetch their latest 30 issues, upsert
/// skeletons for not-in-library issues, emit candidates, and bump the series' updatedAt (rotates the window).
async fn phase2_comicvine(
    db: &Db, client: &Client, cv_api_key: &str,
    issues: &mut HashMap<String, Vec<IssueRec>>, coverage: &HashMap<String, Vec<String>>,
    skeletons_created: &mut i32, candidates: &mut Vec<MonitorCandidate>,
) -> Result<()> {
    let rows = sqlx::query(
        // isManga is CAST for the Any driver (no SQLite BOOLEAN mapping); `monitored = true`
        // stays — SQLite 3.23+ reads the TRUE literal as 1, matching the stored 0/1.
        r#"SELECT id, name, publisher, year, "metadataId", CAST("isManga" AS INTEGER) AS "isManga", "coverUrl" FROM "Series"
           WHERE monitored = true AND "metadataSource" = 'COMICVINE' ORDER BY "updatedAt" ASC LIMIT 25"#,
    ).fetch_all(&db.pool).await?;

    for row in &rows {
        let series_id: String = row.get("id");
        let series_name: String = row.get("name");
        let publisher: Option<String> = row.get("publisher");
        let year: i32 = row.get("year");
        let cv_id: Option<String> = row.get("metadataId");
        let is_manga: bool = row.get::<i64, _>("isManga") != 0;
        let cover_url: Option<String> = row.get("coverUrl");

        let Some(cv_id) = cv_id else { continue };

        let issue_req = match client.get("https://comicvine.gamespot.com/api/issues/")
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
            .build()
        {
            Ok(r) => r,
            Err(_) => continue,
        };
        let full_url = issue_req.url().to_string();

        // Shared response cache: with the cache on, a brand-new issue is noticed at most one
        // list-TTL late — the documented freshness trade-off of metadata_cache_enabled.
        let data: Value = match crate::metadata_cache::get(db, "comicvine", &full_url).await {
            Some(hit) => hit,
            None => {
                let resp = client.execute(issue_req).await;
                crate::api_usage::log(&db.pool, "comicvine", "https://comicvine.gamespot.com/api/issues/").await;
                match resp.and_then(|r| r.error_for_status()) {
                    Ok(r) => match r.json::<Value>().await {
                        Ok(d) => {
                            crate::metadata_cache::put(db, "comicvine", &full_url, &d).await;
                            d
                        }
                        Err(_) => continue,
                    },
                    Err(_) => continue, // Node swallows per-series CV errors.
                }
            }
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

            // The skeleton above is kept either way; only the CANDIDATE is withheld for a covered issue.
            if in_library_or_covered(bucket, coverage.get(&series_id), &cv_num_str) { continue; }

            let issue_year = issue_date.as_deref().and_then(|d| d.split('-').next()).filter(|y| !y.is_empty())
                .map(|y| y.to_string()).unwrap_or_else(|| year.to_string());
            let image_url = cv.pointer("/image/medium_url").and_then(|v| v.as_str()).map(|s| s.to_string()).or_else(|| cover_url.clone());
            candidates.push(MonitorCandidate {
                volume_id: cv_id.clone(),
                // This phase queries only COMICVINE-monitored series (see the SQL filter above).
                metadata_source: "COMICVINE".to_string(),
                search_name: format!("{} #{}", series_name, cv_num_str),
                issue_number: cv_num_str.clone(),
                issue_year,
                is_released,
                has_date: issue_date.is_some(),
                publisher: publisher.clone().unwrap_or_else(|| "Unknown".to_string()),
                is_manga,
                image_url,
            });
        }

        let _ = sqlx::query(&format!(r#"UPDATE "Series" SET "updatedAt" = {} WHERE id = $1"#, db.now_expr())).bind(&series_id).execute(&db.pool).await;
        tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
    }
    Ok(())
}

pub async fn run_series_monitor(db: Db) -> Result<MonitorOutput> {
    let (series, mut issues, coverage, mut strays) = load_state(&db).await?;
    let client = Client::builder().build()?;

    let mut skeletons_created = 0;
    let mut candidates: Vec<MonitorCandidate> = Vec::new();
    let mut notes: Vec<String> = Vec::new();

    // Phase 1 — Metron (only when credentials are present).
    let creds = sqlx::query(r#"SELECT key, value FROM "SystemSetting" WHERE key IN ('metron_user','metron_pass')"#).fetch_all(&db.pool).await?;
    let mut metron_user = String::new();
    let mut metron_pass = String::new();
    for r in &creds {
        let k: String = r.get("key");
        let v: String = r.get("value");
        if k == "metron_user" { metron_user = v; } else if k == "metron_pass" { metron_pass = v; }
    }
    let metron_pass = crate::secret_crypto::decrypt_setting(&db.pool, Some(metron_pass)).await.unwrap_or_default();
    if !metron_user.is_empty() && !metron_pass.is_empty() {
        phase1_metron(&db, &client, &metron_user, &metron_pass, &series, &mut issues, &coverage, &mut strays, &mut skeletons_created, &mut candidates, &mut notes).await;
    }

    // Phase 2 — ComicVine (only when a key is present).
    let cv_api_key: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'cv_api_key'"#)
        .fetch_optional(&db.pool).await?;
    let cv_api_key = crate::secret_crypto::decrypt_setting(&db.pool, cv_api_key).await.filter(|s| !s.is_empty());
    if let Some(key) = cv_api_key {
        if let Err(e) = phase2_comicvine(&db, &client, &key, &mut issues, &coverage, &mut skeletons_created, &mut candidates).await {
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

    // #203 COLLECTED coverage: a covered issue is withheld from candidates exactly like an owned one.
    #[test]
    fn covered_counts_as_in_library_for_candidates_only_when_an_owned_book_says_so() {
        let issues = vec![issue("3", Some("/lib/3.cbz")), issue("21", None)];
        let covered = vec!["21".to_string(), "22".to_string()];
        assert!(in_library_or_covered(&issues, Some(&covered), "3"));    // on disk
        assert!(in_library_or_covered(&issues, Some(&covered), "21"));   // a skeleton, but reprinted in an owned trade
        assert!(in_library_or_covered(&issues, Some(&covered), "022"));  // number rules apply to coverage too
        assert!(!in_library_or_covered(&issues, Some(&covered), "23"));
        assert!(!in_library_or_covered(&issues, None, "21"));
    }

    /// A file-backed fixture with the three tables load_state reads (the Any driver's in-memory
    /// handling differs per connection — the same shape attached_volumes/scanner tests use).
    async fn fixture(tag: &str) -> Db {
        let base = std::env::temp_dir().join(format!("omnibus_mon_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("create fixture dir");
        let db_file = base.join("mon.db");
        std::fs::File::create(&db_file).expect("pre-create sqlite file");
        let db_url = format!("file:{}", db_file.to_string_lossy().replace('\\', "/"));
        let db = Db::connect(&db_url, 2).await.expect("connect file-backed sqlite");
        for ddl in [
            r#"CREATE TABLE "Series" (id TEXT PRIMARY KEY, name TEXT, publisher TEXT, year INTEGER, "metadataId" TEXT,
                "metadataSource" TEXT, monitored INTEGER, "isManga" INTEGER DEFAULT 0, "coverUrl" TEXT, "metronId" INTEGER)"#,
            r#"CREATE TABLE "Issue" (id TEXT PRIMARY KEY, "seriesId" TEXT, number TEXT, "filePath" TEXT, "releaseDate" TEXT,
                "isAnnual" INTEGER DEFAULT 0, "attachedVolumeId" TEXT, "coversIssues" TEXT, "metadataId" TEXT, "metadataSource" TEXT)"#,
            r#"CREATE TABLE "AttachedVolume" (id TEXT PRIMARY KEY, "seriesId" TEXT, kind TEXT)"#,
            r#"CREATE TABLE "SystemSetting" (key TEXT PRIMARY KEY, value TEXT)"#,
        ] {
            sqlx::query(ddl).execute(&db.pool).await.expect("create schema");
        }
        db
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_series(db: &Db, id: &str, name: &str, publisher: &str, year: i32, meta_id: &str, source: &str, monitored: i32, metron_id: Option<i64>) {
        sqlx::query(r#"INSERT INTO "Series" (id, name, publisher, year, "metadataId", "metadataSource", monitored, "isManga", "coverUrl", "metronId")
                       VALUES ($1,$2,$3,$4,$5,$6,$7,0,NULL,$8)"#)
            .bind(id).bind(name).bind(publisher).bind(year).bind(meta_id).bind(source).bind(monitored).bind(metron_id)
            .execute(&db.pool).await.unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_issue(db: &Db, id: &str, series_id: &str, num: &str, path: Option<&str>, annual: i32, lane: Option<&str>, covers: Option<&str>, meta_id: Option<&str>, source: Option<&str>) {
        sqlx::query(r#"INSERT INTO "Issue" (id, "seriesId", number, "filePath", "releaseDate", "isAnnual", "attachedVolumeId", "coversIssues", "metadataId", "metadataSource")
                       VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9)"#)
            .bind(id).bind(series_id).bind(num).bind(path).bind(annual).bind(lane).bind(covers).bind(meta_id).bind(source)
            .execute(&db.pool).await.unwrap();
    }

    #[tokio::test]
    async fn load_state_keeps_lane_rows_out_of_the_run_and_reads_only_owned_coverage() {
        let db = fixture("coverage").await;
        insert_series(&db, "s1", "Absolute Batman", "DC", 2024, "160294", "COMICVINE", 1, None).await;
        sqlx::query(r#"INSERT INTO "AttachedVolume" VALUES ('att1','s1','COLLECTED')"#).execute(&db.pool).await.unwrap();
        for (id, num, path, annual, lane, covers) in [
            ("run3", "3", Some("/lib/AB 003.cbz"), 0, None, None),             // the run, on disk
            ("run21", "21", None, 0, None, None),                              // the run, a skeleton
            ("ann1", "1", Some("/lib/AB Annual 001.cbz"), 1, None, None),      // an annual — invisible
            ("vol3", "3", Some("/lib/AB Vol 3.cbz"), 0, Some("att1"), Some("15-23")), // an OWNED trade, numbered "3"
            ("vol1", "1", None, 0, Some("att1"), Some("1-6")),                 // a trade NOT owned — covers nothing
        ] {
            insert_issue(&db, id, "s1", num, path, annual, lane, covers, None, None).await;
        }

        let (series, issues, coverage, _strays) = load_state(&db).await.unwrap();

        assert_eq!(series.len(), 1);
        let mut run: Vec<&str> = issues["s1"].iter().map(|i| i.number.as_str()).collect();
        run.sort();
        assert_eq!(run, vec!["21", "3"], "no lane row and no annual in the run — an owned trade numbered 3 is not issue #3");
        assert_eq!(coverage["s1"], (15..=23).map(|n| n.to_string()).collect::<Vec<_>>(), "only the OWNED book's coverage");
        // The trade's own "3" never made #3 look owned; #21 is withheld only through coverage.
        assert!(!is_already_in_library(&issues["s1"], "21"));
        assert!(in_library_or_covered(&issues["s1"], coverage.get("s1"), "21"));
        assert!(!in_library_or_covered(&issues["s1"], coverage.get("s1"), "5"));
    }

    // ==== #208 (anacronismo): Phase 1 matched Metron's upcoming issues to a local series by
    // normalized name + publisher only and took the first row in table order — every upcoming
    // "X-Men" issue landed on whichever of his seven X-Men volumes was inserted first (the 2013
    // run), as METRON skeletons with the 2024 covers. The match is now anchored on the Metron id
    // (the series' own, or the cross-provider metronId the matcher stores on a ComicVine series),
    // then on name + publisher + Metron's year_began — and a same-name family that the year can't
    // settle is skipped, never guessed.

    fn rec(id: &str, name: &str, publisher: &str, year: i32, source: &str, meta_id: Option<&str>, metron_id: Option<&str>) -> SeriesRec {
        SeriesRec {
            id: id.into(), name: name.into(), publisher: Some(publisher.into()), year,
            metadata_id: meta_id.map(|s| s.into()), metadata_source: source.into(),
            monitored: true, is_manga: false, cover_url: None, metron_id: metron_id.map(|s| s.into()),
        }
    }

    fn xmen_family() -> Vec<SeriesRec> {
        vec![
            rec("s2013", "X-Men", "Marvel", 2013, "COMICVINE", Some("65678"), None),
            rec("s2019", "X-Men", "Marvel", 2019, "COMICVINE", Some("122333"), None),
            rec("s2024", "X-Men", "Marvel", 2024, "COMICVINE", Some("160511"), None),
        ]
    }

    #[test]
    fn metron_match_prefers_the_metron_sourced_series_id() {
        let mut series = xmen_family();
        series.push(rec("m2024", "X-Men", "Marvel", 2024, "METRON", Some("7914"), None));
        // Even with a same-name ComicVine 2024 row earlier in the table, the Metron-sourced id wins.
        assert_eq!(match_series_for_metron_issue(&series, Some("7914"), "xmen", "marvel", Some(2024)), MetronMatch::Matched(3));
    }

    #[test]
    fn metron_match_uses_the_cross_provider_metron_id_on_a_comicvine_series() {
        let mut series = xmen_family();
        series[2].metron_id = Some("7914".into());
        // The matcher stored metronId on the ComicVine row; the id decides before any name is compared.
        assert_eq!(match_series_for_metron_issue(&series, Some("7914"), "xmen", "marvel", None), MetronMatch::Matched(2));
    }

    #[test]
    fn metron_match_picks_the_same_name_volume_whose_year_began_agrees() {
        let series = xmen_family();
        // 2013 sits first in table order — the exact bug; the year picks 2024.
        assert_eq!(match_series_for_metron_issue(&series, Some("7914"), "xmen", "marvel", Some(2024)), MetronMatch::Matched(2));
        assert_eq!(match_series_for_metron_issue(&series, None, "xmen", "marvel", Some(2019)), MetronMatch::Matched(1));
        assert_eq!(match_series_for_metron_issue(&series, None, "xmen", "marvel", Some(2013)), MetronMatch::Matched(0));
    }

    #[test]
    fn metron_match_never_guesses_between_same_name_volumes_without_a_year() {
        let series = xmen_family();
        assert_eq!(match_series_for_metron_issue(&series, Some("7914"), "xmen", "marvel", None), MetronMatch::Ambiguous { candidates: 3 });
    }

    #[test]
    fn metron_match_finds_no_home_when_no_same_name_volume_is_within_a_year() {
        // #208 round 2: his Uncanny X-Men family is 2013 / 2016 / 2019 and Metron's upcoming issues
        // are the 2024 run he doesn't own. The year rules every local volume out — that is "not in
        // the library", not a family the year can't settle.
        let uncanny = vec![
            rec("u2013", "Uncanny X-Men", "Marvel", 2013, "COMICVINE", Some("65678"), None),
            rec("u2016", "Uncanny X-Men", "Marvel", 2016, "COMICVINE", Some("90001"), None),
            rec("u2019", "Uncanny X-Men", "Marvel", 2019, "COMICVINE", Some("120001"), None),
        ];
        assert_eq!(match_series_for_metron_issue(&uncanny, Some("8106"), "uncannyxmen", "marvel", Some(2024)), MetronMatch::NoMatch);
        // A year between the volumes that none of them is within a year of: no home either.
        assert_eq!(match_series_for_metron_issue(&xmen_family(), None, "xmen", "marvel", Some(2016)), MetronMatch::NoMatch);
        // A same-name volume with no recorded year could be the one — that stays ambiguous.
        let mut with_unknown = uncanny.clone();
        with_unknown.push(rec("u0", "Uncanny X-Men", "Marvel", 0, "COMICVINE", None, None));
        assert_eq!(match_series_for_metron_issue(&with_unknown, None, "uncannyxmen", "marvel", Some(2024)), MetronMatch::Ambiguous { candidates: 4 });
    }

    #[test]
    fn metron_match_falls_back_to_the_only_neighbour_within_a_year() {
        let series = xmen_family();
        // Metron says 2025 (cover-date vs store-date drift): only the 2024 run is within a year.
        assert_eq!(match_series_for_metron_issue(&series, None, "xmen", "marvel", Some(2025)), MetronMatch::Matched(2));
        let close = vec![
            rec("a", "Batman", "DC", 2023, "COMICVINE", None, None),
            rec("b", "Batman", "DC", 2025, "COMICVINE", None, None),
        ];
        // Two volumes each a year away → ambiguous, skipped.
        assert_eq!(match_series_for_metron_issue(&close, None, "batman", "dc", Some(2024)), MetronMatch::Ambiguous { candidates: 2 });
    }

    #[test]
    fn metron_match_rejects_a_lone_same_name_volume_from_a_different_era() {
        let only_2013 = vec![rec("s2013", "X-Men", "Marvel", 2013, "COMICVINE", Some("65678"), None)];
        // The library has only the 2013 run: a 2024 upcoming issue is a volume it doesn't own.
        assert_eq!(match_series_for_metron_issue(&only_2013, Some("7914"), "xmen", "marvel", Some(2024)), MetronMatch::NoMatch);
        // Within a year of it, or with no year from Metron at all (the pre-#208 behaviour), it matches.
        assert_eq!(match_series_for_metron_issue(&only_2013, None, "xmen", "marvel", Some(2014)), MetronMatch::Matched(0));
        assert_eq!(match_series_for_metron_issue(&only_2013, None, "xmen", "marvel", None), MetronMatch::Matched(0));
        // A local series with no year recorded can't be told apart by year — accept it as before.
        let unknown_year = vec![rec("s0", "X-Men", "Marvel", 0, "COMICVINE", None, None)];
        assert_eq!(match_series_for_metron_issue(&unknown_year, None, "xmen", "marvel", Some(2024)), MetronMatch::Matched(0));
    }

    #[test]
    fn metron_match_requires_the_publisher_when_metron_names_one() {
        let series = vec![
            rec("img", "X-Men", "Image", 2024, "COMICVINE", None, None),
            rec("mvl", "X-Men", "Marvel", 2024, "COMICVINE", None, None),
        ];
        assert_eq!(match_series_for_metron_issue(&series, None, "xmen", "marvel", Some(2024)), MetronMatch::Matched(1));
        // Two exact-year rows and no publisher to split them → skipped, not the first one.
        assert_eq!(match_series_for_metron_issue(&series, None, "xmen", "", Some(2024)), MetronMatch::Ambiguous { candidates: 2 });
        assert_eq!(match_series_for_metron_issue(&series, None, "wolverine", "marvel", Some(2024)), MetronMatch::NoMatch);
    }

    #[tokio::test]
    async fn load_state_reads_metron_ids_and_the_file_less_metron_skeletons() {
        let db = fixture("strays").await;
        insert_series(&db, "s2013", "X-Men", "Marvel", 2013, "65678", "COMICVINE", 0, None).await;
        insert_series(&db, "s2024", "X-Men", "Marvel", 2024, "160511", "COMICVINE", 1, Some(7914)).await;
        insert_issue(&db, "stray34", "s2013", "34", None, 0, None, None, Some("172602"), Some("METRON")).await;      // file-less METRON → a stray candidate
        insert_issue(&db, "owned35", "s2013", "35", Some("/lib/x35.cbz"), 0, None, None, Some("172603"), Some("METRON")).await; // has a file → never touched
        insert_issue(&db, "cv36", "s2013", "36", None, 0, None, None, Some("99"), Some("COMICVINE")).await;           // ComicVine skeleton → not Metron's
        insert_issue(&db, "lane1", "s2013", "1", None, 0, Some("att1"), None, Some("172700"), Some("METRON")).await;   // a lane row → invisible

        let (series, _issues, _coverage, strays) = load_state(&db).await.unwrap();

        let by_id: HashMap<&str, &SeriesRec> = series.iter().map(|s| (s.id.as_str(), s)).collect();
        assert_eq!(by_id["s2024"].metron_id.as_deref(), Some("7914"), "metronId is read as text on every dialect");
        assert_eq!(by_id["s2013"].metron_id, None);
        assert_eq!(strays.len(), 1);
        let stray = &strays["172602"];
        assert_eq!((stray.issue_id.as_str(), stray.series_id.as_str(), stray.number.as_str()), ("stray34", "s2013", "34"));
    }

    #[tokio::test]
    async fn heal_relocates_a_stray_skeleton_to_the_volume_metron_names() {
        let db = fixture("relocate").await;
        insert_series(&db, "s2013", "X-Men", "Marvel", 2013, "65678", "COMICVINE", 0, None).await;
        insert_series(&db, "s2024", "X-Men", "Marvel", 2024, "160511", "COMICVINE", 1, None).await;
        insert_issue(&db, "stray34", "s2013", "34", None, 0, None, None, Some("172602"), Some("METRON")).await;
        let (_series, mut issues, _coverage, mut strays) = load_state(&db).await.unwrap();

        let action = heal_stray_skeleton(&db, &mut issues, &mut strays, "172602", "s2024").await;

        assert_eq!(action, Some(StrayAction::Relocated));
        let owner: String = sqlx::query_scalar(r#"SELECT "seriesId" FROM "Issue" WHERE id = 'stray34'"#).fetch_one(&db.pool).await.unwrap();
        assert_eq!(owner, "s2024", "the row moved; its id, number and cover survive");
        // The in-memory buckets follow the row, so the upsert that follows sees #34 under 2024 and
        // the 2013 run no longer reports it missing.
        assert!(issues.get("s2013").map(|b| b.is_empty()).unwrap_or(true));
        assert_eq!(issues["s2024"].iter().map(|i| i.number.as_str()).collect::<Vec<_>>(), vec!["34"]);
        assert_eq!(strays["172602"].series_id, "s2024");
        // Already where it belongs → nothing to do.
        assert_eq!(heal_stray_skeleton(&db, &mut issues, &mut strays, "172602", "s2024").await, None);
        assert_eq!(heal_stray_skeleton(&db, &mut issues, &mut strays, "no-such-id", "s2024").await, None);
    }

    #[tokio::test]
    async fn heal_deletes_a_stray_when_the_right_volume_already_has_the_number() {
        let db = fixture("delete").await;
        insert_series(&db, "s2013", "X-Men", "Marvel", 2013, "65678", "COMICVINE", 0, None).await;
        insert_series(&db, "s2024", "X-Men", "Marvel", 2024, "160511", "COMICVINE", 1, None).await;
        insert_issue(&db, "stray34", "s2013", "34", None, 0, None, None, Some("172602"), Some("METRON")).await;
        insert_issue(&db, "own34", "s2024", "034", Some("/lib/X-Men 034.cbz"), 0, None, None, Some("160511-34"), Some("COMICVINE")).await;
        let (_series, mut issues, _coverage, mut strays) = load_state(&db).await.unwrap();

        let action = heal_stray_skeleton(&db, &mut issues, &mut strays, "172602", "s2024").await;

        assert_eq!(action, Some(StrayAction::Deleted));
        let left: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM "Issue" WHERE id = 'stray34'"#).fetch_one(&db.pool).await.unwrap();
        assert_eq!(left, 0, "the 2024 run already has #34 (as \"034\") — the twin is dropped, not duplicated");
        assert!(issues.get("s2013").map(|b| b.is_empty()).unwrap_or(true));
        assert_eq!(issues["s2024"].len(), 1);
        assert!(!strays.contains_key("172602"));
    }

    // ==== #208 lone-volume audit: the out-of-window audit visited same-name FAMILIES only, so a
    // stray the old first-in-table guess filed under a LONE same-name volume (a library with just
    // X-Men 2013 got X-Men 2024's issues too) stayed once it left the Oracle window. The audit now
    // covers every unseen stray, remembers the ones it has proven at home so the cost is one-time,
    // and settles a Metron-sourced volume's own rows with one issue_list walk instead of a fetch each.

    fn strays_of(rows: &[(&str, &str)]) -> StrayMap {
        rows.iter().map(|(m_id, series_id)| {
            ((*m_id).to_string(), StraySkeleton { issue_id: format!("i{}", m_id), series_id: (*series_id).into(), number: "1".into() })
        }).collect()
    }

    #[test]
    fn the_stray_audit_plans_every_unseen_unchecked_stray_families_first() {
        let series = vec![
            rec("x2013", "X-Men", "Marvel", 2013, "COMICVINE", None, None),
            rec("x2024", "X-Men", "Marvel", 2024, "COMICVINE", None, None),
            rec("u2013", "Uncanny X-Men", "Marvel", 2013, "COMICVINE", None, None),  // LONE — the gap
            rec("hulk", "Hulk", "Marvel", 2021, "COMICVINE", None, Some("7000")),     // ComicVine with a metronId
            rec("wolv", "Wolverine", "Marvel", 2024, "METRON", Some("9000"), None),   // Metron-sourced
            rec("slug", "Storm", "Marvel", 2023, "METRON", Some("storm-2023"), None), // Metron-sourced by slug — no id to walk
        ];
        let strays = strays_of(&[
            ("300", "x2013"),  // family → single, first
            ("100", "u2013"),  // lone ComicVine volume → single (was never audited)
            ("200", "hulk"),   // ComicVine host with a metronId → single (its Metron rows are the monitor's)
            ("250", "slug"),   // slug-keyed Metron host → single, never a walk of /series/<slug>/
            ("400", "x2013"),  // seen by the Oracle this run → not planned
            ("500", "u2013"),  // already proven at home on an earlier run → not planned
            ("610", "wolv"),   // Metron-sourced host → one walk of its own issue list for both
            ("600", "wolv"),
            ("700", "gone"),   // host no longer in the library → not planned
        ]);
        let seen: HashSet<String> = ["400".to_string()].into_iter().collect();
        let checked: HashSet<String> = ["500".to_string()].into_iter().collect();

        let plan = plan_stray_audit(&series, &strays, &seen, &checked);

        assert_eq!(plan.singles, vec![("300".to_string(), 0usize), ("100".to_string(), 2usize), ("200".to_string(), 3usize), ("250".to_string(), 5usize)]);
        assert_eq!(plan.walks, vec![(4usize, "9000".to_string(), vec!["600".to_string(), "610".to_string()])]);
    }

    #[test]
    fn a_walked_volume_keeps_its_own_issues_and_suspects_the_rest() {
        let own: HashSet<String> = ["600", "601", "602"].iter().map(|s| s.to_string()).collect();
        let (home, suspects) = split_walked(&["600".to_string(), "610".to_string(), "602".to_string()], &own);
        assert_eq!(home, vec!["600".to_string(), "602".to_string()]);
        assert_eq!(suspects, vec!["610".to_string()], "not in the volume's own list → fetched and matched like any stray");
    }

    #[test]
    fn a_volume_walk_is_attempted_only_when_it_fits_the_page_cap() {
        assert!(walk_fits(250, 100));                       // 3 pages
        assert!(walk_fits(0, 0));                           // an empty list is one page, already read
        assert!(walk_fits((WALK_PAGE_CAP * 100) as i64, 100));
        assert!(!walk_fits((WALK_PAGE_CAP * 100 + 1) as i64, 100), "one page over the cap → the volume's strays fall back to single checks");
    }

    #[tokio::test]
    async fn the_checked_set_persists_and_is_pruned_to_rows_that_are_still_strays() {
        let db = fixture("checked").await;
        assert!(load_audit_checked(&db).await.is_empty(), "no setting yet → nothing checked");

        let checked: HashSet<String> = ["100", "200", "300"].iter().map(|s| s.to_string()).collect();
        let strays = strays_of(&[("100", "u2013"), ("300", "x2013"), ("900", "x2013")]);
        save_audit_checked(&db, &checked, &strays).await;

        let back = load_audit_checked(&db).await;
        let mut ids: Vec<&str> = back.iter().map(|s| s.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["100", "300"], "200 is no longer a stray (downloaded, moved or removed) → dropped from the set");

        sqlx::query(r#"UPDATE "SystemSetting" SET value = 'not json' WHERE key = $1"#).bind(AUDIT_CHECKED_KEY).execute(&db.pool).await.unwrap();
        assert!(load_audit_checked(&db).await.is_empty(), "an unreadable value starts over rather than failing the run");
    }

    // ==== #208 round 2 (anacronismo): X-Men (2013) healed, Uncanny X-Men (2013) did not — the heal
    // only moved a stray TO a matched local volume, and he doesn't own Uncanny X-Men (2024), so its
    // upcoming #36-38 had no home to move to and stayed on the 2013 run. A stray whose host is
    // provably another volume, for an issue with no single local home, is now evicted.

    #[test]
    fn a_host_is_misfiled_only_when_the_year_or_the_metron_id_proves_it() {
        let host = |year: i32, source: &str, meta: Option<&str>, metron: Option<&str>| rec("h", "Uncanny X-Men", "Marvel", year, source, meta, metron);
        // Began 2013, Metron says the issue's volume began 2024 → not this volume.
        assert!(stray_host_is_misfiled(&host(2013, "COMICVINE", Some("65678"), None), Some("8106"), Some(2024)));
        // Within a year (cover-date drift) → could be it; never evicted on a doubt.
        assert!(!stray_host_is_misfiled(&host(2023, "COMICVINE", None, None), None, Some(2024)));
        // No recorded year on the host, or no year from Metron, and no ids → nothing proves it.
        assert!(!stray_host_is_misfiled(&host(0, "COMICVINE", None, None), Some("8106"), Some(2024)));
        assert!(!stray_host_is_misfiled(&host(2013, "COMICVINE", None, None), Some("8106"), None));
        // A Metron identity decides before the year: another Metron series is another volume even in
        // the same year; the Metron series itself is home.
        assert!(stray_host_is_misfiled(&host(2024, "COMICVINE", None, Some("9000")), Some("8106"), Some(2024)));
        assert!(stray_host_is_misfiled(&host(2024, "METRON", Some("9000"), None), Some("8106"), Some(2024)));
        assert!(!stray_host_is_misfiled(&host(2013, "COMICVINE", None, Some("8106")), Some("8106"), Some(2024)));
        // A Metron-sourced series can carry a name SLUG as its metadataId (the sync resolves it by
        // search) — that is no Metron identity, so it never "proves" a mismatch; the year decides.
        assert!(!stray_host_is_misfiled(&host(2024, "METRON", Some("uncanny-x-men-2024"), None), Some("8106"), Some(2024)));
        assert!(stray_host_is_misfiled(&host(2013, "METRON", Some("uncanny-x-men-2013"), None), Some("8106"), Some(2024)));
    }

    #[tokio::test]
    async fn evict_drops_a_stray_whose_volume_is_not_in_the_library() {
        let db = fixture("evict").await;
        insert_series(&db, "u2013", "Uncanny X-Men", "Marvel", 2013, "65678", "COMICVINE", 0, None).await;
        insert_series(&db, "u2016", "Uncanny X-Men", "Marvel", 2016, "90001", "COMICVINE", 0, None).await;
        insert_series(&db, "u0", "Uncanny X-Men", "Marvel", 0, "70000", "COMICVINE", 0, None).await;
        insert_issue(&db, "own35", "u2013", "35", Some("/lib/UXM 035.cbz"), 0, None, None, Some("65678-35"), Some("COMICVINE")).await;
        insert_issue(&db, "stray36", "u2013", "36", None, 0, None, None, Some("174666"), Some("METRON")).await;
        insert_issue(&db, "stray37", "u0", "37", None, 0, None, None, Some("174667"), Some("METRON")).await;
        let (series, mut issues, _coverage, mut strays) = load_state(&db).await.unwrap();

        let action = evict_misfiled_stray(&db, &series, &mut issues, &mut strays, "174666", Some("8106"), Some(2024)).await;

        assert_eq!(action, Some(StrayAction::Evicted));
        let left: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM "Issue" WHERE id = 'stray36'"#).fetch_one(&db.pool).await.unwrap();
        assert_eq!(left, 0, "Uncanny X-Men (2024) #36 no longer shows missing from the 2013 run");
        assert_eq!(issues["u2013"].iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["own35"], "the run's own issues are untouched");
        assert!(!strays.contains_key("174666"));
        // A host with no recorded year can't be proven wrong → left as it is.
        assert_eq!(evict_misfiled_stray(&db, &series, &mut issues, &mut strays, "174667", Some("8106"), Some(2024)).await, None);
        let kept: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM "Issue" WHERE id = 'stray37'"#).fetch_one(&db.pool).await.unwrap();
        assert_eq!(kept, 1);
        // No stray for this Metron issue (the common case for the industry-wide list) → nothing.
        assert_eq!(evict_misfiled_stray(&db, &series, &mut issues, &mut strays, "999999", Some("8106"), Some(2024)).await, None);
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
