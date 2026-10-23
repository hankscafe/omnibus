// Bulk rename / standardize job — the engine port of src/app/api/library/rename/route.ts.
//
// Node forwards the whole job here (synchronously, via engineFetchLong) so a library-wide
// standardize doesn't run hundreds of file moves + DB updates on the Node event loop. Every rule
// is parity with the Node route, which remains the full local fallback:
//   - files are relocated ONE-BY-ONE, never a folder-level move with overwrite (the historical
//     "Standardize names ate my comics" data-loss bug),
//   - an existing different file at the target is a logged conflict, never an overwrite,
//   - only confirmed-empty source directories are removed, walking up to (never past) the
//     library root.
use anyhow::Result;
use crate::db::Db;
use sqlx::Row;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use crate::naming::{self, IssuePadding, NamingInput};

pub struct RenameSummary {
    pub files_renamed: i64,
    pub folders_renamed: i64,
    pub conflicts: i64,
    pub last_path: String,
}

/// Separator- and case-insensitive path comparison key (parity with the Node route's
/// `path.normalize(x).toLowerCase()` comparisons).
fn norm_ci(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Remove `start`, then walk up removing empty parents, stopping at (never removing) the library
/// root or the first non-empty directory (parity with Node's cleanupEmptyDirs in safe-fs.ts).
fn cleanup_empty_dirs(start: &Path, library_root: &Path) {
    let root_n = norm_ci(&library_root.to_string_lossy());
    if root_n.is_empty() {
        return;
    }
    let mut dir = start.to_path_buf();
    loop {
        let dir_n = norm_ci(&dir.to_string_lossy());
        // Require the separator boundary so "/libraryX" can't be treated as inside "/library".
        if dir_n.len() <= root_n.len() || !dir_n.starts_with(&format!("{}/", root_n)) {
            break;
        }
        match fs::read_dir(&dir) {
            Ok(mut rd) => {
                if rd.next().is_some() {
                    break; // not empty — never delete a folder with contents
                }
            }
            Err(_) => break,
        }
        if fs::remove_dir(&dir).is_err() {
            break;
        }
        log::debug!("[Renamer] Removed empty folder: {:?}", dir);
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => break,
        }
    }
}

/// Move with a cross-device fallback (parity with Node's moveFileSafe in safe-fs.ts): on rename
/// failure, copy to a temp name BESIDE the destination, rename it into place (same-filesystem →
/// atomic), then delete the source. A crash mid-copy can never leave a partial file at the real
/// filename — only a stale `.omnitmp` that no comic-extension filter matches.
fn move_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = dst.with_file_name(format!(
        "{}.{}.omnitmp",
        dst.file_name().unwrap_or_default().to_string_lossy(),
        millis
    ));
    let staged = (|| {
        fs::copy(src, &tmp)?;
        fs::rename(&tmp, dst)?;
        fs::remove_file(src)
    })();
    if staged.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    staged
}

struct SeriesRow {
    id: String,
    name: String,
    publisher: Option<String>,
    year: i32,
    universe: Option<String>,
    series_group: Option<String>,
    imprint: Option<String>,
    folder_path: String,
    library_id: Option<String>,
    is_manga: bool,
}

struct LibraryRow {
    id: String,
    path: String,
    is_default: bool,
    is_manga: bool,
}

/// Per-series file pattern: manga series use the manga template when one is supplied (2026-07-25
/// worklist item 8 — the engine previously applied `file_pattern` unconditionally, so manga always
/// got the comic convention on standardize). Empty/blank manga patterns fall back to the comic one.
fn effective_file_pattern<'a>(is_manga: bool, file_pattern: &'a str, manga_file_pattern: Option<&'a str>) -> &'a str {
    match manga_file_pattern {
        Some(m) if is_manga && !m.trim().is_empty() => m,
        _ => file_pattern,
    }
}

/// #203 Phase 1: the Mylar-shaped annual name — "Batman Annual #001 (2012)", the year being the
/// ANNUAL's own. Fixed rather than pattern-driven in v1: interoperating with what Mylar/Komga expect
/// beside the main run is the entire point of the naming, and it outranks the manga template too
/// (a manga annual is still an annual). Twins: the Node standardize loop, importer, watched_sync.
pub(crate) const ANNUAL_FILE_PATTERN: &str = "{Series} Annual #{Issue} ({IssueYear})";

/// #203 COLLECTED: the default shape for a trade or omnibus attached to a series. Unlike the
/// annual pattern this one is CONFIGURABLE (collected_file_naming_pattern) — TPB conventions vary
/// far more (v01 / Vol. 1 / the collection's own title), so a fixed pattern would rename against
/// the grain of half the libraries that use this. The number is the user's curation, which makes
/// the filename carry reading order for free.
pub(crate) const COLLECTED_FILE_PATTERN: &str = "{Series} Vol. {Issue} ({IssueYear})";

/// `is_retained_collected` (#239): the row belongs to a series that a COLLECTED attachment keeps
/// as its own ("Leave it as its own series") and the row has no attachment of its own. Its books are
/// that collection's volumes, so they take the collected pattern in their own folder — ranked after
/// the annual check, so an annual inside such a series keeps its Mylar name.
pub(crate) fn file_pattern_for_issue<'a>(
    is_annual: bool,
    is_collected: bool,
    is_retained_collected: bool,
    is_manga: bool,
    file_pattern: &'a str,
    manga_file_pattern: Option<&'a str>,
    collected_file_pattern: Option<&'a str>,
) -> &'a str {
    let collected = || match collected_file_pattern {
        Some(p) if !p.trim().is_empty() => p,
        _ => COLLECTED_FILE_PATTERN,
    };
    // Collected first: a collected edition of a manga series is still a collected edition, and an
    // attachment's kind is an explicit human decision that outranks the series-level template.
    if is_collected {
        return collected();
    }
    if is_annual {
        ANNUAL_FILE_PATTERN
    } else if is_retained_collected {
        collected()
    } else {
        effective_file_pattern(is_manga, file_pattern, manga_file_pattern)
    }
}

/// What `{Series}` means in one issue's FILE name. EXACT TWIN of Node's `seriesTokenForIssue`
/// (src/lib/utils/file-pattern.ts).
///
/// A LOCAL collected edition — a trade the provider has no volume for — is claimed by its files'
/// NAMES alone (the name-anchored rule, attached_volumes.rs attachment_for_filename): there is no
/// issue id in a ComicInfo to fall back on. So its books are named after the EDITION ("Batman
/// Compendium Vol. 001"), which the name rule still finds as the filename's prefix; naming them
/// after the series ("Batman Vol. 001") would orphan them at the next wipe, where they would parse
/// as the run's #1. Every other row — a plain issue, an annual, a provider-backed trade — names
/// after the series as before.
fn series_token_for_issue<'a>(
    is_collected: bool,
    attachment_source: Option<&'a str>,
    attachment_name: Option<&'a str>,
    series_name: &'a str,
) -> &'a str {
    match attachment_name.map(str::trim) {
        Some(edition) if is_collected && attachment_source == Some("LOCAL") && !edition.is_empty() => edition,
        _ => series_name,
    }
}

pub async fn run_bulk_rename(
    db: &Db,
    series_ids: &[String],
    folder_pattern: &str,
    file_pattern: &str,
    manga_file_pattern: Option<&str>,
    collected_file_pattern: Option<&str>,
    padding: IssuePadding,
) -> Result<RenameSummary> {
    // Empty id list → nothing to rename (`IN ()` is invalid SQL; matches the old ANY('{}')).
    let series_rows = if series_ids.is_empty() {
        Vec::new()
    } else {
        // Portable IN (...) list + CAST bool columns for the Any driver (see src/db.rs).
        let sql = format!(
            r#"SELECT id, name, publisher, year, universe, "seriesGroup", imprint, "folderPath", "libraryId", CAST("isManga" AS INTEGER) AS "isManga"
               FROM "Series" WHERE id IN ({})"#,
            Db::in_placeholders(1, series_ids.len())
        );
        let mut q = sqlx::query(&sql);
        for id in series_ids {
            q = q.bind(id);
        }
        q.fetch_all(&db.pool).await?
    };

    let libraries: Vec<LibraryRow> = sqlx::query(r#"SELECT id, path, CAST("isDefault" AS INTEGER) AS "isDefault", CAST("isManga" AS INTEGER) AS "isManga" FROM "Library""#)
        .fetch_all(&db.pool)
        .await?
        .into_iter()
        .map(|r| LibraryRow {
            id: r.get("id"),
            path: r.get("path"),
            is_default: r.get::<i64, _>("isDefault") != 0,
            is_manga: r.get::<i64, _>("isManga") != 0,
        })
        .collect();

    log::info!(
        "[Renamer] Standardize procedure for {} series. Folder: \"{}\" | File: \"{}\" | Manga file: \"{}\"",
        series_rows.len(), folder_pattern, file_pattern, manga_file_pattern.unwrap_or("(comic pattern)")
    );

    let mut files_renamed: i64 = 0;
    let mut folders_renamed: i64 = 0;
    let mut conflicts: i64 = 0;
    let mut last_path = String::new();

    for row in series_rows {
        let s = SeriesRow {
            id: row.get("id"),
            name: row.get("name"),
            publisher: row.get("publisher"),
            year: row.get("year"),
            universe: row.get("universe"),
            series_group: row.get("seriesGroup"),
            imprint: row.get("imprint"),
            folder_path: row.get("folderPath"),
            library_id: row.get("libraryId"),
            is_manga: row.get::<i64, _>("isManga") != 0,
        };

        // Library resolution: the series' own library → the matching-type default → the first one.
        let lib = libraries
            .iter()
            .find(|l| Some(&l.id) == s.library_id.as_ref())
            .or_else(|| libraries.iter().find(|l| l.is_default && l.is_manga == s.is_manga))
            .or_else(|| libraries.first());
        let library_root = match lib {
            Some(l) if !l.path.is_empty() => l.path.clone(),
            _ => {
                log::debug!("[Renamer] Skipping series \"{}\" - no library root resolved.", s.name);
                continue;
            }
        };
        // The engine runs as root: renaming under a Root Path the server can't use would create the
        // target folder inside the container, where the next image update deletes it (beta.018
        // follow-up, same check as the watched-folder import).
        if let Some(problem) = crate::server_paths::folder_problem(&library_root, "/data/comics") {
            log::warn!(
                "[Renamer] Skipping series \"{}\" - its library's Root Path can't be used: {} Fix it in Settings → Library & Files.",
                s.name, problem
            );
            continue;
        }
        let current_folder = s.folder_path.clone();

        // --- Compute the target folder from the active pattern (naming.rs, twinned with Node) ---
        let series_values = NamingInput {
            publisher: s.publisher.clone(),
            series: s.name.clone(),
            series_year: s.year,
            universe: s.universe.clone(),
            series_group: s.series_group.clone(),
            imprint: s.imprint.clone(),
            ..Default::default()
        };
        let Some(folder_parts) = naming::folder_segments(folder_pattern, &series_values) else {
            log::warn!("[Renamer] Skipping series \"{}\" - the folder pattern doesn't give a folder inside the library.", s.name);
            continue;
        };
        let mut target_folder = PathBuf::from(&library_root);
        for part in &folder_parts {
            target_folder.push(part);
        }
        let target_folder_str = target_folder.to_string_lossy().to_string();
        let folder_changed = current_folder.is_empty() || norm_ci(&current_folder) != norm_ci(&target_folder_str);

        // An issue's attachment names it only when the attachment is THIS series' own (#239): a row
        // that strayed into another series with a foreign attachment id must not take that lane's
        // naming here. The join condition, not a WHERE, so the row itself is still renamed.
        let issues = sqlx::query(
            r#"SELECT i.id, i.name, i.number, i."filePath", i."releaseDate", CAST(i."isAnnual" AS INTEGER) AS is_annual,
                      CASE WHEN av.kind = 'COLLECTED' THEN 1 ELSE 0 END AS is_collected,
                      av.id AS attachment_id, av."metadataSource" AS attachment_source, av.name AS attachment_name
               FROM "Issue" i LEFT JOIN "AttachedVolume" av ON av.id = i."attachedVolumeId" AND av."seriesId" = i."seriesId"
               WHERE i."seriesId" = $1"#,
        )
        .bind(&s.id)
        .fetch_all(&db.pool)
        .await?;

        // #239: a series a COLLECTED attachment keeps as its own ("Leave it as its own series") is that
        // collection — its books take the collected pattern, in its own folder, under its own name.
        let retained_collected = crate::attached_volumes::retaining_kinds(db, &s.id)
            .await?
            .iter()
            .any(|k| k == "COLLECTED");

        // Only act if at least one real file exists (the recorded folder, or any issue file wherever
        // it lives) — avoids creating an empty target folder for a series with nothing on disk.
        let has_any_file = (!current_folder.is_empty() && Path::new(&current_folder).exists())
            || issues.iter().any(|i| {
                i.get::<Option<String>, _>("filePath").map(|p| Path::new(&p).exists()).unwrap_or(false)
            });
        if !has_any_file {
            log::debug!("[Renamer] Skipping series \"{}\" - no files found on disk.", s.name);
            continue;
        }

        // Create the destination. Files are relocated one-by-one + guarded below — NEVER a whole-folder
        // move with overwrite.
        if let Err(e) = fs::create_dir_all(&target_folder) {
            log::error!("[Renamer] Could not create target folder {:?}: {}", target_folder, e);
            continue;
        }

        // Track the directories we move files out of, so we can clean up the emptied ones afterward.
        let mut source_dirs: HashSet<PathBuf> = HashSet::new();
        if !current_folder.is_empty() {
            source_dirs.insert(PathBuf::from(&current_folder));
        }

        for issue in &issues {
            let issue_id: String = issue.get("id");
            let issue_name: Option<String> = issue.get("name");
            let issue_number: String = issue.get("number");
            let issue_file_path: Option<String> = issue.get("filePath");
            let release_date: Option<String> = issue.get("releaseDate");
            let is_annual: bool = issue.try_get::<i64, _>("is_annual").map(|v| v != 0).unwrap_or(false);
            let is_collected: bool = issue.try_get::<i64, _>("is_collected").map(|v| v != 0).unwrap_or(false);
            let has_attachment = issue.try_get::<Option<String>, _>("attachment_id").unwrap_or(None).is_some();
            let attachment_source: Option<String> = issue.try_get("attachment_source").unwrap_or(None);
            let attachment_name: Option<String> = issue.try_get("attachment_name").unwrap_or(None);

            // Resolve the REAL source file: the issue's recorded path first (so files scattered across
            // {SeriesGroup} subfolders are found + consolidated), else the series folder by basename.
            let base_name = issue_file_path
                .as_deref()
                .map(|p| p.rsplit(['/', '\\']).next().unwrap_or(p).to_string())
                .unwrap_or_default();
            let source_path: Option<PathBuf> = match issue_file_path.as_deref() {
                Some(p) if Path::new(p).exists() => Some(PathBuf::from(p)),
                _ if !base_name.is_empty() && !current_folder.is_empty() => {
                    let fallback = Path::new(&current_folder).join(&base_name);
                    if fallback.exists() { Some(fallback) } else { None }
                }
                _ => None,
            };
            let source_path = match source_path {
                Some(p) => p,
                None => {
                    log::debug!("[Renamer] Skipping issue {:?} - file not found (db path: {:?}).", issue_name, issue_file_path);
                    continue;
                }
            };

            let ext = source_path
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();

            // Strip a redundant "Series #N: " prefix out of the issue title before substitution.
            let mut clean_issue_name = issue_name.clone().unwrap_or_default();
            if !s.name.is_empty() {
                let prefix = format!("{} #{}: ", s.name, issue_number);
                let exact = format!("{} #{}", s.name, issue_number);
                if let Some(stripped) = clean_issue_name.strip_prefix(&prefix) {
                    clean_issue_name = stripped.to_string();
                } else if clean_issue_name == exact {
                    clean_issue_name = String::new();
                }
            }

            // A LOCAL collected edition's books are named after the edition — its files' names are
            // the only claim it has (twinned with the Node loop + the preview).
            let series_token = series_token_for_issue(is_collected, attachment_source.as_deref(), attachment_name.as_deref(), &s.name);
            let issue_values = NamingInput {
                series: series_token.to_string(),
                issue_number: issue_number.clone(),
                release_date: release_date.clone(),
                issue_title: Some(clean_issue_name),
                ..series_values.clone()
            };

            // #203 Phase 1: an annual takes the Mylar-shaped name (see ANNUAL_FILE_PATTERN), named
            // through the same naming.rs rules as every other file.
            let pattern = file_pattern_for_issue(
                is_annual, is_collected, retained_collected && !has_attachment, s.is_manga,
                file_pattern, manga_file_pattern, collected_file_pattern,
            );
            let Some(stem) = naming::file_name(pattern, &issue_values, padding) else {
                log::warn!("[Renamer] Skipping issue {:?} - the file pattern leaves no name.", issue_name);
                continue;
            };
            let file_name = format!("{}{}", stem, ext);
            let new_file_path = target_folder.join(&file_name);
            let new_file_path_str = new_file_path.to_string_lossy().to_string();

            // Already at the correct path + name (case-insensitive) → just keep the DB in sync.
            if norm_ci(&source_path.to_string_lossy()) == norm_ci(&new_file_path_str) {
                if issue_file_path.as_deref() != Some(new_file_path_str.as_str()) {
                    sqlx::query(r#"UPDATE "Issue" SET "filePath" = $1 WHERE id = $2"#)
                        .bind(&new_file_path_str)
                        .bind(&issue_id)
                        .execute(&db.pool)
                        .await?;
                }
                continue;
            }

            // GUARD: never overwrite a different existing file. Leave the source untouched and count
            // the conflict so the worst case is "nothing moved" rather than data loss.
            if new_file_path.exists() {
                log::warn!("[Renamer] Conflict: a different file already exists at the target, leaving source in place: {:?}", new_file_path);
                conflicts += 1;
                continue;
            }

            let src = source_path.clone();
            let dst = new_file_path.clone();
            let moved = tokio::task::spawn_blocking(move || move_file(&src, &dst)).await;
            match moved {
                Ok(Ok(())) => {
                    if let Some(parent) = source_path.parent() {
                        source_dirs.insert(parent.to_path_buf());
                    }
                    sqlx::query(r#"UPDATE "Issue" SET "filePath" = $1 WHERE id = $2"#)
                        .bind(&new_file_path_str)
                        .bind(&issue_id)
                        .execute(&db.pool)
                        .await?;
                    files_renamed += 1;
                }
                Ok(Err(e)) => log::error!("[Renamer] File move failed for {:?}: {}", source_path, e),
                Err(e) => log::error!("[Renamer] File move task panicked for {:?}: {}", source_path, e),
            }
        }

        // Point the series at the (now-populated) target folder.
        if s.folder_path != target_folder_str {
            sqlx::query(r#"UPDATE "Series" SET "folderPath" = $1 WHERE id = $2"#)
                .bind(&target_folder_str)
                .bind(&s.id)
                .execute(&db.pool)
                .await?;
            if folder_changed {
                folders_renamed += 1;
            }
        }

        // Clean up emptied source folders ONLY — never the target, never a folder that still has files.
        let library_root_path = PathBuf::from(&library_root);
        for dir in &source_dirs {
            if norm_ci(&dir.to_string_lossy()) != norm_ci(&target_folder_str) {
                let dir = dir.clone();
                let root = library_root_path.clone();
                let _ = tokio::task::spawn_blocking(move || cleanup_empty_dirs(&dir, &root)).await;
            }
        }

        last_path = target_folder_str;
    }

    log::info!("[Renamer] Standardize complete: {} files renamed, {} folders renamed, {} conflicts.", files_renamed, folders_renamed, conflicts);
    Ok(RenameSummary { files_renamed, folders_renamed, conflicts, last_path })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_ci_boundary_prevents_sibling_root_match() {
        // "/libraryX" must not be treated as inside "/library" by the cleanup walk.
        let root = norm_ci("/library");
        let sibling = norm_ci("/libraryX/sub");
        assert!(!sibling.starts_with(&format!("{}/", root)) || sibling.starts_with("/library/"));
        assert!(norm_ci("C:\\Data\\Comics\\").starts_with(&norm_ci("c:/data/comics")));
    }

    #[test]
    fn cleanup_empty_dirs_removes_only_empty_dirs_up_to_root() {
        let root = std::env::temp_dir().join(format!("omnibus_renamer_test_{}", uuid::Uuid::new_v4()));
        let keep = root.join("Publisher").join("Keep");
        let empty_leaf = root.join("Publisher").join("Old Series").join("Sub");
        fs::create_dir_all(&keep).unwrap();
        fs::create_dir_all(&empty_leaf).unwrap();
        fs::write(keep.join("file.cbz"), b"data").unwrap();

        cleanup_empty_dirs(&empty_leaf, &root);

        // The empty chain is gone, but Publisher survives (it still holds Keep) and root is untouched.
        assert!(!empty_leaf.exists());
        assert!(!root.join("Publisher").join("Old Series").exists());
        assert!(keep.join("file.cbz").exists());
        assert!(root.exists());

        // Calling it on the root itself must never delete the root.
        cleanup_empty_dirs(&root, &root);
        assert!(root.exists());

        fs::remove_dir_all(&root).unwrap();
    }

    // Worklist item 8: manga series get the manga template on standardize; comics never do; a
    // blank manga pattern falls back to the comic one rather than producing empty file names.
    #[test]
    fn annual_issues_take_the_mylar_annual_name_over_every_other_pattern() {
        let comic = "{Series} #{Issue}";
        let manga = Some("{Series} Vol. {Issue}");
        // The annual name outranks both the comic and the manga template — a manga annual is still
        // an annual, and Mylar/Komga expect "<Series> Annual #NNN (YYYY)" beside the main run.
        assert_eq!(
            file_pattern_for_issue(true, false, false, false, comic, manga, None),
            "{Series} Annual #{Issue} ({IssueYear})"
        );
        assert_eq!(
            file_pattern_for_issue(true, false, false, true, comic, manga, None),
            "{Series} Annual #{Issue} ({IssueYear})"
        );
        // Non-annual rows are untouched by any of this.
        assert_eq!(file_pattern_for_issue(false, false, false, true, comic, manga, None), "{Series} Vol. {Issue}");
        assert_eq!(file_pattern_for_issue(false, false, false, false, comic, manga, None), "{Series} #{Issue}");

        // End to end through the naming rules the rename loop uses: zero-padded number, the
        // annual's own year, sanitized result.
        let annual = naming_values("Batman", "1", "2012-05-01");
        assert_eq!(
            naming::file_name(file_pattern_for_issue(true, false, false, false, comic, None, None), &annual, IssuePadding::Three).as_deref(),
            Some("Batman Annual #001 (2012)")
        );
    }

    fn naming_values(series: &str, number: &str, release_date: &str) -> NamingInput {
        NamingInput { series: series.into(), issue_number: number.into(), release_date: Some(release_date.into()), ..Default::default() }
    }

    // #203 COLLECTED: a trade attached to a series is named by its own (configurable) template,
    // and that template outranks every other one — including the annual pattern, since an
    // attachment's kind is an explicit human decision about what the file IS.
    #[test]
    fn collected_editions_take_their_own_configurable_pattern() {
        let comic = "{Series} #{Issue}";
        let manga = Some("{Series} Vol. {Issue}");

        // No setting configured → the built-in default.
        assert_eq!(
            file_pattern_for_issue(false, true, false, false, comic, manga, None),
            "{Series} Vol. {Issue} ({IssueYear})"
        );
        // A configured pattern wins, for manga series too.
        assert_eq!(
            file_pattern_for_issue(false, true, false, true, comic, manga, Some("{Series} v{Issue}")),
            "{Series} v{Issue}"
        );
        // A blank setting is not a pattern — fall back rather than emit empty file names.
        assert_eq!(
            file_pattern_for_issue(false, true, false, false, comic, manga, Some("   ")),
            "{Series} Vol. {Issue} ({IssueYear})"
        );
        // Collected outranks annual when a row is somehow both.
        assert_eq!(
            file_pattern_for_issue(true, true, false, false, comic, manga, None),
            "{Series} Vol. {Issue} ({IssueYear})"
        );

        // End to end: the user's number becomes the volume number, so the filename carries the
        // reading order they curated.
        let trade = naming_values("Batman", "2", "2012-05-01");
        assert_eq!(
            naming::file_name(file_pattern_for_issue(false, true, false, false, comic, None, None), &trade, IssuePadding::Three).as_deref(),
            Some("Batman Vol. 002 (2012)")
        );
    }

    #[test]
    fn manga_series_select_the_manga_file_pattern() {
        assert_eq!(effective_file_pattern(true, "{Series} #{Issue}", Some("{Series} Vol. {Issue}")), "{Series} Vol. {Issue}");
        assert_eq!(effective_file_pattern(false, "{Series} #{Issue}", Some("{Series} Vol. {Issue}")), "{Series} #{Issue}");
        assert_eq!(effective_file_pattern(true, "{Series} #{Issue}", None), "{Series} #{Issue}");
        assert_eq!(effective_file_pattern(true, "{Series} #{Issue}", Some("   ")), "{Series} #{Issue}");
    }

    // A LOCAL collected edition (no provider volume) is claimed by its files' NAMES alone — the
    // name-anchored rule — so its books are named after the edition, never the parent series:
    // "Batman Compendium Vol. 001", not "Batman Vol. 001" (which the next wipe would orphan, and
    // which parses as run #1). Twin of Node's seriesTokenForIssue (src/lib/utils/file-pattern.ts).
    #[test]
    fn local_collected_books_are_named_after_their_edition() {
        assert_eq!(series_token_for_issue(true, Some("LOCAL"), Some("Batman Compendium"), "Batman"), "Batman Compendium");
        assert_eq!(series_token_for_issue(true, Some("LOCAL"), Some("  Batman Compendium "), "Batman"), "Batman Compendium");
        // Provider-backed books keep the series name: their claim is the issue id.
        assert_eq!(series_token_for_issue(true, Some("COMICVINE"), Some("Batman: The Deluxe Edition"), "Batman"), "Batman");
        assert_eq!(series_token_for_issue(true, Some("METRON"), Some("Batman TPB"), "Batman"), "Batman");
        // Nothing to name after → the series; a non-collected row never takes the edition's name.
        assert_eq!(series_token_for_issue(true, Some("LOCAL"), Some("   "), "Batman"), "Batman");
        assert_eq!(series_token_for_issue(true, Some("LOCAL"), None, "Batman"), "Batman");
        assert_eq!(series_token_for_issue(false, Some("LOCAL"), Some("Batman Compendium"), "Batman"), "Batman");
        assert_eq!(series_token_for_issue(false, None, None, "Batman"), "Batman");

        // End to end through the collected pattern: the edition's name is what the name rule will
        // find as the filename's prefix after the rename.
        let token = series_token_for_issue(true, Some("LOCAL"), Some("Batman Compendium"), "Batman");
        let book = naming_values(token, "1", "2016-01-01");
        assert_eq!(
            naming::file_name(file_pattern_for_issue(false, true, false, false, "{Series} #{Issue}", None, None), &book, IssuePadding::Three).as_deref(),
            Some("Batman Compendium Vol. 001 (2016)")
        );
    }

    /// The bulk renamer against a real file-backed SQLite + real files, so the issue query's JOIN
    /// (kind, source, name off the attachment) is proven, not just the pure naming rule.
    async fn rename_fixture(tag: &str) -> (Db, PathBuf) {
        let base = std::env::temp_dir().join(format!("omnibus_rn_{}_{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("create fixture dir");
        let db_file = base.join("rn.db");
        fs::File::create(&db_file).expect("pre-create sqlite file");
        let db_url = format!("file:{}", db_file.to_string_lossy().replace('\\', "/"));
        let db = Db::connect(&db_url, 2).await.expect("connect file-backed sqlite");
        for ddl in [
            r#"CREATE TABLE "Series" (id TEXT PRIMARY KEY, name TEXT NOT NULL, publisher TEXT, year INTEGER NOT NULL DEFAULT 0,
                universe TEXT, "seriesGroup" TEXT, imprint TEXT, "folderPath" TEXT NOT NULL DEFAULT '', "libraryId" TEXT, "isManga" INTEGER NOT NULL DEFAULT 0,
                "metadataId" TEXT, "metadataSource" TEXT NOT NULL DEFAULT 'COMICVINE')"#,
            r#"CREATE TABLE "Library" (id TEXT PRIMARY KEY, path TEXT NOT NULL, "isDefault" INTEGER NOT NULL DEFAULT 0, "isManga" INTEGER NOT NULL DEFAULT 0)"#,
            r#"CREATE TABLE "Issue" (id TEXT PRIMARY KEY, "seriesId" TEXT, name TEXT, number TEXT NOT NULL, "filePath" TEXT,
                "releaseDate" TEXT, "isAnnual" INTEGER NOT NULL DEFAULT 0, "attachedVolumeId" TEXT)"#,
            // #239: the renamer reads `retained` (and the child's metadata ids) to name a retained child's books.
            r#"CREATE TABLE "AttachedVolume" (id TEXT PRIMARY KEY, "seriesId" TEXT, "metadataSource" TEXT NOT NULL, "volumeId" TEXT NOT NULL DEFAULT '',
                kind TEXT NOT NULL, name TEXT, "retained" BOOLEAN NOT NULL DEFAULT false)"#,
        ] {
            sqlx::query(ddl).execute(&db.pool).await.expect("create schema");
        }
        (db, base)
    }

    #[tokio::test]
    async fn bulk_rename_names_a_local_edition_after_itself_and_a_provider_trade_after_the_series() {
        let (db, root) = rename_fixture("local").await;
        let root_str = root.to_string_lossy().replace('\\', "/");
        let messy = root.join("Batman");
        fs::create_dir_all(&messy).unwrap();
        for f in ["Batman Compendium 01.cbz", "Batman TPB 02.cbz", "Batman 3.cbz"] {
            fs::write(messy.join(f), b"data").unwrap();
        }
        let messy_str = messy.to_string_lossy().replace('\\', "/");

        sqlx::query(r#"INSERT INTO "Library" (id, path, "isDefault", "isManga") VALUES ('lib_1', $1, 1, 0)"#).bind(&root_str).execute(&db.pool).await.unwrap();
        sqlx::query(r#"INSERT INTO "Series" (id, name, publisher, year, "folderPath", "libraryId", "isManga") VALUES ('s1', 'Batman', 'DC Comics', 2016, $1, 'lib_1', 0)"#)
            .bind(&messy_str).execute(&db.pool).await.unwrap();
        sqlx::query(r#"INSERT INTO "AttachedVolume" (id, "seriesId", "metadataSource", kind, name) VALUES ('att_local', 's1', 'LOCAL', 'COLLECTED', 'Batman Compendium')"#).execute(&db.pool).await.unwrap();
        sqlx::query(r#"INSERT INTO "AttachedVolume" (id, "seriesId", "metadataSource", kind, name) VALUES ('att_cv', 's1', 'COMICVINE', 'COLLECTED', 'Batman')"#).execute(&db.pool).await.unwrap();
        for (id, number, name, file, date, att) in [
            ("local_book", "1", "Vol. 1", "Batman Compendium 01.cbz", None, Some("att_local")),
            ("cv_book", "2", "Vol. 2: City of Owls", "Batman TPB 02.cbz", Some("2016-06-01"), Some("att_cv")),
            ("issue_3", "3", "Batman #3", "Batman 3.cbz", Some("2016-03-01"), None),
        ] {
            sqlx::query(r#"INSERT INTO "Issue" (id, "seriesId", name, number, "filePath", "releaseDate", "attachedVolumeId") VALUES ($1, 's1', $2, $3, $4, $5, $6)"#)
                .bind(id).bind(name).bind(number).bind(format!("{}/{}", messy_str, file)).bind(date).bind(att)
                .execute(&db.pool).await.unwrap();
        }

        let summary = run_bulk_rename(&db, &["s1".to_string()], "{Publisher}/{Series} ({Year})", "{Series} #{Issue}", None, None, IssuePadding::Three).await.unwrap();
        assert_eq!((summary.files_renamed, summary.folders_renamed, summary.conflicts), (3, 1, 0));

        let target = root.join("DC Comics").join("Batman (2016)");
        // The local edition's book carries the edition's name — the name rule still claims it.
        assert!(target.join("Batman Compendium Vol. 001 (2016).cbz").exists(), "local book named after its edition");
        assert!(!target.join("Batman Vol. 001 (2016).cbz").exists(), "never the series name for a local book");
        // The provider trade and the plain issue are unchanged in shape.
        assert!(target.join("Batman Vol. 002 (2016).cbz").exists());
        assert!(target.join("Batman #003.cbz").exists());

        let path_of = |id: &str| {
            let db = &db;
            let id = id.to_string();
            async move {
                sqlx::query(r#"SELECT "filePath" FROM "Issue" WHERE id = $1"#).bind(id).fetch_one(&db.pool).await.unwrap().get::<Option<String>, _>("filePath").unwrap_or_default()
            }
        };
        assert!(path_of("local_book").await.ends_with("Batman Compendium Vol. 001 (2016).cbz"));
        assert!(path_of("cv_book").await.ends_with("Batman Vol. 002 (2016).cbz"));
        assert!(path_of("issue_3").await.ends_with("Batman #003.cbz"));
        let _ = fs::remove_dir_all(&root);
    }

    // beta.018 follow-up: the engine runs as root, so renaming under a Root Path the server can't use
    // (here: a full path nothing is mounted at) would CREATE it - inside the container, where the next
    // image update deletes the moved files. The series is skipped instead, and nothing is created.
    #[tokio::test]
    async fn bulk_rename_skips_a_series_whose_library_root_does_not_exist() {
        let (db, base) = rename_fixture("unmounted_root").await;
        let missing_root = base.join("not-mounted");
        let messy = base.join("inbox");
        fs::create_dir_all(&messy).unwrap();
        let source = messy.join("Batman 1.cbz");
        fs::write(&source, b"data").unwrap();
        let messy_str = messy.to_string_lossy().replace('\\', "/");

        sqlx::query(r#"INSERT INTO "Library" (id, path, "isDefault", "isManga") VALUES ('lib_1', $1, 1, 0)"#)
            .bind(missing_root.to_string_lossy().replace('\\', "/")).execute(&db.pool).await.unwrap();
        sqlx::query(r#"INSERT INTO "Series" (id, name, publisher, year, "folderPath", "libraryId", "isManga") VALUES ('s1', 'Batman', 'DC Comics', 2016, $1, 'lib_1', 0)"#)
            .bind(&messy_str).execute(&db.pool).await.unwrap();
        sqlx::query(r#"INSERT INTO "Issue" (id, "seriesId", name, number, "filePath") VALUES ('i1', 's1', 'Batman #1', '1', $1)"#)
            .bind(source.to_string_lossy().to_string()).execute(&db.pool).await.unwrap();

        let summary = run_bulk_rename(&db, &["s1".to_string()], "{Publisher}/{Series} ({Year})", "{Series} #{Issue}", None, None, IssuePadding::Three).await.unwrap();

        assert_eq!((summary.files_renamed, summary.folders_renamed), (0, 0));
        assert!(!missing_root.exists(), "the missing Root Path is never created");
        assert!(source.exists(), "the file stays where it was");
        let _ = fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn bulk_rename_uses_imprint_and_omits_blank_imprint_tier_and_separator() {
        for (tag, imprint, expected_folder, expected_file) in [
            ("with_imprint", Some("Absolute"), "Absolute/Batman (2016)", "Absolute - Batman #001.cbz"),
            ("blank_imprint", None, "Batman (2016)", "Batman #001.cbz"),
        ] {
            let (db, root) = rename_fixture(tag).await;
            let root_str = root.to_string_lossy().replace('\\', "/");
            let messy = root.join("inbox");
            fs::create_dir_all(&messy).unwrap();
            let source = messy.join("Batman 1.cbz");
            fs::write(&source, b"data").unwrap();
            let messy_str = messy.to_string_lossy().replace('\\', "/");

            sqlx::query(r#"INSERT INTO "Library" (id, path, "isDefault", "isManga") VALUES ('lib_1', $1, 1, 0)"#)
                .bind(&root_str).execute(&db.pool).await.unwrap();
            sqlx::query(r#"INSERT INTO "Series" (id, name, publisher, year, imprint, "folderPath", "libraryId", "isManga") VALUES ('s1', 'Batman', 'DC Comics', 2016, $1, $2, 'lib_1', 0)"#)
                .bind(imprint).bind(&messy_str).execute(&db.pool).await.unwrap();
            sqlx::query(r#"INSERT INTO "Issue" (id, "seriesId", name, number, "filePath") VALUES ('i1', 's1', 'Batman #1', '1', $1)"#)
                .bind(source.to_string_lossy().to_string()).execute(&db.pool).await.unwrap();

            let summary = run_bulk_rename(
                &db,
                &["s1".to_string()],
                "{Imprint}/{Series} ({Year})",
                "{Imprint} - {Series} #{Issue}",
                None,
                None,
                IssuePadding::Three,
            ).await.unwrap();

            assert_eq!((summary.files_renamed, summary.folders_renamed, summary.conflicts), (1, 1, 0));
            assert!(root.join(expected_folder).join(expected_file).exists(), "expected renamed file for {tag}");
            let _ = fs::remove_dir_all(&root);
        }
    }

    // #244: Standardize pads by the issue_number_padding setting, and an unknown year leaves no
    // "(0000)" behind - the same name an import of the same issue gets.
    #[tokio::test]
    async fn bulk_rename_pads_by_the_setting_and_leaves_no_0000_for_an_unknown_year() {
        for (tag, padding, expected) in [
            ("pad_none", IssuePadding::None, ["Batman #3.cbz", "Batman #1A.cbz", "Batman #0.5.cbz"]),
            ("pad_two", IssuePadding::Two, ["Batman #03.cbz", "Batman #01A.cbz", "Batman #00.5.cbz"]),
            ("pad_three", IssuePadding::Three, ["Batman #003.cbz", "Batman #001A.cbz", "Batman #000.5.cbz"]),
        ] {
            let (db, root) = rename_fixture(tag).await;
            let root_str = root.to_string_lossy().replace('\\', "/");
            let inbox = root.join("inbox");
            fs::create_dir_all(&inbox).unwrap();
            sqlx::query(r#"INSERT INTO "Library" (id, path, "isDefault", "isManga") VALUES ('lib_1', $1, 1, 0)"#).bind(&root_str).execute(&db.pool).await.unwrap();
            sqlx::query(r#"INSERT INTO "Series" (id, name, publisher, year, "folderPath", "libraryId", "isManga") VALUES ('s1', 'Batman', 'DC Comics', 0, $1, 'lib_1', 0)"#)
                .bind(inbox.to_string_lossy().to_string()).execute(&db.pool).await.unwrap();
            for (id, number, file) in [("i3", "003", "b3.cbz"), ("i1a", "1A", "b1a.cbz"), ("ihalf", "½", "bhalf.cbz")] {
                fs::write(inbox.join(file), b"data").unwrap();
                sqlx::query(r#"INSERT INTO "Issue" (id, "seriesId", name, number, "filePath") VALUES ($1, 's1', NULL, $2, $3)"#)
                    .bind(id).bind(number).bind(inbox.join(file).to_string_lossy().to_string()).execute(&db.pool).await.unwrap();
            }

            let summary = run_bulk_rename(&db, &["s1".to_string()], "{Publisher}/{Series} ({Year})", "{Series} #{Issue} ({IssueYear})", None, None, padding).await.unwrap();

            assert_eq!(summary.files_renamed, 3, "{tag}");
            let target = root.join("DC Comics").join("Batman");
            for name in expected {
                assert!(target.join(name).exists(), "{tag}: expected {name}");
            }
            let _ = fs::remove_dir_all(&root);
        }
    }

    // A folder pattern that climbs out of the library (an admin's typo) skips the series instead
    // of building a folder beside the library.
    #[tokio::test]
    async fn bulk_rename_never_builds_a_folder_outside_the_library() {
        let (db, base) = rename_fixture("climb").await;
        let root = base.join("library");
        let inbox = root.join("inbox");
        fs::create_dir_all(&inbox).unwrap();
        fs::write(inbox.join("b1.cbz"), b"data").unwrap();
        sqlx::query(r#"INSERT INTO "Library" (id, path, "isDefault", "isManga") VALUES ('lib_1', $1, 1, 0)"#).bind(root.to_string_lossy().to_string()).execute(&db.pool).await.unwrap();
        sqlx::query(r#"INSERT INTO "Series" (id, name, publisher, year, "folderPath", "libraryId", "isManga") VALUES ('s1', 'Batman', 'DC Comics', 2016, $1, 'lib_1', 0)"#)
            .bind(inbox.to_string_lossy().to_string()).execute(&db.pool).await.unwrap();
        sqlx::query(r#"INSERT INTO "Issue" (id, "seriesId", name, number, "filePath") VALUES ('i1', 's1', NULL, '1', $1)"#)
            .bind(inbox.join("b1.cbz").to_string_lossy().to_string()).execute(&db.pool).await.unwrap();

        let summary = run_bulk_rename(&db, &["s1".to_string()], "../{Series}", "{Series} #{Issue}", None, None, IssuePadding::Three).await.unwrap();

        assert_eq!((summary.files_renamed, summary.folders_renamed), (0, 0));
        assert!(!base.join("Batman").exists(), "nothing built beside the library");
        assert!(inbox.join("b1.cbz").exists(), "the file stays where it was");
        let _ = fs::remove_dir_all(&base);
    }

    // ==== #239: a volume kept as its own series ("Leave it as its own series") ====

    /// Absolute Batman (2024) with the 2025 collected volume attached; that volume is ALSO a series
    /// of its own, in its own folder, holding the books as the field report had them.
    async fn seed_retained(db: &Db, root: &Path, retained: bool) -> (PathBuf, PathBuf) {
        let root_str = root.to_string_lossy().replace('\\', "/");
        let parent_dir = root.join("DC Comics").join("Absolute Batman (2024)");
        let child_dir = root.join("DC Comics").join("Absolute Batman (2025)");
        fs::create_dir_all(&parent_dir).unwrap();
        fs::create_dir_all(&child_dir).unwrap();
        fs::write(parent_dir.join("Absolute Batman #001.cbz"), b"parent").unwrap();
        fs::write(child_dir.join("Absolute Batman #01.cbz"), b"trade1").unwrap();
        fs::write(child_dir.join("Absolute Batman #02.cbz"), b"trade2").unwrap();
        let (p, c) = (parent_dir.to_string_lossy().replace('\\', "/"), child_dir.to_string_lossy().replace('\\', "/"));

        sqlx::query(r#"INSERT INTO "Library" (id, path, "isDefault", "isManga") VALUES ('lib_1', $1, 1, 0)"#).bind(&root_str).execute(&db.pool).await.unwrap();
        for (id, meta, year, folder) in [("parent", "160294", 2024, &p), ("child", "167340", 2025, &c)] {
            sqlx::query(r#"INSERT INTO "Series" (id, name, publisher, year, "folderPath", "libraryId", "metadataId", "metadataSource") VALUES ($1, 'Absolute Batman', 'DC Comics', $2, $3, 'lib_1', $4, 'COMICVINE')"#)
                .bind(id).bind(year).bind(folder).bind(meta).execute(&db.pool).await.unwrap();
        }
        sqlx::query(&format!(
            r#"INSERT INTO "AttachedVolume" (id, "seriesId", "metadataSource", "volumeId", kind, name, retained) VALUES ('att', 'parent', 'COMICVINE', '167340', 'COLLECTED', 'Absolute Batman', {})"#,
            if retained { "true" } else { "false" }
        ))
        .execute(&db.pool).await.unwrap();
        for (id, series, number, file, date, att) in [
            ("p1", "parent", "1", format!("{}/Absolute Batman #001.cbz", p), "2024-10-09", None),
            ("c1", "child", "1", format!("{}/Absolute Batman #01.cbz", c), "2025-03-25", None),
            // The reproduction's damage: the child's sync once adopted the parent's skeleton for this
            // book, and the row kept the PARENT's attachment id. It must not name the book by that lane.
            ("c2", "child", "2", format!("{}/Absolute Batman #02.cbz", c), "2026-01-20", Some("att")),
        ] {
            sqlx::query(r#"INSERT INTO "Issue" (id, "seriesId", number, "filePath", "releaseDate", "attachedVolumeId") VALUES ($1, $2, $3, $4, $5, $6)"#)
                .bind(id).bind(series).bind(number).bind(file).bind(date).bind(att)
                .execute(&db.pool).await.unwrap();
        }
        (parent_dir, child_dir)
    }

    #[tokio::test]
    async fn a_retained_child_names_its_books_as_collected_editions_in_its_own_folder() {
        let (db, root) = rename_fixture("retained").await;
        let (parent_dir, child_dir) = seed_retained(&db, &root, true).await;
        let (folder, file) = ("{Publisher}/{Series} ({Year})", "{Series} #{Issue}");

        // The parent's run touches the parent's rows only.
        let parent = run_bulk_rename(&db, &["parent".to_string()], folder, file, None, None, IssuePadding::Three).await.unwrap();
        assert_eq!((parent.files_renamed, parent.conflicts), (0, 0));
        assert!(child_dir.join("Absolute Batman #01.cbz").exists(), "the parent never reaches into the child");
        assert!(parent_dir.join("Absolute Batman #001.cbz").exists());

        // The child's own run: collected pattern, its own folder and year, each book's own year.
        let child = run_bulk_rename(&db, &["child".to_string()], folder, file, None, None, IssuePadding::Three).await.unwrap();
        assert_eq!((child.files_renamed, child.folders_renamed, child.conflicts), (2, 0, 0));
        assert!(child_dir.join("Absolute Batman Vol. 001 (2025).cbz").exists());
        assert!(child_dir.join("Absolute Batman Vol. 002 (2026).cbz").exists(), "the 2026 book stays under the 2025 folder");
        assert!(!parent_dir.join("Absolute Batman Vol. 001 (2025).cbz").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_child_left_unretained_keeps_the_plain_pattern_and_ignores_a_stray_attachment_id() {
        let (db, root) = rename_fixture("not_retained").await;
        let (_, child_dir) = seed_retained(&db, &root, false).await;

        let child = run_bulk_rename(&db, &["child".to_string()], "{Publisher}/{Series} ({Year})", "{Series} #{Issue}", None, None, IssuePadding::Three).await.unwrap();
        assert_eq!(child.files_renamed, 2);
        assert!(child_dir.join("Absolute Batman #001.cbz").exists());
        // c2 carries the parent's COLLECTED attachment id, but that lane is not this series' own.
        assert!(child_dir.join("Absolute Batman #002.cbz").exists());
        assert!(!child_dir.join("Absolute Batman Vol. 002 (2026).cbz").exists());
        let _ = fs::remove_dir_all(&root);
    }

    // Pattern choice parity (#239): the same table drives file-pattern.ts filePatternForIssue.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PatternCase {
        label: String,
        annual: bool,
        collected: bool,
        retained_collected: bool,
        manga: bool,
        file_pattern: String,
        manga_file_pattern: Option<String>,
        collected_file_pattern: Option<String>,
        expected: String,
    }

    #[test]
    fn pattern_choice_matches_the_parity_table() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Table {
            pattern_choice: Vec<PatternCase>,
        }
        let table: Table = serde_json::from_str(include_str!("../tests/fixtures/naming_parity.json")).expect("naming_parity.json parses");
        assert!(!table.pattern_choice.is_empty());
        let mut wrong = Vec::new();
        for c in &table.pattern_choice {
            let got = file_pattern_for_issue(
                c.annual, c.collected, c.retained_collected, c.manga,
                &c.file_pattern, c.manga_file_pattern.as_deref(), c.collected_file_pattern.as_deref(),
            );
            if got != c.expected {
                wrong.push(format!("{}: got {got:?}, want {:?}", c.label, c.expected));
            }
        }
        assert!(wrong.is_empty(), "pattern-choice mismatches:\n{}", wrong.join("\n"));
    }
}
