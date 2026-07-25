use anyhow::{Context, Result};
use image::DynamicImage;
use rayon::prelude::*;
use std::fs::{self, File};
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use crate::db::Db;
use sqlx::Row;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use webp::Encoder;
use zip::write::FileOptions;
use zip::ZipWriter;

/// Represents a processed page ready to be zipped
struct ProcessedPage {
    filename: String,
    data: Vec<u8>,
}

/// Numeric-aware, case-insensitive comparison so `page2` sorts before `page10`
/// (parity with Node's `localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })`).
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let a = a.to_lowercase();
    let b = b.to_lowercase();
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    let mut na = String::new();
                    while let Some(&c) = ai.peek() {
                        if c.is_ascii_digit() { na.push(c); ai.next(); } else { break; }
                    }
                    let mut nb = String::new();
                    while let Some(&c) = bi.peek() {
                        if c.is_ascii_digit() { nb.push(c); bi.next(); } else { break; }
                    }
                    let va = na.trim_start_matches('0');
                    let vb = nb.trim_start_matches('0');
                    // Longer (after stripping leading zeros) = larger number; else compare lexically.
                    let ord = va.len().cmp(&vb.len()).then_with(|| va.cmp(vb));
                    if ord != Ordering::Equal { return ord; }
                } else {
                    if ca != cb { return ca.cmp(&cb); }
                    ai.next();
                    bi.next();
                }
            }
        }
    }
}

// ============================================================================
// Native OS extraction (parity with Node converter.ts beta.028-034)
//
// Official `unrar` is the primary decoder: unar/XADMaster corrupts some files
// inside RAR 2.0 archives (common in vintage comic rips). `unar` remains the
// fallback because it auto-detects other formats, e.g. genuine 7z archives
// (.cb7). ZIPs in disguise are routed by magic bytes and never reach either.
// ============================================================================

/// Reads the leading magic bytes of a file; returns an empty vec on any failure. 8 bytes so the
/// 6-byte 7z signature fits alongside the shorter zip/RAR ones.
fn read_file_signature(path: &Path) -> Vec<u8> {
    let mut buf = [0u8; 8];
    match File::open(path).and_then(|mut f| f.read(&mut buf)) {
        Ok(n) => buf[..n].to_vec(),
        Err(_) => Vec::new(),
    }
}

/// "PK" ZIP local-file-header signature.
fn is_zip_signature(sig: &[u8]) -> bool {
    sig.len() >= 2 && sig[0] == 0x50 && sig[1] == 0x4B
}

/// 7z signature (`7z\xBC\xAF\x27\x1C`) — a real .cb7, as opposed to a ZIP/RAR wearing a .cb7 name.
fn is_7z_signature(sig: &[u8]) -> bool {
    sig.len() >= 6 && sig[..6] == [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]
}

/// Image formats considered valid pages (parity with Node IMAGE_EXT_REGEX).
fn is_image_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"].iter().any(|e| lower.ends_with(e))
}

/// Archive formats Omnibus can import (parity with Node COMIC_EXT_REGEX).
fn is_comic_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    [".cbz", ".cbr", ".zip", ".rar", ".cb7", ".epub"].iter().any(|e| lower.ends_with(e))
}

/// Image entries in an `unrar lb` (bare listing) output.
fn count_image_lines(listing: &str) -> usize {
    listing.lines().filter(|line| is_image_name(line.trim())).count()
}

struct NativeExtraction {
    /// Page count from the unrar listing — the caller MUST validate the extracted image count
    /// against it (extraction success is never judged by exit code). None when unar/zip handled it.
    expected_pages: Option<usize>,
    /// stderr/error detail from a non-zero unrar extract exit, surfaced in validation failures.
    unrar_exit_detail: Option<String>,
}

/// Extracts a cbr/rar/cb7 archive into `temp_dir` using the native CLI decoders.
///
/// Extensions lie: .cbr files are frequently ZIPs in disguise, and unrar exits 0 with an empty
/// listing for them — so the real container format, not the extension or exit code, picks the
/// decoder. unrar also exits non-zero for benign structural quirks (e.g. a missing end-of-archive
/// block) even when the listing/extraction completed, so its stdout is salvaged and success is
/// judged by the extracted-vs-listed page count.
fn extract_archive_native(source: &Path, temp_dir: &Path) -> Result<NativeExtraction> {
    let file_name = source.file_name().unwrap_or_default().to_string_lossy().to_string();

    if is_zip_signature(&read_file_signature(source)) {
        log::info!("[Converter] {} is a ZIP in disguise — extracting natively", file_name);
        extract_zip(source, temp_dir)?;
        return Ok(NativeExtraction { expected_pages: None, unrar_exit_detail: None });
    }

    // unrar listing — stdout is salvaged even when the exit code is non-zero. An empty listing
    // means "not a RAR" (unrar succeeds silently on non-RAR input) → route to unar instead.
    // A missing unrar binary also falls through to unar.
    let listing = Command::new("unrar")
        .args(["lb", "-p-"])
        .arg(source)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .filter(|s| !s.trim().is_empty());

    if let Some(listing) = listing {
        let expected_pages = count_image_lines(&listing);
        let mut unrar_exit_detail = None;
        match Command::new("unrar")
            .args(["x", "-y", "-o+", "-p-", "-idq"])
            .arg(source)
            .arg(format!("{}{}", temp_dir.display(), std::path::MAIN_SEPARATOR))
            .output()
        {
            Ok(o) if !o.status.success() => {
                let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
                unrar_exit_detail =
                    Some(if stderr.is_empty() { format!("unrar exited with {}", o.status) } else { stderr });
            }
            Err(e) => unrar_exit_detail = Some(e.to_string()),
            _ => {}
        }
        return Ok(NativeExtraction { expected_pages: Some(expected_pages), unrar_exit_detail });
    }

    // unar fallback: format-agnostic decoder for everything that isn't a RAR or ZIP (genuine 7z, etc.)
    match Command::new("unar")
        .args(["-q", "-p", "", "-o"])
        .arg(temp_dir)
        .args(["-f", "-D"])
        .arg(source)
        .output()
    {
        Ok(o) if o.status.success() => Ok(NativeExtraction { expected_pages: None, unrar_exit_detail: None }),
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
            anyhow::bail!(
                "Native extraction failed: {}",
                if stderr.is_empty() { "Unknown CLI error".to_string() } else { stderr }
            )
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            anyhow::bail!("Native extraction failed: unar binary not found on PATH (is it installed in this environment?)")
        }
        Err(e) => anyhow::bail!("Native extraction failed: {}", e),
    }
}

/// Validates the extracted page count against the unrar listing (never the exit code).
fn validate_extraction(extraction: &NativeExtraction, extracted_images: usize) -> Result<()> {
    if let Some(expected) = extraction.expected_pages {
        if extracted_images < expected {
            let detail = extraction
                .unrar_exit_detail
                .clone()
                .unwrap_or_else(|| "archive may be damaged".to_string());
            anyhow::bail!(
                "Native extraction failed: only {} of {} pages extracted ({})",
                extracted_images,
                expected,
                detail
            );
        }
    }
    Ok(())
}

/// Base directory for extraction temp work. Honors the configured cache dir (OMNIBUS_CACHE_DIR — set
/// to /config/cache on the container, CACHE_DIR accepted as an alias) so temp files land on the
/// mounted cache volume, never the container's ephemeral root fs. Defaults to /config/cache to match
/// the Node app's paths.ts, so a missing env can't silently redirect heavy extraction to /tmp.
fn extraction_temp_base() -> PathBuf {
    std::env::var("OMNIBUS_CACHE_DIR")
        .or_else(|_| std::env::var("CACHE_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/config/cache"))
}

/// Fast, native function to extract a CBR/RAR/CB7 and repack it directly to CBZ (ZIP) without re-encoding images.
pub fn convert_cbr_to_cbz(cbr_path: &Path) -> Result<PathBuf> {
    if !cbr_path.exists() {
        anyhow::bail!("File does not exist: {:?}", cbr_path);
    }

    let cbz_path = cbr_path.with_extension("cbz");
    // Extraction temp lives under the configured cache dir (see extraction_temp_base).
    let temp_dir_base = extraction_temp_base();

    let temp_dir = temp_dir_base.join(format!("omnibus_extraction_{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).context("Failed to create temp directory")?;

    // 1. Extract natively (unrar primary w/ salvage, unar fallback, ZIP-in-disguise sniff).
    let extraction = match extract_archive_native(cbr_path, &temp_dir) {
        Ok(x) => x,
        Err(e) => {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(e);
        }
    };
    if let Err(e) = validate_extraction(&extraction, find_images(&temp_dir)?.len()) {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(e);
    }

    // 2. Create the new ZIP file
    let cbz_file = File::create(&cbz_path)?;
    let mut zip = ZipWriter::new(cbz_file);
    // Use Deflated compression (standard ZIP)
    let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // 3. Walk the temporary directory and stream files into the new ZIP
    for entry in jwalk::WalkDir::new(&temp_dir) {
        let entry = entry?;
        let path = entry.path();
        
        if path.is_file() {
            let name = path.strip_prefix(&temp_dir)?.to_string_lossy().replace("\\", "/");
            zip.start_file(name, options)?;
            
            let mut f = File::open(&path)?;
            std::io::copy(&mut f, &mut zip)?;
        }
    }
    zip.finish()?;

    // 4. Cleanup the temporary folder and the original CBR file
    fs::remove_dir_all(&temp_dir)?;
    fs::remove_file(cbr_path)?;

    Ok(cbz_path)
}

/// Reads the user's WebP conversion settings from the database.
/// Parity with converter.ts:25-30 — defaults: conversion OFF, quality 80.
pub async fn get_webp_settings(db: &sqlx::AnyPool) -> (bool, f32) {
    let rows = sqlx::query(
        r#"SELECT key, value FROM "SystemSetting" WHERE key IN ('convert_to_webp', 'webp_quality')"#
    )
    .fetch_all(db)
    .await
    .unwrap_or_default();

    let mut convert_to_webp = false;
    let mut webp_quality = 80.0_f32;
    for row in rows {
        let key: String = row.get("key");
        let value: String = row.get("value");
        match key.as_str() {
            "convert_to_webp" => convert_to_webp = value == "true",
            "webp_quality" => webp_quality = value.parse::<f32>().unwrap_or(80.0),
            _ => {}
        }
    }
    (convert_to_webp, webp_quality)
}

/// The Parallel Background Sweep Job for converting all CBRs in the library.
/// An `issue_id` converts just that issue (beta.034 targeted conversion).
pub async fn process_cbr_sweep(db: Db, issue_id: Option<String>) -> anyhow::Result<(i32, i32, String)> {
    let issues = if let Some(id) = &issue_id {
        sqlx::query(r#"SELECT id, "filePath" FROM "Issue" WHERE id = $1 AND "filePath" IS NOT NULL"#)
            .bind(id)
            .fetch_all(&db.pool)
            .await?
    } else {
        sqlx::query(
            r#"SELECT id, "filePath" FROM "Issue"
               WHERE LOWER("filePath") LIKE '%.cbr' OR LOWER("filePath") LIKE '%.rar' OR LOWER("filePath") LIKE '%.cb7'"#
        ).fetch_all(&db.pool).await?
    };

    if issues.is_empty() {
        let msg = match &issue_id {
            Some(id) => format!("Targeted issue {} not found or already converted.", id),
            None => "No CBR files found to convert.".to_string(),
        };
        return Ok((0, 0, msg));
    }

    // Honor the user's WebP settings (the sweep previously did a raw RAR→ZIP repack, ignoring them).
    let (convert_to_webp, webp_quality) = get_webp_settings(&db.pool).await;
    log::info!("[Converter] CBR sweep starting for {} files. WebP: {} (quality {}).", issues.len(), convert_to_webp, webp_quality);

    // Bound concurrency to the core count so a large library can't exhaust the blocking pool / thrash disk.
    let cfg = crate::engine_config::EngineConfig::load(&db.pool).await;
    let sem = Arc::new(Semaphore::new(cfg.convert_workers));
    let mut join_set = JoinSet::new();

    for row in issues {
        let issue_id: String = row.get("id");
        let file_path: String = row.get("filePath");
        let sem = sem.clone();

        join_set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            let path = PathBuf::from(&file_path);
            // Route through process_archive so the sweep honors WebP settings (parity with Node's convertCbrToCbz).
            let result = tokio::task::spawn_blocking(move || process_archive(&path, convert_to_webp, webp_quality)).await;
            match result {
                Ok(Ok(new_path)) => Ok((issue_id, new_path.to_string_lossy().to_string())),
                Ok(Err(e)) => Err(format!("Failed to convert {}: {}", file_path, e)),
                Err(e) => Err(format!("Conversion task panicked for {}: {}", file_path, e)),
            }
        });
    }

    let mut success = 0;
    let mut fail = 0;
    let mut details = String::new();

    // Await the conversions and update the database with the new .cbz file paths
    while let Some(res) = join_set.join_next().await {
        match res {
            Ok(Ok((issue_id, new_path))) => {
                // The freshly-built CBZ finally has a countable page count (the source RAR didn't) —
                // record it so OPDS-PSE stops advertising the issue as "0 pages".
                let pages = count_zip_pages(Path::new(&new_path)).unwrap_or(0);
                // The file is already converted on disk; if the DB update fails the record would point at a
                // deleted .cbr, so surface it rather than silently counting a success.
                if let Err(e) = sqlx::query(
                    r#"UPDATE "Issue" SET "filePath" = $1,
                           "pageCount" = CASE WHEN $2 > 0 THEN $2 ELSE "pageCount" END
                       WHERE id = $3"#
                )
                    .bind(&new_path)
                    .bind(pages)
                    .bind(&issue_id)
                    .execute(&db.pool).await
                {
                    log::error!("[Converter] Converted {} but failed to update its database path: {:?}", new_path, e);
                    fail += 1;
                    details.push_str(&format!("[WARN] Converted but DB update failed for {}\n", new_path));
                } else {
                    success += 1;
                }
            },
            Ok(Err(err_msg)) => {
                fail += 1;
                details.push_str(&format!("[FAIL] {}\n", err_msg));
            },
            Err(e) => {
                fail += 1;
                details.push_str(&format!("[FAIL] task join error: {}\n", e));
            },
        }
    }

    Ok((success, fail, details))
}

/// Converts a CBR/RAR file or repacks an existing CBZ/ZIP file. (Includes WebP support)
pub fn process_archive(
    source_path: &Path,
    convert_to_webp: bool,
    webp_quality: f32,
) -> Result<PathBuf> {
    log::info!("Starting processing for: {:?}", source_path.file_name().unwrap_or_default());

    // 1. Extraction temp lives under the configured cache dir (see extraction_temp_base).
    let temp_dir_base = extraction_temp_base();
        
    let temp_dir = temp_dir_base.join(format!("omnibus_extraction_{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).context("Failed to create temp directory")?;

    // 2. Extract the archive — the real container format (magic bytes), not the extension,
    // picks the decoder for the RAR-family extensions.
    let ext = source_path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
    let extraction = if ext == "cbr" || ext == "rar" || ext == "cb7" {
        match extract_archive_native(source_path, &temp_dir) {
            Ok(x) => x,
            Err(e) => {
                let _ = fs::remove_dir_all(&temp_dir);
                return Err(e);
            }
        }
    } else if ext == "cbz" || ext == "zip" {
        extract_zip(source_path, &temp_dir)?;
        NativeExtraction { expected_pages: None, unrar_exit_detail: None }
    } else {
        let _ = fs::remove_dir_all(&temp_dir);
        anyhow::bail!("Unsupported file extension: {}", ext);
    };

    // 3. Find all valid images inside the extracted folder and validate against the unrar listing.
    let mut images = find_images(&temp_dir)?;
    if let Err(e) = validate_extraction(&extraction, images.len()) {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(e);
    }
    if images.is_empty() {
        fs::remove_dir_all(&temp_dir)?;
        anyhow::bail!("Archive contained no valid images after extraction.");
    }
    // Natural sort (numeric-aware, case-insensitive) so page2 < page10 — parity with Node's localeCompare(numeric).
    images.sort_by(|a, b| natural_cmp(&a.to_string_lossy(), &b.to_string_lossy()));
    log::debug!("[Converter Debug] Found {} images in {:?}", images.len(), source_path.file_name().unwrap_or_default());

    // 4. Determine output path (always outputs a .cbz)
    let output_path = source_path.with_extension("cbz");
    
    // Create a temporary output file to prevent corrupting data if the process crashes
    let temp_output_path = source_path.with_extension("cbz.tmp");
    let file = File::create(&temp_output_path)?;
    let mut zip = ZipWriter::new(file);
    let options = FileOptions::default().compression_method(zip::CompressionMethod::Stored); // WebP/JPEGs are already compressed

    // 5. PARALLEL IMAGE PROCESSING 🚀
    let mut processed_pages: Vec<Result<ProcessedPage>> = images
        .into_par_iter()
        .enumerate()
        .map(|(index, img_path)| {
            let page_num = format!("page_{:04}", index + 1);
            let img_ext = img_path.extension().unwrap_or_default().to_string_lossy().to_lowercase();

            if convert_to_webp && img_ext != "webp" && img_ext != "gif" {
                match image::open(&img_path) {
                    Ok(img) => {
                        log::debug!("[Converter Debug] Encoding page {} to WebP at {}%...", index + 1, webp_quality);
                        let webp_data = encode_to_webp(&img, webp_quality)?;
                        Ok(ProcessedPage {
                            filename: format!("{}.webp", page_num),
                            data: webp_data,
                        })
                    }
                    Err(e) => {
                        log::warn!("[Converter] WebP decode failed for {:?}: {:?}; storing raw.", img_path.file_name().unwrap_or_default(), e);
                        read_raw_file(&img_path, format!("{}.{}", page_num, img_ext))
                    }
                }
            } else {
                read_raw_file(&img_path, format!("{}.{}", page_num, img_ext))
            }
        })
        .collect();

    // 6. Write processed pages to the new CBZ archive sequentially
    for page_result in processed_pages.drain(..) {
        let page = page_result?;
        zip.start_file(page.filename, options)?;
        zip.write_all(&page.data)?;
    }

    // 7. Preserve ComicInfo.xml if it exists
    let comic_info_path = temp_dir.join("ComicInfo.xml");
    if comic_info_path.exists() {
        zip.start_file("ComicInfo.xml", options)?;
        let mut f = File::open(comic_info_path)?;
        let mut buffer = Vec::new();
        f.read_to_end(&mut buffer)?;
        zip.write_all(&buffer)?;
    }

    zip.finish()?;

    // 8. Move the temp zip to the final destination and clean up
    fs::rename(&temp_output_path, &output_path)?;
    if source_path != output_path && source_path.exists() {
        fs::remove_file(source_path)?; // Delete original CBR if we made a CBZ
    }
    fs::remove_dir_all(&temp_dir)?;

    log::info!("Successfully processed and saved to {:?}", output_path);
    Ok(output_path)
}

fn encode_to_webp(img: &DynamicImage, quality: f32) -> Result<Vec<u8>> {
    // Preserve the alpha channel for transparent images (covers/logos) instead of dropping it.
    if img.color().has_alpha() {
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();
        let webp_memory = Encoder::from_rgba(rgba.as_raw(), w, h).encode(quality);
        Ok(webp_memory.to_vec())
    } else {
        let rgb = img.to_rgb8();
        let (w, h) = rgb.dimensions();
        let webp_memory = Encoder::from_rgb(rgb.as_raw(), w, h).encode(quality);
        Ok(webp_memory.to_vec())
    }
}

fn read_raw_file(path: &Path, filename: String) -> Result<ProcessedPage> {
    let mut f = File::open(path)?;
    let mut data = Vec::new();
    f.read_to_end(&mut data)?;
    Ok(ProcessedPage { filename, data })
}

fn find_images(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    if dir.is_dir() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            // Skip macOS resource-fork junk that would otherwise become garbage pages.
            let name_lower = path.file_name().and_then(|n| n.to_str()).map(|s| s.to_lowercase()).unwrap_or_default();
            if name_lower == "__macosx" || name_lower.starts_with("._") {
                continue;
            }
            if path.is_dir() {
                files.extend(find_images(&path)?);
            } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if matches!(ext.to_lowercase().as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp") {
                    files.push(path);
                }
            }
        }
    }
    Ok(files)
}

fn extract_zip(source: &Path, dest: &Path) -> Result<()> {
    let file = File::open(source)?;
    let mut archive = zip::ZipArchive::new(file)?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        
        let outpath = match file.enclosed_name() {
            Some(path) => dest.join(path),
            None => continue,
        };

        if (*file.name()).ends_with('/') {
            fs::create_dir_all(&outpath)?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    fs::create_dir_all(p)?;
                }
            }
            let mut outfile = File::create(&outpath)?;
            std::io::copy(&mut file, &mut outfile)?;
        }
    }
    Ok(())
}

// ============================================================================
// Cover extraction — pull the first page out of an archive into <folder>/cover.<ext>
// so unmatched / un-synced series still get a real cover. Reuses natural_cmp +
// is_image_name + the native RAR/7z extractor; no new archive machinery.
// ============================================================================

/// Picks the first natural-sorted image entry from a newline-separated archive listing (e.g. the
/// output of `unrar lb`). Skips macOS junk and AppleDouble (._*) sidecars, mirroring first_image_from_zip.
/// Returns None when the listing holds no image page.
fn first_image_in_listing(listing: &str) -> Option<String> {
    let mut images: Vec<&str> = listing
        .lines()
        .map(str::trim)
        .filter(|l| {
            if l.is_empty() { return false; }
            if l.to_lowercase().contains("__macosx") { return false; }
            let base = l.rsplit(['/', '\\']).next().unwrap_or(l);
            if base.starts_with("._") { return false; }
            is_image_name(l)
        })
        .collect();
    images.sort_by(|a, b| natural_cmp(a, b));
    images.first().map(|s| s.to_string())
}

/// Targeted first-page extraction for RAR-family archives: list the entries, pick the first image, and
/// extract ONLY that one file — instead of unpacking the whole (often hundreds-of-MB) archive just to
/// read the cover. `dest_dir` must already exist. Returns Ok(None) when the archive genuinely has no
/// image page. Returns Err to tell the caller to fall back to a full extraction: unrar is unavailable
/// or the file isn't a RAR (e.g. a real 7z that needs unar), or a name whose wildcard metacharacters
/// (`*`/`?`) made unrar match nothing — verified by checking what actually landed.
fn first_image_from_rar(archive_path: &Path, dest_dir: &Path) -> Result<Option<(Vec<u8>, String)>> {
    // `lb` lists bare entry paths; stdout is taken even on a non-zero exit (parity with the salvage in
    // extract_archive_native). An empty listing means "not a unrar-readable RAR" → signal fallback.
    let listing = Command::new("unrar")
        .args(["lb", "-p-"])
        .arg(archive_path)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("unrar listing unavailable"))?;

    let target = match first_image_in_listing(&listing) {
        Some(t) => t,
        None => return Ok(None), // no image pages — a full extraction wouldn't find any either
    };

    // Extract just that entry, flattened into dest_dir. `--` ends switch parsing so a name beginning
    // with '-' isn't read as a flag. The exit code isn't trusted — success is judged by what landed.
    let _ = Command::new("unrar")
        .args(["e", "-y", "-o+", "-p-", "-idq", "--"])
        .arg(archive_path)
        .arg(&target)
        .arg(format!("{}{}", dest_dir.display(), std::path::MAIN_SEPARATOR))
        .output();

    let mut extracted = find_images(dest_dir)?;
    if extracted.is_empty() {
        anyhow::bail!("targeted unrar extraction produced no image for {:?}", target);
    }
    extracted.sort_by(|a, b| natural_cmp(&a.to_string_lossy(), &b.to_string_lossy()));
    let p = &extracted[0];
    let bytes = fs::read(p)?;
    let e = p.extension().unwrap_or_default().to_string_lossy().to_lowercase();
    Ok(Some((bytes, e)))
}

/// First natural-sorted image page of an archive, as (bytes, lowercase-ext). Handles native zip
/// (.cbz/.zip and zip-in-disguise) directly and shells the RAR/7z extractor for .cbr/.cb7.
/// Ok(None) when the archive holds no readable image page.
pub fn extract_first_image(archive_path: &Path) -> Result<Option<(Vec<u8>, String)>> {
    let ext = archive_path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
    let sig = read_file_signature(archive_path);

    if ext == "cbz" || ext == "zip" || is_zip_signature(&sig) {
        return first_image_from_zip(archive_path);
    }

    if ext == "cbr" || ext == "rar" || ext == "cb7" {
        let temp_dir = extraction_temp_base().join(format!("omnibus_cover_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir)?;
        let result = (|| -> Result<Option<(Vec<u8>, String)>> {
            // Fast path: extract ONLY the first page into its own subdir.
            let first_dir = temp_dir.join("first");
            fs::create_dir_all(&first_dir)?;
            match first_image_from_rar(archive_path, &first_dir) {
                Ok(found) => return Ok(found),
                Err(e) => log::debug!(
                    "[Cover] Targeted first-page extraction unavailable for {:?} ({}); extracting fully.",
                    archive_path.file_name().unwrap_or_default(), e
                ),
            }
            // Fallback: full native extraction (covers 7z/unar and odd RAR quirks), then the first image.
            let full_dir = temp_dir.join("full");
            fs::create_dir_all(&full_dir)?;
            extract_archive_native(archive_path, &full_dir)?;
            let mut images = find_images(&full_dir)?;
            images.sort_by(|a, b| natural_cmp(&a.to_string_lossy(), &b.to_string_lossy()));
            match images.first() {
                Some(p) => {
                    let bytes = fs::read(p)?;
                    let e = p.extension().unwrap_or_default().to_string_lossy().to_lowercase();
                    Ok(Some((bytes, e)))
                }
                None => Ok(None),
            }
        })();
        let _ = fs::remove_dir_all(&temp_dir);
        return result;
    }

    Ok(None)
}

/// First image entry (natural-sorted, skipping macOS junk) read out of a zip-based archive.
fn first_image_from_zip(archive_path: &Path) -> Result<Option<(Vec<u8>, String)>> {
    let file = File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    let mut names: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            if entry.is_dir() { continue; }
            let name = entry.name().to_string();
            if name.to_lowercase().contains("__macosx") { continue; }
            let base = name.rsplit('/').next().unwrap_or(&name);
            if base.starts_with("._") { continue; }
            if is_image_name(&name) { names.push(name); }
        }
    }
    names.sort_by(|a, b| natural_cmp(a, b));

    match names.first() {
        Some(first) => {
            let mut entry = archive.by_name(first)?;
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            let e = Path::new(first).extension().unwrap_or_default().to_string_lossy().to_lowercase();
            Ok(Some((buf, e)))
        }
        None => Ok(None),
    }
}

/// Resolve a reader page name to the actual zip entry, mirroring the Node reader route's fallbacks:
/// exact match → backslash-normalized → basename match (case-sensitive, like adm-zip).
fn resolve_zip_entry<R: Read + Seek>(archive: &mut zip::ZipArchive<R>, entry_name: &str) -> Option<String> {
    if archive.by_name(entry_name).is_ok() {
        return Some(entry_name.to_string());
    }
    let fwd = entry_name.replace('\\', "/");
    if fwd != entry_name && archive.by_name(&fwd).is_ok() {
        return Some(fwd);
    }
    let target_base = entry_name.rsplit(['/', '\\']).next().unwrap_or(entry_name);
    for i in 0..archive.len() {
        if let Ok(e) = archive.by_index(i) {
            let n = e.name().to_string();
            let base = n.rsplit(['/', '\\']).next().unwrap_or(&n);
            if base == target_base {
                return Some(n);
            }
        }
    }
    None
}

/// Extract a single named page from a zip/cbz, resize it to fit `max_width` (never enlarging), and
/// re-encode as WebP at `quality`. Returns None when the entry isn't found. This is the reader
/// page-serving offload: it keeps the whole-archive buffer + image work off the Node event loop. These
/// are display images, so it trades byte-for-byte parity with the Node sharp pipeline for that — the
/// Node route keeps a local sharp fallback (and still owns the auto-crop path, which has no clean
/// image-crate equivalent).
pub fn extract_page_webp(archive_path: &Path, entry_name: &str, max_width: u32, quality: f32) -> Result<Option<Vec<u8>>> {
    // Native RAR reading (no conversion needed): resolve the entry against the unrar listing and
    // stream just that page's bytes. The signature (not the extension) decides, same as the zip path.
    let sig = read_file_signature(archive_path);
    if is_rar_signature(&sig) {
        let pages = rar_image_entries(archive_path)?;
        let name = match resolve_listed_entry(&pages, entry_name) {
            Some(n) => n,
            None => return Ok(None),
        };
        return Ok(Some(webp_from_image_bytes(&rar_entry_bytes(archive_path, &name)?, max_width, quality)?));
    }
    // Native 7z reading: resolve against the metadata listing, then decompress just that entry.
    if is_7z_signature(&sig) {
        let pages = sevenz_image_entries(archive_path)?;
        let name = match resolve_listed_entry(&pages, entry_name) {
            Some(n) => n,
            None => return Ok(None),
        };
        return Ok(Some(webp_from_image_bytes(&sevenz_entry_bytes(archive_path, &name)?, max_width, quality)?));
    }
    let file = File::open(archive_path)?;
    extract_page_webp_from_reader(file, entry_name, max_width, quality)
}

fn extract_page_webp_from_reader<R: Read + Seek>(reader: R, entry_name: &str, max_width: u32, quality: f32) -> Result<Option<Vec<u8>>> {
    let mut archive = zip::ZipArchive::new(reader)?;
    let name = match resolve_zip_entry(&mut archive, entry_name) {
        Some(n) => n,
        None => return Ok(None),
    };
    extract_named_entry_webp(&mut archive, &name, max_width, quality)
}

/// The zip's image pages in the OPDS manifest order: non-directory, no macOS junk, image extension,
/// natural-sorted by full entry name (parity with the Node OPDS page route's
/// `localeCompare(undefined, { numeric: true, sensitivity: 'base' })` sort — indexes must line up
/// with what the same book's earlier page requests resolved to).
fn sorted_image_entries<R: Read + Seek>(archive: &mut zip::ZipArchive<R>) -> Vec<String> {
    let mut pages: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        if let Ok(e) = archive.by_index(i) {
            if e.is_dir() { continue; }
            let name = e.name().to_string();
            if name.to_lowercase().contains("__macosx") { continue; }
            if is_image_name(&name) { pages.push(name); }
        }
    }
    pages.sort_by(|a, b| natural_cmp(a, b));
    pages
}

/// Page count of a zip-family archive (cbz/zip/epub, including ZIPs in disguise — the signature,
/// not the extension, decides readability): image entries with the same filter as the OPDS/reader
/// paths. None when the file isn't a readable zip (a real RAR counts as None, not 0 — its count
/// becomes known after CBZ conversion). Feeds Issue.pageCount, which OPDS-PSE clients read as
/// pse:count — a 0 there renders as an unopenable "0 pages" book in reader apps.
pub fn count_zip_pages(path: &Path) -> Option<i32> {
    if !is_zip_signature(&read_file_signature(path)) {
        return None;
    }
    let file = File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    Some(sorted_image_entries(&mut archive).len() as i32)
}

/// Extract the Nth image page (0-based, natural-sorted) from a zip/cbz, resized + WebP-encoded like
/// [`extract_page_webp`]. This is the OPDS-PSE offload: PSE clients address pages by index, not entry
/// name. Returns None when the index is out of bounds (the Node route maps that to 404).
pub fn extract_page_index_webp(archive_path: &Path, index: usize, max_width: u32, quality: f32) -> Result<Option<Vec<u8>>> {
    // Native RAR reading: same natural-sort index addressing as the zip path, so pse:count and
    // page indexes line up whichever format the archive happens to be.
    let sig = read_file_signature(archive_path);
    if is_rar_signature(&sig) {
        let pages = rar_image_entries(archive_path)?;
        let name = match pages.get(index) {
            Some(n) => n.clone(),
            None => return Ok(None),
        };
        return Ok(Some(webp_from_image_bytes(&rar_entry_bytes(archive_path, &name)?, max_width, quality)?));
    }
    // Native 7z reading: same natural-sort index addressing across formats.
    if is_7z_signature(&sig) {
        let pages = sevenz_image_entries(archive_path)?;
        let name = match pages.get(index) {
            Some(n) => n.clone(),
            None => return Ok(None),
        };
        return Ok(Some(webp_from_image_bytes(&sevenz_entry_bytes(archive_path, &name)?, max_width, quality)?));
    }
    let file = File::open(archive_path)?;
    extract_page_index_webp_from_reader(file, index, max_width, quality)
}

fn extract_page_index_webp_from_reader<R: Read + Seek>(reader: R, index: usize, max_width: u32, quality: f32) -> Result<Option<Vec<u8>>> {
    let mut archive = zip::ZipArchive::new(reader)?;
    let pages = sorted_image_entries(&mut archive);
    let name = match pages.get(index) {
        Some(n) => n.clone(),
        None => return Ok(None),
    };
    extract_named_entry_webp(&mut archive, &name, max_width, quality)
}

/// Shared tail of the page-serving paths: read `name` out of the archive, resize to fit `max_width`
/// (never enlarging), encode as WebP.
fn extract_named_entry_webp<R: Read + Seek>(archive: &mut zip::ZipArchive<R>, name: &str, max_width: u32, quality: f32) -> Result<Option<Vec<u8>>> {
    let mut buf = Vec::new();
    archive.by_name(name)?.read_to_end(&mut buf)?;
    Ok(Some(webp_from_image_bytes(&buf, max_width, quality)?))
}

/// Display-image tail shared by every page-serving format: decode, fit to `max_width` (never
/// enlarging), WebP-encode.
fn webp_from_image_bytes(buf: &[u8], max_width: u32, quality: f32) -> Result<Vec<u8>> {
    let img = image::load_from_memory(buf)?;
    let (w, h) = (img.width(), img.height());
    let out = if w > max_width && w > 0 {
        let nh = (((h as u64) * (max_width as u64)) / (w as u64)).max(1) as u32;
        img.resize_exact(max_width, nh, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    encode_to_webp(&out, quality)
}

// ============================================================================
// Native RAR page reading — the reader/OPDS paths were zip-only, so an unconverted
// .cbr was unreadable (and advertised pse:count=0 to OPDS clients). These helpers
// reuse the proven cover-route primitives: `unrar lb` to list, `unrar p` to stream
// one entry to stdout — no temp dir, no full extraction. CBZ conversion remains the
// recommended default (zip has real random access; solid RARs decompress serially),
// but a library that skips or hasn't reached conversion is now readable.
// ============================================================================

/// The RAR's image pages with the SAME filter + order as `sorted_image_entries` (skip __MACOSX,
/// image extensions, natural sort) so OPDS-PSE index addressing lines up across formats. Stdout is
/// salvaged even on a non-zero exit (vintage RAR 2.0 quirk — success is judged by content, not exit
/// code). Err when unrar is unavailable or the listing is empty ("not natively readable").
fn rar_image_entries(archive_path: &Path) -> Result<Vec<String>> {
    let listing = Command::new("unrar")
        .args(["lb", "-p-"])
        .arg(archive_path)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("unrar listing unavailable for {:?}", archive_path.file_name().unwrap_or_default()))?;

    let mut pages: Vec<String> = listing
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.to_lowercase().contains("__macosx") && is_image_name(l))
        .map(str::to_string)
        .collect();
    pages.sort_by(|a, b| natural_cmp(a, b));
    Ok(pages)
}

/// Streams ONE entry's bytes out of a RAR via `unrar p` (print to stdout — the pattern proven by
/// the scanner's ComicInfo reader). `-inul` silences everything but the file bytes; `--` ends
/// switch parsing so an entry starting with '-' isn't read as a flag.
fn rar_entry_bytes(archive_path: &Path, entry: &str) -> Result<Vec<u8>> {
    let out = Command::new("unrar")
        .args(["p", "-inul", "-p-", "--"])
        .arg(archive_path)
        .arg(entry)
        .output()?;
    if out.stdout.is_empty() {
        anyhow::bail!("unrar produced no bytes for entry {:?} of {:?}", entry, archive_path.file_name().unwrap_or_default());
    }
    Ok(out.stdout)
}

/// Reader page-name resolution against a pre-listed archive (RAR or 7z), mirroring
/// `resolve_zip_entry`: exact match → slash-normalized → basename.
fn resolve_listed_entry(pages: &[String], entry_name: &str) -> Option<String> {
    if pages.iter().any(|p| p == entry_name) {
        return Some(entry_name.to_string());
    }
    let fwd = entry_name.replace('\\', "/");
    if let Some(p) = pages.iter().find(|p| p.replace('\\', "/") == fwd) {
        return Some(p.clone());
    }
    let target_base = entry_name.rsplit(['/', '\\']).next().unwrap_or(entry_name);
    pages.iter().find(|p| p.rsplit(['/', '\\']).next().unwrap_or(p) == target_base).cloned()
}

// ============================================================================
// Native 7z (.cb7) page reading — the reader/OPDS paths handled zip and RAR, so an
// unconverted .cb7 was unreadable and advertised pse:count=0. Unlike RAR (proprietary,
// shelled out to unrar), 7z has a pure-Rust decoder (sevenz-rust2) — so this is in-process,
// needs no runtime binary, and its tests run everywhere. CBZ conversion is still the
// recommended default (zip has real random access; 7z blocks decode serially), but a library
// that skips or hasn't reached conversion is now readable.
// ============================================================================

/// The 7z's image pages with the SAME filter + order as `sorted_image_entries` (skip __MACOSX,
/// image extensions, natural sort) so OPDS-PSE index addressing lines up across formats. Listing
/// reads only the archive's metadata header — no block is decompressed. Err when the file can't be
/// opened as 7z ("not natively readable").
fn sevenz_image_entries(archive_path: &Path) -> Result<Vec<String>> {
    let archive = sevenz_rust2::Archive::open(archive_path)
        .map_err(|e| anyhow::anyhow!("7z listing unavailable for {:?}: {e}", archive_path.file_name().unwrap_or_default()))?;
    let mut pages: Vec<String> = archive
        .files
        .iter()
        .filter(|f| !f.is_directory() && f.has_stream())
        .map(|f| f.name().to_string())
        .filter(|n| !n.to_lowercase().contains("__macosx") && is_image_name(n))
        .collect();
    pages.sort_by(|a, b| natural_cmp(a, b));
    Ok(pages)
}

/// Decompresses ONE entry's bytes out of a 7z by name (parity with `rar_entry_bytes`). `read_file`
/// decodes only the block that entry lives in — for a solid archive that means decoding up to it,
/// inherent to 7z. Empty password: encrypted .cb7 is an unsupported edge and fails gracefully here.
fn sevenz_entry_bytes(archive_path: &Path, entry: &str) -> Result<Vec<u8>> {
    let mut reader = sevenz_rust2::ArchiveReader::open(archive_path, sevenz_rust2::Password::empty())
        .map_err(|e| anyhow::anyhow!("could not open 7z {:?}: {e}", archive_path.file_name().unwrap_or_default()))?;
    let bytes = reader.read_file(entry)
        .map_err(|e| anyhow::anyhow!("7z produced no bytes for entry {:?} of {:?}: {e}", entry, archive_path.file_name().unwrap_or_default()))?;
    if bytes.is_empty() {
        anyhow::bail!("7z entry {:?} of {:?} was empty", entry, archive_path.file_name().unwrap_or_default());
    }
    Ok(bytes)
}

/// Reads a single entry by BASENAME (case-insensitive) out of a 7z — the scanner's ComicInfo reader
/// needs a non-image entry the image-only listing skips. Keeps all sevenz-rust2 use in this file.
/// None when the archive can't be opened, has no matching entry, or the entry is empty.
pub(crate) fn sevenz_read_by_basename(path: &Path, basename: &str) -> Option<Vec<u8>> {
    let archive = sevenz_rust2::Archive::open(path).ok()?;
    let name = archive
        .files
        .iter()
        .filter(|f| !f.is_directory())
        .map(|f| f.name().to_string())
        .find(|n| n.rsplit(['/', '\\']).next().unwrap_or("").eq_ignore_ascii_case(basename))?;
    let mut reader = sevenz_rust2::ArchiveReader::open(path, sevenz_rust2::Password::empty()).ok()?;
    reader.read_file(&name).ok().filter(|b| !b.is_empty())
}

/// Page count of ANY natively readable archive: zip-family directly, RAR-family via the unrar
/// listing. None when the file is neither (e.g. a real 7z — its count becomes known after CBZ
/// conversion). Same OPDS-PSE significance as [`count_zip_pages`].
pub fn count_archive_pages(path: &Path) -> Option<i32> {
    if let Some(n) = count_zip_pages(path) {
        return Some(n);
    }
    let sig = read_file_signature(path);
    if is_rar_signature(&sig) {
        return rar_image_entries(path).ok().map(|p| p.len() as i32);
    }
    if is_7z_signature(&sig) {
        return sevenz_image_entries(path).ok().map(|p| p.len() as i32);
    }
    None
}

/// Image entry names of any natively readable archive in reader/OPDS order — the web reader's
/// page list (Node has no RAR reader, so it asks the engine for non-zip archives).
pub fn list_image_entries(path: &Path) -> Result<Vec<String>> {
    let sig = read_file_signature(path);
    if is_zip_signature(&sig) {
        let file = File::open(path)?;
        let mut archive = zip::ZipArchive::new(file)?;
        return Ok(sorted_image_entries(&mut archive));
    }
    if is_rar_signature(&sig) {
        return rar_image_entries(path);
    }
    if is_7z_signature(&sig) {
        return sevenz_image_entries(path);
    }
    anyhow::bail!("unsupported archive format for page listing: {:?}", path.file_name().unwrap_or_default())
}

/// ComicInfo.xml adjustments for a page-removal rewrite (issue #189): the `<Pages>` block indexes
/// pages by position and is stale the moment pages shift, so it is dropped wholesale; a numeric
/// `<PageCount>` is rewritten to the new count. Plain string surgery on purpose — ComicInfo files
/// are machine-written, and a quick-xml round-trip would reformat the rest of a foreign file.
/// Anything unrecognized passes through untouched (the next metadata embed rewrites it fully).
pub(crate) fn strip_comic_info_pages(xml: &str, new_page_count: usize) -> String {
    let mut out = xml.to_string();

    // Drop `<Pages ...>...</Pages>` or a self-closing `<Pages/>` (first occurrence).
    if let Some(start) = out.find("<Pages") {
        let close_tag = "</Pages>";
        if let Some(close_rel) = out[start..].find(close_tag) {
            out.replace_range(start..start + close_rel + close_tag.len(), "");
        } else if let Some(self_close_rel) = out[start..].find("/>") {
            out.replace_range(start..start + self_close_rel + 2, "");
        }
    }

    // Rewrite `<PageCount>N</PageCount>` in place when present (never inserted when absent).
    if let (Some(open), Some(close)) = (out.find("<PageCount>"), out.find("</PageCount>")) {
        let val_start = open + "<PageCount>".len();
        if close >= val_start && out[val_start..close].trim().chars().all(|c| c.is_ascii_digit()) {
            out.replace_range(val_start..close, &new_page_count.to_string());
        }
    }

    out
}

/// Rewrites a CBZ in place without the named page entries (issue #189, Phase 1: zip-only — RAR/7z
/// cannot be written back and go through conversion instead). Safety posture for a destructive op
/// on a user's library file:
/// * removals are keyed by exact ENTRY NAME (the reader's page list), never by index — a stale
///   list from a since-changed archive aborts instead of deleting the wrong page;
/// * at least one image page must remain (removing every page = deleting the comic — refused);
/// * the new zip is written to a temp file IN THE SAME DIRECTORY, re-opened and its page count
///   verified, and only then atomically renamed over the original — the archive on disk is always
///   either the old file or the fully-verified new one;
/// * untouched entries are raw-copied (no recompression); ComicInfo.xml gets its stale `<Pages>`
///   block dropped and `<PageCount>` corrected.
///
/// Returns the new image-page count.
pub fn remove_pages_from_cbz(path: &Path, entry_names: &[String]) -> Result<usize> {
    if entry_names.is_empty() {
        anyhow::bail!("No pages given to remove.");
    }
    let sig = read_file_signature(path);
    if !is_zip_signature(&sig) {
        anyhow::bail!("Only CBZ archives can be rewritten in place. Convert this file to CBZ first.");
    }

    let file = File::open(path).with_context(|| format!("Failed to open archive: {:?}", path))?;
    let mut archive = zip::ZipArchive::new(file).context("Failed to read archive")?;

    // Verify every requested name against the archive's CURRENT page list — a mismatch means the
    // caller marked pages against an outdated listing (file changed since), which must abort.
    let images = sorted_image_entries(&mut archive);
    let image_set: std::collections::HashSet<&str> = images.iter().map(|s| s.as_str()).collect();
    let missing: Vec<&String> = entry_names.iter().filter(|n| !image_set.contains(n.as_str())).collect();
    if !missing.is_empty() {
        anyhow::bail!(
            "{} of the selected pages no longer exist in this archive (it changed since the pages were listed). Re-open the page view and try again.",
            missing.len()
        );
    }
    let remove_set: std::collections::HashSet<&str> = entry_names.iter().map(|s| s.as_str()).collect();
    let expected_remaining = images.len() - remove_set.len();
    if expected_remaining < 1 {
        anyhow::bail!("Refusing to remove every page — at least one page must remain. Delete the issue instead if that's the intent.");
    }

    // Write the surviving entries to a sibling temp file (same directory ⇒ same filesystem ⇒ the
    // final rename is atomic). Cleaned up on every failure path below.
    let file_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp_path = path.with_file_name(format!(".{}.pages_tmp_{}", file_name, uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let tmp_file = File::create(&tmp_path).context("Failed to create temp archive")?;
        let mut writer = ZipWriter::new(tmp_file);
        let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        for i in 0..archive.len() {
            let name = archive.by_index_raw(i).map(|f| f.name().to_string())?;
            if remove_set.contains(name.as_str()) {
                continue;
            }
            let base = name.rsplit('/').next().unwrap_or(&name).to_ascii_lowercase();
            if base == "comicinfo.xml" {
                // Decompress + adjust + re-store: the page table inside must not survive the shift.
                let mut entry = archive.by_index(i)?;
                let mut xml = String::new();
                use std::io::Read;
                entry.read_to_string(&mut xml).context("Failed to read ComicInfo.xml")?;
                drop(entry);
                let adjusted = strip_comic_info_pages(&xml, expected_remaining);
                writer.start_file(name, options)?;
                use std::io::Write;
                writer.write_all(adjusted.as_bytes())?;
            } else {
                let entry = archive.by_index_raw(i)?;
                writer.raw_copy_file(entry)?;
            }
        }
        writer.finish()?;

        // Trust nothing until the rewritten archive proves itself: it must open and hold exactly
        // the expected number of image pages.
        let check_file = File::open(&tmp_path).context("Failed to re-open rewritten archive")?;
        let mut check = zip::ZipArchive::new(check_file).context("Rewritten archive is unreadable")?;
        let new_count = sorted_image_entries(&mut check).len();
        if new_count != expected_remaining {
            anyhow::bail!(
                "Rewritten archive verification failed (expected {} pages, found {}) — original left untouched.",
                expected_remaining, new_count
            );
        }
        Ok(())
    })();

    if let Err(e) = result {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }

    fs::rename(&tmp_path, path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        anyhow::anyhow!("Failed to swap the rewritten archive into place: {}", e)
    })?;

    Ok(expected_remaining)
}

/// Page removal for ANY natively readable archive (issue #189 Phase 2). CBZ rewrites in place;
/// RAR/7z cannot be written back, so removal there IS a conversion: the surviving entries are
/// repacked into a sibling `.cbz` and the original file is retired. Same safety posture as the
/// CBZ path — name-verified marks, at-least-one-page floor, verify-then-swap, no failure path
/// that damages the original.
///
/// Returns `(final_path, new_page_count)` — `final_path` differs from the input for RAR/7z
/// (extension becomes .cbz) and the caller owns updating any stored file path.
pub fn remove_pages_from_archive(path: &Path, entry_names: &[String]) -> Result<(PathBuf, usize)> {
    if entry_names.is_empty() {
        anyhow::bail!("No pages given to remove.");
    }
    // Entry names come from the archive's own listing, but never trust them as paths: a
    // traversal-shaped name must not be able to touch anything outside the work area.
    if entry_names.iter().any(|n| n.split(['/', '\\']).any(|seg| seg == "..")) {
        anyhow::bail!("Refusing entry names containing traversal segments.");
    }

    let sig = read_file_signature(path);
    if is_zip_signature(&sig) {
        let n = remove_pages_from_cbz(path, entry_names)?;
        return Ok((path.to_path_buf(), n));
    }
    if !is_rar_signature(&sig) && !is_7z_signature(&sig) {
        anyhow::bail!("Unsupported archive format for page removal: {:?}", path.file_name().unwrap_or_default());
    }

    // Shared verification against the archive's CURRENT reader listing (stale marks abort).
    let images = list_image_entries(path)?;
    let image_set: std::collections::HashSet<&str> = images.iter().map(|s| s.as_str()).collect();
    let missing = entry_names.iter().filter(|n| !image_set.contains(n.as_str())).count();
    if missing > 0 {
        anyhow::bail!(
            "{} of the selected pages no longer exist in this archive (it changed since the pages were listed). Re-open the page view and try again.",
            missing
        );
    }
    let remove_set: std::collections::HashSet<&str> = entry_names.iter().map(|s| s.as_str()).collect();
    let expected_remaining = images.len() - remove_set.len();
    if expected_remaining < 1 {
        anyhow::bail!("Refusing to remove every page — at least one page must remain. Delete the issue instead if that's the intent.");
    }

    // The rewritten archive is a CBZ next to the original. Never clobber an existing sibling.
    let final_path = path.with_extension("cbz");
    if final_path != path && final_path.exists() {
        anyhow::bail!(
            "A .cbz with this name already exists next to the original ({:?}) — resolve that first.",
            final_path.file_name().unwrap_or_default()
        );
    }
    let file_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp_path = path.with_file_name(format!(".{}.pages_tmp_{}.cbz", file_name, uuid::Uuid::new_v4()));

    let result = if is_7z_signature(&sig) {
        repack_7z_without_pages(path, &remove_set, expected_remaining, &tmp_path)
    } else {
        repack_rar_without_pages(path, &remove_set, expected_remaining, &tmp_path)
    };
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }

    // Verify the repack before it becomes the real file.
    let verify = (|| -> Result<()> {
        let f = File::open(&tmp_path).context("Failed to re-open rewritten archive")?;
        let mut check = zip::ZipArchive::new(f).context("Rewritten archive is unreadable")?;
        let n = sorted_image_entries(&mut check).len();
        if n != expected_remaining {
            anyhow::bail!("Rewritten archive verification failed (expected {} pages, found {}) — original left untouched.", expected_remaining, n);
        }
        Ok(())
    })();
    if let Err(e) = verify {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }

    fs::rename(&tmp_path, &final_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        anyhow::anyhow!("Failed to move the rewritten archive into place: {}", e)
    })?;
    // The original RAR/7z is retired only after the verified CBZ is in place. A failed delete
    // leaves both files — noisy but safe (the duplicate detector will flag it for cleanup).
    if final_path != path {
        if let Err(e) = fs::remove_file(path) {
            log::warn!("[Converter] Rewrote {:?} as {:?} but could not remove the original: {}", file_name, final_path.file_name().unwrap_or_default(), e);
        }
    }
    Ok((final_path, expected_remaining))
}

/// Real-container check for the sweep's candidate gate: extensions lie, signatures don't.
pub fn is_zip_archive(path: &Path) -> bool {
    is_zip_signature(&read_file_signature(path))
}

/// SHA-256 hex + byte length of ONE entry from any natively readable archive (issue #189
/// Phase 3): the fingerprint of the page an admin wants found across the series.
pub fn hash_archive_entry(path: &Path, entry: &str) -> Result<(String, u64)> {
    use sha2::{Digest, Sha256};
    let sig = read_file_signature(path);
    let bytes: Vec<u8> = if is_zip_signature(&sig) {
        let file = File::open(path).with_context(|| format!("Failed to open archive: {:?}", path))?;
        let mut archive = zip::ZipArchive::new(file).context("Failed to read archive")?;
        let mut f = archive.by_name(entry).map_err(|_| anyhow::anyhow!("Entry {:?} not found in {:?}", entry, path.file_name().unwrap_or_default()))?;
        let mut buf = Vec::new();
        use std::io::Read;
        f.read_to_end(&mut buf)?;
        buf
    } else if is_rar_signature(&sig) {
        rar_entry_bytes(path, entry)?
    } else if is_7z_signature(&sig) {
        sevenz_entry_bytes(path, entry)?
    } else {
        anyhow::bail!("Unsupported archive format: {:?}", path.file_name().unwrap_or_default());
    };
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok((format!("{:x}", hasher.finalize()), bytes.len() as u64))
}

/// Byte-identical page matches inside a CBZ (issue #189 Phase 3, the series sweep's per-file
/// step). The zip central directory carries every entry's UNCOMPRESSED size without touching
/// data, so only size-equal candidates are ever decompressed and hashed — for a typical chapter
/// that is 0–1 entries, which is what makes a 400-file sweep take seconds. Matching is by
/// content only (scan groups rename their credit pages); returned indices are positions in the
/// reader's page order (`sorted_image_entries` parity) so the UI can say "page 3".
pub fn find_matching_pages_in_cbz(path: &Path, target_hash: &str, target_size: u64) -> Result<Vec<(String, usize)>> {
    use sha2::{Digest, Sha256};
    let file = File::open(path).with_context(|| format!("Failed to open archive: {:?}", path))?;
    let mut archive = zip::ZipArchive::new(file).context("Failed to read archive")?;

    // The reader's exact listing (filter + natural order) is the index authority.
    let listed = sorted_image_entries(&mut archive);
    let index_of: std::collections::HashMap<&str, usize> =
        listed.iter().enumerate().map(|(i, n)| (n.as_str(), i)).collect();

    // Central-directory pass: sizes only, no decompression.
    let mut candidates: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let f = archive.by_index_raw(i)?;
        let name = f.name().to_string();
        if f.size() == target_size && index_of.contains_key(name.as_str()) {
            candidates.push(name);
        }
    }

    let mut matches: Vec<(String, usize)> = Vec::new();
    for name in candidates {
        let mut entry = archive.by_name(&name)?;
        let mut buf = Vec::with_capacity(target_size as usize);
        use std::io::Read;
        entry.read_to_end(&mut buf)?;
        drop(entry);
        let mut hasher = Sha256::new();
        hasher.update(&buf);
        if format!("{:x}", hasher.finalize()) == target_hash {
            let idx = *index_of.get(name.as_str()).unwrap_or(&0);
            matches.push((name, idx));
        }
    }
    matches.sort_by_key(|(_, i)| *i);
    Ok(matches)
}

/// 7z → CBZ repack minus the marked pages, streamed entry-by-entry with the pure-Rust decoder
/// (no CLI dependency, unlike conversion's unar path — this keeps removal testable everywhere).
fn repack_7z_without_pages(path: &Path, remove_set: &std::collections::HashSet<&str>, expected_remaining: usize, tmp_path: &Path) -> Result<()> {
    use std::io::Write;
    let archive = sevenz_rust2::Archive::open(path)
        .map_err(|e| anyhow::anyhow!("could not open 7z {:?}: {e}", path.file_name().unwrap_or_default()))?;
    let names: Vec<String> = archive
        .files
        .iter()
        .filter(|f| !f.is_directory() && f.has_stream())
        .map(|f| f.name().to_string())
        .collect();
    let mut reader = sevenz_rust2::ArchiveReader::open(path, sevenz_rust2::Password::empty())
        .map_err(|e| anyhow::anyhow!("could not read 7z {:?}: {e}", path.file_name().unwrap_or_default()))?;

    let tmp_file = File::create(tmp_path).context("Failed to create temp archive")?;
    let mut writer = ZipWriter::new(tmp_file);
    let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for name in names {
        if remove_set.contains(name.as_str()) {
            continue;
        }
        let bytes = reader.read_file(&name)
            .map_err(|e| anyhow::anyhow!("7z produced no bytes for entry {:?}: {e}", name))?;
        let zip_name = name.replace('\\', "/");
        let base = zip_name.rsplit('/').next().unwrap_or(&zip_name).to_ascii_lowercase();
        writer.start_file(zip_name.clone(), options)?;
        if base == "comicinfo.xml" {
            let xml = String::from_utf8_lossy(&bytes).to_string();
            writer.write_all(strip_comic_info_pages(&xml, expected_remaining).as_bytes())?;
        } else {
            writer.write_all(&bytes)?;
        }
    }
    writer.finish()?;
    Ok(())
}

/// RAR → CBZ repack minus the marked pages via one native extraction pass (unrar/unar — the same
/// decoders conversion trusts), then a rezip of everything that survived.
fn repack_rar_without_pages(path: &Path, remove_set: &std::collections::HashSet<&str>, expected_remaining: usize, tmp_path: &Path) -> Result<()> {
    let temp_dir = extraction_temp_base().join(format!("omnibus_pages_{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).context("Failed to create temp directory")?;

    let result = (|| -> Result<()> {
        let extraction = extract_archive_native(path, &temp_dir)?;
        validate_extraction(&extraction, find_images(&temp_dir)?.len())?;

        // Drop the marked pages from the extracted tree. A miss here means the extraction didn't
        // produce what the listing promised — abort rather than repack a wrong set.
        for name in remove_set {
            let victim = temp_dir.join(name);
            fs::remove_file(&victim)
                .with_context(|| format!("Marked page {:?} was not extracted — archive may be damaged", name))?;
        }

        // Adjust any ComicInfo.xml in place before the rezip.
        for entry in jwalk::WalkDir::new(&temp_dir) {
            let entry = entry?;
            let p = entry.path();
            if p.is_file() && p.file_name().map(|n| n.to_string_lossy().eq_ignore_ascii_case("comicinfo.xml")).unwrap_or(false) {
                if let Ok(xml) = fs::read_to_string(&p) {
                    let _ = fs::write(&p, strip_comic_info_pages(&xml, expected_remaining));
                }
            }
        }

        let tmp_file = File::create(tmp_path).context("Failed to create temp archive")?;
        let mut writer = ZipWriter::new(tmp_file);
        let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for entry in jwalk::WalkDir::new(&temp_dir) {
            let entry = entry?;
            let p = entry.path();
            if p.is_file() {
                let name = p.strip_prefix(&temp_dir)?.to_string_lossy().replace('\\', "/");
                writer.start_file(name, options)?;
                let mut f = File::open(&p)?;
                std::io::copy(&mut f, &mut writer)?;
            }
        }
        writer.finish()?;
        Ok(())
    })();

    let _ = fs::remove_dir_all(&temp_dir);
    result
}

/// Ensures `<folder>` has a usable cover. If one already exists (custom upload, a packed cover, or a
/// prior extraction) its path is returned untouched; otherwise the first page of `archive_path` is
/// written to `<folder>/cover.<ext>`. Best-effort — returns None on any failure. Only writes formats
/// the cover route can serve (jpg/png/webp); anything else is skipped.
pub fn ensure_folder_cover(folder: &Path, archive_path: &Path) -> Option<PathBuf> {
    const EXISTING: &[&str] = &[
        "cover.jpg", "cover.jpeg", "cover.png", "cover.webp",
        "folder.jpg", "Cover.jpg", "Cover.png", "folder.png",
    ];
    for pc in EXISTING {
        let p = folder.join(pc);
        if p.exists() { return Some(p); }
    }

    let (bytes, ext) = match extract_first_image(archive_path) {
        Ok(Some(v)) => v,
        Ok(None) => return None,
        Err(e) => {
            log::debug!("[Cover] Extraction failed for {:?}: {}", archive_path.file_name().unwrap_or_default(), e);
            return None;
        }
    };

    let dest = match ext.as_str() {
        "jpg" | "jpeg" => folder.join("cover.jpg"),
        "png" => folder.join("cover.png"),
        "webp" => folder.join("cover.webp"),
        other => {
            log::debug!("[Cover] First page is .{} (unservable) in {:?}; skipping.", other, archive_path.file_name().unwrap_or_default());
            return None;
        }
    };

    match std::fs::write(&dest, &bytes) {
        Ok(_) => {
            log::info!("[Cover] Extracted archive cover for {:?}", folder.file_name().unwrap_or_default());
            Some(dest)
        }
        Err(e) => {
            log::debug!("[Cover] Failed to write {:?}: {}", dest, e);
            None
        }
    }
}

/// The lowest natural-sorted comic archive directly inside `folder` (epub is skipped — its cover lives
/// in OPF metadata, not as a page). Used to pick which file a series cover is pulled from.
pub fn first_comic_file(folder: &Path) -> Option<PathBuf> {
    let mut comics: Vec<PathBuf> = Vec::new();
    if let Ok(rd) = fs::read_dir(folder) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if matches!(ext.to_lowercase().as_str(), "cbz" | "cbr" | "zip" | "rar" | "cb7") {
                        comics.push(path);
                    }
                }
            }
        }
    }
    comics.sort_by(|a, b| natural_cmp(&a.to_string_lossy(), &b.to_string_lossy()));
    comics.into_iter().next()
}

// ============================================================================
// Nested-pack handling (importer offload)
//
// Batch downloads frequently arrive as one ZIP containing many comic archives.
// The Node importer used AdmZip for both the detection count and the extraction,
// which loads the entire pack (often multi-GB) into the Node heap. These helpers
// stream from the file instead and keep the work off the Node event loop.
// ============================================================================

/// `Rar!` archive signature.
fn is_rar_signature(sig: &[u8]) -> bool {
    sig.len() >= 4 && sig[..4] == [0x52, 0x61, 0x72, 0x21]
}

/// Comic archives nested inside a batch pack (non-directory entries with a comic extension) —
/// the importer's batch-payload detection (parity with importer.ts COMIC_EXT_REGEX filter).
/// Dispatches on the file SIGNATURE, not the extension: zip/cbz reads the central directory via
/// the zip crate; a RAR pack (the dominant Usenet/scene container — issue #174) lists via `unrar lb`.
pub fn list_nested_archives(archive_path: &Path) -> Result<Vec<String>> {
    if is_rar_signature(&read_file_signature(archive_path)) {
        let out = Command::new("unrar")
            .args(["lb", "-p-"])
            .arg(archive_path)
            .output()
            .context("unrar unavailable for RAR pack listing")?;
        return Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && is_comic_name(l))
            .map(str::to_string)
            .collect());
    }

    let mut archive = zip::ZipArchive::new(File::open(archive_path)?)?;
    let mut found = Vec::new();
    for i in 0..archive.len() {
        if let Ok(e) = archive.by_index(i) {
            if !e.is_dir() && is_comic_name(e.name()) {
                found.push(e.name().to_string());
            }
        }
    }
    Ok(found)
}

/// The true comic extension for a file signature: `Rar!` → cbr, `PK` zip header → cbz.
fn magic_true_ext(sig: &[u8]) -> Option<&'static str> {
    if sig.len() >= 4 && sig == [0x52, 0x61, 0x72, 0x21] { return Some(".cbr"); }
    if sig.len() >= 4 && sig[..4] == [0x50, 0x4B, 0x03, 0x04] { return Some(".cbz"); }
    None
}

/// Whether a fake extension should be corrected — only flips between the zip and rar families,
/// never touches anything else (parity with importer.ts fixMagicNumberSync).
fn should_fix_ext(current_ext: &str, true_ext: &str) -> bool {
    ((current_ext == ".cbz" || current_ext == ".zip") && true_ext == ".cbr")
        || ((current_ext == ".cbr" || current_ext == ".rar") && true_ext == ".cbz")
}

/// Renames `path` to match its magic-byte container format when the extension lies
/// (parity with importer.ts fixMagicNumberSync). Best-effort: any failure returns the path unchanged.
fn fix_magic_extension(path: &Path) -> PathBuf {
    let mut sig = [0u8; 4];
    let read = File::open(path).and_then(|mut f| f.read(&mut sig));
    let n = match read { Ok(n) => n, Err(_) => return path.to_path_buf() };
    let true_ext = match magic_true_ext(&sig[..n]) { Some(e) => e, None => return path.to_path_buf() };
    let current_ext = format!(".{}", path.extension().unwrap_or_default().to_string_lossy().to_lowercase());
    if !should_fix_ext(&current_ext, true_ext) {
        return path.to_path_buf();
    }
    let corrected = path.with_extension(&true_ext[1..]);
    log::info!("[Importer] Detected fake extension ({} -> {}) on {:?}! Renaming to match true signature...",
        current_ext, true_ext, path.file_name().unwrap_or_default());
    match fs::rename(path, &corrected) {
        Ok(_) => corrected,
        Err(_) => path.to_path_buf(),
    }
}

/// Extracts every nested comic archive out of a batch pack into `dest_dir`. Mirrors the importer's
/// routing rules: flatten to the entry's basename, timestamp-prefix on name collision, then
/// magic-fix the extension. Returns the final on-disk paths. Zip packs stream entry-by-entry
/// (never holding the pack in memory); RAR packs (issue #174) unrar into a temp dir and move the
/// nested comics across.
pub fn extract_nested_archives(archive_path: &Path, dest_dir: &Path) -> Result<Vec<PathBuf>> {
    if is_rar_signature(&read_file_signature(archive_path)) {
        return extract_nested_archives_rar(archive_path, dest_dir);
    }
    fs::create_dir_all(dest_dir)?;
    let mut archive = zip::ZipArchive::new(File::open(archive_path)?)?;
    let mut written = Vec::new();
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.is_dir() || !is_comic_name(entry.name()) { continue; }
        let name = entry.name().to_string();
        let file_name = name.rsplit(['/', '\\']).next().unwrap_or(&name).to_string();
        let mut dest = dest_dir.join(&file_name);
        if dest.exists() {
            let millis = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            dest = dest_dir.join(format!("{}_{}", millis, file_name));
        }
        log::debug!("[Importer] Extracting nested archive from ZIP to Watched: {}", file_name);
        let mut out = File::create(&dest)?;
        std::io::copy(&mut entry, &mut out)?;
        drop(out);
        written.push(fix_magic_extension(&dest));
    }
    Ok(written)
}

/// RAR branch of extract_nested_archives (issue #174): unrar the whole pack into a temp dir, then
/// move each nested comic into `dest_dir` with the same flatten/collision/magic-fix rules as the
/// zip path. Success is judged by what landed on disk, never the unrar exit code (vintage RAR 2.0
/// archives exit non-zero on benign quirks — see extract_archive_native).
fn extract_nested_archives_rar(archive_path: &Path, dest_dir: &Path) -> Result<Vec<PathBuf>> {
    fs::create_dir_all(dest_dir)?;
    // Big packs belong on the cache mount, not the container's tmpfs; fall back to the system temp
    // dir when the cache base isn't writable (e.g. dev machines running the test suite).
    let temp_base = {
        let base = extraction_temp_base();
        if fs::create_dir_all(&base).is_ok() { base } else { std::env::temp_dir() }
    };
    let temp = temp_base.join(format!("omnibus_pack_{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&temp)?;

    let run = Command::new("unrar")
        .args(["x", "-y", "-o+", "-p-", "-idq"])
        .arg(archive_path)
        .arg(format!("{}{}", temp.display(), std::path::MAIN_SEPARATOR))
        .output();
    if let Err(e) = run {
        let _ = fs::remove_dir_all(&temp);
        anyhow::bail!("unrar unavailable for RAR pack extraction: {}", e);
    }

    let mut comics: Vec<PathBuf> = Vec::new();
    collect_comic_files(&temp, &mut comics);
    comics.sort();

    let mut written = Vec::new();
    for src in comics {
        let file_name = src.file_name().unwrap_or_default().to_string_lossy().to_string();
        if file_name.is_empty() { continue; }
        let mut dest = dest_dir.join(&file_name);
        if dest.exists() {
            let millis = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            dest = dest_dir.join(format!("{}_{}", millis, file_name));
        }
        log::debug!("[Importer] Extracting nested archive from RAR to Watched: {}", file_name);
        // rename fails across filesystems (temp base vs watched mount) → copy+delete fallback.
        if fs::rename(&src, &dest).is_err() {
            if fs::copy(&src, &dest).is_err() { continue; }
            let _ = fs::remove_file(&src);
        }
        written.push(fix_magic_extension(&dest));
    }
    let _ = fs::remove_dir_all(&temp);

    if written.is_empty() {
        anyhow::bail!("no nested comic archives could be extracted from the RAR pack");
    }
    Ok(written)
}

/// Recursively gathers every comic-extension file under `dir` (unrar preserves the pack's folder
/// structure in the temp extraction; the watched folder wants a flat list).
fn collect_comic_files(dir: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                collect_comic_files(&p, out);
            } else if is_comic_name(&p.to_string_lossy()) {
                out.push(p);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    // ==== Issue #189: page removal (rewrite-minus-entries) ====

    /// Writes a real CBZ on disk: pages 1..4 (dummy bytes — the remover keys on names), a
    /// ComicInfo.xml with a stale <Pages> table + PageCount, and a non-page passenger entry.
    fn make_pages_cbz(dir: &Path) -> PathBuf {
        use std::io::Write;
        let path = dir.join("pages_fixture.cbz");
        let f = File::create(&path).unwrap();
        let mut zw = ZipWriter::new(f);
        let opts: FileOptions = FileOptions::default();
        zw.start_file("ComicInfo.xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><ComicInfo><Series>Test</Series><PageCount>4</PageCount><Pages><Page Image=\"0\" Type=\"FrontCover\" /><Page Image=\"1\" /></Pages><Notes>keep me</Notes></ComicInfo>").unwrap();
        zw.start_file("notes.txt", opts).unwrap();
        zw.write_all(b"passenger entry").unwrap();
        for n in 1..=4 {
            zw.start_file(format!("page{}.jpg", n), opts).unwrap();
            zw.write_all(format!("fake image bytes {}", n).as_bytes()).unwrap();
        }
        zw.finish().unwrap();
        path
    }

    fn scratch_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("omnibus_pages_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn strip_comic_info_pages_drops_pages_table_and_fixes_count() {
        let xml = "<ComicInfo><PageCount>4</PageCount><Pages><Page Image=\"0\" /></Pages><Notes>x</Notes></ComicInfo>";
        let out = strip_comic_info_pages(xml, 2);
        assert!(!out.contains("<Pages"), "Pages table must be dropped: {}", out);
        assert!(out.contains("<PageCount>2</PageCount>"), "PageCount must be rewritten: {}", out);
        assert!(out.contains("<Notes>x</Notes>"), "unrelated content preserved: {}", out);

        // Self-closing Pages, and no PageCount tag at all — nothing invented.
        let out2 = strip_comic_info_pages("<ComicInfo><Pages/><Series>S</Series></ComicInfo>", 3);
        assert!(!out2.contains("<Pages"));
        assert!(!out2.contains("PageCount"));

        // A non-numeric PageCount is left alone rather than corrupted.
        let out3 = strip_comic_info_pages("<ComicInfo><PageCount>abc</PageCount></ComicInfo>", 3);
        assert!(out3.contains("<PageCount>abc</PageCount>"));
    }

    #[test]
    fn remove_pages_rewrites_cbz_and_adjusts_comicinfo() {
        use std::io::Read;
        let dir = scratch_dir();
        let cbz = make_pages_cbz(&dir);

        let removed = remove_pages_from_cbz(&cbz, &["page1.jpg".to_string(), "page3.jpg".to_string()]).unwrap();
        assert_eq!(removed, 2, "returns the new page count");

        let mut archive = zip::ZipArchive::new(File::open(&cbz).unwrap()).unwrap();
        let names: Vec<String> = (0..archive.len()).map(|i| archive.by_index(i).unwrap().name().to_string()).collect();
        assert!(names.contains(&"page2.jpg".to_string()) && names.contains(&"page4.jpg".to_string()));
        assert!(!names.contains(&"page1.jpg".to_string()) && !names.contains(&"page3.jpg".to_string()));
        assert!(names.contains(&"notes.txt".to_string()), "non-page passengers survive");

        let mut xml = String::new();
        archive.by_name("ComicInfo.xml").unwrap().read_to_string(&mut xml).unwrap();
        assert!(!xml.contains("<Pages"), "stale page table dropped: {}", xml);
        assert!(xml.contains("<PageCount>2</PageCount>"), "PageCount corrected: {}", xml);
        assert!(xml.contains("<Notes>keep me</Notes>"));

        // No temp litter left behind.
        let litter: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("pages_tmp")).collect();
        assert!(litter.is_empty(), "temp file must not remain");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_pages_aborts_on_stale_entry_names_leaving_original_untouched() {
        let dir = scratch_dir();
        let cbz = make_pages_cbz(&dir);
        let before = fs::read(&cbz).unwrap();

        let err = remove_pages_from_cbz(&cbz, &["page1.jpg".to_string(), "ghost.jpg".to_string()]).unwrap_err();
        assert!(err.to_string().contains("no longer exist"), "stale-list abort: {}", err);
        assert_eq!(fs::read(&cbz).unwrap(), before, "original archive byte-identical after abort");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_pages_refuses_removing_every_page() {
        let dir = scratch_dir();
        let cbz = make_pages_cbz(&dir);
        let all: Vec<String> = (1..=4).map(|n| format!("page{}.jpg", n)).collect();
        let err = remove_pages_from_cbz(&cbz, &all).unwrap_err();
        assert!(err.to_string().contains("at least one page"), "{}", err);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_pages_rejects_non_zip_archives() {
        use std::io::Write;
        let dir = scratch_dir();
        let fake_rar = dir.join("not_a_zip.cbr");
        let mut f = File::create(&fake_rar).unwrap();
        f.write_all(b"Rar!\x1a\x07\x00 definitely not a zip").unwrap();
        drop(f);
        let err = remove_pages_from_cbz(&fake_rar, &["page1.jpg".to_string()]).unwrap_err();
        assert!(err.to_string().contains("CBZ"), "{}", err);
        let _ = fs::remove_dir_all(&dir);
    }

    // ==== Issue #189 Phase 2: RAR/7z removal = repack as CBZ ====

    #[test]
    fn remove_pages_from_cb7_repacks_as_cbz_and_retires_original() {
        // Pure-Rust 7z path — runs everywhere (no unar needed, unlike conversion).
        let dir = scratch_dir();
        let cb7 = dir.join("pages_probe.cb7");
        fs::copy(reader_sevenz_fixture(), &cb7).unwrap();

        let (final_path, remaining) = remove_pages_from_archive(&cb7, &["02.png".to_string()]).unwrap();
        assert_eq!(final_path, dir.join("pages_probe.cbz"), "rewritten as a sibling CBZ");
        assert_eq!(remaining, 2);
        assert!(!cb7.exists(), "original .cb7 retired after the verified repack");

        let mut archive = zip::ZipArchive::new(File::open(&final_path).unwrap()).unwrap();
        let pages = sorted_image_entries(&mut archive);
        assert_eq!(pages, vec!["01.png", "10.png"], "marked page gone, order preserved");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_pages_from_cb7_stale_name_aborts_untouched() {
        let dir = scratch_dir();
        let cb7 = dir.join("stale_probe.cb7");
        fs::copy(reader_sevenz_fixture(), &cb7).unwrap();
        let before = fs::read(&cb7).unwrap();

        let err = remove_pages_from_archive(&cb7, &["ghost.png".to_string()]).unwrap_err();
        assert!(err.to_string().contains("no longer exist"), "{}", err);
        assert_eq!(fs::read(&cb7).unwrap(), before, "original byte-identical after abort");
        assert!(!dir.join("stale_probe.cbz").exists(), "no cbz appears on abort");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_pages_from_cb7_refuses_clobbering_an_existing_cbz_sibling() {
        let dir = scratch_dir();
        let cb7 = dir.join("collide.cb7");
        fs::copy(reader_sevenz_fixture(), &cb7).unwrap();
        fs::write(dir.join("collide.cbz"), b"already here").unwrap();

        let err = remove_pages_from_archive(&cb7, &["02.png".to_string()]).unwrap_err();
        assert!(err.to_string().contains("already exists"), "{}", err);
        assert!(cb7.exists(), "original untouched");
        assert_eq!(fs::read(dir.join("collide.cbz")).unwrap(), b"already here", "sibling not clobbered");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_pages_from_archive_rejects_traversal_entry_names() {
        let dir = scratch_dir();
        let cb7 = dir.join("traversal.cb7");
        fs::copy(reader_sevenz_fixture(), &cb7).unwrap();
        let err = remove_pages_from_archive(&cb7, &["../escape.png".to_string()]).unwrap_err();
        assert!(err.to_string().contains("traversal"), "{}", err);
        let _ = fs::remove_dir_all(&dir);
    }

    // ==== Issue #189 Phase 3: series sweep scan (hash + size-prefiltered matching) ====

    /// A zip holding `entries`: (name, bytes). Returns its path inside `dir`.
    fn make_zip(dir: &Path, file_name: &str, entries: &[(&str, &[u8])]) -> PathBuf {
        use std::io::Write;
        let path = dir.join(file_name);
        let f = File::create(&path).unwrap();
        let mut zw = ZipWriter::new(f);
        let opts: FileOptions = FileOptions::default();
        for (name, bytes) in entries {
            zw.start_file(*name, opts).unwrap();
            zw.write_all(bytes).unwrap();
        }
        zw.finish().unwrap();
        path
    }

    #[test]
    fn find_matching_pages_matches_by_content_not_name_with_reader_indices() {
        let dir = scratch_dir();
        let credit: &[u8] = b"scan group credit page bytes";
        let source = make_zip(&dir, "src.cbz", &[("credit.jpg", credit), ("page1.jpg", b"story page one")]);
        let (hash, size) = hash_archive_entry(&source, "credit.jpg").unwrap();

        // Candidate: identical bytes under a DIFFERENT name, sorted after two story pages —
        // reader index must be 2. A same-size decoy must NOT match (hash discriminates).
        let cand = make_zip(&dir, "ch2.cbz", &[
            ("01.jpg", b"chapter two page one"),
            ("02.jpg", b"chapter two page two!!!!!!!!"), // same length as credit, different bytes
            ("zz_credits.jpg", credit),
            ("ComicInfo.xml", b"<ComicInfo/>"),
        ]);
        assert_eq!(cand, dir.join("ch2.cbz"));
        let matches = find_matching_pages_in_cbz(&cand, &hash, size).unwrap();
        assert_eq!(matches, vec![("zz_credits.jpg".to_string(), 2)]);

        // A candidate with no identical page yields nothing.
        let clean = make_zip(&dir, "ch3.cbz", &[("01.jpg", b"different content entirely")]);
        assert!(find_matching_pages_in_cbz(&clean, &hash, size).unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hash_archive_entry_reads_zip_and_7z_sources() {
        let dir = scratch_dir();
        let source = make_zip(&dir, "src.cbz", &[("credit.jpg", b"the page")]);
        let (zip_hash, zip_size) = hash_archive_entry(&source, "credit.jpg").unwrap();
        assert_eq!(zip_size, 8);
        assert_eq!(zip_hash.len(), 64, "sha256 hex");
        assert!(hash_archive_entry(&source, "nope.jpg").is_err());

        // 7z source (the reader fixture) — the sweep's source page may live in any format.
        let (h7, s7) = hash_archive_entry(&reader_sevenz_fixture(), "01.png").unwrap();
        assert_eq!(h7.len(), 64);
        assert!(s7 > 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_zip_archive_judges_by_signature_not_extension() {
        use std::io::Write;
        let dir = scratch_dir();
        // A "cbr" that is really a zip (the classic lying extension) IS sweepable.
        let lying = make_zip(&dir, "lying.cbr", &[("01.jpg", b"x")]);
        assert!(is_zip_archive(&lying));
        // A real RAR signature is not.
        let real_rar = dir.join("real.cbr");
        let mut f = File::create(&real_rar).unwrap();
        f.write_all(b"Rar!\x1a\x07\x00").unwrap();
        drop(f);
        assert!(!is_zip_archive(&real_rar));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_pages_from_rar_repacks_as_cbz() {
        if !unrar_available() { eprintln!("skipping: unrar not on PATH"); return; }
        // OMNIBUS_CACHE_DIR steers extraction temp; default /config/cache doesn't exist on dev boxes.
        std::env::set_var("OMNIBUS_CACHE_DIR", std::env::temp_dir());

        let dir = scratch_dir();
        let cbr = dir.join("pages_probe.cbr");
        fs::copy(reader_rar_fixture(), &cbr).unwrap();

        let (final_path, remaining) = remove_pages_from_archive(&cbr, &["10.png".to_string()]).unwrap();
        assert_eq!(final_path, dir.join("pages_probe.cbz"));
        assert_eq!(remaining, 2);
        assert!(!cbr.exists(), "original .cbr retired");

        let mut archive = zip::ZipArchive::new(File::open(&final_path).unwrap()).unwrap();
        assert_eq!(sorted_image_entries(&mut archive), vec!["01.png", "02.png"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn first_image_in_listing_picks_first_natural_page_and_skips_junk() {
        // Out of order, with a non-image, macOS junk, and an AppleDouble sidecar mixed in.
        let listing = "page10.jpg\nComicInfo.xml\npage2.jpg\n__MACOSX/page1.jpg\n._page1.jpg\npage1.jpg\n";
        // Natural sort puts page1 before page2 before page10; junk/non-images are filtered out.
        assert_eq!(first_image_in_listing(listing).as_deref(), Some("page1.jpg"));

        // CRLF line endings (unrar on Windows) are trimmed.
        assert_eq!(first_image_in_listing("b.png\r\na.png\r\n").as_deref(), Some("a.png"));

        // No image pages → None (caller returns "no cover" rather than falling back).
        assert_eq!(first_image_in_listing("ComicInfo.xml\nnotes.txt\n"), None);
        assert_eq!(first_image_in_listing(""), None);
    }

    #[test]
    fn extract_page_webp_resolves_entry_and_encodes() {
        use std::io::{Cursor, Write};
        // Build an in-memory cbz: a junk entry + a 2000x100 page.
        let mut zip_buf: Vec<u8> = Vec::new();
        {
            let mut zw = ZipWriter::new(Cursor::new(&mut zip_buf));
            let opts: FileOptions = FileOptions::default();
            let img = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(2000, 100, image::Rgb([200, 10, 10])));
            let mut png: Vec<u8> = Vec::new();
            img.write_to(&mut Cursor::new(&mut png), image::ImageOutputFormat::Png).unwrap();
            zw.start_file("ComicInfo.xml", opts).unwrap();
            zw.write_all(b"<ComicInfo/>").unwrap();
            zw.start_file("page1.png", opts).unwrap();
            zw.write_all(&png).unwrap();
            zw.finish().unwrap();
        }

        let is_webp = |b: &[u8]| b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP";

        // Exact name → valid WebP.
        let out = extract_page_webp_from_reader(Cursor::new(&zip_buf), "page1.png", 1600, 80.0).unwrap().unwrap();
        assert!(is_webp(&out), "expected a WebP payload");

        // Basename fallback (a path prefix that isn't a real entry still resolves by file name).
        let out2 = extract_page_webp_from_reader(Cursor::new(&zip_buf), "some/dir/page1.png", 1600, 80.0).unwrap();
        assert!(out2.is_some());

        // Unknown entry → None (not an error).
        let out3 = extract_page_webp_from_reader(Cursor::new(&zip_buf), "nope.png", 1600, 80.0).unwrap();
        assert!(out3.is_none());
    }

    #[test]
    fn extract_page_index_webp_sorts_filters_and_bounds_like_the_opds_route() {
        use std::io::{Cursor, Write};
        // Pages written out of order, plus macOS junk, a directory entry, and a non-image —
        // exactly the noise the Node OPDS route filters before indexing.
        let mut png1: Vec<u8> = Vec::new();
        DynamicImage::ImageRgb8(image::RgbImage::from_pixel(2000, 100, image::Rgb([10, 200, 10])))
            .write_to(&mut Cursor::new(&mut png1), image::ImageOutputFormat::Png).unwrap();
        let mut png2: Vec<u8> = Vec::new();
        DynamicImage::ImageRgb8(image::RgbImage::from_pixel(50, 50, image::Rgb([10, 10, 200])))
            .write_to(&mut Cursor::new(&mut png2), image::ImageOutputFormat::Png).unwrap();

        let mut zip_buf: Vec<u8> = Vec::new();
        {
            let mut zw = ZipWriter::new(Cursor::new(&mut zip_buf));
            let opts: FileOptions = FileOptions::default();
            zw.start_file("page10.png", opts).unwrap();
            zw.write_all(&png2).unwrap();
            zw.start_file("ComicInfo.xml", opts).unwrap();
            zw.write_all(b"<ComicInfo/>").unwrap();
            zw.start_file("__MACOSX/page0.png", opts).unwrap();
            zw.write_all(&png2).unwrap();
            zw.add_directory("scans/", opts).unwrap();
            zw.start_file("page2.png", opts).unwrap();
            zw.write_all(&png1).unwrap();
            zw.finish().unwrap();
        }

        // Natural order after filtering: [page2.png, page10.png].
        let mut archive = zip::ZipArchive::new(Cursor::new(&zip_buf)).unwrap();
        assert_eq!(sorted_image_entries(&mut archive), vec!["page2.png", "page10.png"]);

        let is_webp = |b: &[u8]| b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP";

        // Index 0 → page2 (the 2000px one), resized down to 1600 wide.
        let out = extract_page_index_webp_from_reader(Cursor::new(&zip_buf), 0, 1600, 80.0).unwrap().unwrap();
        assert!(is_webp(&out), "expected a WebP payload");

        // Index 1 → page10 (50px, under max_width so never enlarged).
        let out1 = extract_page_index_webp_from_reader(Cursor::new(&zip_buf), 1, 1600, 80.0).unwrap().unwrap();
        assert!(is_webp(&out1));
        assert!(out1.len() < out.len(), "the 50px page should encode smaller than the 1600px page");

        // Out of bounds → None (the route serves 404, matching the Node bounds check).
        assert!(extract_page_index_webp_from_reader(Cursor::new(&zip_buf), 2, 1600, 80.0).unwrap().is_none());
    }

    #[test]
    fn count_zip_pages_counts_filtered_images_only() {
        use std::io::{Cursor, Write};
        let mut zip_buf: Vec<u8> = Vec::new();
        {
            let mut zw = ZipWriter::new(Cursor::new(&mut zip_buf));
            let opts: FileOptions = FileOptions::default();
            zw.start_file("page1.jpg", opts).unwrap();
            zw.write_all(b"a").unwrap();
            zw.start_file("sub/page2.PNG", opts).unwrap();
            zw.write_all(b"b").unwrap();
            zw.start_file("ComicInfo.xml", opts).unwrap();
            zw.write_all(b"<ComicInfo/>").unwrap();
            zw.start_file("__MACOSX/page1.jpg", opts).unwrap();
            zw.write_all(b"junk").unwrap();
            zw.add_directory("scans/", opts).unwrap();
            zw.finish().unwrap();
        }
        let work = std::env::temp_dir().join(format!("omnibus_count_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&work).unwrap();
        let cbz = work.join("book.cbz");
        fs::write(&cbz, &zip_buf).unwrap();

        assert_eq!(count_zip_pages(&cbz), Some(2));

        // Not a zip → None (unknown), never a misleading 0.
        let rar = work.join("book.cbr");
        fs::write(&rar, b"Rar!\x1a\x07\x00junk").unwrap();
        assert_eq!(count_zip_pages(&rar), None);
        assert_eq!(count_zip_pages(&work.join("missing.cbz")), None);

        fs::remove_dir_all(&work).unwrap();
    }

    #[test]
    fn magic_fix_decisions_match_the_node_importer() {
        // Signature detection: Rar! → .cbr, PK zip header → .cbz, anything else → no opinion.
        assert_eq!(magic_true_ext(&[0x52, 0x61, 0x72, 0x21]), Some(".cbr"));
        assert_eq!(magic_true_ext(&[0x50, 0x4B, 0x03, 0x04]), Some(".cbz"));
        assert_eq!(magic_true_ext(&[0x50, 0x4B]), None); // too short
        assert_eq!(magic_true_ext(b"\x89PNG"), None);

        // Rename only flips between the zip and rar families.
        assert!(should_fix_ext(".cbz", ".cbr"));
        assert!(should_fix_ext(".zip", ".cbr"));
        assert!(should_fix_ext(".cbr", ".cbz"));
        assert!(should_fix_ext(".rar", ".cbz"));
        assert!(!should_fix_ext(".cbz", ".cbz")); // already correct
        assert!(!should_fix_ext(".epub", ".cbz")); // outside both families
        assert!(!should_fix_ext(".cb7", ".cbz"));
    }

    #[test]
    fn nested_archives_are_listed_and_extracted_with_flatten_collision_and_magic_fix() {
        use std::io::{Cursor, Write};

        // A minimal real zip to use as the nested archives' content (so magic-fix sees "PK").
        let mut inner_zip: Vec<u8> = Vec::new();
        {
            let mut zw = ZipWriter::new(Cursor::new(&mut inner_zip));
            let opts: FileOptions = FileOptions::default();
            zw.start_file("page1.jpg", opts).unwrap();
            zw.write_all(b"fake image bytes").unwrap();
            zw.finish().unwrap();
        }

        // The batch pack: two nested comics (one under a folder, one with a lying .cbr extension),
        // plus junk the importer must ignore (a directory, a loose image, an nfo).
        let mut pack: Vec<u8> = Vec::new();
        {
            let mut zw = ZipWriter::new(Cursor::new(&mut pack));
            let opts: FileOptions = FileOptions::default();
            zw.add_directory("scans/", opts).unwrap();
            zw.start_file("pack/Inner One.cbz", opts).unwrap();
            zw.write_all(&inner_zip).unwrap();
            zw.start_file("Disguised.cbr", opts).unwrap(); // PK bytes → should become .cbz on disk
            zw.write_all(&inner_zip).unwrap();
            zw.start_file("cover.jpg", opts).unwrap();
            zw.write_all(b"not an archive").unwrap();
            zw.start_file("release.nfo", opts).unwrap();
            zw.write_all(b"junk").unwrap();
            zw.finish().unwrap();
        }

        let work = std::env::temp_dir().join(format!("omnibus_nested_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&work).unwrap();
        let pack_path = work.join("batch.zip");
        fs::write(&pack_path, &pack).unwrap();
        let dest = work.join("watched");

        // Listing: exactly the two nested comics, junk filtered.
        let listed = list_nested_archives(&pack_path).unwrap();
        assert_eq!(listed, vec!["pack/Inner One.cbz", "Disguised.cbr"]);

        // Pre-create a collision for the flattened first entry.
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("Inner One.cbz"), b"pre-existing").unwrap();

        let written = extract_nested_archives(&pack_path, &dest).unwrap();
        assert_eq!(written.len(), 2);

        // Collision → timestamp-prefixed name, original untouched; content is the real nested bytes.
        let first_name = written[0].file_name().unwrap().to_string_lossy().to_string();
        assert!(first_name.ends_with("_Inner One.cbz") , "expected a prefixed collision name, got {}", first_name);
        assert_eq!(fs::read(dest.join("Inner One.cbz")).unwrap(), b"pre-existing");
        assert_eq!(fs::read(&written[0]).unwrap(), inner_zip);

        // The lying .cbr (PK bytes) was renamed to .cbz by the magic fix.
        assert_eq!(written[1].file_name().unwrap().to_string_lossy(), "Disguised.cbz");
        assert!(written[1].exists());
        assert!(!dest.join("Disguised.cbr").exists());

        fs::remove_dir_all(&work).unwrap();
    }

    // ==== Issue #174: RAR packs (the common Usenet/scene container) must be batch-split like ZIPs.
    // Fixture: tests/fixtures/nested_pack.cbr — a real RAR holding "Comic A 001.cbz",
    // "sub/Comic B 002.cbz" (nested folder → tests flattening), "Comic C 003.cbr" (ZIP bytes in
    // disguise → tests the magic fix), and "notes.txt" junk. Skips when unrar isn't on PATH
    // (CI installs it; the Docker image ships it).

    fn unrar_available() -> bool {
        Command::new("unrar").arg("-?").output().is_ok()
    }

    fn rar_fixture() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/nested_pack.cbr")
    }

    #[test]
    fn rar_pack_nested_archives_are_listed() {
        if !unrar_available() { eprintln!("skipping: unrar not on PATH"); return; }

        let listed = list_nested_archives(&rar_fixture()).unwrap();
        assert_eq!(listed.len(), 3, "expected the 3 nested comics, got {:?}", listed);
        assert!(listed.iter().any(|n| n.ends_with("Comic A 001.cbz")), "{:?}", listed);
        // unrar lists nested paths with the platform separator — accept either.
        assert!(listed.iter().any(|n| n.ends_with("Comic B 002.cbz")), "{:?}", listed);
        assert!(listed.iter().any(|n| n.ends_with("Comic C 003.cbr")), "{:?}", listed);
        assert!(listed.iter().all(|n| !n.contains("notes.txt")), "junk must be filtered: {:?}", listed);
    }

    // ==== Native RAR page reading: the reader/OPDS paths must list, count, and extract pages from
    // an unconverted .cbr. Fixture: tests/fixtures/reader_pages.cbr — a real RAR holding three real
    // 1x1 PNGs named 01.png / 02.png / 10.png (10 sorting after 2 proves natural order). Skips when
    // unrar isn't on PATH (CI installs it; the Docker image ships it).

    fn reader_rar_fixture() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/reader_pages.cbr")
    }

    #[test]
    fn rar_pages_list_and_count_in_natural_order() {
        if !unrar_available() { eprintln!("skipping: unrar not on PATH"); return; }

        let pages = list_image_entries(&reader_rar_fixture()).unwrap();
        assert_eq!(pages, vec!["01.png", "02.png", "10.png"]);
        assert_eq!(count_archive_pages(&reader_rar_fixture()), Some(3));

        // The ComicInfo fixture carries metadata alongside its single page — non-image entries
        // must not count as pages (an inflated pse:count would break OPDS-PSE clients).
        let with_xml = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/comicinfo_pack.cbr");
        assert_eq!(count_archive_pages(&with_xml), Some(1));
    }

    #[test]
    fn rar_page_extraction_by_index_and_entry() {
        if !unrar_available() { eprintln!("skipping: unrar not on PATH"); return; }

        // OPDS-PSE index addressing: natural-sort position 2 = "10.png".
        let by_index = extract_page_index_webp(&reader_rar_fixture(), 2, 100, 80.0).unwrap();
        let bytes = by_index.expect("page index 2 must resolve");
        assert_eq!(&bytes[..4], b"RIFF", "reader pages are WebP-encoded");

        // Web-reader entry addressing.
        assert!(extract_page_webp(&reader_rar_fixture(), "02.png", 100, 80.0).unwrap().is_some());

        // Misses map to None (the Node routes turn that into a 404, not a 500).
        assert!(extract_page_index_webp(&reader_rar_fixture(), 99, 100, 80.0).unwrap().is_none());
        assert!(extract_page_webp(&reader_rar_fixture(), "nope.png", 100, 80.0).unwrap().is_none());
    }

    // ==== Native 7z (.cb7) page reading — the .cb7 twins of the RAR fixtures, same entry contents
    // (built by tests/fixtures/make_cb7_fixtures.py). NO skip guard: sevenz-rust2 is pure Rust, so
    // these run in CI and locally without any external binary — unlike the unrar-gated RAR tests.

    fn reader_sevenz_fixture() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/reader_pages.cb7")
    }

    #[test]
    fn sevenz_pages_list_and_count_in_natural_order() {
        let pages = list_image_entries(&reader_sevenz_fixture()).unwrap();
        assert_eq!(pages, vec!["01.png", "02.png", "10.png"]);
        assert_eq!(count_archive_pages(&reader_sevenz_fixture()), Some(3));

        // Non-image entries (ComicInfo.xml) must not inflate pse:count.
        let with_xml = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/comicinfo_pack.cb7");
        assert_eq!(count_archive_pages(&with_xml), Some(1));
    }

    #[test]
    fn sevenz_page_extraction_by_index_and_entry() {
        // OPDS-PSE index addressing: natural-sort position 2 = "10.png".
        let by_index = extract_page_index_webp(&reader_sevenz_fixture(), 2, 100, 80.0).unwrap();
        let bytes = by_index.expect("page index 2 must resolve");
        assert_eq!(&bytes[..4], b"RIFF", "reader pages are WebP-encoded");

        // Web-reader entry addressing.
        assert!(extract_page_webp(&reader_sevenz_fixture(), "02.png", 100, 80.0).unwrap().is_some());

        // Misses map to None (the Node routes turn that into a 404, not a 500).
        assert!(extract_page_index_webp(&reader_sevenz_fixture(), 99, 100, 80.0).unwrap().is_none());
        assert!(extract_page_webp(&reader_sevenz_fixture(), "nope.png", 100, 80.0).unwrap().is_none());
    }

    #[test]
    fn sevenz_signature_is_distinct_from_zip_and_rar() {
        assert!(is_7z_signature(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C, 0x00, 0x04]));
        assert!(!is_7z_signature(&[0x50, 0x4B, 0x03, 0x04])); // PK (zip)
        assert!(!is_7z_signature(&[0x52, 0x61, 0x72, 0x21])); // Rar!
        assert!(!is_7z_signature(&[0x37, 0x7A])); // too short to decide
    }

    #[test]
    fn rar_pack_nested_archives_extract_flatten_and_magic_fix() {
        if !unrar_available() { eprintln!("skipping: unrar not on PATH"); return; }

        let work = std::env::temp_dir().join(format!("omnibus_rar_nested_{}", uuid::Uuid::new_v4()));
        let dest = work.join("watched");

        let written = extract_nested_archives(&rar_fixture(), &dest).unwrap();
        assert_eq!(written.len(), 3, "expected 3 extracted comics, got {:?}", written);

        // Flattened out of the RAR's sub/ folder, straight into dest.
        assert!(dest.join("Comic A 001.cbz").exists());
        assert!(dest.join("Comic B 002.cbz").exists());
        // The lying .cbr (ZIP bytes) was renamed to .cbz by the magic fix.
        assert!(dest.join("Comic C 003.cbz").exists());
        assert!(!dest.join("Comic C 003.cbr").exists());
        // Junk never lands in the watched folder.
        assert!(!dest.join("notes.txt").exists());

        // Each extracted comic is a readable zip with its page intact.
        let bytes = fs::read(dest.join("Comic B 002.cbz")).unwrap();
        assert!(is_zip_signature(&bytes[..4.min(bytes.len())]));

        fs::remove_dir_all(&work).unwrap();
    }

    #[test]
    fn natural_cmp_orders_pages_numerically() {
        assert_eq!(natural_cmp("page2.jpg", "page10.jpg"), Ordering::Less);
        assert_eq!(natural_cmp("page10.jpg", "page2.jpg"), Ordering::Greater);
        assert_eq!(natural_cmp("page01.jpg", "page1.jpg"), Ordering::Equal); // 01 == 1
        assert_eq!(natural_cmp("A.jpg", "a.jpg"), Ordering::Equal); // case-insensitive
        assert_eq!(natural_cmp("cover.jpg", "page1.jpg"), Ordering::Less); // c < p

        let mut v = vec!["page10.jpg", "page2.jpg", "page1.jpg"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["page1.jpg", "page2.jpg", "page10.jpg"]);
    }

    #[test]
    fn zip_signature_detects_pk_header() {
        assert!(is_zip_signature(&[0x50, 0x4B, 0x03, 0x04]));
        assert!(is_zip_signature(&[0x50, 0x4B])); // 2 bytes are enough
        assert!(!is_zip_signature(&[0x52, 0x61, 0x72, 0x21])); // "Rar!"
        assert!(!is_zip_signature(&[0x50])); // too short
        assert!(!is_zip_signature(&[]));
    }

    #[test]
    fn image_listing_counts_only_image_lines() {
        // unrar lb output: bare entry names, one per line.
        let listing = "cover.jpg\npage_001.JPG\npage_002.png\nComicInfo.xml\nsubdir/page_003.webp\nnotes.txt\n";
        assert_eq!(count_image_lines(listing), 4);
        assert_eq!(count_image_lines(""), 0);
        assert_eq!(count_image_lines("ComicInfo.xml\nreadme.nfo"), 0);
    }

    #[test]
    fn extraction_validation_judges_page_count_not_exit_code() {
        // A non-zero unrar exit with all pages present is a SUCCESS (salvage behavior).
        let quirky = NativeExtraction {
            expected_pages: Some(36),
            unrar_exit_detail: Some("missing end-of-archive block".to_string()),
        };
        assert!(validate_extraction(&quirky, 36).is_ok());
        // Missing pages fail with the salvaged detail.
        let err = validate_extraction(&quirky, 20).unwrap_err().to_string();
        assert!(err.contains("20 of 36"));
        assert!(err.contains("missing end-of-archive block"));
        // No listing (unar/zip path) -> nothing to validate.
        let unar = NativeExtraction { expected_pages: None, unrar_exit_detail: None };
        assert!(validate_extraction(&unar, 0).is_ok());
    }

    #[test]
    fn extract_first_image_picks_first_page_and_skips_comicinfo() {
        let dir = std::env::temp_dir().join(format!("omnibus_cov_first_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("test.cbz");
        {
            let f = File::create(&zip_path).unwrap();
            let mut zw = ZipWriter::new(f);
            let opt = FileOptions::default().compression_method(zip::CompressionMethod::Stored);
            // Intentionally out of natural order + a ComicInfo.xml that must be ignored.
            zw.start_file("page10.jpg", opt).unwrap(); zw.write_all(b"TEN").unwrap();
            zw.start_file("ComicInfo.xml", opt).unwrap(); zw.write_all(b"<x/>").unwrap();
            zw.start_file("page2.jpg", opt).unwrap(); zw.write_all(b"TWO").unwrap();
            zw.start_file("page1.jpg", opt).unwrap(); zw.write_all(b"ONE").unwrap();
            zw.finish().unwrap();
        }
        let (bytes, ext) = extract_first_image(&zip_path).unwrap().expect("an image page");
        assert_eq!(ext, "jpg");
        assert_eq!(bytes, b"ONE"); // page1 wins via natural sort
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_folder_cover_keeps_an_existing_cover() {
        let dir = std::env::temp_dir().join(format!("omnibus_cov_skip_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("cover.jpg"), b"existing").unwrap();
        // A bogus archive path must not even be opened, because a cover already exists.
        let got = ensure_folder_cover(&dir, Path::new("does_not_exist.cbz"));
        assert_eq!(got, Some(dir.join("cover.jpg")));
        assert_eq!(fs::read(dir.join("cover.jpg")).unwrap(), b"existing");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn first_comic_file_picks_lowest_and_ignores_noncomics() {
        let dir = std::env::temp_dir().join(format!("omnibus_first_comic_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("Series 010.cbz"), b"").unwrap();
        fs::write(dir.join("Series 002.cbz"), b"").unwrap();
        fs::write(dir.join("cover.jpg"), b"").unwrap(); // not a comic
        fs::write(dir.join("notes.txt"), b"").unwrap();
        let got = first_comic_file(&dir).unwrap();
        assert_eq!(got.file_name().unwrap().to_string_lossy(), "Series 002.cbz");
        let _ = fs::remove_dir_all(&dir);
    }
}