use anyhow::Result;
use crate::db::Db;
use serde::Deserialize;
use sqlx::Row;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use zip::ZipArchive;
use tokio::task::JoinSet;
use regex::Regex;
use std::sync::{Mutex, MutexGuard, OnceLock};

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "PascalCase")]
struct ComicInfo {
    title: Option<String>,
    series: Option<String>,
    number: Option<String>,
    year: Option<i32>,
    #[serde(default)]
    month: Option<i32>,
    #[serde(default)]
    day: Option<i32>,
    #[serde(default)]
    volume: Option<String>,
    // #203: <Format> is one of the annual-domain signals (annual_flag_for_signals).
    #[serde(default)]
    format: Option<String>,
    publisher: Option<String>,
    manga: Option<String>,
    #[serde(default)]
    universe: Option<String>,
    #[serde(default)]
    series_group: Option<String>,
    #[serde(default)]
    imprint: Option<String>,
    #[serde(default)]
    writer: Option<String>,
    #[serde(default)]
    penciller: Option<String>,
    #[serde(default)]
    characters: Option<String>,
    #[serde(default)]
    web: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    comic_vine_volume_id: Option<String>,
    #[serde(default)]
    metron_id: Option<String>,
    #[serde(default)]
    comic_vine_issue_id: Option<String>,
    #[serde(default)]
    metron_issue_id: Option<String>,
}

struct PreProcessedFile {
    original_path: PathBuf,
    working_path: PathBuf,
    meta: Option<ComicInfo>,
}

/// `4050-(\d+)` — the numeric ComicVine VOLUME id inside an embedded `/volume/4050-<id>/` Web URL.
fn re_cv_volume() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"4050-(\d+)").unwrap())
}

/// `/series/(\d+)` — the numeric Metron SERIES id inside an embedded `/series/<id>/` Web URL.
fn re_metron_series() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"/series/(\d+)").unwrap())
}

/// `4000-(\d+)` — the numeric ComicVine ISSUE id inside an embedded `/issue/4000-<id>/` Web URL.
fn re_cv_issue() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"4000-(\d+)").unwrap())
}

/// `/issue/(\d+)` — the numeric Metron ISSUE id inside an embedded `/issue/<id>/` Web URL.
fn re_metron_issue() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"/issue/(\d+)").unwrap())
}

// ==========================================
// ONE SWEEP AT A TIME
// ==========================================
// Three things trigger a sweep: the schedule, the importer after it routes a batch pack here, and
// an admin's Run now. A sweep converting big packs can outlast the next trigger, and two sweeps
// over one folder race each other's moves and imports (#240). A trigger that lands mid-sweep is
// folded into ONE more sweep after the running one - its files may have arrived after the running
// sweep listed the folder, so dropping it would leave them for the next scheduled run.

struct SweepState {
    running: bool,
    rerun: bool,
}

/// Admits one watched-folder sweep at a time; see [`spawn_exclusive`].
pub(crate) struct SweepGate(Mutex<SweepState>);

/// The gate every watched-folder trigger goes through.
pub(crate) static WATCHED_SWEEP: SweepGate = SweepGate::new();

impl SweepGate {
    pub(crate) const fn new() -> Self {
        SweepGate(Mutex::new(SweepState { running: false, rerun: false }))
    }

    fn state(&self) -> MutexGuard<'_, SweepState> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Claims the gate, or None when a sweep is running - which then sweeps once more.
    fn try_acquire(&'static self) -> Option<SweepClaim> {
        let mut s = self.state();
        if s.running {
            s.rerun = true;
            None
        } else {
            s.running = true;
            Some(SweepClaim { gate: self, released: false })
        }
    }
}

/// The running sweep's hold on its gate; dropping it (a panicked sweep included) opens the gate.
struct SweepClaim {
    gate: &'static SweepGate,
    released: bool,
}

impl SweepClaim {
    /// After a sweep: true when a trigger landed during it (sweep again, still holding the gate);
    /// false opens the gate under the same lock, so no trigger can slip in between unseen.
    fn rerun_requested(&mut self) -> bool {
        let mut s = self.gate.state();
        if s.rerun {
            s.rerun = false;
            true
        } else {
            s.running = false;
            self.released = true;
            false
        }
    }
}

impl Drop for SweepClaim {
    fn drop(&mut self) {
        if !self.released {
            let mut s = self.gate.state();
            s.running = false;
            s.rerun = false;
        }
    }
}

/// Runs `sweep` on a background task unless one is already running on `gate`; None means this
/// trigger was folded into one more sweep after the running one.
pub(crate) fn spawn_exclusive<F, Fut>(gate: &'static SweepGate, sweep: F) -> Option<tokio::task::JoinHandle<()>>
where
    F: Fn() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let mut claim = gate.try_acquire()?;
    Some(tokio::spawn(async move {
        loop {
            sweep().await;
            if !claim.rerun_requested() {
                break;
            }
            log::info!("[Watched Sync] Sweeping again for the trigger that arrived during the last sweep.");
        }
    }))
}

pub async fn process_watched_folder(db: Db) -> Result<(i32, i32, String)> {
    let watched_dir = std::env::var("OMNIBUS_WATCHED_DIR").unwrap_or_else(|_| "/watched".to_string());
    let unmatched_dir = std::env::var("OMNIBUS_AWAITING_MATCH_DIR").unwrap_or_else(|_| "/unmatched".to_string());
    
    std::fs::create_dir_all(&watched_dir)?;
    std::fs::create_dir_all(&unmatched_dir)?;

    let mut files_to_process = Vec::new();
    for entry in jwalk::WalkDir::new(&watched_dir) {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() {
            let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
            if matches!(ext.as_str(), "cbz" | "cbr" | "zip" | "rar" | "cb7" | "epub") {
                files_to_process.push(path);
            }
        }
    }

    if files_to_process.is_empty() {
        return Ok((0, 0, "No files found in watched folder.".to_string()));
    }

    // ==========================================
    // PHASE 1: PARALLEL FILE I/O & CONVERSION
    // ==========================================
    let cfg = crate::engine_config::EngineConfig::load(&db.pool).await;
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(cfg.convert_workers));
    let mut join_set = JoinSet::new();

    for path in files_to_process {
        let sem = sem.clone();
        join_set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            tokio::task::spawn_blocking(move || {
                let mut working_path = path.clone();
                let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();

                if ext == "cbr" || ext == "rar" || ext == "cb7" {
                    if let Ok(new_path) = crate::converter::convert_cbr_to_cbz(&path) {
                        working_path = new_path;
                    } else {
                        log::error!("Failed to convert CBR during import: {:?}", path);
                    }
                }

                let meta = extract_comicinfo(&working_path);
                PreProcessedFile { original_path: path, working_path, meta }
            })
            .await
            .ok()
        });
    }

    let mut preprocessed_files = Vec::new();
    while let Some(res) = join_set.join_next().await {
        if let Ok(Some(file_data)) = res {
            preprocessed_files.push(file_data);
        }
    }

    // ==========================================
    // PHASE 2: SEQUENTIAL DATABASE ROUTING
    // ==========================================
    let settings = sqlx::query(r#"SELECT key, value FROM "SystemSetting""#).fetch_all(&db.pool).await?;
    let mut folder_pattern = "{Publisher}/{Series} ({Year})".to_string();
    let mut file_pattern = "{Series} #{Issue}".to_string();
    let mut manga_file_pattern = "{Series} Vol. {Issue}".to_string();
    
    for row in settings {
        let key: String = row.get("key");
        let val: String = row.get("value");
        if key == "folder_naming_pattern" { folder_pattern = val.clone(); }
        if key == "file_naming_pattern" { file_pattern = val.clone(); }
        if key == "manga_file_naming_pattern" { manga_file_pattern = val.clone(); }
    }

    // Bool columns are CAST for the Any driver — SQLite's BOOLEAN decltype has no mapping.
    let libraries = sqlx::query(r#"SELECT id, path, CAST("isDefault" AS INTEGER) AS "isDefault", CAST("isManga" AS INTEGER) AS "isManga" FROM "Library""#).fetch_all(&db.pool).await?;
    if libraries.is_empty() {
        anyhow::bail!("No libraries configured in the database!");
    }

    // Manga-detection waterfall inputs, loaded once per job (parity with the scanner): publisher
    // lists + a shared HTTP client for the AniList fallback. Used only for NEW series whose ComicInfo
    // <Manga> tag didn't already settle it.
    let (manga_pubs, western_pubs) = crate::manga_detector::get_detector_settings(&db.pool).await;
    let manga_http = reqwest::Client::new();

    let mut success_count = 0;
    let mut unmatched_count = 0;
    let mut synced_series_ids = std::collections::HashSet::new();

    for file_data in preprocessed_files {
        let path = file_data.working_path;
        
        if let Some(info) = file_data.meta {
            if info.series.is_none() {
                if move_to_unmatched(&path, &unmatched_dir).is_ok() { unmatched_count += 1; }
                continue;
            }

            let series_name = info.series.clone().unwrap_or_else(|| "Unknown".to_string());
            let publisher = info.publisher.clone().unwrap_or_else(|| "Other".to_string());
            // ComicInfo <Volume> usually holds the start year; fall back to <Year> (parity with
            // parseComicInfo / metadata-extractor.ts). 0 means "unknown" — rendered as "" in the
            // naming patterns below so an empty (year) is cleaned up rather than printed as "0".
            let year = info.volume.as_deref()
                .and_then(|v| v.trim().parse::<i32>().ok())
                .filter(|y| *y != 0)
                .or_else(|| info.year.filter(|y| *y != 0))
                .unwrap_or(0);
            let year_str = if year != 0 { year.to_string() } else { String::new() };
            let issue_num = info.number.clone().unwrap_or_else(|| "1".to_string());
            // #203: annual domain flag from the file's own signals (Format / Number shape / the
            // ORIGINAL filename — checked before any rename). The number keeps its ComicInfo-only
            // contract above; the flag rides beside it into dedupe + the row.
            let is_annual = crate::scanner::annual_flag_for_signals(
                info.format.as_deref(),
                info.number.as_deref(),
                &path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            );
            
            let manga_str = info.manga.as_deref().unwrap_or("").to_lowercase();
            let mut is_manga = manga_str == "yes" || manga_str == "yesandrighttoleft";

            // Resolve the provider source + NUMERIC series ID. Prefer the dedicated ID tags Omnibus
            // embeds (ComicVineVolumeId / MetronId); fall back to the numeric id inside the <Web> URL
            // (comicvine .../volume/4050-<id>/ or metron .../series/<id>/). A file with no resolvable
            // numeric series ID stays LOCAL and is routed to /unmatched below for a human to match —
            // mirroring Node's `if (meta.metadataId && meta.series)` import gate — instead of being
            // imported as MATCHED under a random UUID (which corrupts downstream metadata sync).
            let only_digits = |s: &str| -> Option<String> {
                let t = s.trim();
                if !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()) { Some(t.to_string()) } else { None }
            };
            let web = info.web.as_deref().unwrap_or("");
            let cv_id = info.comic_vine_volume_id.as_deref().and_then(only_digits).or_else(|| {
                if web.contains("comicvine.gamespot.com") {
                    re_cv_volume().captures(web).and_then(|c| c.get(1)).map(|m| m.as_str().to_string())
                } else {
                    None
                }
            });
            let metron_id = info.metron_id.as_deref().and_then(only_digits).or_else(|| {
                if web.contains("metron.cloud") {
                    re_metron_series().captures(web).and_then(|c| c.get(1)).map(|m| m.as_str().to_string())
                } else {
                    None
                }
            });
            let (meta_source, meta_id) = if let Some(id) = cv_id {
                ("COMICVINE".to_string(), id)
            } else if let Some(id) = metron_id {
                ("METRON".to_string(), id)
            } else {
                ("LOCAL".to_string(), String::new())
            };

            if meta_source == "LOCAL" || meta_id.is_empty() {
                log::info!("[Watched Sync] '{}' has no ComicVine/Metron ID; routing to unmatched for review.", series_name);
                if move_to_unmatched(&path, &unmatched_dir).is_ok() { unmatched_count += 1; }
                continue;
            }

            // Match an existing series strictly by the (metadataSource, metadataId) unique key, like
            // Node's findUnique. The earlier name+publisher OR clause could merge two distinct series
            // or shadow a real ID match on a stale name collision.
            let existing_series = sqlx::query(
                // isManga is CAST for the Any driver (no SQLite BOOLEAN mapping).
                r#"SELECT id, CAST("isManga" AS INTEGER) AS "isManga", "libraryId", "folderPath", imprint,
                          CAST("hasCustomMetadata" AS INTEGER) AS "hasCustomMetadata" FROM "Series"
                   WHERE "metadataSource" = $1 AND "metadataId" = $2"#
            )
            .bind(&meta_source).bind(&meta_id)
            .fetch_optional(&db.pool).await?;

            let had_existing_series = existing_series.is_some();
            let mut existing_imprint: Option<String> = None;
            let mut existing_has_custom_metadata = false;
            let series_id: String;
            let target_lib_id: String;
            let dest_folder: PathBuf;

            if let Some(series_row) = existing_series {
                series_id = series_row.get("id");
                is_manga = series_row.get::<i64, _>("isManga") != 0;
                target_lib_id = series_row.get("libraryId");
                dest_folder = PathBuf::from(series_row.get::<String, _>("folderPath"));
                existing_imprint = series_row.try_get("imprint").unwrap_or(None);
                existing_has_custom_metadata = series_row.try_get::<i64, _>("hasCustomMetadata").unwrap_or(0) != 0;
            } else {
                series_id = uuid::Uuid::new_v4().to_string();

                // The ComicInfo <Manga> tag is honored above; for a NEW series that the tag didn't
                // mark as manga, run the full detection waterfall (manga-publisher list → western
                // bypass → AniList) so an untagged manga dropped into /watched is filed correctly
                // instead of landing in the comics library (parity with Node's watched-sync detectManga).
                if !is_manga {
                    is_manga = crate::manga_detector::detect_manga(
                        &manga_http, &series_name, &publisher, year, &manga_pubs, &western_pubs,
                    ).await;
                }

                // Library selection tiers (parity with Node: default+match → any match → first):
                // a matching default library wins, else any library whose isManga matches, else the
                // first library. Without the middle tier a non-default manga library is never chosen.
                let mut fallback_lib_path = String::new();
                let mut fallback_lib_id = String::new();
                for lib in &libraries {
                    let lib_manga: bool = lib.get::<i64, _>("isManga") != 0;
                    let lib_default: bool = lib.get::<i64, _>("isDefault") != 0;
                    if lib_manga == is_manga && lib_default {
                        fallback_lib_path = lib.get("path");
                        fallback_lib_id = lib.get("id");
                        break;
                    }
                }
                if fallback_lib_path.is_empty() {
                    for lib in &libraries {
                        let lib_manga: bool = lib.get::<i64, _>("isManga") != 0;
                        if lib_manga == is_manga {
                            fallback_lib_path = lib.get("path");
                            fallback_lib_id = lib.get("id");
                            break;
                        }
                    }
                }
                if fallback_lib_path.is_empty() {
                    fallback_lib_path = libraries[0].get("path");
                    fallback_lib_id = libraries[0].get("id");
                }

                target_lib_id = fallback_lib_id;
                let rel_folder = expand_folder_pattern(
                    &folder_pattern,
                    info.imprint.as_deref(),
                    &publisher,
                    &series_name,
                    &year_str,
                    info.universe.as_deref().unwrap_or_default(),
                    info.series_group.as_deref().unwrap_or_default(),
                ).join("/");
                // Build the path one segment at a time under the library root (blank segments were
                // already dropped); anything that would leave the root is refused and sent to unmatched.
                let Some(folder) = library_subfolder(&fallback_lib_path, &rel_folder) else {
                    log::warn!("[Watched Sync] Folder pattern for '{}' expanded to '{}', which leaves the library root; routing to unmatched for review.", series_name, rel_folder);
                    if move_to_unmatched(&path, &unmatched_dir).is_ok() { unmatched_count += 1; }
                    continue;
                };
                dest_folder = folder;
            }

            // A curated nonblank Series imprint is authoritative. Otherwise a new or unlocked
            // existing series may adopt the archive's standard ComicInfo value for this import.
            let effective_imprint = resolve_effective_imprint(
                had_existing_series,
                existing_imprint.as_deref(),
                existing_has_custom_metadata,
                info.imprint.as_deref(),
            );
            let imprint_db = if effective_imprint.is_empty() { None } else { Some(effective_imprint.clone()) };
            let should_adopt_imprint = imprint_db.is_some()
                && (!had_existing_series || (!existing_has_custom_metadata && existing_imprint.as_deref().map(str::trim).unwrap_or("").is_empty()));

            let _ = std::fs::create_dir_all(&dest_folder);

            let formatted_num = if issue_num.len() == 1 { format!("0{}", issue_num) } else { issue_num.clone() };
            // #243: {IssueYear} is this issue's own year, not the series' (year_str above is the
            // Volume-first SERIES year). A series already in the library may hold the issue's row
            // (the monitor's placeholder for a wanted issue) with its release date.
            let issue_release = if had_existing_series {
                issue_release_date(&db, &series_id, &issue_num, is_annual).await
            } else {
                None
            };
            let issue_year_str = issue_year_for_name(issue_release.as_deref(), info.year, &year_str);
            // #203 Phase 1: an annual arriving through the watched folder is named the Mylar way
            // ("Batman Annual #001 (2012)") — parity with renamer.rs and the Node importer, so a
            // file lands under the same name whichever door it came through.
            let annual_pattern = "{Series} Annual #{Issue} ({IssueYear})".to_string();
            let pattern_to_use = if is_annual {
                &annual_pattern
            } else if is_manga {
                &manga_file_pattern
            } else {
                &file_pattern
            };

            let new_filename = expand_file_pattern(
                pattern_to_use,
                Some(&effective_imprint),
                &[
                    ("{Publisher}", publisher.as_str()),
                    ("{Series}", series_name.as_str()),
                    ("{Year}", year_str.as_str()),
                    ("{VolumeYear}", year_str.as_str()),
                    ("{IssueYear}", issue_year_str.as_str()),
                    ("{Issue}", formatted_num.as_str()),
                    ("{IssueTitle}", info.title.as_deref().unwrap_or_default()),
                    ("{UniverseName}", info.universe.as_deref().unwrap_or_default()),
                    ("{SeriesGroup}", info.series_group.as_deref().unwrap_or_default()),
                ],
            );

            // Converted archives (cbr/rar/cb7) and zip/cbz all normalize to .cbz; an .epub is left as
            // .epub so a renamed EPUB isn't mislabeled as a comic archive.
            let dest_ext = match path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref() {
                Some("epub") => "epub",
                _ => "cbz",
            };
            let final_dest = dest_folder.join(format!("{}.{}", new_filename, dest_ext));

            if robust_move(&path, &final_dest).is_ok() {
                // Move sibling images (Cover scans) utilizing the original path
                if let Some(parent_dir) = file_data.original_path.parent() {
                    if let Ok(siblings) = std::fs::read_dir(parent_dir) {
                        for sibling in siblings.flatten() {
                            let sib_path = sibling.path();
                            if sib_path.is_file() {
                                let sib_ext = sib_path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
                                if matches!(sib_ext.as_str(), "jpg" | "jpeg" | "png" | "webp") {
                                    let sib_dest = dest_folder.join(sibling.file_name());
                                    let _ = robust_move(&sib_path, &sib_dest);
                                }
                            }
                        }
                    }
                }

                // Raw (un-sanitized) Series Group for DB storage — only set on a fresh insert; the
                // ON CONFLICT path touches folderPath only, so an existing group is never clobbered.
                let series_group_db = info.series_group.clone()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());

                let _ = sqlx::query(&format!(
                    r#"INSERT INTO "Series" (id, name, publisher, year, "folderPath", "metadataId", "metadataSource", "matchState", "isManga", "seriesGroup", "libraryId", "updatedAt")
                       VALUES ($1, $2, $3, $4, $5, $6, $7, 'MATCHED', $8, $9, $10, {now})
                       ON CONFLICT (id) DO UPDATE SET "folderPath" = EXCLUDED."folderPath", "updatedAt" = {now}"#,
                    now = db.now_expr()
                ))
                .bind(&series_id).bind(&series_name).bind(&publisher).bind(year)
                .bind(dest_folder.to_string_lossy().to_string())
                .bind(&meta_id).bind(&meta_source).bind(is_manga).bind(&series_group_db).bind(&target_lib_id)
                .execute(&db.pool).await;

                if should_adopt_imprint {
                    if let Some(imprint_value) = imprint_db.as_deref() {
                        let _ = sqlx::query(r#"UPDATE "Series" SET imprint = $1 WHERE id = $2"#)
                            .bind(imprint_value).bind(&series_id).execute(&db.pool).await;
                    }
                }

                let issue_id = uuid::Uuid::new_v4().to_string();

                // Per-issue provider ID (parity with metadata-extractor.ts + importer.ts): prefer the
                // dedicated ComicVineIssueId/MetronIssueId tags, else the numeric id in the <Web> URL
                // (.../4000-<id>/ for ComicVine, metron.cloud/issue/<id> for Metron; Metron takes
                // precedence). With a real per-issue id the issue is MATCHED under that id; without one
                // it is imported UNMATCHED under an `unmatched_<uuid>` placeholder so the follow-up
                // metadata sync can match it (Node: matchState = metadataIssueId ? 'MATCHED' : 'UNMATCHED').
                let cv_issue_id = info.comic_vine_issue_id.as_deref().and_then(only_digits).or_else(|| {
                    if web.contains("comicvine") {
                        re_cv_issue().captures(web).and_then(|c| c.get(1)).map(|m| m.as_str().to_string())
                    } else { None }
                });
                let metron_issue_id = info.metron_issue_id.as_deref().and_then(only_digits).or_else(|| {
                    if web.contains("metron.cloud") {
                        re_metron_issue().captures(web).and_then(|c| c.get(1)).map(|m| m.as_str().to_string())
                    } else { None }
                });
                let resolved_issue_id = metron_issue_id.clone().or_else(|| cv_issue_id.clone());
                // Credits parsed from ComicInfo.xml (parity with the main importer).
                let writers_json = split_to_json(info.writer.as_deref());
                let artists_json = split_to_json(info.penciller.as_deref());
                let characters_json = split_to_json(info.characters.as_deref());

                let (issue_meta_id, issue_meta_source, issue_match_state): (String, String, &str) = match &resolved_issue_id {
                    Some(id) => {
                        let src = if metron_issue_id.is_some() || meta_source == "METRON" { "METRON" } else { "COMICVINE" };
                        // Local-first ingest (discussion #182, parity with the scanner): an id AND
                        // creative credits from the file = enrichment-complete → DEEP_SYNCED, so
                        // opening the imported issue never costs a provider call.
                        let state = if writers_json != "[]" || artists_json != "[]" { "DEEP_SYNCED" } else { "MATCHED" };
                        (id.clone(), src.to_string(), state)
                    }
                    None => (format!("unmatched_{}", uuid::Uuid::new_v4()), "LOCAL".to_string(), "UNMATCHED"),
                };
                log::debug!("[Watched Sync Debug] Issue {} #{} resolved → metadataId={}, source={}, matchState={}", series_name, issue_num, issue_meta_id, issue_meta_source, issue_match_state);
                let issue_title = info.title.clone().unwrap_or_default();
                let issue_summary = info.summary.clone().unwrap_or_default();
                // ISO release date from <Year>/<Month>/<Day> (discussion #182, parity with the
                // scanner) — without it a keyless local-first import never gets calendar dates.
                let release_date = crate::scanner::compose_release_date(info.year, info.month, info.day);
                let file_path_str = final_dest.to_string_lossy().to_string();

                // pageCount feeds OPDS-PSE (pse:count); 0 for a not-yet-converted RAR.
                let count_path = final_dest.clone();
                let page_count = tokio::task::spawn_blocking(move || crate::converter::count_zip_pages(&count_path))
                    .await.ok().flatten().unwrap_or(0);

                // Dedupe: update an existing issue with the same number — in the same annual
                // domain (#203) — instead of inserting a duplicate.
                let existing_issue_id: Option<String> = sqlx::query(
                    r#"SELECT id, number, CAST("isAnnual" AS INTEGER) AS is_annual FROM "Issue" WHERE "seriesId" = $1"#,
                )
                .bind(&series_id)
                .fetch_all(&db.pool)
                .await
                .unwrap_or_default()
                .iter()
                .find_map(|r| {
                    let n: String = r.get("number");
                    let row_annual = r.try_get::<i64, _>("is_annual").map(|v| v != 0).unwrap_or(false);
                    if row_annual == is_annual && crate::metadata::is_same_issue(&n, &issue_num) { Some(r.get::<String, _>("id")) } else { None }
                });

                let res = if let Some(eid) = existing_issue_id {
                    sqlx::query(&format!(
                        // Preserve already-present data on re-import (parity with importer.ts dedupe):
                        // keep existing non-empty name/description/credits and a real metadataId; only
                        // upgrade metadataSource from LOCAL and matchState from UNMATCHED — never clobber
                        // a richly-matched issue with freshly-parsed (possibly empty) values.
                        // Issue.fileAddedAt (#206 follow-up, importer.ts parity): filling a placeholder
                        // is an arrival; replacing a file the row already had is not.
                        r#"UPDATE "Issue" SET
                               number=$1,
                               status='DOWNLOADED',
                               {stamp},
                               "filePath"=$2,
                               name=COALESCE(NULLIF(name, ''), $3),
                               description=COALESCE(NULLIF(description, ''), $4),
                               "releaseDate"=COALESCE(NULLIF("releaseDate", ''), $13),
                               writers=CASE WHEN writers IS NOT NULL AND writers <> '' AND writers <> '[]' THEN writers ELSE $5 END,
                               artists=CASE WHEN artists IS NOT NULL AND artists <> '' AND artists <> '[]' THEN artists ELSE $6 END,
                               characters=CASE WHEN characters IS NOT NULL AND characters <> '' AND characters <> '[]' THEN characters ELSE $7 END,
                               "metadataId"=CASE WHEN "metadataId" IS NULL OR "metadataId" = '' OR "metadataId" LIKE 'unmatched%' THEN $8 ELSE "metadataId" END,
                               "metadataSource"=CASE WHEN "metadataSource" = 'LOCAL' THEN $9 ELSE "metadataSource" END,
                               "matchState"=CASE WHEN "matchState" = 'UNMATCHED' THEN $10 ELSE "matchState" END,
                               "pageCount"=CASE WHEN $11 > 0 THEN $11 ELSE "pageCount" END
                           WHERE id=$12"#,
                        stamp = crate::file_added::arrival_set(&db)
                    ))
                    .bind(&issue_num).bind(&file_path_str).bind(&issue_title).bind(&issue_summary)
                    .bind(&writers_json).bind(&artists_json).bind(&characters_json)
                    .bind(&issue_meta_id).bind(&issue_meta_source).bind(issue_match_state).bind(page_count).bind(&eid)
                    .bind(&release_date)
                    .execute(&db.pool).await
                } else {
                    sqlx::query(&format!(
                        // isAnnual as a SQL literal — the Any-driver bool rule (#203).
                        r#"INSERT INTO "Issue" (id, "seriesId", number, "isAnnual", status, "filePath", name, description, writers, artists, characters, "matchState", "metadataId", "metadataSource", "pageCount", "releaseDate", "fileAddedAt", "createdAt")
                           VALUES ($1, $2, $3, {annual}, 'DOWNLOADED', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, {now}, {now})"#,
                        annual = if is_annual { "true" } else { "false" },
                        now = db.now_expr()
                    ))
                    .bind(&issue_id).bind(&series_id).bind(&issue_num).bind(&file_path_str)
                    .bind(&issue_title).bind(&issue_summary)
                    .bind(&writers_json).bind(&artists_json).bind(&characters_json)
                    .bind(issue_match_state).bind(&issue_meta_id).bind(&issue_meta_source).bind(page_count)
                    .bind(&release_date)
                    .execute(&db.pool).await
                };

                if let Err(e) = res {
                    log::error!("[Watched Sync] Failed to upsert issue {:?}: {:?}", final_dest.file_name(), e);
                }

                synced_series_ids.insert(series_id);
                success_count += 1;
            } else {
                log::warn!("Skipping file {:?}. It might be locked by another program or cross-drive move failed.", path.file_name());
            }
        } else {
            if move_to_unmatched(&path, &unmatched_dir).is_ok() { unmatched_count += 1; }
        }
    }

    let _ = clean_empty_folders(Path::new(&watched_dir), Path::new(&watched_dir));

    if !synced_series_ids.is_empty() {
        let series_list: Vec<String> = synced_series_ids.into_iter().collect();
        let db_clone = db.clone();
        tokio::spawn(async move {
            // An automatic import never asks for per-issue Metron credits: the setting decides.
            let _ = crate::metadata::sync_metadata(db_clone, Some(series_list), false).await;
        });
    }

    Ok((success_count, unmatched_count, format!("Processed watched folder. Imported: {}. Moved to unmatched: {}.", success_count, unmatched_count)))
}

fn extract_comicinfo(path: &Path) -> Option<ComicInfo> {
    let file = File::open(path).ok()?;
    let mut archive = ZipArchive::new(file).ok()?;
    
    for i in 0..archive.len() {
        if let Ok(mut file) = archive.by_index(i) {
            if file.name().eq_ignore_ascii_case("comicinfo.xml") {
                let mut xml_content = String::new();
                if file.read_to_string(&mut xml_content).is_ok() {
                    // Sanitize bare ampersands so a "Cloak & Dagger"-style tag doesn't fail parse and
                    // needlessly route the file to /unmatched (parity with scanner.rs + Node extractor).
                    let xml_content = crate::scanner::sanitize_xml_ampersands(&xml_content);
                    return quick_xml::de::from_str(&xml_content).ok();
                }
            }
        }
    }
    None
}

/// #243: the year a file name's {IssueYear} carries - this issue's release date in the library
/// (the year Standardize writes, so the next Standardize leaves the name alone), else the file's
/// own ComicInfo <Year> (its cover year; never <Volume>, which is the series' start year), else
/// the series year. Node twin: src/lib/utils/issue-year.ts resolveIssueYear.
fn issue_year_for_name(release_date: Option<&str>, comicinfo_year: Option<i32>, series_year: &str) -> String {
    let plausible = |y: &i32| (1900..=2100).contains(y);
    release_date
        .and_then(|d| d.trim().get(..4))
        .and_then(|y| y.parse::<i32>().ok())
        .filter(plausible)
        .or_else(|| comicinfo_year.filter(plausible))
        .map(|y| y.to_string())
        .unwrap_or_else(|| series_year.to_string())
}

/// The release date of the series' row for this issue, if the library already has one - same
/// identity as the import dedupe below: number (by issue identity, "38" == "038") + annual domain.
async fn issue_release_date(db: &Db, series_id: &str, issue_num: &str, is_annual: bool) -> Option<String> {
    let rows = sqlx::query(
        // isAnnual is CAST for the Any driver (no SQLite BOOLEAN mapping); releaseDate is TEXT.
        r#"SELECT number, CAST("isAnnual" AS INTEGER) AS is_annual, "releaseDate" FROM "Issue" WHERE "seriesId" = $1"#,
    )
    .bind(series_id)
    .fetch_all(&db.pool)
    .await
    .ok()?;
    rows.iter()
        .find(|r| {
            let n: String = r.try_get("number").unwrap_or_default();
            let row_annual = r.try_get::<i64, _>("is_annual").map(|v| v != 0).unwrap_or(false);
            row_annual == is_annual && crate::metadata::is_same_issue(&n, issue_num)
        })
        .and_then(|r| r.try_get::<Option<String>, _>("releaseDate").ok().flatten())
}

fn robust_move(src: &Path, dest: &Path) -> Result<()> {
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    copy_then_replace(src, dest)
}

/// The cross-device fallback of `robust_move` (a plain rename can't cross mounts): copy beside the
/// destination under a temp name of its own, swap it into place, then remove the source. A failed
/// copy or swap removes the staged copy and keeps the source.
fn copy_then_replace(src: &Path, dest: &Path) -> Result<()> {
    let tmp_dest = crate::converter::temp_sibling(dest, "move");
    let staged = (|| -> Result<()> {
        std::fs::copy(src, &tmp_dest)?;
        if cfg!(target_os = "windows") && dest.exists() {
            let _ = std::fs::remove_file(dest);
        }
        std::fs::rename(&tmp_dest, dest)?;
        Ok(())
    })();
    if let Err(e) = staged {
        let _ = std::fs::remove_file(&tmp_dest);
        return Err(e);
    }
    std::fs::remove_file(src)?;

    Ok(())
}

fn move_to_unmatched(src: &Path, unmatched_dir: &str) -> Result<()> {
    let dest = PathBuf::from(unmatched_dir).join(src.file_name().unwrap());
    robust_move(src, &dest)?;
    Ok(())
}

fn clean_empty_folders(dir: &Path, base_dir: &Path) -> Result<bool> {
    let mut is_empty = true;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if !clean_empty_folders(&path, base_dir)? { is_empty = false; }
            } else {
                is_empty = false;
            }
        }
    }
    if is_empty && dir != base_dir {
        let _ = std::fs::remove_dir(dir);
    }
    Ok(is_empty)
}

/// Strips characters invalid in file/folder names and neutralizes dot-only traversal values — the
/// same rules as renamer's sanitize_component and Node's sanitizeFilename. ComicInfo feeds this, so
/// a `<Publisher>..</Publisher>` becomes "_" instead of a ".." segment above the library root.
fn clean_fs_name(input: &str) -> String {
    let cleaned = input.replace(&['<', '>', ':', '"', '/', '\\', '|', '?', '*'][..], "");
    let cleaned = cleaned.trim();
    let safe = cleaned.trim_matches('.').trim();
    if safe.is_empty() && !cleaned.is_empty() {
        return "_".to_string();
    }
    safe.to_string()
}

/// Joins an expanded folder pattern onto the library root one segment at a time, dropping blank
/// segments. Refuses (None) any segment that isn't a single plain name — "..", ".", a dots-only run,
/// a drive prefix — so no pattern + metadata combination can place a series outside the library
/// root (defence in depth behind clean_fs_name).
fn library_subfolder(root: &str, rel_folder: &str) -> Option<PathBuf> {
    let mut folder = PathBuf::from(root);
    for seg in rel_folder.split(['/', '\\']).map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let mut parts = Path::new(seg).components();
        let plain = matches!((parts.next(), parts.next()), (Some(std::path::Component::Normal(_)), None));
        if !plain || seg.chars().all(|c| c == '.') {
            return None;
        }
        folder.push(seg);
    }
    Some(folder)
}

fn replace_imprint_token(pattern: &str, imprint: Option<&str>) -> String {
    let safe_imprint = crate::renamer::sanitize_component(imprint.unwrap_or_default().trim());
    crate::renamer::replace_token_ci(pattern, "{Imprint}", &safe_imprint)
}

fn expand_folder_pattern(
    pattern: &str,
    imprint: Option<&str>,
    publisher: &str,
    series: &str,
    year: &str,
    universe: &str,
    series_group: &str,
) -> Vec<String> {
    let expanded = replace_imprint_token(pattern, imprint)
        .replace("{Publisher}", &clean_fs_name(publisher))
        .replace("{Series}", &clean_fs_name(series))
        .replace("{Year}", year)
        .replace("{VolumeYear}", year)
        .replace("{UniverseName}", &clean_fs_name(universe))
        .replace("{SeriesGroup}", &clean_fs_name(series_group));

    clean_naming_leftovers(&expanded)
        .split(['/', '\\'])
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .collect()
}

fn expand_file_pattern(
    pattern: &str,
    imprint: Option<&str>,
    tokens: &[(&str, &str)],
) -> String {
    let mut expanded = replace_imprint_token(pattern, imprint);
    for (token, value) in tokens {
        let value = match *token {
            "{Publisher}" | "{Series}" | "{IssueTitle}" | "{UniverseName}" | "{SeriesGroup}" => clean_fs_name(value),
            _ => value.to_string(),
        };
        expanded = expanded.replace(token, &value);
    }

    clean_naming_leftovers(&expanded)
}

fn resolve_effective_imprint(
    had_existing_series: bool,
    stored_imprint: Option<&str>,
    has_custom_metadata: bool,
    comic_info_imprint: Option<&str>,
) -> String {
    match stored_imprint.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value.to_string(),
        None if had_existing_series && has_custom_metadata => String::new(),
        None => comic_info_imprint.unwrap_or_default().trim().to_string(),
    }
}

/// Removes the debris an unfilled naming variable leaves behind — empty `()`/`[]` groups (e.g. a
/// blank `{Year}` inside `({Year})`) and collapsed whitespace — then trims (parity with importer.ts).
fn clean_naming_leftovers(input: &str) -> String {
    static EMPTY_PARENS: OnceLock<Regex> = OnceLock::new();
    static EMPTY_BRACKETS: OnceLock<Regex> = OnceLock::new();
    static MULTI_WS: OnceLock<Regex> = OnceLock::new();
    let no_parens = EMPTY_PARENS.get_or_init(|| Regex::new(r"\(\s*\)").unwrap()).replace_all(input, "");
    let no_brackets = EMPTY_BRACKETS.get_or_init(|| Regex::new(r"\[\s*\]").unwrap()).replace_all(&no_parens, "");
    MULTI_WS.get_or_init(|| Regex::new(r"\s+").unwrap()).replace_all(&no_brackets, " ").trim().to_string()
}

/// Splits a comma-separated ComicInfo field into a JSON array string (e.g. "A, B" -> `["A","B"]`).
/// Shared with the scanner's issue_file_meta (discussion #177).
pub(crate) fn split_to_json(s: Option<&str>) -> String {
    match s {
        Some(v) => {
            let parts: Vec<&str> = v.split(',').map(|p| p.trim()).filter(|p| !p.is_empty()).collect();
            serde_json::to_string(&parts).unwrap_or_else(|_| "[]".to_string())
        }
        None => "[]".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==== Unique temp files: the cross-device move used to stage every copy as
    // `dest.with_extension("tmp_move")` - shared by any two moves of the same name (and by
    // "X.cbr" / "X.cbz", which both become "X.tmp_move"), and left behind when the swap failed.

    fn move_fixture() -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("omnibus_move_{}", uuid::Uuid::new_v4()));
        let (from, to) = (base.join("watched"), base.join("unmatched"));
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        let src = from.join("Batman 001.cbz");
        std::fs::write(&src, b"the comic").unwrap();
        (base, src, to)
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string()).collect();
        v.sort();
        v
    }

    #[test]
    fn copy_then_replace_never_touches_another_movers_temp_file() {
        let (base, src, to) = move_fixture();
        // Another move into the same folder is mid-copy under the name every move used to share.
        let theirs = to.join("Batman 001.tmp_move");
        std::fs::write(&theirs, b"another mover's bytes").unwrap();
        let dest = to.join("Batman 001.cbz");

        copy_then_replace(&src, &dest).unwrap();

        assert_eq!(std::fs::read(&dest).unwrap(), b"the comic");
        assert!(!src.exists(), "the source is removed after the move");
        assert_eq!(std::fs::read(&theirs).unwrap(), b"another mover's bytes", "another move's temp file is untouched");
        assert_eq!(names_in(&to), vec!["Batman 001.cbz", "Batman 001.tmp_move"], "no temp file of ours left behind");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_then_replace_cleans_up_when_the_final_swap_fails() {
        let (base, src, to) = move_fixture();
        // The destination name is taken by a non-empty folder: the copy succeeds, the swap can't.
        let dest = to.join("Batman 001.cbz");
        std::fs::create_dir_all(dest.join("inner")).unwrap();

        assert!(copy_then_replace(&src, &dest).is_err());

        assert!(src.exists(), "a failed move keeps the source");
        assert_eq!(names_in(&to), vec!["Batman 001.cbz"], "the staged copy is removed");
        let _ = std::fs::remove_dir_all(&base);
    }

    // ==== #243: {IssueYear} carried the SERIES year (ComicInfo <Volume>, else <Year>) for every
    // file the watched folder imported - "X-Men #38 (2024)" for a 2026 issue of a 2024 series.

    #[test]
    fn issue_year_for_name_prefers_the_library_then_the_files_year_then_the_series() {
        assert_eq!(issue_year_for_name(Some("2026-01-14"), Some(2025), "2024"), "2026");
        assert_eq!(issue_year_for_name(Some("2026-01-14T00:00:00.000Z"), None, "2024"), "2026");
        assert_eq!(issue_year_for_name(None, Some(2026), "2024"), "2026");
        assert_eq!(issue_year_for_name(Some(""), Some(2026), "2024"), "2026");
        assert_eq!(issue_year_for_name(None, None, "2024"), "2024");
        // Implausible values never become a year (a ComicVine id in <Year>, a placeholder date).
        assert_eq!(issue_year_for_name(Some("TBA"), Some(106705), "2024"), "2024");
        assert_eq!(issue_year_for_name(Some("0000-00-00"), Some(0), ""), "");
    }

    #[tokio::test]
    async fn issue_release_date_reads_the_matching_row_in_the_files_domain() {
        let base = std::env::temp_dir().join(format!("omnibus_issueyear_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let db_file = base.join("iy.db");
        std::fs::File::create(&db_file).unwrap();
        let db_url = format!("file:{}", db_file.to_string_lossy().replace('\\', "/"));
        let db = crate::db::Db::connect(&db_url, 2).await.expect("connect file-backed sqlite");
        // Column types as Prisma creates them on SQLite (BOOLEAN has no Any-driver mapping).
        sqlx::query(r#"CREATE TABLE "Issue" (id TEXT PRIMARY KEY, "seriesId" TEXT, number TEXT, "isAnnual" BOOLEAN NOT NULL DEFAULT false, "releaseDate" TEXT)"#)
            .execute(&db.pool).await.unwrap();
        for (id, series, number, annual, date) in [
            ("a", "xmen", "37", false, Some("2025-12-10")),
            ("b", "xmen", "38", false, Some("2026-01-14")),
            ("c", "xmen", "1", false, Some("2024-07-10")),
            ("d", "xmen", "1", true, Some("2025-08-20")),
            ("e", "xmen", "39", false, None),
            ("f", "other", "38", false, Some("1999-01-01")),
        ] {
            sqlx::query(r#"INSERT INTO "Issue" (id, "seriesId", number, "isAnnual", "releaseDate") VALUES ($1, $2, $3, $4, $5)"#)
                .bind(id).bind(series).bind(number).bind(if annual { 1_i64 } else { 0_i64 }).bind(date)
                .execute(&db.pool).await.unwrap();
        }

        assert_eq!(issue_release_date(&db, "xmen", "38", false).await.as_deref(), Some("2026-01-14"));
        assert_eq!(issue_release_date(&db, "xmen", "038", false).await.as_deref(), Some("2026-01-14"), "same issue identity as the import dedupe");
        assert_eq!(issue_release_date(&db, "xmen", "1", true).await.as_deref(), Some("2025-08-20"), "an annual reads the annual's row");
        assert_eq!(issue_release_date(&db, "xmen", "1", false).await.as_deref(), Some("2024-07-10"));
        assert_eq!(issue_release_date(&db, "xmen", "39", false).await, None, "a row with no date");
        assert_eq!(issue_release_date(&db, "xmen", "40", false).await, None, "no row yet");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn comicinfo_imprint_deserializes() {
        let info: ComicInfo = quick_xml::de::from_str(
            "<ComicInfo><Imprint>Absolute</Imprint></ComicInfo>",
        ).expect("parse ComicInfo imprint");
        assert_eq!(info.imprint.as_deref(), Some("Absolute"));
    }

    #[test]
    fn stored_or_locked_imprint_precedence_is_respected() {
        assert_eq!(resolve_effective_imprint(true, Some(" Vertigo "), true, Some("Absolute")), "Vertigo");
        assert_eq!(resolve_effective_imprint(false, None, false, Some(" Absolute ")), "Absolute");
        assert_eq!(resolve_effective_imprint(true, None, false, Some(" Absolute ")), "Absolute");
        assert_eq!(resolve_effective_imprint(true, None, true, Some("Absolute")), "");
    }

    #[test]
    fn fs_name_strips_invalid_characters() {
        assert_eq!(clean_fs_name("Bat: Man?"), "Bat Man");
        assert_eq!(clean_fs_name("  A/B\\C|D  "), "ABCD");
        assert_eq!(clean_fs_name("Plain Name"), "Plain Name");
    }

    #[test]
    fn fs_name_neutralizes_dot_only_traversal_values() {
        // ComicInfo values are untrusted: <Publisher>..</Publisher> must never survive as a ".."
        // path segment (parity with renamer's sanitize_component + Node's sanitizeFilename).
        assert_eq!(clean_fs_name(".."), "_");
        assert_eq!(clean_fs_name("."), "_");
        assert_eq!(clean_fs_name("..."), "_");
        assert_eq!(clean_fs_name(" .. "), "_");
        assert_eq!(clean_fs_name("..Name"), "Name");
        assert_eq!(clean_fs_name("Name..."), "Name");
        // Separators are stripped first, so a smuggled "../.." collapses to dots and then to "_".
        assert_eq!(clean_fs_name("../.."), "_");
        assert_eq!(clean_fs_name("..\\etc"), "etc");
        // Interior dots are ordinary name characters; a blank value stays blank (dropped token).
        assert_eq!(clean_fs_name("Mr. Miracle"), "Mr. Miracle");
        assert_eq!(clean_fs_name(""), "");
    }

    /// The watched-sync folder expansion for a NEW series, token for token.
    fn expand_folder(pattern: &str, publisher: &str, series: &str, year: &str, universe: &str, group: &str) -> String {
        clean_naming_leftovers(&pattern
            .replace("{Publisher}", &clean_fs_name(publisher))
            .replace("{Series}", &clean_fs_name(series))
            .replace("{Year}", year)
            .replace("{VolumeYear}", year)
            .replace("{UniverseName}", &clean_fs_name(universe))
            .replace("{SeriesGroup}", &clean_fs_name(group)))
    }

    fn assert_plainly_under(root: &Path, folder: &Path) {
        assert!(folder.starts_with(root), "{:?} is not under {:?}", folder, root);
        let rel = folder.strip_prefix(root).unwrap();
        assert!(
            rel.components().all(|c| matches!(c, std::path::Component::Normal(_))),
            "{:?} has a non-plain component",
            folder
        );
    }

    #[test]
    fn dot_dot_comicinfo_values_cannot_climb_out_of_the_library_root() {
        let root = if cfg!(windows) { r"C:\comics" } else { "/comics" };
        for pattern in ["{Publisher}/{Series} ({Year})", "{Series}", "{UniverseName}/{SeriesGroup}/{Series}"] {
            for hostile in ["..", ".", "...", " .. ", "../..", "..\\.."] {
                for (publisher, series, universe, group) in [
                    (hostile, "Saga", "", ""),
                    ("Image", hostile, "", ""),
                    (hostile, hostile, hostile, hostile),
                ] {
                    let rel = expand_folder(pattern, publisher, series, "", universe, group);
                    let folder = library_subfolder(root, &rel)
                        .unwrap_or_else(|| panic!("{:?} with {:?} was refused; clean_fs_name should defuse it", pattern, hostile));
                    assert_plainly_under(Path::new(root), &folder);
                }
            }
        }
        // The default pattern still reads naturally around the neutralized value.
        let rel = expand_folder("{Publisher}/{Series} ({Year})", "..", "Saga", "2012", "", "");
        assert_eq!(library_subfolder(root, &rel).unwrap(), Path::new(root).join("_").join("Saga (2012)"));
    }

    #[test]
    fn library_subfolder_refuses_any_segment_that_is_not_a_plain_name() {
        // Defence in depth behind clean_fs_name: pattern literals + blank tokens (or a future
        // unsanitized token) must still never yield a path that leaves the root.
        let root = if cfg!(windows) { r"C:\comics" } else { "/comics" };
        for rel in ["..", "../escape", "Marvel/../../etc", "Marvel\\..\\x", ".", "Marvel/./x", "...", "Marvel/ .. /x"] {
            assert_eq!(library_subfolder(root, rel), None, "{:?} should be refused", rel);
        }
        #[cfg(windows)]
        assert_eq!(library_subfolder(root, "D:/Marvel"), None); // a drive prefix would replace the root
        // Ordinary expansions are untouched: blank segments dropped, interior dots kept.
        assert_eq!(library_subfolder(root, "Marvel//X-Men (1991)"), Some(Path::new(root).join("Marvel").join("X-Men (1991)")));
        assert_eq!(library_subfolder(root, " DC Comics / Mr. Miracle (2017) "), Some(Path::new(root).join("DC Comics").join("Mr. Miracle (2017)")));
        assert_eq!(library_subfolder(root, ""), Some(PathBuf::from(root)));
    }

    #[test]
    fn naming_leftovers_cleaned() {
        // Blank {Year} inside "({Year})" leaves "()" — must be removed, not printed.
        assert_eq!(clean_naming_leftovers("Saga ()"), "Saga");
        assert_eq!(clean_naming_leftovers("Saga [] #01"), "Saga #01");
        assert_eq!(clean_naming_leftovers("Saga  (2014)  #01"), "Saga (2014) #01");
    }

    #[test]
    fn imprint_expands_in_watched_folder_and_file_patterns() {
        let folder_pattern = "{Imprint}/{Series} ({Year})";
        let file_pattern = "{Imprint} {Series} #{Issue}";

        assert_eq!(
            expand_folder_pattern(folder_pattern, Some("Absolute"), "DC Comics", "Batman", "2016", "", ""),
            vec!["Absolute", "Batman (2016)"],
        );
        assert_eq!(
            expand_folder_pattern(folder_pattern, None, "DC Comics", "Batman", "2016", "", ""),
            vec!["Batman (2016)"],
        );
        assert_eq!(
            expand_file_pattern(file_pattern, Some("Absolute"), &[("{Series}", "Batman"), ("{Issue}", "001")]),
            "Absolute Batman #001",
        );
        assert_eq!(
            expand_file_pattern(file_pattern, None, &[("{Series}", "Batman"), ("{Issue}", "001")]),
            "Batman #001",
        );
    }

    #[test]
    fn comicinfo_fields_split_to_json_arrays() {
        assert_eq!(split_to_json(Some("A, B")), r#"["A","B"]"#);
        assert_eq!(split_to_json(Some("Solo")), r#"["Solo"]"#);
        assert_eq!(split_to_json(Some(" , ,")), "[]"); // empty parts filtered
        assert_eq!(split_to_json(None), "[]");
    }

    // These regexes decide whether a watched file imports MATCHED or routes to /unmatched —
    // high blast-radius, so the URL shapes are pinned here.
    #[test]
    fn provider_id_regexes_extract_numeric_ids() {
        let cv_vol = "https://comicvine.gamespot.com/spider-man/4050-12345/";
        assert_eq!(re_cv_volume().captures(cv_vol).unwrap().get(1).unwrap().as_str(), "12345");

        let cv_issue = "https://comicvine.gamespot.com/issue/4000-999/";
        assert_eq!(re_cv_issue().captures(cv_issue).unwrap().get(1).unwrap().as_str(), "999");

        let metron_series = "https://metron.cloud/series/678/";
        assert_eq!(re_metron_series().captures(metron_series).unwrap().get(1).unwrap().as_str(), "678");

        let metron_issue = "https://metron.cloud/issue/55/";
        assert_eq!(re_metron_issue().captures(metron_issue).unwrap().get(1).unwrap().as_str(), "55");

        // Non-numeric / unrelated URLs must NOT match.
        assert!(re_cv_volume().captures("https://example.com/foo").is_none());
        assert!(re_metron_series().captures("https://metron.cloud/series/slug-name/").is_none());
    }

    // ==== One sweep at a time (#240): every trigger - the schedule, the importer after a batch
    // pack, an admin's Run now - spawned its own sweep, so a long sweep had others running over
    // the same folder beside it (four sweeps finishing in the same second).

    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
    use std::sync::Arc;

    type SweepFuture = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

    /// A stand-in sweep that counts its runs and overlaps, and holds until the test finishes it.
    struct FakeSweeps {
        started: AtomicUsize,
        active: AtomicUsize,
        max_active: AtomicUsize,
        finish: tokio::sync::Semaphore,
    }

    impl FakeSweeps {
        fn new() -> Arc<Self> {
            Arc::new(FakeSweeps {
                started: AtomicUsize::new(0),
                active: AtomicUsize::new(0),
                max_active: AtomicUsize::new(0),
                finish: tokio::sync::Semaphore::new(0),
            })
        }

        fn sweep(self: &Arc<Self>) -> impl Fn() -> SweepFuture + Send + 'static {
            let me = self.clone();
            move || {
                let me = me.clone();
                Box::pin(async move {
                    me.started.fetch_add(1, SeqCst);
                    let now = me.active.fetch_add(1, SeqCst) + 1;
                    me.max_active.fetch_max(now, SeqCst);
                    me.finish.acquire().await.unwrap().forget();
                    me.active.fetch_sub(1, SeqCst);
                })
            }
        }

        fn finish_one(&self) {
            self.finish.add_permits(1);
        }

        async fn wait_started(&self, n: usize) {
            for _ in 0..2000 {
                if self.started.load(SeqCst) >= n {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
            panic!("sweep {} never started", n);
        }
    }

    #[tokio::test]
    async fn triggers_during_a_sweep_become_one_more_sweep_after_it_never_one_beside_it() {
        static GATE: SweepGate = SweepGate::new();
        let fake = FakeSweeps::new();

        let first = spawn_exclusive(&GATE, fake.sweep()).expect("an idle gate runs the sweep");
        fake.wait_started(1).await;

        // The schedule and a batch import both fire while it runs.
        assert!(spawn_exclusive(&GATE, fake.sweep()).is_none(), "a trigger mid-sweep doesn't start a second sweep");
        assert!(spawn_exclusive(&GATE, fake.sweep()).is_none(), "nor does a third");
        assert_eq!(fake.started.load(SeqCst), 1);

        // Its files may have landed after the running sweep listed the folder: one more sweep follows.
        fake.finish_one();
        fake.wait_started(2).await;
        fake.finish_one();
        first.await.unwrap();

        assert_eq!(fake.started.load(SeqCst), 2, "two mid-sweep triggers fold into one follow-up sweep");
        assert_eq!(fake.max_active.load(SeqCst), 1, "never two sweeps at once");

        // Idle again: the next trigger sweeps straight away.
        let next = spawn_exclusive(&GATE, fake.sweep()).expect("the gate opens once the sweeps finish");
        fake.finish_one();
        next.await.unwrap();
        assert_eq!(fake.started.load(SeqCst), 3);
    }

    #[tokio::test]
    async fn a_sweep_with_no_trigger_during_it_runs_once() {
        static GATE: SweepGate = SweepGate::new();
        let fake = FakeSweeps::new();

        let only = spawn_exclusive(&GATE, fake.sweep()).expect("an idle gate runs the sweep");
        fake.finish_one();
        only.await.unwrap();

        assert_eq!(fake.started.load(SeqCst), 1, "no follow-up without a trigger");
        assert!(spawn_exclusive(&GATE, fake.sweep()).is_some(), "and the gate is open");
        fake.finish_one();
    }

    #[tokio::test]
    async fn a_sweep_that_panics_still_opens_the_gate() {
        static GATE: SweepGate = SweepGate::new();

        let crashed = spawn_exclusive(&GATE, || async { panic!("sweep crashed"); }).expect("an idle gate runs the sweep");
        assert!(crashed.await.is_err(), "the sweep panicked");

        let fake = FakeSweeps::new();
        let next = spawn_exclusive(&GATE, fake.sweep()).expect("a crashed sweep doesn't hold the gate shut");
        fake.finish_one();
        next.await.unwrap();
        assert_eq!(fake.started.load(SeqCst), 1);
    }
}
