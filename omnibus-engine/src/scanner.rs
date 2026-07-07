use crate::db::Db;
use jwalk::WalkDir;
use sqlx::Row;
use std::collections::{HashSet, HashMap};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use regex::Regex;
use serde::Deserialize;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use uuid::Uuid;
use zip::ZipArchive;

// ============================================================================
// ComicInfo.xml parsing (parity with src/lib/metadata-extractor.ts parseComicInfo)
// ============================================================================

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct ScanComicInfo {
    series: Option<String>,
    publisher: Option<String>,
    volume: Option<String>,
    year: Option<String>,
    manga: Option<String>,
    web: Option<String>,
    series_group: Option<String>,
    comic_vine_volume_id: Option<String>,
    comic_vine_issue_id: Option<String>,
    metron_id: Option<String>,
    metron_issue_id: Option<String>,
}

struct DerivedMeta {
    cv_id: Option<i32>,
    metron_id: Option<i32>,
    /// Raw issue ids, kept so the dynamic issue→volume resolution can tell WHICH provider the
    /// file carries evidence for (parity with parseComicInfo's cvIssueId/metronIssueId locals).
    cv_issue_id: Option<i32>,
    metron_issue_id: Option<i32>,
    /// String form of (metronId || cvId) — goes into the metadataId column.
    metadata_id: Option<String>,
    /// String form of (metronIssueId || cvIssueId).
    metadata_issue_id: Option<String>,
    metadata_source: String,
    is_manga: bool,
    parsed_year: Option<i32>,
}

impl DerivedMeta {
    /// Recompute the resolved source + series id after dynamic resolution filled in cv_id/metron_id
    /// (parity with parseComicInfo's resolvedMetaSource/resolvedMetaId, which run AFTER step 3).
    fn recompute_resolved(&mut self) {
        self.metadata_source = if self.metron_id.is_some() || self.metron_issue_id.is_some() {
            "METRON"
        } else if self.cv_id.is_some() || self.cv_issue_id.is_some() {
            "COMICVINE"
        } else {
            "LOCAL"
        }
        .to_string();
        self.metadata_id = self.metron_id.or(self.cv_id).map(|v| v.to_string());
    }
}

fn parse_i32(s: &str) -> Option<i32> {
    s.trim().parse::<i32>().ok()
}

fn capture_i32(re: &Regex, haystack: &str) -> Option<i32> {
    re.captures(haystack)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<i32>().ok())
}

fn web_re_cv_vol() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)(?:comicvine\.gamespot\.com|comicvine\.com)/.*/4050-(\d+)").unwrap())
}
fn web_re_cv_issue() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)(?:comicvine\.gamespot\.com|comicvine\.com)/.*/4000-(\d+)").unwrap())
}
fn web_re_metron_series() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)metron\.cloud/series/(\d+)").unwrap())
}
fn web_re_metron_issue() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)metron\.cloud/issue/(\d+)").unwrap())
}

/// Off-thread page count for an on-disk archive; 0 when unreadable (a real RAR stays 0 until CBZ
/// conversion counts it, matching the Node importer's zip-only counting).
async fn count_pages_blocking(file: &str) -> i32 {
    let f = file.to_string();
    tokio::task::spawn_blocking(move || crate::converter::count_zip_pages(Path::new(&f)))
        .await
        .ok()
        .flatten()
        .unwrap_or(0)
}

/// Reads ComicInfo.xml out of a CBZ/ZIP. RAR/CBR is not a zip, so it returns None
/// (matches Node's AdmZip, which also can't read ComicInfo from a real RAR).
fn parse_comic_info(path: &Path) -> Option<ScanComicInfo> {
    let file = File::open(path).ok()?;
    let mut archive = ZipArchive::new(file).ok()?;

    for i in 0..archive.len() {
        if let Ok(mut entry) = archive.by_index(i) {
            if entry.name().eq_ignore_ascii_case("comicinfo.xml") {
                let mut xml = String::new();
                if entry.read_to_string(&mut xml).is_ok() {
                    // Sanitize bare ampersands without breaking real entities (parity with metadata-extractor.ts:34).
                    let xml = sanitize_xml_ampersands(&xml);
                    return quick_xml::de::from_str(&xml).ok();
                }
            }
        }
    }
    None
}

/// Replaces `&` that is not the start of a valid XML entity with `&amp;`.
pub(crate) fn sanitize_xml_ampersands(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for (idx, c) in input.char_indices() {
        if c == '&' {
            let rest = &input[idx..];
            let valid = rest.starts_with("&amp;")
                || rest.starts_with("&lt;")
                || rest.starts_with("&gt;")
                || rest.starts_with("&quot;")
                || rest.starts_with("&apos;")
                || is_numeric_entity(rest);
            if valid {
                out.push('&');
            } else {
                out.push_str("&amp;");
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// True if `s` (which starts with '&') is a numeric entity like `&#123;` or `&#xAF;`.
fn is_numeric_entity(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() < 4 || bytes[1] != b'#' {
        return false;
    }
    let hex = bytes[2] == b'x' || bytes[2] == b'X';
    let start = if hex { 3 } else { 2 };
    let mut i = start;
    while i < bytes.len() {
        let b = bytes[i];
        let ok = if hex { b.is_ascii_hexdigit() } else { b.is_ascii_digit() };
        if ok {
            i += 1;
        } else {
            break;
        }
    }
    i > start && i < bytes.len() && bytes[i] == b';'
}

fn derive_meta(info: &ScanComicInfo) -> DerivedMeta {
    let mut cv_id = info.comic_vine_volume_id.as_deref().and_then(parse_i32);
    let mut cv_issue_id = info.comic_vine_issue_id.as_deref().and_then(parse_i32);
    let mut metron_id = info.metron_id.as_deref().and_then(parse_i32);
    let mut metron_issue_id = info.metron_issue_id.as_deref().and_then(parse_i32);

    if let Some(web) = &info.web {
        if cv_id.is_none() {
            cv_id = capture_i32(web_re_cv_vol(), web);
        }
        if cv_issue_id.is_none() {
            cv_issue_id = capture_i32(web_re_cv_issue(), web);
        }
        if metron_id.is_none() {
            metron_id = capture_i32(web_re_metron_series(), web);
        }
        if metron_issue_id.is_none() {
            metron_issue_id = capture_i32(web_re_metron_issue(), web);
        }
    }

    let metadata_source = if metron_id.is_some() || metron_issue_id.is_some() {
        "METRON"
    } else if cv_id.is_some() || cv_issue_id.is_some() {
        "COMICVINE"
    } else {
        "LOCAL"
    }
    .to_string();

    let metadata_id = metron_id.or(cv_id).map(|v| v.to_string());
    let metadata_issue_id = metron_issue_id.or(cv_issue_id).map(|v| v.to_string());
    let is_manga = matches!(info.manga.as_deref(), Some("Yes") | Some("YesAndRightToLeft"));

    // ComicInfo <Volume> usually holds the start year; fall back to <Year> (parity with parseComicInfo).
    let parsed_year = info
        .volume
        .as_deref()
        .and_then(parse_i32)
        .filter(|y| *y != 0)
        .or_else(|| info.year.as_deref().and_then(parse_i32).filter(|y| *y != 0));

    DerivedMeta { cv_id, metron_id, cv_issue_id, metron_issue_id, metadata_id, metadata_issue_id, metadata_source, is_manga, parsed_year }
}

// ============================================================================
// Dynamic issue→volume/series ID resolution (parity with parseComicInfo step 3)
//
// Many tagged files carry ONLY an issue id (ComicVineIssueId, or a /4000- Web URL). Node resolves
// the owning volume id live — CV `issue/4000-{id}?field_list=volume`, or a Metron series-name
// search — so the series lands MATCHED instead of UNMATCHED. A 24h in-memory cache (keyed by
// provider + series + year, same as Node's volumeResolutionCache) prevents API hammering during
// mass scans.
// ============================================================================

fn resolution_cache() -> &'static tokio::sync::Mutex<HashMap<String, (i32, std::time::Instant)>> {
    static CACHE: OnceLock<tokio::sync::Mutex<HashMap<String, (i32, std::time::Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

const RESOLUTION_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

async fn resolution_cache_get(key: &str) -> Option<i32> {
    let cache = resolution_cache().lock().await;
    cache.get(key).filter(|(_, at)| at.elapsed() < RESOLUTION_CACHE_TTL).map(|(v, _)| *v)
}

async fn resolution_cache_set(key: String, value: i32) {
    resolution_cache().lock().await.insert(key, (value, std::time::Instant::now()));
}

/// Provider API bases, overridable for tests (a mock server) — production always uses the defaults.
fn cv_base_url() -> String {
    std::env::var("OMNIBUS_CV_BASE_URL").unwrap_or_else(|_| "https://comicvine.gamespot.com".to_string())
}
fn metron_base_url() -> String {
    std::env::var("OMNIBUS_METRON_BASE_URL").unwrap_or_else(|_| "https://metron.cloud".to_string())
}

/// Metron series-search result selection (parity with parseComicInfo): exact name match with a
/// ≤1-year variance when both years are known → first plain name match → first result.
fn pick_metron_series(results: &[serde_json::Value], series_name: &str, parsed_year: Option<i32>) -> Option<i32> {
    let name_of = |s: &serde_json::Value| -> Option<String> {
        s.get("name").or_else(|| s.get("series")).and_then(|v| v.as_str()).map(|v| v.to_lowercase())
    };
    let target = series_name.to_lowercase();
    let exact = results.iter().find(|s| {
        let name_match = name_of(s).as_deref() == Some(target.as_str());
        let year_began = s.get("year_began").and_then(|y| y.as_i64().or_else(|| y.as_str().and_then(|v| v.parse().ok())));
        match (parsed_year, year_began) {
            (Some(py), Some(yb)) => name_match && (yb as i32 - py).abs() <= 1,
            _ => name_match,
        }
    });
    let fallback = results.iter().find(|s| name_of(s).as_deref() == Some(target.as_str()));
    let chosen = exact.or(fallback).or_else(|| results.first())?;
    chosen
        .get("id")
        .and_then(|v| v.as_i64().map(|i| i as i32).or_else(|| v.as_str().and_then(|s| s.parse().ok())))
}

/// Fill in a missing volume/series id when the file only carries an issue id, then recompute the
/// resolved source + metadata id. Best-effort: any API/credential failure leaves the meta as-is
/// (the series stays UNMATCHED, exactly like Node's catch branches).
async fn resolve_dynamic_ids(db: &Db, client: &reqwest::Client, d: &mut DerivedMeta, series_name: Option<&str>) {
    let cache_tail = format!(
        "{}_{}",
        series_name.unwrap_or(""),
        d.parsed_year.map(|y| y.to_string()).unwrap_or_else(|| "unknown".to_string())
    );

    if d.cv_id.is_none() && d.cv_issue_id.is_some() {
        let cv_key = format!("CV:{}", cache_tail);
        if series_name.is_some() {
            if let Some(cached) = resolution_cache_get(&cv_key).await {
                d.cv_id = Some(cached);
                d.recompute_resolved();
                return;
            }
        }
        let api_key: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'cv_api_key'"#)
            .fetch_optional(&db.pool).await.ok().flatten();
        let api_key = crate::secret_crypto::decrypt_setting_any(&db.pool, api_key).await;
        if let Some(api_key) = api_key.filter(|k| !k.is_empty()) {
            let issue_id = d.cv_issue_id.unwrap();
            let url = format!("{}/api/issue/4000-{}/", cv_base_url(), issue_id);
            let resp = client
                .get(&url)
                .query(&[("api_key", api_key.as_str()), ("format", "json"), ("field_list", "volume")])
                .header("User-Agent", "Omnibus/1.0")
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await;
            match resp {
                Ok(r) if r.status().is_success() => {
                    if let Ok(body) = r.json::<serde_json::Value>().await {
                        let vol_id = body.pointer("/results/volume/id").and_then(|v| v.as_i64()).map(|v| v as i32);
                        if let Some(vol_id) = vol_id {
                            log::info!("[Scanner] Resolved CV Volume ID {} from Issue ID {}.", vol_id, issue_id);
                            d.cv_id = Some(vol_id);
                            if series_name.is_some() {
                                resolution_cache_set(cv_key, vol_id).await;
                            }
                        }
                    }
                }
                _ => log::warn!("[Scanner] Failed to resolve Volume ID from Issue ID: {}", issue_id),
            }
        }
    } else if d.metron_id.is_none() && d.metron_issue_id.is_some() && series_name.is_some() {
        let series_name = series_name.unwrap();
        let metron_key = format!("METRON:{}", cache_tail);
        if let Some(cached) = resolution_cache_get(&metron_key).await {
            d.metron_id = Some(cached);
            d.recompute_resolved();
            return;
        }
        if let Some(auth) = crate::metadata::metron_auth_any(&db.pool).await {
            let url = format!("{}/api/series/?name={}", metron_base_url(), urlencoding::encode(series_name));
            let resp = client
                .get(&url)
                .basic_auth(&auth.0, Some(&auth.1))
                .header("User-Agent", "Omnibus/1.0")
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await;
            match resp {
                Ok(r) if r.status().is_success() => {
                    if let Ok(body) = r.json::<serde_json::Value>().await {
                        let results = body.get("results").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                        if let Some(id) = pick_metron_series(&results, series_name, d.parsed_year) {
                            log::info!("[Scanner] Resolved Metron Series ID {} from Series Name search (Year Checked: {}).", id, d.parsed_year.map(|y| y.to_string()).unwrap_or_else(|| "None".to_string()));
                            d.metron_id = Some(id);
                            resolution_cache_set(metron_key, id).await;
                        }
                    }
                }
                _ => log::warn!("[Scanner] Failed to dynamically resolve Metron Series ID for: {}", series_name),
            }
        }
    }

    d.recompute_resolved();
}

// ============================================================================
// Issue number extraction (parity with library-scanner.ts extractIssueNumber)
// ============================================================================

/// Strips leading zeros while keeping at least one digit — equivalent to JS `replace(/^0+(?=\d)/, '')`.
fn strip_leading_zeros(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i] == b'0' {
        i += 1;
    }
    if i == 0 {
        s.to_string()
    } else if i < bytes.len() && bytes[i].is_ascii_digit() {
        s[i..].to_string()
    } else {
        // Next char is '.' or end → keep a single leading zero (e.g. "0" -> "0", "00.5" -> "0.5").
        format!("0{}", &s[i..])
    }
}

// Parity with Node src/lib/utils/issue-parser.ts extractIssueNumber (negative-number aware).
// The Node regexes use lookbehind/lookahead, which the `regex` crate doesn't support; those
// boundary conditions are emulated with manual byte checks at the match positions.
fn issue_number_from_filename(file_name: &str) -> String {
    static RE_BRACKET: OnceLock<Regex> = OnceLock::new();
    static RE_CROSSREF: OnceLock<Regex> = OnceLock::new();
    static RE_CROSSREF_KEEP: OnceLock<Regex> = OnceLock::new();
    static RE_NEGATIVE: OnceLock<Regex> = OnceLock::new();
    static RE_ISSUE: OnceLock<Regex> = OnceLock::new();
    static RE_VOL: OnceLock<Regex> = OnceLock::new();
    static RE_NUM: OnceLock<Regex> = OnceLock::new();

    let re_bracket = RE_BRACKET
        .get_or_init(|| Regex::new(r"\[\d{4}(?:-\d{4})?\]|\(\d{4}(?:-\d{4})?\)").unwrap());
    // Bracketed cross-references containing letters + digits, e.g. "(of 12)" / "[Annual 2]".
    let re_crossref = RE_CROSSREF.get_or_init(|| {
        Regex::new(r"[\[(][^\[\]()]*[a-zA-Z]+[^\[\]()]*\d+[^\[\]()]*[\])]").unwrap()
    });
    let re_crossref_keep =
        RE_CROSSREF_KEEP.get_or_init(|| Regex::new(r"(?i)#|issue|ch(?:apter)?|vol(?:ume)?|v\s*\.").unwrap());
    // GUARDED NEGATIVE: the sign must follow an explicit marker ("#-1", "Issue -1", "Vol -2") so
    // title separators ("Title - 001") never become negative issues.
    let re_negative = RE_NEGATIVE.get_or_init(|| {
        Regex::new(r"(?i)(?:#\s*-|issue\s+#?-|issue\s+-|ch(?:apter)?\s+-|vol(?:ume)?\s+-|v\s*-)\s*0*(\d+(?:\.\d+)?[a-zA-Z]?)")
            .unwrap()
    });
    let re_issue = RE_ISSUE.get_or_init(|| {
        Regex::new(r"(?i)(?:#|issue\s*#?|ch(?:apter)?\.?)\s*0*(\d+(?:\.\d+)?[a-zA-Z]?)").unwrap()
    });
    let re_vol = RE_VOL.get_or_init(|| {
        Regex::new(r"(?i)(?:vol(?:ume)?\s*\.?|v\s*\.?)\s*0*(\d+(?:\.\d+)?[a-zA-Z]?)").unwrap()
    });
    let re_num = RE_NUM.get_or_init(|| Regex::new(r"\d+(?:\.\d+)?[a-zA-Z]?").unwrap());

    // 1. Strip a trailing extension.
    let mut clean = file_name.to_string();
    if let Some(dot) = clean.rfind('.') {
        let ext = &clean[dot + 1..];
        if !ext.is_empty() && ext.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            clean = clean[..dot].to_string();
        }
    }
    // 2. Strip bracketed/parenthesized 4-digit years (or year ranges) so they're not mistaken for issues.
    let clean = re_bracket.replace_all(&clean, "").to_string();
    // 3. Smartly strip cross-references, keeping blocks that carry an explicit issue/vol marker.
    let clean = re_crossref
        .replace_all(&clean, |caps: &regex::Captures| {
            if re_crossref_keep.is_match(&caps[0]) { caps[0].to_string() } else { String::new() }
        })
        .to_string();

    // 4. HIGHEST PRIORITY: explicit negative marker.
    if let Some(caps) = re_negative.captures(&clean) {
        return format!("-{}", strip_leading_zeros(&caps[1]));
    }

    // 5. Explicit issue marker (#, "issue", "chapter"). The "issue"/"ch" tokens must not be glued
    // to a preceding letter (Node's `(?<=^|[^a-zA-Z])` lookbehind).
    let bytes = clean.as_bytes();
    for caps in re_issue.captures_iter(&clean) {
        let m0 = caps.get(0).unwrap();
        let starts_with_hash = clean[m0.start()..].starts_with('#');
        if !starts_with_hash && m0.start() > 0 && bytes[m0.start() - 1].is_ascii_alphabetic() {
            continue;
        }
        return strip_leading_zeros(&caps[1]);
    }

    // 6. Temporarily hide Volume tokens (recording the first volume number as a tertiary fallback).
    // Emulates Node's `(?<=^|[^a-zA-Z])(?:vol...|v...)\s*0*(\d{1,3}...)(?!\d)`.
    let mut volume_num: Option<String> = None;
    let mut no_vol = String::new();
    let mut last_end = 0;
    for caps in re_vol.captures_iter(&clean) {
        let m0 = caps.get(0).unwrap();
        let g1 = caps.get(1).unwrap();
        let prev_alpha = m0.start() > 0 && bytes[m0.start() - 1].is_ascii_alphabetic();
        let next_digit = m0.end() < bytes.len() && bytes[m0.end()].is_ascii_digit();
        let int_len = g1.as_str().chars().take_while(|c| c.is_ascii_digit()).count();
        if prev_alpha || next_digit || int_len == 0 || int_len > 3 {
            // Not a valid volume token — keep the text as-is.
            no_vol.push_str(&clean[last_end..m0.end()]);
            last_end = m0.end();
            continue;
        }
        if volume_num.is_none() {
            volume_num = Some(strip_leading_zeros(g1.as_str()));
        }
        no_vol.push_str(&clean[last_end..m0.start()]);
        last_end = m0.end();
    }
    no_vol.push_str(&clean[last_end..]);

    // 7. SECONDARY PRIORITY: bare numbers — scan in REVERSE and skip 4-digit years. Negative signs
    // are intentionally NOT captured here so "Title - 001" parses as positive.
    let nv_bytes = no_vol.as_bytes();
    let mut candidates: Vec<&str> = Vec::new();
    for m in re_num.find_iter(&no_vol) {
        let prev_ok = m.start() == 0 || !nv_bytes[m.start() - 1].is_ascii_alphanumeric();
        let next_ok = m.end() == nv_bytes.len() || !nv_bytes[m.end()].is_ascii_alphanumeric();
        if prev_ok && next_ok {
            candidates.push(m.as_str());
        }
    }
    for cand in candidates.iter().rev() {
        let stripped = strip_leading_zeros(cand);
        let has_alpha = stripped.chars().any(|c| c.is_ascii_alphabetic());
        if let Ok(num_val) = stripped.parse::<f64>() {
            if (1900.0..=2099.0).contains(&num_val) && !has_alpha {
                continue; // looks like a year, not an issue number
            }
        }
        return stripped;
    }

    // 8. TERTIARY PRIORITY: the volume number.
    if let Some(v) = volume_num {
        return v;
    }
    "1".to_string()
}

fn trailing_year_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\s\(\d{4}\)$").unwrap())
}
fn any_year_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\((\d{4})\)").unwrap())
}

// ============================================================================
// Main scan
// ============================================================================

pub async fn scan_library(db: Db, library_path: String, library_id: String, specific_path: Option<String>) -> anyhow::Result<()> {
    log::info!("Starting fast parallel scan of: {}", library_path);
    let start_time = std::time::Instant::now();

    // ---------------------------------------------------------
    // 0. DRIVE-DISCONNECTED GUARD
    // If this library's path is unreachable, abort BEFORE any ghost cleanup so an
    // unmounted drive can never wipe its records. (Parity with library-scanner.ts:60-65.)
    // ---------------------------------------------------------
    if !Path::new(&library_path).exists() {
        log::error!("[Scan] Drive disconnected: {}", library_path);
        anyhow::bail!("Drive disconnected: {}", library_path);
    }

    // TARGETED DIRECTORY DISPATCHING (beta.024): a specific path scans only that subtree and
    // skips the global DB cleanup routines below — parity with library-scanner.ts scan(specificPath).
    let scan_root: String = match &specific_path {
        Some(sp) => {
            let p = Path::new(sp);
            let target = if p.is_file() {
                p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_else(|| sp.clone())
            } else {
                sp.clone()
            };
            if !Path::new(&target).exists() {
                anyhow::bail!("Targeted scan path does not exist: {}", target);
            }
            log::info!("[Scan] Starting targeted library scan for: {}", target);
            target
        }
        None => library_path.clone(),
    };

    // Read the library's manga flag once — used as a baseline for series isManga.
    // Boolean columns are read as CAST(... AS INTEGER): sqlx's Any driver rejects SQLite's
    // BOOLEAN-declared columns outright (SqliteTypeInfo(Bool) has no Any mapping), and the cast is
    // equally valid on Postgres (bool → int4). Any's integer decode converts across widths.
    let lib_is_manga: bool = match sqlx::query(r#"SELECT CAST("isManga" AS INTEGER) AS "isManga" FROM "Library" WHERE id = $1"#)
        .bind(&library_id)
        .fetch_optional(&db.pool)
        .await?
    {
        Some(row) => row.get::<i64, _>("isManga") != 0,
        None => false,
    };

    // PERFORMANCE SAFEGUARD (beta.024): the global ghost purge / ghost-issue sweep only runs on
    // full automation cycles, never during a targeted import scan.
    if specific_path.is_none() {
        // ---------------------------------------------------------
        // 1. GHOST SERIES PURGE (scoped to this library)
        // A series is a ghost if its folder is gone AND it isn't monitored AND no active
        // request references it. (Parity with library-scanner.ts:67-96.)
        // ---------------------------------------------------------
        let active_reqs = sqlx::query(
            r#"SELECT "volumeId" FROM "Request" WHERE status NOT IN ('COMPLETED','IMPORTED','CANCELLED')"#,
        )
        .fetch_all(&db.pool)
        .await?;
        let active_vol_ids: HashSet<String> =
            active_reqs.iter().map(|r| r.get::<String, _>("volumeId")).collect();

        let series_for_ghost = sqlx::query(
            // monitored is CAST for the Any driver (see the isManga note above) and COALESCEd
            // because a NULL expression result decodes as type NULL under Any — the code always
            // treated NULL as false, so folding it in SQL is behavior-preserving.
            r#"SELECT id, "folderPath", COALESCE(CAST(monitored AS INTEGER), 0) AS monitored, "metadataId" FROM "Series" WHERE "libraryId" = $1"#,
        )
        .bind(&library_id)
        .fetch_all(&db.pool)
        .await?;

        // Ghost-series purge with a GRACE WINDOW. A series whose folder is missing is NOT deleted
        // immediately — a transient SMB/network subfolder outage must not destroy read progress and
        // curated metadata (the per-issue delete cascades to ReadProgress). We persist when each series
        // was first seen missing (the scan_missing_series SystemSetting) and only purge after the folder
        // has stayed gone past GRACE_MS. The library-root reachability check above already aborts the whole
        // scan on a full-drive disconnect. (Parity with library-scanner.ts.)
        const GRACE_MS: i64 = 24 * 60 * 60 * 1000; // 24h gone before auto-purge
        let now_ms = chrono::Utc::now().timestamp_millis();

        let miss_raw: Option<String> = sqlx::query_scalar(
            r#"SELECT value FROM "SystemSetting" WHERE key = 'scan_missing_series'"#,
        )
        .fetch_optional(&db.pool)
        .await
        .ok()
        .flatten();
        let miss_state: HashMap<String, i64> =
            miss_raw.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();

        let mut bad_series_ids: Vec<String> = Vec::new();
        let mut next_miss_state: HashMap<String, i64> = HashMap::new();
        for row in series_for_ghost {
            let id: String = row.get("id");
            let folder: String = row.get("folderPath");
            let monitored = row.get::<i64, _>("monitored") != 0;
            let metadata_id: Option<String> = row.get("metadataId");

            if !folder.is_empty() && Path::new(&folder).exists() {
                continue; // folder is present
            }
            if monitored {
                continue; // user is monitoring it for new issues
            }
            if let Some(mid) = &metadata_id {
                if active_vol_ids.contains(mid) {
                    continue; // an active request is tied to it
                }
            }

            let first_missed = miss_state.get(&id).copied().unwrap_or(now_ms); // first time seen gone
            if now_ms - first_missed >= GRACE_MS {
                bad_series_ids.push(id); // gone long enough → purge
            } else {
                next_miss_state.insert(id, first_missed); // still in grace → remember
            }
        }

        // Persist grace counters (recovered + purged series naturally drop out of the map). Best-effort:
        // a failed write just makes series look "freshly missing" next scan and stay un-purged — a safe
        // failure mode (never deletes early), so a counter-write hiccup must not abort the scan.
        let next_miss_json =
            serde_json::to_string(&next_miss_state).unwrap_or_else(|_| "{}".to_string());
        if let Err(e) = sqlx::query(
            r#"INSERT INTO "SystemSetting" (key, value) VALUES ('scan_missing_series', $1)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"#,
        )
        .bind(&next_miss_json)
        .execute(&db.pool)
        .await
        {
            log::warn!("[Scan] Could not persist ghost-series grace counters: {:?}", e);
        }

        if !bad_series_ids.is_empty() {
            // Portable IN (...) list instead of Postgres's `= ANY($1)` array bind — SQLite has no
            // arrays and the Any driver can't bind Vec<T>. Ghost lists are small (per-library).
            let ph = Db::in_placeholders(1, bad_series_ids.len());
            let issues_sql = format!(r#"DELETE FROM "Issue" WHERE "seriesId" IN ({})"#, ph);
            let mut q = sqlx::query(&issues_sql);
            for id in &bad_series_ids {
                q = q.bind(id);
            }
            if let Err(e) = q.execute(&db.pool).await {
                log::error!("[Scan] Failed to delete ghost-series issues: {:?}", e);
            }
            let series_sql = format!(r#"DELETE FROM "Series" WHERE id IN ({})"#, ph);
            let mut q = sqlx::query(&series_sql);
            for id in &bad_series_ids {
                q = q.bind(id);
            }
            if let Err(e) = q.execute(&db.pool).await {
                log::error!("[Scan] Failed to delete ghost series: {:?}", e);
            }
            log::info!("[Scan] Purged {} ghost series records (folder missing > 24h).", bad_series_ids.len());
        }
        let grace_count = next_miss_state.len();
        if grace_count > 0 {
            log::info!("[Scan] {} series folder(s) missing but within the 24h grace window — not purged.", grace_count);
        }

        // ---------------------------------------------------------
        // 2. GHOST ISSUE DETECTION (scoped to this library)
        // ---------------------------------------------------------
        log::debug!("[Scanner Debug] Searching for ghost issues with missing files...");
        let all_issues = sqlx::query(
            r#"SELECT i.id, i."filePath", i."metadataId" FROM "Issue" i
               JOIN "Series" s ON i."seriesId" = s.id
               WHERE i."filePath" IS NOT NULL AND s."libraryId" = $1"#,
        )
        .bind(&library_id)
        .fetch_all(&db.pool)
        .await?;

        let mut ghost_count = 0;
        for row in all_issues {
            let issue_id: String = row.get("id");
            let file_path: String = row.get("filePath");
            let metadata_id: Option<String> = row.get("metadataId");

            if !Path::new(&file_path).exists() {
                log::debug!("[Scanner Debug] Removing ghost file path: {}", file_path);
                if let Some(meta_id) = metadata_id {
                    if !meta_id.starts_with("unmatched") {
                        // It was matched, so keep the record but mark it WANTED.
                        if let Err(e) = sqlx::query(
                            r#"UPDATE "Issue" SET "filePath" = NULL, status = 'WANTED' WHERE id = $1"#,
                        )
                        .bind(&issue_id)
                        .execute(&db.pool)
                        .await
                        {
                            log::error!("[Scanner Debug] Error blanking ghost issue '{}': {:?}", file_path, e);
                        }
                    } else {
                        delete_issue(&db, &issue_id).await;
                    }
                } else {
                    delete_issue(&db, &issue_id).await;
                }
                ghost_count += 1;
            }
        }
        if ghost_count > 0 {
            log::info!("[Scan] Cleared {} ghost issue files.", ghost_count);
        }
    }

    // ---------------------------------------------------------
    // 3. FETCH EXISTING DATA (IN-MEMORY MAPPING)
    // ---------------------------------------------------------
    log::info!("Mapping existing library data into memory...");

    let series_rows = sqlx::query(r#"SELECT id, "folderPath" FROM "Series" WHERE "folderPath" IS NOT NULL"#)
        .fetch_all(&db.pool)
        .await?;
    let mut existing_series: HashMap<String, String> = HashMap::new();
    for row in series_rows {
        let id: String = row.get("id");
        let folder: String = row.get("folderPath");
        existing_series.insert(folder.replace('\\', "/").to_lowercase(), id);
    }

    let issue_rows = sqlx::query(r#"SELECT "filePath" FROM "Issue" WHERE "filePath" IS NOT NULL"#)
        .fetch_all(&db.pool)
        .await?;
    let mut existing_files: HashSet<String> = HashSet::new();
    for row in issue_rows {
        let file: String = row.get("filePath");
        existing_files.insert(file.replace('\\', "/").to_lowercase());
    }

    // ---------------------------------------------------------
    // 4. DISK SCAN
    // Index every comic archive format Omnibus can import (parity with isComicFile, beta.031).
    // ---------------------------------------------------------
    log::info!("Scanning disk for new files...");
    let valid_extensions = ["cbz", "cbr", "zip", "rar", "cb7", "epub"];

    let mut new_folders: HashMap<String, Vec<String>> = HashMap::new();
    let mut new_issues_existing_series: Vec<(String, String)> = Vec::new();

    for dir_entry in WalkDir::new(&scan_root).skip_hidden(true).into_iter().flatten() {
        let path = dir_entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if valid_extensions.contains(&ext.to_lowercase().as_str()) {
                    let file_str = path.to_string_lossy().replace('\\', "/");
                    let file_lower = file_str.to_lowercase();

                    if !existing_files.contains(&file_lower) {
                        if let Some(parent) = path.parent() {
                            let parent_str = parent.to_string_lossy().replace('\\', "/");
                            let parent_lower = parent_str.to_lowercase();

                            if let Some(series_id) = existing_series.get(&parent_lower) {
                                new_issues_existing_series.push((series_id.clone(), file_str));
                            } else {
                                new_folders.entry(parent_str).or_default().push(file_str);
                            }
                        }
                    }
                }
            }
        }
    }

    log::info!(
        "Disk scan found {} new folder(s) and {} new file(s) for existing series.",
        new_folders.len(),
        new_issues_existing_series.len()
    );

    let mut series_inserted = 0;
    let mut issues_inserted = 0;

    // Manga-detection (3rd tier) resources: one HTTP client + the publisher lists, fetched once for the whole scan.
    let http_client = reqwest::Client::new();
    let (manga_pubs, western_pubs) = crate::manga_detector::get_detector_settings_any(&db.pool).await;

    // ---------------------------------------------------------
    // 5A. NEW FOLDERS → new Series + Issues, matched from the first archive's ComicInfo.xml
    // ---------------------------------------------------------
    // Parse each new folder's first-archive ComicInfo in parallel (bounded to CPU count), then insert sequentially.
    let cfg = crate::engine_config::EngineConfig::load_any(&db.pool).await;
    let parse_sem = Arc::new(Semaphore::new(cfg.scan_workers));

    // Series name / year / publisher derivation, shared by the parallel phase (for manga detection) and
    // the insert loop, so the two can't drift.
    fn derive_folder_basics(info: &Option<ScanComicInfo>, folder_name: &str) -> (String, i32, String) {
        let derived = info.as_ref().map(derive_meta);
        let clean_name = info.as_ref().and_then(|i| i.series.clone()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                let stripped = trailing_year_re().replace(folder_name, "").trim().to_string();
                if stripped.is_empty() { "Unknown Series".to_string() } else { stripped }
            });
        let year = derived.as_ref().and_then(|d| d.parsed_year)
            .or_else(|| any_year_re().captures(folder_name).and_then(|c| c[1].parse::<i32>().ok()))
            .unwrap_or(0);
        let publisher = info.as_ref().and_then(|i| i.publisher.clone()).map(|p| p.trim().to_string()).filter(|p| !p.is_empty())
            .unwrap_or_else(|| "Other".to_string());
        (clean_name, year, publisher)
    }

    struct ParsedFolder {
        folder_path: String,
        files: Vec<String>,
        info: Option<ScanComicInfo>,
        clean_name: String,
        year: i32,
        publisher: String,
        is_manga: bool,
    }

    // Publisher lists are read-only and shared across all folder tasks.
    let manga_pubs = Arc::new(manga_pubs);
    let western_pubs = Arc::new(western_pubs);

    let mut folder_parse_set: JoinSet<ParsedFolder> = JoinSet::new();
    for (folder_path, mut files) in new_folders {
        files.sort(); // deterministic "first archive" regardless of walk order
        let sem = parse_sem.clone();
        let client = http_client.clone();
        let manga_pubs = manga_pubs.clone();
        let western_pubs = western_pubs.clone();
        folder_parse_set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            let first = files[0].clone();
            let info = tokio::task::spawn_blocking(move || parse_comic_info(Path::new(&first))).await.unwrap_or(None);

            let folder_name = Path::new(&folder_path).file_name().unwrap_or_default().to_string_lossy().to_string();
            let (clean_name, year, publisher) = derive_folder_basics(&info, &folder_name);
            // 3-tier manga detection runs HERE (in the bounded parallel phase) instead of one-at-a-time in
            // the sequential insert loop below — otherwise the AniList HTTP call (10s timeout, 3rd tier)
            // serialized across every unknown-publisher folder during a large first scan.
            let comicinfo_manga = info.as_ref().map(derive_meta).map(|d| d.is_manga).unwrap_or(false);
            let is_manga = if comicinfo_manga || lib_is_manga {
                true
            } else {
                crate::manga_detector::detect_manga(&client, &clean_name, &publisher, year, &manga_pubs, &western_pubs).await
            };

            ParsedFolder { folder_path, files, info, clean_name, year, publisher, is_manga }
        });
    }
    let mut parsed_folders: Vec<ParsedFolder> = Vec::new();
    while let Some(res) = folder_parse_set.join_next().await {
        if let Ok(t) = res { parsed_folders.push(t); }
    }

    for pf in parsed_folders {
        let ParsedFolder { folder_path, files, info, clean_name, year, publisher, is_manga } = pf;

        log::debug!("[Scanner Debug] Indexing new folder ({} archives): {}", files.len(), folder_path);

        let mut derived = info.as_ref().map(derive_meta);

        // Dynamic resolution (parity with parseComicInfo step 3): files tagged with only an issue id
        // get their owning volume/series id resolved live, so they land MATCHED. Sequential + cached —
        // one API call per unique series name/year across the whole scan.
        if let Some(d) = derived.as_mut() {
            let series_name = info.as_ref().and_then(|i| i.series.as_deref()).map(str::trim).filter(|s| !s.is_empty());
            resolve_dynamic_ids(&db, &http_client, d, series_name).await;
        }

        let metadata_source = derived
            .as_ref()
            .map(|d| d.metadata_source.clone())
            .unwrap_or_else(|| "LOCAL".to_string());
        let series_meta_id = derived
            .as_ref()
            .and_then(|d| d.metadata_id.clone())
            .unwrap_or_else(|| format!("unmatched_{}", Uuid::new_v4()));
        let match_state = if derived.as_ref().and_then(|d| d.metadata_id.as_ref()).is_some() {
            "MATCHED"
        } else {
            "UNMATCHED"
        };
        let cv_id = derived.as_ref().and_then(|d| d.cv_id);
        let metron_id = derived.as_ref().and_then(|d| d.metron_id);
        // is_manga was resolved in the parallel parse phase above (3-tier: ComicInfo Manga tag ‖
        // Library.isManga ‖ detect_manga publisher-list/AniList).

        log::debug!(
            "[Scanner Debug] Extracted -> Name: \"{}\", Year: {}, Publisher: \"{}\", Source: {}, Match: {}, Manga: {}",
            clean_name, year, publisher, metadata_source, match_state, is_manga
        );

        let series_id = Uuid::new_v4().to_string();

        // Series Group comes only from the file's ComicInfo.xml (ComicVine/Metron don't supply it);
        // captured here at series creation so {SeriesGroup} folder patterns work for scanned libraries.
        let series_group = info
            .as_ref()
            .and_then(|i| i.series_group.clone())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        // ON CONFLICT DO NOTHING guards the @@unique([metadataSource, metadataId]) constraint —
        // a duplicate matched series is skipped (parity with Node's create-throws-then-skip).
        let insert_res = sqlx::query(&format!(
            r#"INSERT INTO "Series"
               (id, "folderPath", name, year, publisher, "metadataId", "metadataSource", "matchState", "cvId", "metronId", "isManga", "seriesGroup", "libraryId", "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, {now}, {now})
               ON CONFLICT DO NOTHING"#,
            now = db.now_expr()
        ))
        .bind(&series_id)
        .bind(&folder_path)
        .bind(&clean_name)
        .bind(year)
        .bind(&publisher)
        .bind(&series_meta_id)
        .bind(&metadata_source)
        .bind(match_state)
        .bind(cv_id)
        .bind(metron_id)
        .bind(is_manga)
        .bind(&series_group)
        .bind(&library_id)
        .execute(&db.pool)
        .await;

        match insert_res {
            Ok(r) if r.rows_affected() == 0 => {
                log::debug!(
                    "[Scanner Debug] Skipping folder {} — a series already exists for ({}, {}).",
                    folder_path, metadata_source, series_meta_id
                );
                continue;
            }
            Err(e) => {
                log::error!("[Scanner Debug] Failed to index folder {}: {:?}", folder_path, e);
                continue;
            }
            Ok(_) => {}
        }
        series_inserted += 1;

        // Issue-level identity comes from the first archive's ComicInfo (parity with Node).
        let issue_real_meta = derived.as_ref().and_then(|d| d.metadata_issue_id.clone());

        let mut folder_issue_count = 0;
        for file in &files {
            let file_name = Path::new(file).file_name().unwrap_or_default().to_string_lossy().to_string();
            let issue_num = issue_number_from_filename(&file_name);

            let issue_id = Uuid::new_v4().to_string();
            let (issue_meta_id, issue_match_state) = match &issue_real_meta {
                Some(id) => (id.clone(), "MATCHED"),
                None => (format!("unmatched_{}", Uuid::new_v4()), "UNMATCHED"),
            };

            // pageCount feeds OPDS-PSE (pse:count) — without it every scanned issue reads "0 pages".
            let page_count = count_pages_blocking(file).await;

            if let Err(e) = sqlx::query(&format!(
                r#"INSERT INTO "Issue"
                   (id, "seriesId", "metadataId", "metadataSource", "matchState", number, status, "filePath", "pageCount", "createdAt", "updatedAt")
                   VALUES ($1, $2, $3, $4, $5, $6, 'DOWNLOADED', $7, $8, {now}, {now})"#,
                now = db.now_expr()
            ))
            .bind(&issue_id)
            .bind(&series_id)
            .bind(&issue_meta_id)
            .bind(&metadata_source)
            .bind(issue_match_state)
            .bind(&issue_num)
            .bind(file)
            .bind(page_count)
            .execute(&db.pool)
            .await
            {
                log::error!("[Scanner Debug] Failed to insert issue for {}: {:?}", file, e);
                continue;
            }
            issues_inserted += 1;
            folder_issue_count += 1;
        }

        log::info!("[Scan] Found and indexed new series: {} with {} issues.", clean_name, folder_issue_count);
    }

    // ---------------------------------------------------------
    // 5B. NEW FILES IN EXISTING SERIES → append issues (read each file's own ComicInfo)
    // ---------------------------------------------------------
    // Parse each new file's ComicInfo in parallel (bounded, reusing the same semaphore), then insert sequentially.
    let mut file_parse_set: JoinSet<(String, String, Option<ScanComicInfo>)> = JoinSet::new();
    for (series_id, file) in new_issues_existing_series {
        let sem = parse_sem.clone();
        file_parse_set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            let f = file.clone();
            let info = tokio::task::spawn_blocking(move || parse_comic_info(Path::new(&f))).await.unwrap_or(None);
            (series_id, file, info)
        });
    }
    let mut parsed_files: Vec<(String, String, Option<ScanComicInfo>)> = Vec::new();
    while let Some(res) = file_parse_set.join_next().await {
        if let Ok(t) = res { parsed_files.push(t); }
    }

    // Pre-load existing issue numbers for every affected series in ONE query (not N+1). Issue has no
    // (seriesId, number) unique constraint, so this map is the guard that stops a renamed/re-pathed
    // file from inserting a DUPLICATE issue row: a same-number match updates the existing row's path
    // instead (parity with the importer / watched-sync dedupe). Newly-inserted numbers are folded back
    // in so two new files sharing a number within one scan don't both insert.
    let involved_series: Vec<String> = parsed_files.iter().map(|(sid, _, _)| sid.clone())
        .collect::<std::collections::HashSet<_>>().into_iter().collect();
    let mut series_issue_nums: std::collections::HashMap<String, Vec<(String, String)>> = std::collections::HashMap::new();
    if !involved_series.is_empty() {
        // Portable IN (...) list — see the ghost-purge note above on `= ANY($1)`.
        let ph = Db::in_placeholders(1, involved_series.len());
        let sql = format!(r#"SELECT "seriesId", id, number FROM "Issue" WHERE "seriesId" IN ({})"#, ph);
        let mut q = sqlx::query(&sql);
        for sid in &involved_series {
            q = q.bind(sid);
        }
        let rows = q.fetch_all(&db.pool).await.unwrap_or_default();
        for r in rows {
            series_issue_nums.entry(r.get::<String, _>("seriesId")).or_default()
                .push((r.get::<String, _>("id"), r.get::<String, _>("number")));
        }
    }

    for (series_id, file, info) in parsed_files {
        let file_name = Path::new(&file).file_name().unwrap_or_default().to_string_lossy().to_string();
        let issue_num = issue_number_from_filename(&file_name);

        // Dedupe against the series' existing issues by number. On a match the file was renamed/moved —
        // repoint the existing row's filePath rather than inserting a second row for the same issue.
        let dup_id: Option<String> = series_issue_nums.get(&series_id)
            .and_then(|v| v.iter().find(|(_, n)| crate::metadata::is_same_issue(n, &issue_num)).map(|(id, _)| id.clone()));
        if let Some(eid) = dup_id {
            // Repointed file: refresh the page count too (a 0-count row may finally have a readable zip).
            let page_count = count_pages_blocking(&file).await;
            if let Err(e) = sqlx::query(&format!(
                r#"UPDATE "Issue" SET "filePath"=$1, status='DOWNLOADED',
                       "pageCount"=CASE WHEN $2 > 0 THEN $2 ELSE "pageCount" END,
                       "updatedAt"={now} WHERE id=$3"#,
                now = db.now_expr()
            ))
            .bind(&file).bind(page_count).bind(&eid).execute(&db.pool).await
            {
                log::error!("[Scanner Debug] Failed to repoint existing issue {}: {:?}", file, e);
            }
            continue;
        }

        let derived = info.as_ref().map(derive_meta);
        let (issue_meta_id, issue_source, issue_match_state) = match &derived {
            Some(d) => match &d.metadata_issue_id {
                Some(id) => (id.clone(), d.metadata_source.clone(), "MATCHED"),
                None => (format!("unmatched_{}", Uuid::new_v4()), d.metadata_source.clone(), "UNMATCHED"),
            },
            None => (format!("unmatched_{}", Uuid::new_v4()), "LOCAL".to_string(), "UNMATCHED"),
        };

        let issue_id = Uuid::new_v4().to_string();
        let page_count = count_pages_blocking(&file).await;
        if let Err(e) = sqlx::query(&format!(
            r#"INSERT INTO "Issue"
               (id, "seriesId", "metadataId", "metadataSource", "matchState", number, status, "filePath", "pageCount", "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, 'DOWNLOADED', $7, $8, {now}, {now})"#,
            now = db.now_expr()
        ))
        .bind(&issue_id)
        .bind(&series_id)
        .bind(&issue_meta_id)
        .bind(&issue_source)
        .bind(issue_match_state)
        .bind(&issue_num)
        .bind(&file)
        .bind(page_count)
        .execute(&db.pool)
        .await
        {
            log::error!("[Scanner Debug] Failed to append issue {}: {:?}", file, e);
            continue;
        }
        // Track the just-inserted number so another file with the same number later in this batch
        // dedupes against it instead of inserting a second row.
        series_issue_nums.entry(series_id.clone()).or_default().push((issue_id.clone(), issue_num.clone()));
        issues_inserted += 1;
    }

    // ---------------------------------------------------------
    // 5C. COVER BACKFILL → give cover-less series a real first-page cover
    // ---------------------------------------------------------
    // Unmatched / un-synced series never reach the provider sync's resolve_cover, so they'd otherwise
    // show the placeholder. Pull the first page of their lowest archive into <folder>/cover.<ext>.
    // Idempotent + cheap on re-scans: skips series that already have a coverUrl or a custom cover.
    let cover_source = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'cover_source'"#)
        .fetch_optional(&db.pool).await.ok().flatten().unwrap_or_else(|| "metadata".to_string());

    if cover_source != "metadata_only" {
        let cover_targets = sqlx::query(
            r#"SELECT id, "folderPath" FROM "Series"
               WHERE "libraryId" = $1 AND "hasCustomCover" = false
                 AND ("coverUrl" IS NULL OR "coverUrl" = '')"#,
        )
        .bind(&library_id)
        .fetch_all(&db.pool)
        .await
        .unwrap_or_default();

        if !cover_targets.is_empty() {
            log::info!("[Cover] Backfilling covers for {} series without one.", cover_targets.len());
            let cover_sem = Arc::new(Semaphore::new(cfg.scan_workers));
            let mut cover_set: JoinSet<Option<(String, String)>> = JoinSet::new();
            for row in cover_targets {
                let id: String = row.get("id");
                let folder: String = row.get("folderPath");
                let sem = cover_sem.clone();
                cover_set.spawn(async move {
                    let _permit = sem.acquire_owned().await.ok();
                    tokio::task::spawn_blocking(move || {
                        let folder_path = Path::new(&folder);
                        let first = crate::converter::first_comic_file(folder_path)?;
                        let cover = crate::converter::ensure_folder_cover(folder_path, &first)?;
                        Some((id, format!("/api/library/cover?path={}", urlencoding::encode(&cover.to_string_lossy()))))
                    })
                    .await
                    .ok()
                    .flatten()
                });
            }
            let mut covered = 0;
            while let Some(res) = cover_set.join_next().await {
                if let Ok(Some((id, url))) = res {
                    if sqlx::query(r#"UPDATE "Series" SET "coverUrl" = $1 WHERE id = $2"#)
                        .bind(&url).bind(&id).execute(&db.pool).await.is_ok()
                    {
                        covered += 1;
                    }
                }
            }
            if covered > 0 { log::info!("[Cover] Backfilled {} archive cover(s).", covered); }
        }
    }

    // ---------------------------------------------------------
    // 5D. PAGE-COUNT BACKFILL → heal rows indexed before pageCount was written
    // ---------------------------------------------------------
    // OPDS-PSE clients read Issue.pageCount as pse:count; rows scanned before the engine wrote it
    // (or whose archive was a RAR at the time) sit at 0 and render as unopenable "0 pages" books.
    // Bounded-parallel recount of this library's 0-count file-backed issues. Cheap on re-scans:
    // only rows still at 0 are touched, and counting reads just the zip central directory.
    let zero_rows = sqlx::query(
        r#"SELECT i.id, i."filePath" FROM "Issue" i
           JOIN "Series" s ON i."seriesId" = s.id
           WHERE s."libraryId" = $1 AND i."pageCount" = 0 AND i."filePath" IS NOT NULL"#,
    )
    .bind(&library_id)
    .fetch_all(&db.pool)
    .await
    .unwrap_or_default();

    if !zero_rows.is_empty() {
        log::info!("[Scan] Backfilling page counts for {} issue(s) with none recorded.", zero_rows.len());
        let count_sem = Arc::new(Semaphore::new(cfg.scan_workers));
        let mut count_set: JoinSet<(String, Option<i32>)> = JoinSet::new();
        for row in zero_rows {
            let id: String = row.get("id");
            let file_path: String = row.get("filePath");
            let sem = count_sem.clone();
            count_set.spawn(async move {
                let _permit = sem.acquire_owned().await.ok();
                let count = tokio::task::spawn_blocking(move || {
                    crate::converter::count_zip_pages(Path::new(&file_path))
                })
                .await
                .ok()
                .flatten();
                (id, count)
            });
        }
        let mut backfilled = 0;
        while let Some(res) = count_set.join_next().await {
            if let Ok((id, Some(count))) = res {
                if count > 0
                    && sqlx::query(r#"UPDATE "Issue" SET "pageCount" = $1 WHERE id = $2"#)
                        .bind(count).bind(&id).execute(&db.pool).await.is_ok()
                {
                    backfilled += 1;
                }
            }
        }
        if backfilled > 0 { log::info!("[Scan] Backfilled page counts for {} issue(s).", backfilled); }
    }

    let duration = start_time.elapsed();
    log::info!(
        "⚡ Scan complete in {:?}! Added {} Series and {} Issues.",
        duration, series_inserted, issues_inserted
    );

    Ok(())
}

async fn delete_issue(db: &Db, issue_id: &str) {
    if let Err(e) = sqlx::query(r#"DELETE FROM "ReadProgress" WHERE "issueId" = $1"#)
        .bind(issue_id)
        .execute(&db.pool)
        .await
    {
        log::error!("[Scanner Debug] Error deleting ReadProgress for {}: {:?}", issue_id, e);
    }
    if let Err(e) = sqlx::query(r#"DELETE FROM "Issue" WHERE id = $1"#)
        .bind(issue_id)
        .execute(&db.pool)
        .await
    {
        log::error!("[Scanner Debug] Error deleting ghost issue {}: {:?}", issue_id, e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_leading_zeros_matches_js() {
        assert_eq!(strip_leading_zeros("007"), "7");
        assert_eq!(strip_leading_zeros("0"), "0");
        assert_eq!(strip_leading_zeros("00"), "0");
        assert_eq!(strip_leading_zeros("0.5"), "0.5");
        assert_eq!(strip_leading_zeros("00.5"), "0.5");
        assert_eq!(strip_leading_zeros("012a"), "12a");
        assert_eq!(strip_leading_zeros("12"), "12");
    }

    #[test]
    fn issue_number_skips_years() {
        // The core C-7 regression: a bare 4-digit year must never become the issue number.
        assert_eq!(issue_number_from_filename("Saga 2014 012.cbz"), "12");
        assert_eq!(issue_number_from_filename("X-Men 1991 05.cbz"), "5");
        assert_eq!(issue_number_from_filename("Batman 001 (2011).cbz"), "1");
        assert_eq!(issue_number_from_filename("Series 2020.cbz"), "1"); // only a year -> default
    }

    #[test]
    fn issue_number_markers() {
        assert_eq!(issue_number_from_filename("Spider-Man #15.cbz"), "15");
        assert_eq!(issue_number_from_filename("Series #0.5.cbz"), "0.5");
        assert_eq!(issue_number_from_filename("Chapter 7.cbz"), "7");
        assert_eq!(issue_number_from_filename("Vol 3.cbz"), "3");
        assert_eq!(issue_number_from_filename("007.cbz"), "7");
        assert_eq!(issue_number_from_filename("Amazing Series 12a.cbz"), "12a");
    }

    // Mirrors Node __tests__/lib/utils/issue-parser.test.ts (beta.023/035 negative-number support).
    #[test]
    fn issue_number_explicit_negatives() {
        assert_eq!(issue_number_from_filename("Spider-Man #-1.cbz"), "-1");
        assert_eq!(issue_number_from_filename("Deadpool Issue -005.cbz"), "-5");
        assert_eq!(issue_number_from_filename("X-Men Vol -2.cbz"), "-2");
        assert_eq!(issue_number_from_filename("Batman (2016) Issue -1.cbz"), "-1");
    }

    #[test]
    fn issue_number_title_separators_stay_positive() {
        assert_eq!(issue_number_from_filename("Spider-Man - 1.cbz"), "1");
        assert_eq!(issue_number_from_filename("Batman - 002.cbz"), "2");
        assert_eq!(issue_number_from_filename("Batman 2016 #001.cbz"), "1");
    }

    #[test]
    fn issue_number_prefers_trailing_numbers_over_volume_tokens() {
        assert_eq!(issue_number_from_filename("Uncanny X-Men-V1-001.cbz"), "1");
        assert_eq!(issue_number_from_filename("Uncanny X-Men-V1-023.cbz"), "23");
        assert_eq!(issue_number_from_filename("Uncanny X-Men-V1-066.cbz"), "66");
        assert_eq!(issue_number_from_filename("Spider-Man v2 #5.cbz"), "5");
        assert_eq!(issue_number_from_filename("Batman Vol 2 Issue 12.cbz"), "12");
        // Volume only as the LAST resort.
        assert_eq!(issue_number_from_filename("Batman Vol 4.cbz"), "4");
    }

    #[test]
    fn derive_meta_from_comicvine_web() {
        let info = ScanComicInfo {
            web: Some("https://comicvine.gamespot.com/spider-man/4050-12345/".to_string()),
            ..Default::default()
        };
        let d = derive_meta(&info);
        assert_eq!(d.cv_id, Some(12345));
        assert_eq!(d.metadata_source, "COMICVINE");
        assert_eq!(d.metadata_id.as_deref(), Some("12345"));
        assert!(!d.is_manga);
    }

    #[test]
    fn derive_meta_metron_and_manga_tag() {
        let info = ScanComicInfo {
            manga: Some("YesAndRightToLeft".to_string()),
            metron_id: Some("999".to_string()),
            comic_vine_volume_id: Some("4050".to_string()),
            ..Default::default()
        };
        let d = derive_meta(&info);
        assert!(d.is_manga);
        assert_eq!(d.metron_id, Some(999));
        // Metron takes precedence over ComicVine for source + metadata_id.
        assert_eq!(d.metadata_source, "METRON");
        assert_eq!(d.metadata_id.as_deref(), Some("999"));
    }

    #[test]
    fn pick_metron_series_prefers_exact_name_and_year() {
        let results: Vec<serde_json::Value> = vec![
            serde_json::json!({ "id": 10, "name": "Batman", "year_began": 1940 }),
            serde_json::json!({ "id": 20, "name": "Batman", "year_began": 2016 }),
            serde_json::json!({ "id": 30, "name": "Batman Beyond", "year_began": 2016 }),
        ];
        // Exact name + year (±1 variance) wins over the earlier plain name match.
        assert_eq!(pick_metron_series(&results, "Batman", Some(2016)), Some(20));
        assert_eq!(pick_metron_series(&results, "Batman", Some(2017)), Some(20)); // 1-year variance
        // No year → first name match.
        assert_eq!(pick_metron_series(&results, "Batman", None), Some(10));
        // No name match at all → first result.
        assert_eq!(pick_metron_series(&results, "Superman", Some(1986)), Some(10));
        // String ids (Metron sometimes serializes them) still parse.
        let stringy = vec![serde_json::json!({ "id": "77", "series": "X-Men" })];
        assert_eq!(pick_metron_series(&stringy, "X-Men", None), Some(77));
        assert_eq!(pick_metron_series(&[], "X-Men", None), None);
    }

    #[test]
    fn recompute_resolved_after_dynamic_resolution() {
        // A file carrying only a CV issue id starts COMICVINE but with no series metadata id...
        let info = ScanComicInfo { comic_vine_issue_id: Some("555".to_string()), ..Default::default() };
        let mut d = derive_meta(&info);
        assert_eq!(d.metadata_source, "COMICVINE");
        assert_eq!(d.cv_issue_id, Some(555));
        assert!(d.metadata_id.is_none());

        // ...and once resolution supplies the volume id, the series id fills in.
        d.cv_id = Some(4050);
        d.recompute_resolved();
        assert_eq!(d.metadata_id.as_deref(), Some("4050"));
        assert_eq!(d.metadata_source, "COMICVINE");

        // Metron precedence survives recompute (metron id outranks cv id).
        d.metron_id = Some(9);
        d.recompute_resolved();
        assert_eq!(d.metadata_id.as_deref(), Some("9"));
        assert_eq!(d.metadata_source, "METRON");
    }

    #[test]
    fn derive_meta_volume_year_fallback() {
        let info = ScanComicInfo { volume: Some("2019".to_string()), ..Default::default() };
        assert_eq!(derive_meta(&info).parsed_year, Some(2019));
        // Volume "0" (or non-numeric) falls back to <Year>.
        let info2 = ScanComicInfo {
            volume: Some("0".to_string()),
            year: Some("2021".to_string()),
            ..Default::default()
        };
        assert_eq!(derive_meta(&info2).parsed_year, Some(2021));
    }

    // ------------------------------------------------------------------
    // SQLite spike: run the real scan_library against a Prisma-created SQLite database file.
    // Gated on env vars so normal `cargo test` runs skip it:
    //   OMNIBUS_SPIKE_DB  — path to a SQLite db created by `prisma db push` (main-branch schema)
    //   OMNIBUS_SPIKE_LIB — scratch directory to use as the library root (fixture cbz is created here)
    // Proves: Any-driver connect + $N placeholders + bool/i64/String decode on SQLite rows,
    // ON CONFLICT, the now_expr() epoch-ms write (Prisma-readable), and scan idempotency.
    // ------------------------------------------------------------------
    #[tokio::test]
    async fn sqlite_spike_end_to_end_scan() {
        let Ok(db_path) = std::env::var("OMNIBUS_SPIKE_DB") else {
            eprintln!("OMNIBUS_SPIKE_DB unset — skipping SQLite spike test");
            return;
        };
        let Ok(lib_dir) = std::env::var("OMNIBUS_SPIKE_LIB") else {
            eprintln!("OMNIBUS_SPIKE_LIB unset — skipping SQLite spike test");
            return;
        };

        // Fixture: <lib>/Spike Series (2020)/Spike Series 001 (2020).cbz — a zip whose 3 image-named
        // entries make count_zip_pages report 3 (it counts entries, it never decodes).
        let series_dir = Path::new(&lib_dir).join("Spike Series (2020)");
        std::fs::create_dir_all(&series_dir).expect("create fixture series dir");
        let cbz = series_dir.join("Spike Series 001 (2020).cbz");
        {
            use std::io::Write as _;
            let f = File::create(&cbz).expect("create fixture cbz");
            let mut zw = zip::ZipWriter::new(f);
            for name in ["01.jpg", "02.jpg", "03.jpg"] {
                zw.start_file(name, zip::write::FileOptions::default()).unwrap();
                zw.write_all(&[0xFF, 0xD8, 0xFF, 0xE0]).unwrap();
            }
            zw.finish().unwrap();
        }

        let db = crate::db::Db::connect(&format!("file:{}", db_path), 2).await.expect("Any-driver SQLite connect");
        assert_eq!(db.dialect, crate::db::Dialect::Sqlite);

        // Seed the Library row the scan reads its isManga baseline from. isManga=true exercises the
        // bool decode AND short-circuits manga detection before its AniList network tier.
        sqlx::query(
            r#"INSERT INTO "Library" (id, name, path, "isManga", "isDefault", "defaultAccess")
               VALUES ($1, $2, $3, true, false, false) ON CONFLICT DO NOTHING"#,
        )
        .bind("spike_lib")
        .bind("Spike Library")
        .bind(&lib_dir)
        .execute(&db.pool)
        .await
        .expect("seed Library row");

        scan_library(db.clone(), lib_dir.clone(), "spike_lib".to_string(), None).await.expect("first scan");

        let series_count: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM "Series" WHERE "libraryId" = 'spike_lib'"#)
            .fetch_one(&db.pool).await.unwrap();
        assert_eq!(series_count, 1, "exactly one series indexed");

        // isManga/createdAt are CAST for the Any driver: SQLite's BOOLEAN- and DATETIME-declared
        // columns have no Any mapping (same reason as the isManga read in scan_library). createdAt
        // goes through TEXT, not INTEGER: expression results carry SQLite's runtime type code,
        // which sqlx maps to the 32-bit Any path — an epoch-ms value silently truncates mod 2^32.
        let row = sqlx::query(r#"SELECT id, name, CAST("isManga" AS INTEGER) AS "isManga", "matchState", CAST("createdAt" AS TEXT) AS "createdAt" FROM "Series" WHERE "libraryId" = 'spike_lib'"#)
            .fetch_one(&db.pool).await.unwrap();
        assert_eq!(row.get::<String, _>("name"), "Spike Series");
        assert_eq!(row.get::<i64, _>("isManga"), 1, "bool stored as INTEGER 1 (Prisma-native)");
        assert_eq!(row.get::<String, _>("matchState"), "UNMATCHED");
        // now_expr() must have written Prisma-native epoch milliseconds (sanity: within a day of now).
        let created_ms: i64 = row.get::<String, _>("createdAt").parse().expect("createdAt is an integer");
        let sys_now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        assert!((sys_now_ms - created_ms).abs() < 24 * 3600 * 1000, "createdAt is epoch-ms, got {}", created_ms);

        let issue = sqlx::query(r#"SELECT number, status, "pageCount" FROM "Issue" WHERE "seriesId" = $1"#)
            .bind(row.get::<String, _>("id"))
            .fetch_one(&db.pool).await.unwrap();
        assert_eq!(issue.get::<String, _>("number"), "1");
        assert_eq!(issue.get::<String, _>("status"), "DOWNLOADED");
        assert_eq!(issue.get::<i64, _>("pageCount"), 3);

        // NULL round-trip through Any (sqlx >= 0.8 required): the ghost sweep reads Option columns
        // that are NULL on real libraries (Series.seriesGroup here, NULL for a ComicInfo-less
        // fixture). On sqlx 0.7 this errored with "Option<T> is not compatible with SQL type NULL".
        let group: Option<String> = sqlx::query_scalar(r#"SELECT "seriesGroup" FROM "Series" WHERE "libraryId" = 'spike_lib'"#)
            .fetch_one(&db.pool).await.expect("Option<String> read of a NULL column");
        assert_eq!(group, None);

        // Second scan: idempotent (dedupe via existing filePath map) and exercises the ghost-sweep
        // read paths (Series bool/Option<bool> reads, Issue joins) against live SQLite rows.
        scan_library(db.clone(), lib_dir.clone(), "spike_lib".to_string(), None).await.expect("second scan");
        let series_count2: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM "Series" WHERE "libraryId" = 'spike_lib'"#)
            .fetch_one(&db.pool).await.unwrap();
        let issue_count2: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*) FROM "Issue" i JOIN "Series" s ON i."seriesId" = s.id WHERE s."libraryId" = 'spike_lib'"#,
        )
        .fetch_one(&db.pool).await.unwrap();
        assert_eq!(series_count2, 1, "re-scan must not duplicate the series");
        assert_eq!(issue_count2, 1, "re-scan must not duplicate the issue");
    }
}
