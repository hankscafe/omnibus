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
use crate::naming::{self, IssuePadding, NamingInput};

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
    let settings: Vec<(String, String)> = sqlx::query(r#"SELECT key, value FROM "SystemSetting""#)
        .fetch_all(&db.pool)
        .await?
        .into_iter()
        .map(|row| (row.get("key"), row.get("value")))
        .collect();
    let naming_settings = WatchedNaming::from_settings(settings.iter().map(|(k, v)| (k.as_str(), v.as_str())));

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
        // #240 PR B: the import handoff is keyed on the file AS IT WAS HANDED OVER, so it is
        // recorded against the original name — the CBR→CBZ conversion above must not move the key.
        let handoff_path = file_data.original_path.clone();
        let path = file_data.working_path;
        
        if let Some(info) = file_data.meta {
            if info.series.is_none() {
                if park_to_unmatched(&db, &watched_dir, &handoff_path, &path, &unmatched_dir).await {
                    unmatched_count += 1;
                }
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
                if park_to_unmatched(&db, &watched_dir, &handoff_path, &path, &unmatched_dir).await {
                    unmatched_count += 1;
                }
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
                // naming.rs gives plain segments only; a pattern that would leave the library root
                // (or give no folder at all) is refused and the file sent to unmatched.
                let folder_values = comicinfo_naming(&info, year, info.imprint.clone(), &issue_num, None);
                let Some(segments) = naming::folder_segments(&naming_settings.folder, &folder_values) else {
                    log::warn!("[Watched Sync] The folder pattern \"{}\" gives no folder inside the library for '{}'; routing to unmatched for review.", naming_settings.folder, series_name);
                    if park_to_unmatched(&db, &watched_dir, &handoff_path, &path, &unmatched_dir).await {
                        unmatched_count += 1;
                    }
                    continue;
                };
                dest_folder = segments.iter().fold(PathBuf::from(&fallback_lib_path), |folder, segment| folder.join(segment));
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

            // #243: {IssueYear} is this issue's own year, not the series' (`year` above is the
            // Volume-first SERIES year). A series already in the library may hold the issue's row
            // (the monitor's placeholder for a wanted issue) with its release date.
            let issue_release = if had_existing_series {
                issue_release_date(&db, &series_id, &issue_num, is_annual).await
            } else {
                None
            };
            // #203 Phase 1: an annual arriving through the watched folder is named the Mylar way
            // ("Batman Annual #001 (2012)"). Every name goes through naming.rs, so a file lands
            // under the same name whichever door it came through.
            let pattern_to_use = if is_annual {
                crate::renamer::ANNUAL_FILE_PATTERN
            } else if is_manga {
                naming_settings.manga_file.as_str()
            } else {
                naming_settings.file.as_str()
            };
            let file_values = comicinfo_naming(&info, year, Some(effective_imprint.clone()), &issue_num, issue_release);
            let Some(new_filename) = naming::file_name(pattern_to_use, &file_values, naming_settings.padding) else {
                log::warn!("[Watched Sync] The file pattern \"{}\" leaves no name for '{}'; routing to unmatched for review.", pattern_to_use, series_name);
                if park_to_unmatched(&db, &watched_dir, &handoff_path, &path, &unmatched_dir).await { unmatched_count += 1; }
                continue;
            };

            // Never write where the server can't keep it (beta.018 follow-up): the engine runs as root,
            // so a Root Path the server can't use - "C:\Comics" under Docker, a leading space, a typo
            // nothing is mounted at - would be CREATED inside the container and the comic lost on the
            // next image update. The file stays in the watched folder until the path is fixed.
            let target_root: Option<String> = libraries
                .iter()
                .find(|lib| lib.get::<String, _>("id") == target_lib_id)
                .map(|lib| lib.get::<String, _>("path"));
            if let Some(problem) = crate::server_paths::series_folder_problem(&dest_folder, target_root.as_deref()) {
                log::error!(
                    "[Watched Sync] Not importing {:?} for '{}': {} The file stays in the watched folder and is imported on the next sweep after the fix.",
                    path.file_name().unwrap_or_default(),
                    series_name,
                    problem
                );
                continue;
            }

            let _ = std::fs::create_dir_all(&dest_folder);

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

                // #240 PR B: the id the handoff reports is the issue row this file really landed
                // in — the existing row when that number already had one, the new id otherwise.
                let handoff_issue_id = existing_issue_id.clone().unwrap_or_else(|| issue_id.clone());

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
                    // #240 PR B: the sweep did handle the file — it just could not become a library
                    // issue. Recorded as unmatched so the batch settles instead of waiting on a row
                    // that nothing will ever close; the health check still flags the request.
                    record_handoff(&db, &watched_dir, &handoff_path, HANDOFF_UNMATCHED, None, None).await;
                } else {
                    record_handoff(&db, &watched_dir, &handoff_path, HANDOFF_IMPORTED, Some(&handoff_issue_id), Some(&file_path_str)).await;
                }

                synced_series_ids.insert(series_id);
                success_count += 1;
            } else {
                log::warn!("Skipping file {:?}. It might be locked by another program or cross-drive move failed.", path.file_name());
            }
        } else {
            if park_to_unmatched(&db, &watched_dir, &handoff_path, &path, &unmatched_dir).await {
                unmatched_count += 1;
            }
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

/// What a handed-off file became (#240 PR B, "ImportHandoff".outcome). PENDING is the importer's
/// row; the sweep only ever writes these two.
const HANDOFF_IMPORTED: &str = "IMPORTED";
const HANDOFF_UNMATCHED: &str = "UNMATCHED";

/// #240 PR B: record what happened to a file this batch was handed, so the request that asked for
/// it is closed on the STORAGE and not on the routing. Keyed on the file's path relative to the
/// watched folder — the same key the importer wrote — and only on the newest row still PENDING: an
/// older settled row under the same name belongs to an earlier batch and is left alone. Best-effort
/// by design: a file nobody queued, or a busy database, must never fail the import itself.
async fn record_handoff(db: &Db, watched_dir: &str, handoff_path: &Path, outcome: &str, issue_id: Option<&str>, destination: Option<&str>) {
    let rel = handoff_path
        .strip_prefix(watched_dir)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| handoff_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
    if rel.is_empty() {
        return;
    }

    // Dual-dialect rules of db.rs: positional placeholders in order, now_expr() for the timestamp
    // (Prisma's SQLite connector stores DateTime columns as INTEGER epoch-milliseconds).
    let sql = format!(
        r#"UPDATE "ImportHandoff" SET outcome = $1, "issueId" = $2, destination = $3, "updatedAt" = {now}
           WHERE id = (SELECT id FROM "ImportHandoff" WHERE "relPath" = $4 AND outcome = 'PENDING'
                       ORDER BY "createdAt" DESC LIMIT 1)"#,
        now = db.now_expr()
    );
    match sqlx::query(&sql).bind(outcome).bind(issue_id).bind(destination).bind(&rel).execute(&db.pool).await {
        Ok(res) if res.rows_affected() > 0 => {
            log::debug!("[Watched Sync] Import handoff {} -> {} ({})", rel, outcome, destination.unwrap_or(""));
        }
        Ok(_) => {}
        Err(e) => log::warn!("[Watched Sync] Could not stamp the import handoff for {}: {:?}", rel, e),
    }
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

/// The name a file takes in /unmatched when its own is already there: "<stem> (copy N).<ext>",
/// the same rule as the upload route (src/lib/utils/unique-path.ts). Never a bare " (N)": the
/// filename parser reads a trailing bare number as the issue number on scene-style names, and the
/// Smart Matcher numbers /unmatched files with it ("Saga 054 (2018) (Digital) (1)" parses as #1).
fn copy_name(file_name: &std::ffi::OsStr, n: u32) -> std::ffi::OsString {
    let as_path = Path::new(file_name);
    let mut name = std::ffi::OsString::new();
    match (as_path.file_stem(), as_path.extension()) {
        (Some(stem), Some(ext)) => {
            name.push(stem);
            name.push(format!(" (copy {}).", n));
            name.push(ext);
        }
        _ => {
            name.push(file_name);
            name.push(format!(" (copy {})", n));
        }
    }
    name
}

/// How many copy numbers are tried before the move gives up (the file then stays in the watched
/// folder) instead of searching forever.
const MAX_UNMATCHED_COPIES: u32 = 9999;

/// Where `file_name` lands in /unmatched without replacing anything: its own name when that is
/// free, else the first free "(copy N)". Anything at a name counts as taken - a file, a folder, a
/// dangling link.
fn unique_unmatched_dest(unmatched_dir: &Path, file_name: &std::ffi::OsStr) -> Option<PathBuf> {
    let taken = |candidate: &Path| std::fs::symlink_metadata(candidate).is_ok();
    let own = unmatched_dir.join(file_name);
    if !taken(&own) {
        return Some(own);
    }
    (1..=MAX_UNMATCHED_COPIES)
        .map(|n| unmatched_dir.join(copy_name(file_name, n)))
        .find(|candidate| !taken(candidate))
}

/// #240 PR B: every exit that parks a file in /unmatched stamps its handoff row before leaving the
/// file behind — the sweep did handle it, so a request waiting on that file is closed on this
/// outcome instead of waiting on a PENDING row nothing will ever touch. Returns whether the file
/// actually moved (the caller counts it as unmatched when it did).
///
/// One helper because there are five such exits, and one of them (the file pattern leaving no name)
/// used to move the file without stamping, which left its whole batch PENDING forever and the
/// request waiting on it IMPORTING until a person looked (#240 review, hankscafe).
async fn park_to_unmatched(db: &Db, watched_dir: &str, handoff_path: &Path, path: &Path, unmatched_dir: &str) -> bool {
    if move_to_unmatched(path, unmatched_dir).is_ok() {
        record_handoff(db, watched_dir, handoff_path, HANDOFF_UNMATCHED, None, None).await;
        true
    } else {
        false
    }
}

fn move_to_unmatched(src: &Path, unmatched_dir: &str) -> Result<()> {
    let file_name = src
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("{:?} has no file name to move into unmatched", src))?;
    // Never over a file already waiting in /unmatched: two ComicInfo-less files with one name (two
    // packs, or one name in two subfolders of the watched folder) used to leave only the last one.
    let dest = unique_unmatched_dest(Path::new(unmatched_dir), file_name)
        .ok_or_else(|| anyhow::anyhow!("no free name for {:?} in {}", file_name, unmatched_dir))?;
    if dest.file_name() != Some(file_name) {
        log::info!(
            "[Watched Sync] {:?} is already waiting in unmatched; keeping both - this one is {:?}.",
            file_name,
            dest.file_name().unwrap_or_default()
        );
    }
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

/// The naming settings a sweep reads once: the three patterns - a blank one is the default, as on
/// the Node side - and the issue-number padding (#244).
struct WatchedNaming {
    folder: String,
    file: String,
    manga_file: String,
    padding: IssuePadding,
}

impl WatchedNaming {
    fn from_settings<'a>(rows: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        let mut naming = WatchedNaming {
            folder: "{Publisher}/{Series} ({Year})".to_string(),
            file: "{Series} #{Issue}".to_string(),
            manga_file: "{Series} Vol. {Issue}".to_string(),
            padding: IssuePadding::Three,
        };
        for (key, value) in rows {
            let pattern = Some(value).filter(|v| !v.trim().is_empty()).map(str::to_string);
            match (key, pattern) {
                ("folder_naming_pattern", Some(p)) => naming.folder = p,
                ("file_naming_pattern", Some(p)) => naming.file = p,
                ("manga_file_naming_pattern", Some(p)) => naming.manga_file = p,
                ("issue_number_padding", _) => naming.padding = IssuePadding::from_setting(Some(value)),
                _ => {}
            }
        }
        naming
    }
}

/// What a watched file's ComicInfo gives the naming rules (naming.rs). The caller picks the
/// imprint: the archive's own <Imprint> for a new series' folder, the effective one (a curated
/// imprint wins) for the file name.
fn comicinfo_naming(info: &ComicInfo, series_year: i32, imprint: Option<String>, issue_number: &str, release_date: Option<String>) -> NamingInput {
    NamingInput {
        publisher: info.publisher.clone(),
        series: info.series.clone().unwrap_or_default(),
        series_year,
        issue_number: issue_number.to_string(),
        release_date,
        comic_info_year: info.year,
        issue_title: info.title.clone(),
        universe: info.universe.clone(),
        series_group: info.series_group.clone(),
        imprint,
    }
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

    // ==== /unmatched never replaces a file: two ComicInfo-less files with one name (two packs, or
    // the same name in two subfolders of the watched folder, flattened in one sweep) used to leave
    // only the second - the first was silently overwritten. The newcomer takes " (copy N)", the
    // rule the upload route uses too: never a bare " (N)", which the filename parser reads as the
    // issue number on scene-style names ("Saga 054 (2018) (Digital) (1)" parses as #1).

    #[test]
    fn move_to_unmatched_keeps_the_file_already_there() {
        let (base, src, to) = move_fixture();
        std::fs::write(to.join("Batman 001.cbz"), b"the first").unwrap();

        move_to_unmatched(&src, &to.to_string_lossy()).unwrap();

        assert_eq!(std::fs::read(to.join("Batman 001.cbz")).unwrap(), b"the first", "the file already in unmatched is untouched");
        assert_eq!(std::fs::read(to.join("Batman 001 (copy 1).cbz")).unwrap(), b"the comic", "the newcomer sits beside it");
        assert!(!src.exists(), "the source is removed after the move");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn move_to_unmatched_takes_the_next_free_copy_number() {
        let (base, src, to) = move_fixture();
        std::fs::write(to.join("Batman 001.cbz"), b"the first").unwrap();
        std::fs::write(to.join("Batman 001 (copy 1).cbz"), b"the second").unwrap();

        move_to_unmatched(&src, &to.to_string_lossy()).unwrap();

        assert_eq!(names_in(&to), vec!["Batman 001 (copy 1).cbz", "Batman 001 (copy 2).cbz", "Batman 001.cbz"]);
        assert_eq!(std::fs::read(to.join("Batman 001 (copy 1).cbz")).unwrap(), b"the second");
        assert_eq!(std::fs::read(to.join("Batman 001 (copy 2).cbz")).unwrap(), b"the comic");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn move_to_unmatched_keeps_the_name_when_it_is_free() {
        let (base, src, to) = move_fixture();

        move_to_unmatched(&src, &to.to_string_lossy()).unwrap();

        assert_eq!(names_in(&to), vec!["Batman 001.cbz"]);
        assert_eq!(std::fs::read(to.join("Batman 001.cbz")).unwrap(), b"the comic");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_names_keep_the_extension_last_like_the_upload_route() {
        let name = |s: &str, n: u32| copy_name(std::ffi::OsStr::new(s), n).to_string_lossy().to_string();
        assert_eq!(name("Saga 054 (2018) (Digital).cbz", 1), "Saga 054 (2018) (Digital) (copy 1).cbz");
        assert_eq!(name("Batman 001.cbz", 12), "Batman 001 (copy 12).cbz");
        assert_eq!(name("archive.tar.gz", 1), "archive.tar (copy 1).gz");
        assert_eq!(name("README", 2), "README (copy 2)");
        assert_eq!(name(".hidden", 1), ".hidden (copy 1)");
    }

    // ==== #243: {IssueYear} carried the SERIES year (ComicInfo <Volume>, else <Year>) for every
    // file the watched folder imported - "X-Men #38 (2024)" for a 2026 issue of a 2024 series.

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

    // ==== Naming (#244 + the naming cleanup): a watched file is named by naming.rs, the same rules
    // Standardize and every Node path use. It used to pad only a single digit ("#01" beside
    // Standardize's "#001"), matched every token but {Imprint} case-sensitively, left a dangling
    // "- " for a blank token, used a blank pattern setting as an empty pattern, and put <Number>
    // into the file name unsanitized - "1/2" became a sub-path the move then failed on.

    fn comicinfo(xml: &str) -> ComicInfo {
        quick_xml::de::from_str(xml).expect("parse ComicInfo")
    }

    #[test]
    fn a_watched_file_is_named_like_standardize_names_it() {
        let info = comicinfo("<ComicInfo><Series>Batman</Series><Number>1</Number><Volume>2016</Volume><Year>2017</Year><Publisher>DC Comics</Publisher></ComicInfo>");
        let v = comicinfo_naming(&info, 2016, None, "1", None);
        assert_eq!(naming::file_name("{Series} #{Issue} ({IssueYear})", &v, IssuePadding::Three).as_deref(), Some("Batman #001 (2017)"));
        assert_eq!(naming::file_name("{series} #{ISSUE}", &v, IssuePadding::Three).as_deref(), Some("Batman #001"));
        assert_eq!(naming::file_name("{Imprint} - {Series} #{Issue}", &v, IssuePadding::Three).as_deref(), Some("Batman #001"));
        assert_eq!(naming::file_name("{Series} #{Issue}", &v, IssuePadding::None).as_deref(), Some("Batman #1"));
        assert_eq!(
            naming::folder_segments("{Publisher}/{Series} ({Year})", &v),
            Some(vec!["DC Comics".to_string(), "Batman (2016)".to_string()])
        );
    }

    #[test]
    fn a_slash_in_the_number_never_becomes_a_sub_path() {
        let info = comicinfo("<ComicInfo><Series>Wizard</Series><Number>1/2</Number></ComicInfo>");
        let name = naming::file_name("{Series} #{Issue}", &comicinfo_naming(&info, 0, None, "1/2", None), IssuePadding::Three).unwrap();
        assert!(!name.contains(['/', '\\']), "{name:?}");
    }

    #[test]
    fn imprint_expands_in_watched_folder_and_file_patterns() {
        let info = comicinfo("<ComicInfo><Series>Batman</Series><Number>1</Number><Imprint>Absolute</Imprint></ComicInfo>");
        let with = comicinfo_naming(&info, 2016, Some("Absolute".into()), "1", None);
        let without = comicinfo_naming(&info, 2016, None, "1", None);
        assert_eq!(naming::folder_segments("{Imprint}/{Series} ({Year})", &with), Some(vec!["Absolute".to_string(), "Batman (2016)".to_string()]));
        assert_eq!(naming::folder_segments("{Imprint}/{Series} ({Year})", &without), Some(vec!["Batman (2016)".to_string()]));
        assert_eq!(naming::file_name("{Imprint} {Series} #{Issue}", &with, IssuePadding::Three).as_deref(), Some("Absolute Batman #001"));
        assert_eq!(naming::file_name("{Imprint} {Series} #{Issue}", &without, IssuePadding::Three).as_deref(), Some("Batman #001"));
    }

    #[test]
    fn dot_dot_comicinfo_values_cannot_climb_out_of_the_library_root() {
        for pattern in ["{Publisher}/{Series} ({Year})", "{Series}", "{UniverseName}/{SeriesGroup}/{Series}"] {
            for hostile in ["..", ".", "...", " .. ", "../..", "..\\.."] {
                for (publisher, series, universe, group) in [
                    (hostile, "Saga", "", ""),
                    ("Image", hostile, "", ""),
                    (hostile, hostile, hostile, hostile),
                ] {
                    let xml = format!(
                        "<ComicInfo><Series>{series}</Series><Publisher>{publisher}</Publisher><Universe>{universe}</Universe><SeriesGroup>{group}</SeriesGroup></ComicInfo>"
                    );
                    let segments = naming::folder_segments(pattern, &comicinfo_naming(&comicinfo(&xml), 0, None, "1", None))
                        .unwrap_or_else(|| panic!("{pattern:?} with {hostile:?} was refused; sanitizing should defuse it"));
                    assert!(segments.iter().all(|s| !s.chars().all(|c| c == '.')), "{pattern:?} with {hostile:?}: {segments:?}");
                }
            }
        }
        // The default pattern still reads naturally around the neutralized value.
        let info = comicinfo("<ComicInfo><Series>Saga</Series><Publisher>..</Publisher></ComicInfo>");
        assert_eq!(
            naming::folder_segments("{Publisher}/{Series} ({Year})", &comicinfo_naming(&info, 2012, None, "1", None)),
            Some(vec!["_".to_string(), "Saga (2012)".to_string()])
        );
    }

    #[test]
    fn blank_naming_settings_fall_back_to_the_defaults_and_the_padding_is_read() {
        let n = WatchedNaming::from_settings([
            ("folder_naming_pattern", ""),
            ("file_naming_pattern", "   "),
            ("manga_file_naming_pattern", "{Series} v{Issue}"),
            ("issue_number_padding", "2"),
        ]);
        assert_eq!(n.folder, "{Publisher}/{Series} ({Year})");
        assert_eq!(n.file, "{Series} #{Issue}");
        assert_eq!(n.manga_file, "{Series} v{Issue}");
        assert_eq!(n.padding, IssuePadding::Two);

        let defaults = WatchedNaming::from_settings([]);
        assert_eq!((defaults.manga_file.as_str(), defaults.padding), ("{Series} Vol. {Issue}", IssuePadding::Three));
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


#[cfg(test)]
mod handoff_tests {
    use super::*;
    use std::io::Write as _;

    /// A file-backed sqlite of its own holding the `ImportHandoff` table exactly as Prisma creates
    /// it on SQLite: TEXT ids, DATETIME (epoch-ms) timestamps — the two processes share one file.
    async fn handoff_db(base: &Path) -> Db {
        let db_file = base.join("handoff.db");
        std::fs::File::create(&db_file).expect("pre-create sqlite file");
        let db_url = format!("file:{}", db_file.to_string_lossy().replace('\\', "/"));
        let db = crate::db::Db::connect(&db_url, 1).await.expect("connect file-backed sqlite");

        // The model exactly as Prisma creates it on SQLite: TEXT ids, DATETIME (epoch-ms) timestamps.
        sqlx::query(
            r#"CREATE TABLE "ImportHandoff" (
                id TEXT PRIMARY KEY NOT NULL,
                "batchId" TEXT NOT NULL,
                "requestIds" TEXT NOT NULL DEFAULT '[]',
                "relPath" TEXT NOT NULL,
                "volumeId" TEXT,
                "metadataSource" TEXT,
                outcome TEXT NOT NULL DEFAULT 'PENDING',
                "issueId" TEXT,
                destination TEXT,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" DATETIME NOT NULL
            )"#,
        )
        .execute(&db.pool)
        .await
        .expect("create handoff table");

        db
    }

    /// #240 PR B: the sweep's whole job in the handoff is to stamp a file's outcome under the key
    /// the importer wrote (its name relative to the watched folder), on Prisma's real SQLite column
    /// types — the two processes share one database file.
    #[tokio::test]
    async fn stamps_the_newest_pending_handoff_row_for_the_relative_path() {
        let base = std::env::temp_dir().join(format!("omnibus_handoff_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).expect("create temp dir");
        let db = handoff_db(&base).await;

        let watched = base.join("watched");
        std::fs::create_dir_all(&watched).unwrap();
        let watched_str = watched.to_string_lossy().to_string();
        let routed = watched.join("Pack #1.cbz");
        std::fs::File::create(&routed).and_then(|mut f| f.write_all(b"x")).expect("write fixture file");
        let rel = "Pack #1.cbz";

        // Two batches, same file name: the older row is already settled, the newer one is pending.
        for (id, outcome, created) in [("old", "UNMATCHED", 1_000_i64), ("new", "PENDING", 2_000_i64)] {
            sqlx::query(
                r#"INSERT INTO "ImportHandoff" (id, "batchId", "requestIds", "relPath", outcome, "createdAt", "updatedAt")
                   VALUES ($1, 'b1', '[]', $2, $3, $4, $4)"#,
            )
            .bind(id)
            .bind(rel)
            .bind(outcome)
            .bind(created)
            .execute(&db.pool)
            .await
            .expect("seed handoff row");
        }

        // A file nobody queued: no row to stamp, and no error either.
        record_handoff(&db, &watched_str, &watched.join("Stranger.cbz"), HANDOFF_UNMATCHED, None, None).await;

        record_handoff(&db, &watched_str, &routed, HANDOFF_IMPORTED, Some("issue-1"), Some("/comics/Pack #1.cbz")).await;

        let rows: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
            r#"SELECT id, outcome, "issueId", destination FROM "ImportHandoff" ORDER BY "createdAt""#,
        )
        .fetch_all(&db.pool)
        .await
        .expect("read handoff rows");

        assert_eq!(rows.len(), 2, "no row is invented for a file nobody queued");
        assert_eq!(rows[0].0, "old");
        assert_eq!(rows[0].1, "UNMATCHED", "an already-settled row is never rewritten");
        assert_eq!(rows[1].0, "new");
        assert_eq!(rows[1].1, "IMPORTED");
        assert_eq!(rows[1].2.as_deref(), Some("issue-1"));
        assert_eq!(rows[1].3.as_deref(), Some("/comics/Pack #1.cbz"));

        // A second pass over the same file leaves the row it already settled alone.
        record_handoff(&db, &watched_str, &routed, HANDOFF_UNMATCHED, None, None).await;
        let (outcome,): (String,) = sqlx::query_as(r#"SELECT outcome FROM "ImportHandoff" WHERE id = 'new'"#)
            .fetch_one(&db.pool)
            .await
            .expect("read settled row");
        assert_eq!(outcome, "IMPORTED");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// #240 review (hankscafe): the fifth exit — the file pattern leaving no name — used to move the
    /// file to /unmatched without stamping its row, which left the whole batch PENDING forever and
    /// the request waiting on it IMPORTING until a person looked. Every park now goes through
    /// `park_to_unmatched`, so this pins the shared behaviour: the file lands in /unmatched AND its
    /// row is settled.
    #[tokio::test]
    async fn parking_a_file_settles_its_pending_handoff_row() {
        let base = std::env::temp_dir().join(format!("omnibus_handoff_park_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).expect("create temp dir");
        let db = handoff_db(&base).await;

        let watched = base.join("watched");
        let unmatched = base.join("unmatched");
        std::fs::create_dir_all(&watched).unwrap();
        // The sweep creates this up front (`process_watched_folder`); the park needs it to exist.
        std::fs::create_dir_all(&unmatched).unwrap();
        let watched_str = watched.to_string_lossy().to_string();
        let file = watched.join("Pack #1.cbz");
        std::fs::File::create(&file).and_then(|mut f| f.write_all(b"x")).expect("write fixture file");

        sqlx::query(
            r#"INSERT INTO "ImportHandoff" (id, "batchId", "requestIds", "relPath", outcome, "createdAt", "updatedAt")
               VALUES ('row1', 'b1', '["req_1"]', 'Pack #1.cbz', 'PENDING', 1000, 1000)"#,
        )
        .execute(&db.pool)
        .await
        .expect("seed handoff row");

        let moved = park_to_unmatched(&db, &watched_str, &file, &file, &unmatched.to_string_lossy()).await;

        assert!(moved, "the file left the watched folder");
        assert!(!file.exists());
        assert!(unmatched.join("Pack #1.cbz").exists(), "and it is parked in /unmatched");
        let (outcome,): (String,) = sqlx::query_as(r#"SELECT outcome FROM "ImportHandoff" WHERE id = 'row1'"#)
            .fetch_one(&db.pool)
            .await
            .expect("read the row");
        assert_eq!(outcome, "UNMATCHED", "the batch settles instead of waiting on a PENDING row");

        let _ = std::fs::remove_dir_all(&base);
    }
}
