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
use std::sync::OnceLock;

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
    publisher: Option<String>,
    manga: Option<String>,
    #[serde(default)]
    universe: Option<String>,
    #[serde(default)]
    series_group: Option<String>,
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
        // Empty settings mean "use the built-in default". Accepting an empty file pattern makes
        // every issue converge on `.cbz`, silently overwriting the previous issue in a batch.
        if !val.trim().is_empty() {
            if key == "folder_naming_pattern" { folder_pattern = val.clone(); }
            if key == "file_naming_pattern" { file_pattern = val.clone(); }
            if key == "manga_file_naming_pattern" { manga_file_pattern = val.clone(); }
        }
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

    // Scene packs frequently omit ComicInfo.xml entirely. Build a conservative list of existing
    // series names and their configured localized aliases so a filename such as `Thorgal T01` or
    // `Elfes.T1` can still be imported. The parser below requires an explicit T/Tome number directly
    // after the series name; spin-offs (`XIII Mystery`, `Thorgal Saga`) and hors-series stay unmatched.
    let series_rows = sqlx::query(r#"SELECT name FROM "Series""#).fetch_all(&db.pool).await?;
    let acronym_rows = sqlx::query(r#"SELECT key, value FROM "SearchAcronym""#).fetch_all(&db.pool).await?;
    let mut filename_series_candidates = Vec::new();
    for row in series_rows {
        let canonical: String = row.get("name");
        filename_series_candidates.push((canonical.clone(), canonical.clone()));
        for alias_row in &acronym_rows {
            let key: String = alias_row.get("key");
            let value: String = alias_row.get("value");
            if key.eq_ignore_ascii_case(&canonical) {
                filename_series_candidates.push((value, canonical.clone()));
            } else if value.eq_ignore_ascii_case(&canonical) {
                filename_series_candidates.push((key, canonical.clone()));
            }
        }
    }
    filename_series_candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.0.len()));

    let mut success_count = 0;
    let mut unmatched_count = 0;
    let mut synced_series_ids = std::collections::HashSet::new();

    for file_data in preprocessed_files {
        let path = file_data.working_path;

        let metadata = file_data.meta.or_else(|| {
            infer_comicinfo_from_filename(&path, &filename_series_candidates)
        });
        if let Some(info) = metadata {
            if info.series.is_none() {
                if move_to_unmatched(&path, &unmatched_dir).is_ok() { unmatched_count += 1; }
                continue;
            }

            let mut series_name = info.series.clone().unwrap_or_else(|| "Unknown".to_string());
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

            // Prefer provider IDs. Scene packs often carry useful ComicInfo (Series + Number) but no
            // ComicVine/Metron IDs; in that case accept only one unambiguous EXISTING local series,
            // including a configured localized alias (for example ComicVine "Elves" ↔ "Elfes").
            // Never create a new series from name alone, and never pick between duplicate names.
            let existing_series = if meta_source == "LOCAL" || meta_id.is_empty() {
                let alias = sqlx::query(
                    r#"SELECT key, value FROM "SearchAcronym"
                       WHERE lower(key) = lower($1) OR lower(value) = lower($1) LIMIT 1"#
                )
                .bind(&series_name)
                .fetch_optional(&db.pool).await?;
                let alternate_name = alias.map(|row| {
                    let key: String = row.get("key");
                    let value: String = row.get("value");
                    if key.eq_ignore_ascii_case(&series_name) { value } else { key }
                }).unwrap_or_else(|| series_name.clone());

                let mut candidates = sqlx::query(
                    r#"SELECT id, name, CAST("isManga" AS INTEGER) AS "isManga", "libraryId", "folderPath"
                       FROM "Series"
                       WHERE lower(name) = lower($1) OR lower(name) = lower($2)"#
                )
                .bind(&series_name).bind(&alternate_name)
                .fetch_all(&db.pool).await?;

                if candidates.len() == 1 {
                    log::info!("[Watched Sync] Matched ID-less pack entry '{}' to the unique existing series '{}'.", series_name, alternate_name);
                    candidates.pop()
                } else {
                    log::info!("[Watched Sync] '{}' has no provider ID and resolved to {} existing series; routing to unmatched.", series_name, candidates.len());
                    None
                }
            } else {
                // Provider-backed files remain strict by the (metadataSource, metadataId) unique key.
                sqlx::query(
                    r#"SELECT id, name, CAST("isManga" AS INTEGER) AS "isManga", "libraryId", "folderPath" FROM "Series"
                       WHERE "metadataSource" = $1 AND "metadataId" = $2"#
                )
                .bind(&meta_source).bind(&meta_id)
                .fetch_optional(&db.pool).await?
            };

            if (meta_source == "LOCAL" || meta_id.is_empty()) && existing_series.is_none() {
                if move_to_unmatched(&path, &unmatched_dir).is_ok() { unmatched_count += 1; }
                continue;
            }

            let series_id: String;
            let target_lib_id: String;
            let dest_folder: PathBuf;

            if let Some(series_row) = existing_series {
                series_id = series_row.get("id");
                // Use the canonical existing name for both DB and file naming. Otherwise a localized
                // ComicInfo alias (`Elfes`) and filename inference (`Elves`) create two parallel sets.
                series_name = series_row.get("name");
                is_manga = series_row.get::<i64, _>("isManga") != 0;
                target_lib_id = series_row.get("libraryId");
                dest_folder = PathBuf::from(series_row.get::<String, _>("folderPath"));
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
                let series_group_fs = clean_fs_name(&info.series_group.clone().unwrap_or_default());
                let universe_fs = clean_fs_name(&info.universe.clone().unwrap_or_default());
                let rel_folder = clean_naming_leftovers(&folder_pattern
                    .replace("{Publisher}", &clean_fs_name(&publisher))
                    .replace("{Series}", &clean_fs_name(&series_name))
                    .replace("{Year}", &year_str)
                    .replace("{VolumeYear}", &year_str)
                    .replace("{UniverseName}", &universe_fs)
                    .replace("{SeriesGroup}", &series_group_fs));
                // Build the path one segment at a time, dropping any that resolved to empty (e.g. a
                // blank {SeriesGroup}) — a leading "" segment would otherwise make join() absolute on Unix.
                let mut folder = PathBuf::from(&fallback_lib_path);
                for seg in rel_folder.split(['/', '\\']).map(|s| s.trim()).filter(|s| !s.is_empty()) {
                    folder.push(seg);
                }
                dest_folder = folder;
            }

            let _ = std::fs::create_dir_all(&dest_folder);

            let formatted_num = if issue_num.len() == 1 { format!("0{}", issue_num) } else { issue_num.clone() };
            let pattern_to_use = if is_manga { &manga_file_pattern } else { &file_pattern };
            
            let new_filename = clean_naming_leftovers(&pattern_to_use
                .replace("{Publisher}", &clean_fs_name(&publisher))
                .replace("{Series}", &clean_fs_name(&series_name))
                .replace("{Year}", &year_str)
                .replace("{VolumeYear}", &year_str)
                .replace("{IssueYear}", &year_str)
                .replace("{Issue}", &formatted_num)
                .replace("{IssueTitle}", &clean_fs_name(&info.title.clone().unwrap_or_default()))
                .replace("{UniverseName}", &clean_fs_name(&info.universe.clone().unwrap_or_default()))
                .replace("{SeriesGroup}", &clean_fs_name(&info.series_group.clone().unwrap_or_default())));

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

                // Dedupe: update an existing issue with the same number instead of inserting a duplicate.
                let existing_issue_id: Option<String> = sqlx::query(
                    r#"SELECT id, number FROM "Issue" WHERE "seriesId" = $1"#,
                )
                .bind(&series_id)
                .fetch_all(&db.pool)
                .await
                .unwrap_or_default()
                .iter()
                .find_map(|r| {
                    let n: String = r.get("number");
                    if crate::metadata::is_same_issue(&n, &issue_num) { Some(r.get::<String, _>("id")) } else { None }
                });

                let res = if let Some(eid) = existing_issue_id {
                    sqlx::query(
                        // Preserve already-present data on re-import (parity with importer.ts dedupe):
                        // keep existing non-empty name/description/credits and a real metadataId; only
                        // upgrade metadataSource from LOCAL and matchState from UNMATCHED — never clobber
                        // a richly-matched issue with freshly-parsed (possibly empty) values.
                        r#"UPDATE "Issue" SET
                               number=$1,
                               status='DOWNLOADED',
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
                    )
                    .bind(&issue_num).bind(&file_path_str).bind(&issue_title).bind(&issue_summary)
                    .bind(&writers_json).bind(&artists_json).bind(&characters_json)
                    .bind(&issue_meta_id).bind(&issue_meta_source).bind(issue_match_state).bind(page_count).bind(&eid)
                    .bind(&release_date)
                    .execute(&db.pool).await
                } else {
                    sqlx::query(&format!(
                        r#"INSERT INTO "Issue" (id, "seriesId", number, status, "filePath", name, description, writers, artists, characters, "matchState", "metadataId", "metadataSource", "pageCount", "releaseDate", "createdAt")
                           VALUES ($1, $2, $3, 'DOWNLOADED', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, {now})"#,
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
        // A batch request is attached to the provider volume, not to an Issue relation. Once every
        // known issue in that volume has a real file, reconcile the old per-issue requests so the UI
        // does not keep showing AWAITING/STALLED after a pack fulfilled the complete series.
        for series_id in &synced_series_ids {
            let metadata_id: Option<String> = sqlx::query_scalar(
                r#"SELECT "metadataId" FROM "Series" WHERE id = $1"#,
            )
            .bind(series_id)
            .fetch_optional(&db.pool)
            .await?
            .flatten();
            let Some(metadata_id) = metadata_id.filter(|id| !id.is_empty()) else { continue };
            let total: i64 = sqlx::query_scalar(
                r#"SELECT COUNT(*) FROM "Issue" WHERE "seriesId" = $1"#,
            ).bind(series_id).fetch_one(&db.pool).await?;
            let missing: i64 = sqlx::query_scalar(
                r#"SELECT COUNT(*) FROM "Issue"
                   WHERE "seriesId" = $1
                     AND (status <> 'DOWNLOADED' OR "filePath" IS NULL OR "filePath" = '')"#,
            ).bind(series_id).fetch_one(&db.pool).await?;
            if total > 0 && missing == 0 {
                let result = sqlx::query(&format!(
                    r#"UPDATE "Request" SET status='COMPLETED', progress=100, "updatedAt"={now}
                       WHERE "volumeId"=$1
                         AND status IN ('PENDING', 'DOWNLOADING', 'AWAITING_RELEASE', 'STALLED', 'MANUAL_DDL', 'IMPORTED')"#,
                    now = db.now_expr()
                )).bind(&metadata_id).execute(&db.pool).await?;
                if result.rows_affected() > 0 {
                    log::info!(
                        "[Watched Sync] Reconciled {} completed requests for provider volume {}.",
                        result.rows_affected(), metadata_id
                    );
                }
            }
        }

        let series_list: Vec<String> = synced_series_ids.into_iter().collect();
        let db_clone = db.clone();
        tokio::spawn(async move {
            let _ = crate::metadata::sync_metadata(db_clone, Some(series_list)).await;
        });
    }

    Ok((success_count, unmatched_count, format!("Processed watched folder. Imported: {}. Moved to unmatched: {}.", success_count, unmatched_count)))
}

fn infer_comicinfo_from_filename(path: &Path, candidates: &[(String, String)]) -> Option<ComicInfo> {
    let stem = path.file_stem()?.to_string_lossy();
    let mut matches = Vec::new();

    for (visible_name, canonical_name) in candidates {
        // Prefer an explicit T/Tome marker, but also accept the common French scene form
        // `Elfes - 01 - title`. The marker-less branch is capped at three digits so a collection
        // year cannot be mistaken for an issue number.
        let pattern = format!(
            r"(?i)^{}[ ._-]+(?:T(?:ome)?[ ._-]*0*([0-9]+)|0*([0-9]{{1,3}}))(?:[ ._-]|$)",
            regex::escape(visible_name)
        );
        let Ok(re) = Regex::new(&pattern) else { continue };
        let Some(captures) = re.captures(&stem) else { continue };
        let Some(number) = captures.get(1).or_else(|| captures.get(2)).map(|m| m.as_str().to_string()) else { continue };
        if !matches.iter().any(|(series, issue): &(String, String)| {
            series.eq_ignore_ascii_case(canonical_name) && issue == &number
        }) {
            matches.push((canonical_name.clone(), number));
        }
    }

    if matches.len() != 1 {
        return None;
    }
    let (series, number) = matches.pop()?;
    log::info!(
        "[Watched Sync] Inferred existing series '{}' issue {} from filename '{}'.",
        series,
        number,
        stem
    );
    Some(ComicInfo {
        title: Some(stem.to_string()),
        series: Some(series),
        number: Some(number),
        ..ComicInfo::default()
    })
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

fn robust_move(src: &Path, dest: &Path) -> Result<()> {
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }

    let tmp_dest = dest.with_extension("tmp_move");
    std::fs::copy(src, &tmp_dest)?;

    if cfg!(target_os = "windows") && dest.exists() {
        let _ = std::fs::remove_file(dest);
    }
    std::fs::rename(&tmp_dest, dest)?;
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

fn clean_fs_name(input: &str) -> String {
    input.replace(&['<', '>', ':', '"', '/', '\\', '|', '?', '*'][..], "").trim().to_string()
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

    #[test]
    fn fs_name_strips_invalid_characters() {
        assert_eq!(clean_fs_name("Bat: Man?"), "Bat Man");
        assert_eq!(clean_fs_name("  A/B\\C|D  "), "ABCD");
        assert_eq!(clean_fs_name("Plain Name"), "Plain Name");
    }

    #[test]
    fn naming_leftovers_cleaned() {
        // Blank {Year} inside "({Year})" leaves "()" — must be removed, not printed.
        assert_eq!(clean_naming_leftovers("Saga ()"), "Saga");
        assert_eq!(clean_naming_leftovers("Saga [] #01"), "Saga #01");
        assert_eq!(clean_naming_leftovers("Saga  (2014)  #01"), "Saga (2014) #01");
    }

    #[test]
    fn comicinfo_fields_split_to_json_arrays() {
        assert_eq!(split_to_json(Some("A, B")), r#"["A","B"]"#);
        assert_eq!(split_to_json(Some("Solo")), r#"["Solo"]"#);
        assert_eq!(split_to_json(Some(" , ,")), "[]"); // empty parts filtered
        assert_eq!(split_to_json(None), "[]");
    }

    #[test]
    fn filename_metadata_accepts_main_series_and_localized_alias() {
        let candidates = vec![
            ("Thorgal".to_string(), "Thorgal".to_string()),
            ("XIII".to_string(), "XIII".to_string()),
            ("Elfes".to_string(), "Elves".to_string()),
        ];
        let thorgal = infer_comicinfo_from_filename(
            Path::new("Thorgal T01 - La Magicienne trahie.cbz"),
            &candidates,
        ).unwrap();
        assert_eq!(thorgal.series.as_deref(), Some("Thorgal"));
        assert_eq!(thorgal.number.as_deref(), Some("1"));

        let elves = infer_comicinfo_from_filename(Path::new("Elfes.T35.FR.cbz"), &candidates).unwrap();
        assert_eq!(elves.series.as_deref(), Some("Elves"));
        assert_eq!(elves.number.as_deref(), Some("35"));

        let elves_dash = infer_comicinfo_from_filename(
            Path::new("Elfes - 01 - Le crystal des Elfes bleus.cbz"),
            &candidates,
        ).unwrap();
        assert_eq!(elves_dash.series.as_deref(), Some("Elves"));
        assert_eq!(elves_dash.number.as_deref(), Some("1"));
    }

    #[test]
    fn filename_metadata_rejects_spin_offs_integrales_and_hors_series() {
        let candidates = vec![("XIII".to_string(), "XIII".to_string()), ("Thorgal".to_string(), "Thorgal".to_string())];
        assert!(infer_comicinfo_from_filename(Path::new("XIII.Mystery.2008.T01.cbz"), &candidates).is_none());
        assert!(infer_comicinfo_from_filename(Path::new("XIII.Intégrale.30.ans.T01.cbz"), &candidates).is_none());
        assert!(infer_comicinfo_from_filename(Path::new("Thorgal Saga - T01.cbz"), &candidates).is_none());
        assert!(infer_comicinfo_from_filename(Path::new("Thorgal THS1 - Bonus.cbz"), &candidates).is_none());
        assert!(infer_comicinfo_from_filename(Path::new("XIII.T13Bis.Enquête.cbz"), &candidates).is_none());
        assert!(infer_comicinfo_from_filename(Path::new("XIII - 2019 collection.cbz"), &candidates).is_none());
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
}
