use anyhow::{Context, Result};
use image::DynamicImage;
use rayon::prelude::*;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use sqlx::{PgPool, Row};
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

/// Reads the leading magic bytes of a file; returns an empty vec on any failure.
fn read_file_signature(path: &Path) -> Vec<u8> {
    let mut buf = [0u8; 4];
    match File::open(path).and_then(|mut f| f.read(&mut buf)) {
        Ok(n) => buf[..n].to_vec(),
        Err(_) => Vec::new(),
    }
}

/// "PK" ZIP local-file-header signature.
fn is_zip_signature(sig: &[u8]) -> bool {
    sig.len() >= 2 && sig[0] == 0x50 && sig[1] == 0x4B
}

/// Image formats considered valid pages (parity with Node IMAGE_EXT_REGEX).
fn is_image_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"].iter().any(|e| lower.ends_with(e))
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

/// Fast, native function to extract a CBR/RAR/CB7 and repack it directly to CBZ (ZIP) without re-encoding images.
pub fn convert_cbr_to_cbz(cbr_path: &Path) -> Result<PathBuf> {
    if !cbr_path.exists() {
        anyhow::bail!("File does not exist: {:?}", cbr_path);
    }

    let cbz_path = cbr_path.with_extension("cbz");
    // 1. Check for a specific Omnibus cache dir, fallback to OS temp dir if not found
    let temp_dir_base = std::env::var("OMNIBUS_CACHE_DIR")
        .or_else(|_| std::env::var("CACHE_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());

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
pub async fn get_webp_settings(db: &PgPool) -> (bool, f32) {
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
pub async fn process_cbr_sweep(db: PgPool, issue_id: Option<String>) -> anyhow::Result<(i32, i32, String)> {
    let issues = if let Some(id) = &issue_id {
        sqlx::query(r#"SELECT id, "filePath" FROM "Issue" WHERE id = $1 AND "filePath" IS NOT NULL"#)
            .bind(id)
            .fetch_all(&db)
            .await?
    } else {
        sqlx::query(
            r#"SELECT id, "filePath" FROM "Issue"
               WHERE "filePath" ILIKE '%.cbr' OR "filePath" ILIKE '%.rar' OR "filePath" ILIKE '%.cb7'"#
        ).fetch_all(&db).await?
    };

    if issues.is_empty() {
        let msg = match &issue_id {
            Some(id) => format!("Targeted issue {} not found or already converted.", id),
            None => "No CBR files found to convert.".to_string(),
        };
        return Ok((0, 0, msg));
    }

    // Honor the user's WebP settings (the sweep previously did a raw RAR→ZIP repack, ignoring them).
    let (convert_to_webp, webp_quality) = get_webp_settings(&db).await;
    log::info!("[Converter] CBR sweep starting for {} files. WebP: {} (quality {}).", issues.len(), convert_to_webp, webp_quality);

    // Bound concurrency to the core count so a large library can't exhaust the blocking pool / thrash disk.
    let cfg = crate::engine_config::EngineConfig::load(&db).await;
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
                // The file is already converted on disk; if the DB update fails the record would point at a
                // deleted .cbr, so surface it rather than silently counting a success.
                if let Err(e) = sqlx::query(r#"UPDATE "Issue" SET "filePath" = $1 WHERE id = $2"#)
                    .bind(&new_path)
                    .bind(&issue_id)
                    .execute(&db).await
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

    // 1. Create a unique temporary directory
    // 1. Check for a specific Omnibus cache dir, fallback to OS temp dir if not found
    let temp_dir_base = std::env::var("OMNIBUS_CACHE_DIR")
        .or_else(|_| std::env::var("CACHE_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
        
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

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
}