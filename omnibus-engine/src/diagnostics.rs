use anyhow::Result;
use sqlx::{PgPool, Row};
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

pub async fn run_ghost_check(db: PgPool) -> Result<(i32, i32, String)> {
    // Drive-online guard (parity with the Node DIAGNOSTICS job's drivesOnline check): if ANY configured
    // library drive is offline, skip the whole pass. Otherwise an unmounted/disconnected volume makes
    // every Issue's file look missing and would flip the entire library to status='MISSING'. Self-heals
    // once the drive is back.
    let library_paths: Vec<String> = sqlx::query_scalar(r#"SELECT path FROM "Library""#)
        .fetch_all(&db).await.unwrap_or_default();
    for lib_path in &library_paths {
        if !Path::new(lib_path).exists() {
            log::warn!("[Ghost Check] Drive offline ({}); skipping ghost check to avoid mass-marking issues MISSING.", lib_path);
            return Ok((0, 0, format!("Ghost check skipped: library drive offline ({}).", lib_path)));
        }
    }

    let issues = sqlx::query(r#"SELECT id, "filePath" FROM "Issue" WHERE "filePath" IS NOT NULL"#)
        .fetch_all(&db).await?;

    let cfg = crate::engine_config::EngineConfig::load(&db).await;
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(cfg.scan_workers));
    let mut join_set = JoinSet::new();

    for row in issues {
        let id: String = row.get("id");
        let file_path: String = row.get("filePath");
        let sem = sem.clone();
        join_set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            tokio::task::spawn_blocking(move || {
                let exists = Path::new(&file_path).exists();
                (id, file_path, exists)
            })
                .await
                .unwrap_or((String::new(), String::new(), true))
        });
    }

    let mut total_checked = 0;
    let mut missing_ids: Vec<String> = Vec::new();

    while let Some(res) = join_set.join_next().await {
        if let Ok((id, file_path, exists)) = res {
            total_checked += 1;
            if !exists {
                log::debug!("[Ghost Check Debug] File is missing -> marking MISSING: {}", file_path);
                missing_ids.push(id);
            }
        }
    }

    // One bulk UPDATE instead of one-per-missing-issue.
    let missing_count = missing_ids.len() as i32;
    if !missing_ids.is_empty() {
        if let Err(e) = sqlx::query(r#"UPDATE "Issue" SET status = 'MISSING' WHERE id = ANY($1)"#)
            .bind(&missing_ids)
            .execute(&db).await
        {
            log::error!("[Ghost Check] Failed to mark {} issues MISSING: {:?}", missing_count, e);
        }
    }

    Ok((total_checked, missing_count, format!("Ghost check complete. Scanned {} files. Found {} missing.", total_checked, missing_count)))
}

pub async fn run_storage_scan(db: PgPool) -> Result<(i32, u64, String)> {
    // Pull the fields the dashboard needs (name/publisher/isManga/issueCount) in one grouped query.
    let series = sqlx::query(
        r#"SELECT s.id, s.name, s.publisher, s."isManga", s."folderPath",
                  COUNT(i.id) AS issue_count
           FROM "Series" s
           LEFT JOIN "Issue" i ON i."seriesId" = s.id
           WHERE s."folderPath" IS NOT NULL
           GROUP BY s.id"#
    )
    .fetch_all(&db).await?;

    let cfg = crate::engine_config::EngineConfig::load(&db).await;
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
        let is_manga: bool = row.try_get("isManga").unwrap_or(false);
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
                let mut sz: u64 = 0;
                if Path::new(&fp).exists() {
                    for e in jwalk::WalkDir::new(&fp).into_iter().flatten() {
                        if e.file_type().is_file() {
                            if let Ok(m) = e.metadata() {
                                sz += m.len();
                            }
                        }
                    }
                }
                sz
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

    // Persist per-series sizes in ONE bulk UPDATE (was one query per series) via parallel arrays —
    // Node writes prisma.series.update({ data: { size } }) per series.
    if !size_ids.is_empty() {
        if let Err(e) = sqlx::query(
            r#"UPDATE "Series" AS s SET "size" = v.size
               FROM (SELECT unnest($1::text[]) AS id, unnest($2::float8[]) AS size) AS v
               WHERE s.id = v.id"#,
        )
        .bind(&size_ids)
        .bind(&size_vals)
        .execute(&db).await
        {
            log::error!("[Storage Scan] Failed to bulk-update {} series sizes: {:?}", size_ids.len(), e);
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
    ).bind(cache_json).execute(&db).await {
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
        ).bind(key).bind(&now_ms).execute(&db).await {
            log::error!("[Storage Scan] Failed to write {}: {:?}", key, e);
        }
    }

    // Keep the aggregate total for any consumer that reads it.
    let total_mb = total_size_bytes / 1_048_576;
    if let Err(e) = sqlx::query(
        r#"INSERT INTO "SystemSetting" (key, value) VALUES ('total_library_size_mb', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"#
    ).bind(total_mb.to_string()).execute(&db).await {
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

pub async fn run_orphan_scan(db: PgPool) -> Result<Vec<String>> {
    let libs = sqlx::query(r#"SELECT path FROM "Library""#).fetch_all(&db).await?;
    let mut all_physical_files = std::collections::HashSet::new();

    // 1. Walk the physical hard drives and collect all comic files
    for lib in libs {
        let lib_path: String = lib.get("path");
        if Path::new(&lib_path).exists() {
            for e in jwalk::WalkDir::new(&lib_path).into_iter().flatten() {
                if e.file_type().is_file() {
                    let ext = e.path().extension().unwrap_or_default().to_string_lossy().to_lowercase();
                    // Node's getPhysicalFiles matches /\.(cbz|cbr|zip)$/i — .rar is excluded (it is
                    // tracked as .cbr or pending conversion, not an orphan candidate).
                    if matches!(ext.as_str(), "cbz" | "cbr" | "zip") {
                        all_physical_files.insert(e.path().to_string_lossy().replace("\\", "/"));
                    }
                }
            }
        }
    }

    // 2. Get all DB file paths, normalized + lowercased for case-insensitive comparison (parity with
    //    Node's path.normalize(p).toLowerCase()).
    let issues = sqlx::query(r#"SELECT "filePath" FROM "Issue" WHERE "filePath" IS NOT NULL"#).fetch_all(&db).await?;
    let mut db_files = std::collections::HashSet::new();
    for row in issues {
        let fp: String = row.get("filePath");
        db_files.insert(fp.replace("\\", "/").to_lowercase());
    }

    // 3. Physical files whose lowercased path is absent from the DB set are orphans. Compare
    //    case-insensitively but return the original-case path so the UI shows the real filename.
    Ok(compute_orphans(all_physical_files, &db_files))
}

pub async fn run_integrity_scan(db: PgPool) -> Result<(i32, i32, String)> {
    // Only test existing .cbz archives (case-insensitive), matching Node's existsSync + endsWith('.cbz').
    let issues = sqlx::query(r#"SELECT id, "filePath" FROM "Issue" WHERE "filePath" ILIKE '%.cbz'"#).fetch_all(&db).await?;
    let cfg = crate::engine_config::EngineConfig::load(&db).await;
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(cfg.scan_workers));
    let mut join_set = JoinSet::new();

    for row in issues {
        let id: String = row.get("id");
        let file_path: String = row.get("filePath");
        let sem = sem.clone();
        // Bounded spawn_blocking: test ZIP headers natively without exhausting the blocking pool.
        join_set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            tokio::task::spawn_blocking(move || {
                // Skip files that don't exist — a missing file is the ghost scan's concern, not a
                // corrupt archive (Node only inspects files that exist). None = skipped, not counted.
                if !Path::new(&file_path).exists() {
                    return (id, file_path, None);
                }
                let corrupted = match std::fs::File::open(&file_path) {
                    Ok(file) => zip::ZipArchive::new(file).is_err(),
                    Err(_) => true,
                };
                (id, file_path, Some(corrupted))
            })
            .await
            .unwrap_or((String::new(), String::new(), None))
        });
    }

    let mut scanned = 0;
    let mut corrupted_ids: Vec<String> = Vec::new();

    while let Some(res) = join_set.join_next().await {
        // Only count + act on files that were actually tested (Some); missing files (None) are skipped.
        if let Ok((id, file_path, Some(is_corrupted))) = res {
            scanned += 1;
            if is_corrupted {
                log::debug!("[Integrity Scan Debug] Archive failed to open -> marking CORRUPTED: {}", file_path);
                corrupted_ids.push(id);
            }
        }
    }

    // One bulk UPDATE instead of one-per-corrupted-issue.
    let corrupted_count = corrupted_ids.len() as i32;
    if !corrupted_ids.is_empty() {
        if let Err(e) = sqlx::query(r#"UPDATE "Issue" SET status = 'CORRUPTED' WHERE id = ANY($1)"#)
            .bind(&corrupted_ids).execute(&db).await
        {
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
}