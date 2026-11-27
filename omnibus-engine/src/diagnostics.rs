use anyhow::Result;
use crate::db::Db;
use sqlx::Row;
use std::path::Path;
use tokio::task::JoinSet;

/// One per-series row in the storage_deep_dive_cache JSON the dashboard reads (admin/storage/route.ts).
/// Field names must match the Node shape exactly (camelCase for isManga/issueCount/sizeBytes).
#[derive(serde::Serialize)]
struct StorageEntry {
    id: String,
    name: String,
    publisher: String,
    #[serde(rename = "isManga")]
    is_manga: bool,
    #[serde(rename = "issueCount")]
    issue_count: i64,
    path: String,
    #[serde(rename = "sizeBytes")]
    size_bytes: u64,
}

/// Sets `ids` back to DOWNLOADED in one bulk UPDATE, but only the rows whose status is `from` at the
/// time of the write: a row whose status changed since it was read is never touched. Returns the rows
/// changed. Portable IN (...) list, as for the MISSING/CORRUPTED writes below.
async fn clear_status(db: &Db, from: &str, ids: &[String]) -> Result<u64> {
    if ids.is_empty() {
        return Ok(0);
    }
    let sql = format!(
        r#"UPDATE "Issue" SET status = 'DOWNLOADED' WHERE status = $1 AND id IN ({})"#,
        Db::in_placeholders(2, ids.len())
    );
    let mut q = sqlx::query(&sql).bind(from);
    for id in ids {
        q = q.bind(id);
    }
    Ok(q.execute(&db.pool).await?.rows_affected())
}

pub async fn run_ghost_check(db: Db) -> Result<(i32, i32, String)> {
    // Drive-online guard (parity with the Node DIAGNOSTICS job's drivesOnline check): if ANY configured
    // library drive is offline, skip the whole pass. Otherwise an unmounted/disconnected volume makes
    // every Issue's file look missing and would flip the entire library to status='MISSING'. Self-heals
    // once the drive is back.
    let library_paths: Vec<String> = sqlx::query_scalar(r#"SELECT path FROM "Library""#)
        .fetch_all(&db.pool).await.unwrap_or_default();
    for lib_path in &library_paths {
        if !Path::new(lib_path).exists() {
            log::warn!("[Ghost Check] Drive offline ({}); skipping ghost check to avoid mass-marking issues MISSING.", lib_path);
            return Ok((0, 0, format!("Ghost check skipped: library drive offline ({}).", lib_path)));
        }
    }

    let issues = sqlx::query(r#"SELECT id, "filePath", status FROM "Issue" WHERE "filePath" IS NOT NULL"#)
        .fetch_all(&db.pool).await?;

    let cfg = crate::engine_config::EngineConfig::load(&db.pool).await;
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(cfg.scan_workers));
    let mut join_set = JoinSet::new();

    for row in issues {
        let id: String = row.get("id");
        let file_path: String = row.get("filePath");
        let was_missing = row.try_get::<Option<String>, _>("status").ok().flatten().as_deref() == Some("MISSING");
        let sem = sem.clone();
        join_set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            tokio::task::spawn_blocking(move || {
                let exists = Path::new(&file_path).exists();
                (id, file_path, exists, was_missing)
            })
                .await
                .unwrap_or((String::new(), String::new(), true, false))
        });
    }

    let mut total_checked = 0;
    let mut missing_ids: Vec<String> = Vec::new();
    let mut found_ids: Vec<String> = Vec::new();

    while let Some(res) = join_set.join_next().await {
        if let Ok((id, file_path, exists, was_missing)) = res {
            total_checked += 1;
            if !exists {
                log::debug!("[Ghost Check Debug] File is missing -> marking MISSING: {}", file_path);
                missing_ids.push(id);
            } else if was_missing {
                log::debug!("[Ghost Check Debug] File is back -> clearing MISSING: {}", file_path);
                found_ids.push(id);
            }
        }
    }

    // Issue #294: a file that is back (a NAS mount that was down during an earlier check, say) leaves
    // MISSING. Only rows that are MISSING now are changed, so any other status is left alone.
    match clear_status(&db, "MISSING", &found_ids).await {
        Ok(n) if n > 0 => log::info!("[Ghost Check] Cleared MISSING on {} issues whose file exists again.", n),
        Ok(_) => {}
        Err(e) => log::error!("[Ghost Check] Failed to clear MISSING on {} issues: {:?}", found_ids.len(), e),
    }

    // One bulk UPDATE instead of one-per-missing-issue. Portable IN (...) list — `= ANY($1)`
    // array binds are Postgres-only (see src/db.rs).
    let missing_count = missing_ids.len() as i32;
    if !missing_ids.is_empty() {
        let sql = format!(r#"UPDATE "Issue" SET status = 'MISSING' WHERE id IN ({})"#, Db::in_placeholders(1, missing_ids.len()));
        let mut q = sqlx::query(&sql);
        for id in &missing_ids {
            q = q.bind(id);
        }
        if let Err(e) = q.execute(&db.pool).await {
            log::error!("[Ghost Check] Failed to mark {} issues MISSING: {:?}", missing_count, e);
        }
    }

    Ok((total_checked, missing_count, format!("Ghost check complete. Scanned {} files. Found {} missing.", total_checked, missing_count)))
}

/// The bytes in every file under `folder` (hidden entries skipped); 0 when it doesn't exist. Each
/// series' walk already has a blocking thread of its own (up to scan_workers at once), so it walks
/// there rather than on rayon's shared pool, where the walks ran on top of each other (#282).
fn folder_size(folder: &str) -> u64 {
    if !Path::new(folder).exists() {
        return 0;
    }
    crate::walk::serial(Path::new(folder))
        .flatten()
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

pub async fn run_storage_scan(db: Db) -> Result<(i32, u64, String)> {
    // Pull the fields the dashboard needs (name/publisher/isManga/issueCount) in one grouped query.
    let series = sqlx::query(
        // isManga is CAST for the Any driver (no SQLite BOOLEAN mapping).
        r#"SELECT s.id, s.name, s.publisher, CAST(s."isManga" AS INTEGER) AS "isManga", s."folderPath",
                  COUNT(i.id) AS issue_count
           FROM "Series" s
           LEFT JOIN "Issue" i ON i."seriesId" = s.id
           WHERE s."folderPath" IS NOT NULL
           GROUP BY s.id"#
    )
    .fetch_all(&db.pool).await?;

    let cfg = crate::engine_config::EngineConfig::load(&db.pool).await;
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(cfg.scan_workers));
    let mut join_set = JoinSet::new();

    for row in series {
        let id: String = row.get("id");
        let name: String = row.try_get("name").unwrap_or_default();
        let publisher: String = row
            .try_get::<Option<String>, _>("publisher")
            .ok()
            .flatten()
            .unwrap_or_else(|| "Unknown".to_string());
        let is_manga: bool = row.try_get::<i64, _>("isManga").map(|v| v != 0).unwrap_or(false);
        let issue_count: i64 = row.try_get("issue_count").unwrap_or(0);
        let folder_path: String = row.get("folderPath");
        let sem = sem.clone();

        join_set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            let fp = folder_path.clone();
            let nm = name.clone();
            // Only the directory walk runs on the blocking pool; the StorageEntry is built out here so a
            // panicked walk still yields a valid (size 0) entry rather than losing the row.
            let size_bytes = tokio::task::spawn_blocking(move || {
                log::debug!("[Storage Scan Debug] Calculating size for \"{}\" at {}", nm, fp);
                folder_size(&fp)
            })
            .await
            .unwrap_or(0);
            StorageEntry { id, name, publisher, is_manga, issue_count, path: folder_path, size_bytes }
        });
    }

    let mut storage_data: Vec<StorageEntry> = Vec::new();
    let mut total_size_bytes: u64 = 0;
    let mut size_ids: Vec<String> = Vec::new();
    let mut size_vals: Vec<f64> = Vec::new();

    while let Some(res) = join_set.join_next().await {
        if let Ok(entry) = res {
            total_size_bytes += entry.size_bytes;
            size_ids.push(entry.id.clone());
            size_vals.push(entry.size_bytes as f64);
            storage_data.push(entry);
        }
    }

    // Persist per-series sizes as one UPDATE per series. The old Postgres-only bulk form
    // (unnest'd parallel arrays) cannot pass through the Any driver — it has no array binds on
    // either backend — and this is a scheduled job whose cost is the filesystem walk above, not
    // these writes (SQLite: local file; Postgres: ~1ms round-trips inside a minutes-long job).
    for (id, size) in size_ids.iter().zip(size_vals.iter()) {
        if let Err(e) = sqlx::query(r#"UPDATE "Series" SET "size" = $1 WHERE id = $2"#)
            .bind(size)
            .bind(id)
            .execute(&db.pool).await
        {
            log::error!("[Storage Scan] Failed to update size for series {}: {:?}", id, e);
        }
    }

    let processed_count = storage_data.len() as i32;

    // Largest-first, matching Node storageData.sort((a, b) => b.sizeBytes - a.sizeBytes).
    storage_data.sort_by_key(|e| std::cmp::Reverse(e.size_bytes));

    // Cache the per-series breakdown under the key the dashboard actually reads.
    let cache_json = serde_json::to_string(&storage_data).unwrap_or_else(|_| "[]".to_string());
    if let Err(e) = sqlx::query(
        r#"INSERT INTO "SystemSetting" (key, value) VALUES ('storage_deep_dive_cache', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"#
    ).bind(cache_json).execute(&db.pool).await {
        log::error!("[Storage Scan] Failed to write storage_deep_dive_cache: {:?}", e);
    }

    // Run timestamp as epoch-ms string. Node stores Date.now().toString() and LIBRARY_SCAN parseInt()s it
    // for the 24h re-scan throttle — an RFC3339 string would break that gate.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_default();
    for key in ["storage_deep_dive_last_run", "last_storage_scan"] {
        if let Err(e) = sqlx::query(
            r#"INSERT INTO "SystemSetting" (key, value) VALUES ($1, $2)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"#
        ).bind(key).bind(&now_ms).execute(&db.pool).await {
            log::error!("[Storage Scan] Failed to write {}: {:?}", key, e);
        }
    }

    // Keep the aggregate total for any consumer that reads it.
    let total_mb = total_size_bytes / 1_048_576;
    if let Err(e) = sqlx::query(
        r#"INSERT INTO "SystemSetting" (key, value) VALUES ('total_library_size_mb', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"#
    ).bind(total_mb.to_string()).execute(&db.pool).await {
        log::error!("[Storage Scan] Failed to write total_library_size_mb: {:?}", e);
    }

    log::info!("[Storage Scan] Complete. Processed {} folders. Total Library Size: {} MB.", processed_count, total_mb);

    Ok((processed_count, total_size_bytes, format!("Storage scan complete. Processed {} folders. Total Library Size: {} MB.", processed_count, total_mb)))
}

/// Physical comic files (original-case, forward-slash paths) whose lowercased path is absent from the
/// DB path set. Split out for testing — the case-fold comparison is where orphan false-positives
/// historically crept in (e.g. a drive that reports a different filename case than the DB stored).
fn compute_orphans(
    physical: std::collections::HashSet<String>,
    db_lower: &std::collections::HashSet<String>,
) -> Vec<String> {
    physical.into_iter().filter(|p| !db_lower.contains(&p.to_lowercase())).collect()
}

/// The orphan-scan candidates under one library root, with forward slashes. Node's getPhysicalFiles
/// matches /\.(cbz|cbr|zip)$/i — .rar is excluded (it is tracked as .cbr or pending conversion, not an
/// orphan candidate).
fn physical_comic_files(lib_path: &str) -> Vec<String> {
    if !Path::new(lib_path).exists() {
        return Vec::new();
    }
    crate::walk::parallel(Path::new(lib_path))
        .flatten()
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            let ext = e.path().extension().unwrap_or_default().to_string_lossy().to_lowercase();
            matches!(ext.as_str(), "cbz" | "cbr" | "zip")
        })
        .map(|e| e.path().to_string_lossy().replace("\\", "/"))
        .collect()
}

pub async fn run_orphan_scan(db: Db) -> Result<Vec<String>> {
    let libs = sqlx::query(r#"SELECT path FROM "Library""#).fetch_all(&db.pool).await?;
    let mut all_physical_files = std::collections::HashSet::new();

    // 1. Walk the physical hard drives and collect all comic files
    for lib in libs {
        let lib_path: String = lib.get("path");
        all_physical_files.extend(physical_comic_files(&lib_path));
    }

    // 2. Get all DB file paths, normalized + lowercased for case-insensitive comparison (parity with
    //    Node's path.normalize(p).toLowerCase()).
    let issues = sqlx::query(r#"SELECT "filePath" FROM "Issue" WHERE "filePath" IS NOT NULL"#).fetch_all(&db.pool).await?;
    let mut db_files = std::collections::HashSet::new();
    for row in issues {
        let fp: String = row.get("filePath");
        db_files.insert(fp.replace("\\", "/").to_lowercase());
    }

    // 3. Physical files whose lowercased path is absent from the DB set are orphans. Compare
    //    case-insensitively but return the original-case path so the UI shows the real filename.
    Ok(compute_orphans(all_physical_files, &db_files))
}

pub async fn run_integrity_scan(db: Db) -> Result<(i32, i32, String)> {
    // Only test existing .cbz archives (case-insensitive), matching Node's existsSync + endsWith('.cbz').
    // LOWER(...) LIKE replaces Postgres-only ILIKE (identical semantics for this ASCII pattern).
    let issues = sqlx::query(r#"SELECT id, "filePath", status FROM "Issue" WHERE LOWER("filePath") LIKE '%.cbz'"#).fetch_all(&db.pool).await?;
    let cfg = crate::engine_config::EngineConfig::load(&db.pool).await;
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(cfg.scan_workers));
    let mut join_set = JoinSet::new();

    for row in issues {
        let id: String = row.get("id");
        let file_path: String = row.get("filePath");
        let was_corrupted = row.try_get::<Option<String>, _>("status").ok().flatten().as_deref() == Some("CORRUPTED");
        let sem = sem.clone();
        // Bounded spawn_blocking: test ZIP headers natively without exhausting the blocking pool.
        join_set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            tokio::task::spawn_blocking(move || {
                // Skip files that don't exist — a missing file is the ghost scan's concern, not a
                // corrupt archive (Node only inspects files that exist). None = skipped, not counted.
                if !Path::new(&file_path).exists() {
                    return (id, file_path, None, was_corrupted);
                }
                let corrupted = match std::fs::File::open(&file_path) {
                    Ok(file) => zip::ZipArchive::new(file).is_err(),
                    Err(_) => true,
                };
                (id, file_path, Some(corrupted), was_corrupted)
            })
            .await
            .unwrap_or((String::new(), String::new(), None, false))
        });
    }

    let mut scanned = 0;
    let mut corrupted_ids: Vec<String> = Vec::new();
    let mut repaired_ids: Vec<String> = Vec::new();

    while let Some(res) = join_set.join_next().await {
        // Only count + act on files that were actually tested (Some); missing files (None) are skipped.
        if let Ok((id, file_path, Some(is_corrupted), was_corrupted)) = res {
            scanned += 1;
            if is_corrupted {
                log::debug!("[Integrity Scan Debug] Archive failed to open -> marking CORRUPTED: {}", file_path);
                corrupted_ids.push(id);
            } else if was_corrupted {
                log::debug!("[Integrity Scan Debug] Archive opens again -> clearing CORRUPTED: {}", file_path);
                repaired_ids.push(id);
            }
        }
    }

    // Issue #294: a repaired file passes the check, so it leaves CORRUPTED. Only rows that are
    // CORRUPTED now are changed, so any other status is left alone.
    match clear_status(&db, "CORRUPTED", &repaired_ids).await {
        Ok(n) if n > 0 => log::info!("[Integrity Scan] Cleared CORRUPTED on {} issues that pass the check again.", n),
        Ok(_) => {}
        Err(e) => log::error!("[Integrity Scan] Failed to clear CORRUPTED on {} issues: {:?}", repaired_ids.len(), e),
    }

    // One bulk UPDATE instead of one-per-corrupted-issue.
    let corrupted_count = corrupted_ids.len() as i32;
    if !corrupted_ids.is_empty() {
        // Portable IN (...) list — see the ghost-check note on `= ANY($1)`.
        let sql = format!(r#"UPDATE "Issue" SET status = 'CORRUPTED' WHERE id IN ({})"#, Db::in_placeholders(1, corrupted_ids.len()));
        let mut q = sqlx::query(&sql);
        for id in &corrupted_ids {
            q = q.bind(id);
        }
        if let Err(e) = q.execute(&db.pool).await {
            log::error!("[Integrity Scan] Failed to mark {} issues CORRUPTED: {:?}", corrupted_count, e);
        }
    }

    Ok((scanned, corrupted_count, format!("Integrity scan complete. Tested {} archives. Found {} corrupted files.", scanned, corrupted_count)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn orphan_detection_is_case_insensitive() {
        let physical: HashSet<String> = ["C:/Lib/Batman/A.cbz", "C:/Lib/Batman/B.cbz", "C:/Lib/Extra/C.cbz"]
            .iter().map(|s| s.to_string()).collect();
        // DB paths are stored lowercased (parity with the scan). A.cbz differs only in case → NOT an
        // orphan; B is present; C is genuinely absent from the DB → the only orphan.
        let db_lower: HashSet<String> = ["c:/lib/batman/a.cbz", "c:/lib/batman/b.cbz"]
            .iter().map(|s| s.to_string()).collect();
        let orphans = compute_orphans(physical, &db_lower);
        assert_eq!(orphans, vec!["C:/Lib/Extra/C.cbz".to_string()]);
    }

    // #282: while rayon's shared pool was busy, a walk came back empty: the Deep Storage Scan wrote
    // a size of 0 for the series and the orphan scan found nothing.

    #[test]
    fn a_series_folder_is_measured_while_the_pool_is_busy() {
        use crate::walk::test_support::{busy_pool, walk_tree};
        let root = walk_tree();
        let path = root.to_string_lossy().to_string();
        assert_eq!(busy_pool(|| folder_size(&path)), 3 + 5 + 7 + 11, "every file but the hidden one");
        assert_eq!(folder_size(&path), 26);
        assert_eq!(folder_size(&root.join("missing").to_string_lossy()), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_series_folder_is_measured_without_waiting_for_a_busy_pool() {
        // Each series walks on its own blocking thread, not on the shared pool: a walk that went to a
        // busy pool would wait jwalk's full second before walking here anyway - per series folder.
        use crate::walk::test_support::{busy_pool, walk_tree};
        let root = walk_tree();
        let path = root.to_string_lossy().to_string();
        let started = std::time::Instant::now();
        assert_eq!(busy_pool(|| folder_size(&path)), 26);
        assert!(started.elapsed() < std::time::Duration::from_millis(900), "took {:?}", started.elapsed());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_orphan_scan_lists_a_library_while_the_pool_is_busy() {
        use crate::walk::test_support::{busy_pool, walk_tree};
        let root = walk_tree();
        let path = root.to_string_lossy().to_string();
        let mut found = busy_pool(|| physical_comic_files(&path));
        found.sort();
        let base = path.replace('\\', "/");
        assert_eq!(found, vec![format!("{base}/a.cbz"), format!("{base}/sub/b.cbr"), format!("{base}/sub/deeper/c.zip")]);
        let _ = std::fs::remove_dir_all(&root);
    }

    // ==== Issue #294: a passing file leaves CORRUPTED / MISSING; nothing else changes. ====

    async fn status_db() -> Db {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(sqlx::any::install_default_drivers);
        let pool = sqlx::any::AnyPoolOptions::new()
            .max_connections(1) // each :memory: connection is its own DB — keep exactly one
            .connect("sqlite::memory:").await.unwrap();
        sqlx::query(r#"CREATE TABLE "Issue" (id TEXT PRIMARY KEY, "filePath" TEXT, status TEXT NOT NULL)"#)
            .execute(&pool).await.unwrap();
        sqlx::query(r#"CREATE TABLE "Library" (path TEXT)"#).execute(&pool).await.unwrap();
        Db { pool, dialect: crate::db::Dialect::Sqlite }
    }

    async fn add_issue(db: &Db, id: &str, path: &std::path::Path, status: &str) {
        sqlx::query(r#"INSERT INTO "Issue" (id, "filePath", status) VALUES ($1, $2, $3)"#)
            .bind(id).bind(path.to_string_lossy().to_string()).bind(status)
            .execute(&db.pool).await.unwrap();
    }

    async fn status_of(db: &Db, id: &str) -> String {
        sqlx::query_scalar(r#"SELECT status FROM "Issue" WHERE id = $1"#)
            .bind(id).fetch_one(&db.pool).await.unwrap()
    }

    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("omnibus_diag_{}_{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_valid_cbz(path: &std::path::Path) {
        let mut zw = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        zw.start_file("001.jpg", zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut zw, b"page").unwrap();
        zw.finish().unwrap();
    }

    #[tokio::test]
    async fn integrity_scan_clears_corrupted_only_on_a_repaired_file() {
        let db = status_db().await;
        let dir = scratch_dir("integrity");
        let repaired = dir.join("repaired.cbz");
        let broken = dir.join("broken.cbz");
        let other = dir.join("other.cbz");
        write_valid_cbz(&repaired);
        std::fs::write(&broken, b"not a zip").unwrap();
        write_valid_cbz(&other);
        add_issue(&db, "repaired", &repaired, "CORRUPTED").await;
        add_issue(&db, "broken", &broken, "CORRUPTED").await;
        add_issue(&db, "other", &other, "WANTED").await;

        let (scanned, corrupted, _) = run_integrity_scan(db.clone()).await.unwrap();

        assert_eq!((scanned, corrupted), (3, 1));
        assert_eq!(status_of(&db, "repaired").await, "DOWNLOADED");
        assert_eq!(status_of(&db, "broken").await, "CORRUPTED");
        assert_eq!(status_of(&db, "other").await, "WANTED", "a row that isn't CORRUPTED is never changed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn ghost_check_clears_missing_only_when_the_file_is_back() {
        let db = status_db().await;
        let dir = scratch_dir("ghost");
        sqlx::query(r#"INSERT INTO "Library" (path) VALUES ($1)"#)
            .bind(dir.to_string_lossy().to_string()).execute(&db.pool).await.unwrap();
        let back = dir.join("back.cbz");
        let gone = dir.join("gone.cbz");
        let other = dir.join("other.cbz");
        std::fs::write(&back, b"x").unwrap();
        std::fs::write(&other, b"x").unwrap();
        add_issue(&db, "back", &back, "MISSING").await;
        add_issue(&db, "gone", &gone, "MISSING").await;
        add_issue(&db, "other", &other, "CORRUPTED").await;

        let (checked, missing, _) = run_ghost_check(db.clone()).await.unwrap();

        assert_eq!((checked, missing), (3, 1));
        assert_eq!(status_of(&db, "back").await, "DOWNLOADED");
        assert_eq!(status_of(&db, "gone").await, "MISSING");
        assert_eq!(status_of(&db, "other").await, "CORRUPTED", "a row that isn't MISSING is never changed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn clear_status_skips_a_row_whose_status_changed_since_the_read() {
        let db = status_db().await;
        let p = std::path::Path::new("/nonexistent/a.cbz");
        add_issue(&db, "a", p, "CORRUPTED").await;
        add_issue(&db, "b", p, "DOWNLOADING").await;

        let n = clear_status(&db, "CORRUPTED", &["a".to_string(), "b".to_string()]).await.unwrap();

        assert_eq!(n, 1);
        assert_eq!(status_of(&db, "a").await, "DOWNLOADED");
        assert_eq!(status_of(&db, "b").await, "DOWNLOADING");
        assert_eq!(clear_status(&db, "CORRUPTED", &[]).await.unwrap(), 0);
    }
}