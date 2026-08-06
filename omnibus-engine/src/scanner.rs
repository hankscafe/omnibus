use crate::db::{Db, Dialect};
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
    month: Option<String>,
    day: Option<String>,
    number: Option<String>,
    manga: Option<String>,
    web: Option<String>,
    series_group: Option<String>,
    comic_vine_volume_id: Option<String>,
    comic_vine_issue_id: Option<String>,
    metron_id: Option<String>,
    metron_issue_id: Option<String>,
    // Narrative + credit fields (discussion #177): stored per issue at scan so a tagged library's
    // metadata lands in the app without burning provider API budget. Comma-separated list tags.
    notes: Option<String>,
    title: Option<String>,
    summary: Option<String>,
    genre: Option<String>,
    writer: Option<String>,
    penciller: Option<String>,
    inker: Option<String>,
    cover_artist: Option<String>,
    colorist: Option<String>,
    letterer: Option<String>,
    characters: Option<String>,
    teams: Option<String>,
    locations: Option<String>,
    story_arc: Option<String>,
    // #199 series-default tags (read-side): values the writer embeds from the Series columns come
    // back at scan, so a wipe/rebuild keeps them and pre-tagged libraries contribute them (5H).
    // PascalCase rename_all covers most; the two all-caps tags need explicit renames.
    tags: Option<String>,
    editor: Option<String>,
    translator: Option<String>,
    imprint: Option<String>,
    format: Option<String>,
    #[serde(rename = "LanguageISO")]
    language_iso: Option<String>,
    age_rating: Option<String>,
    community_rating: Option<String>,
    black_and_white: Option<String>,
    #[serde(rename = "GTIN")]
    gtin: Option<String>,
    scan_information: Option<String>,
    review: Option<String>,
    main_character_or_team: Option<String>,
    alternate_series: Option<String>,
    alternate_number: Option<String>,
    alternate_count: Option<String>,
    story_arc_number: Option<String>,
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

/// Off-thread page count for an on-disk archive; 0 when unreadable. Counts zip-family natively and
/// RAR-family via the unrar listing (native CBR reading) — the pageCount=0 backfill sweep below
/// therefore heals RAR libraries scanned by older zip-only builds without a rescan. Only a real 7z
/// stays 0 until CBZ conversion.
async fn count_pages_blocking(file: &str) -> i32 {
    let f = file.to_string();
    tokio::task::spawn_blocking(move || crate::converter::count_archive_pages(Path::new(&f)))
        .await
        .ok()
        .flatten()
        .unwrap_or(0)
}

/// Reads ComicInfo.xml out of a comic archive. CBZ/ZIP reads via the zip crate; CBR/RAR (discussion
/// #177) lists + prints the entry via unrar, so CBR-only tagged libraries contribute ComicInfo
/// evidence at scan time too instead of relying solely on series.json.
fn parse_comic_info(path: &Path) -> Option<ScanComicInfo> {
    // Signature-dispatch (extensions lie): "Rar!" -> unrar; 7z magic -> native 7z; else zip.
    let mut sig = [0u8; 6];
    let n = File::open(path).and_then(|mut f| f.read(&mut sig)).unwrap_or(0);
    if n >= 4 && sig[..4] == [0x52, 0x61, 0x72, 0x21] {
        return parse_comic_info_rar(path);
    }
    if n >= 6 && sig[..6] == [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C] {
        return parse_comic_info_7z(path);
    }

    let file = File::open(path).ok()?;
    let mut archive = ZipArchive::new(file).ok()?;

    for i in 0..archive.len() {
        if let Ok(mut entry) = archive.by_index(i) {
            if entry.name().eq_ignore_ascii_case("comicinfo.xml") {
                let mut xml = String::new();
                if entry.read_to_string(&mut xml).is_ok() {
                    // Sanitize bare ampersands without breaking real entities (parity with metadata-extractor.ts:34).
                    let xml = sanitize_xml_ampersands(&xml);
                    return quick_xml::de::from_str(xml.trim_start_matches('\u{feff}')).ok();
                }
            }
        }
    }
    None
}

/// RAR branch: find the ComicInfo entry case-insensitively via `unrar lb`, then print it to stdout
/// with `unrar p`. Any missing binary / listing / parse failure is a None — the scan proceeds on
/// the folder's other evidence (series.json, folder name).
fn parse_comic_info_rar(path: &Path) -> Option<ScanComicInfo> {
    let list = std::process::Command::new("unrar")
        .args(["lb", "-p-"])
        .arg(path)
        .output()
        .ok()?;
    let entry = String::from_utf8_lossy(&list.stdout)
        .lines()
        .map(str::trim)
        .find(|l| l.rsplit(['/', '\\']).next().unwrap_or("").eq_ignore_ascii_case("comicinfo.xml"))
        .map(str::to_string)?;
    let out = std::process::Command::new("unrar")
        .args(["p", "-inul", "-p-"])
        .arg(path)
        .arg(&entry)
        .output()
        .ok()?;
    if out.stdout.is_empty() {
        return None;
    }
    let xml = String::from_utf8_lossy(&out.stdout).to_string();
    let xml = sanitize_xml_ampersands(&xml);
    quick_xml::de::from_str(xml.trim_start_matches('\u{feff}')).ok()
}

/// 7z (.cb7) branch: pull ComicInfo.xml straight out of the archive with the pure-Rust decoder
/// (no CLI). Same sanitize + parse tail as the zip/RAR paths; any failure is a None so the scan
/// falls back to the folder's other evidence.
fn parse_comic_info_7z(path: &Path) -> Option<ScanComicInfo> {
    let bytes = crate::converter::sevenz_read_by_basename(path, "comicinfo.xml")?;
    let xml = String::from_utf8_lossy(&bytes).to_string();
    let xml = sanitize_xml_ampersands(&xml);
    quick_xml::de::from_str(xml.trim_start_matches('\u{feff}')).ok()
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

/// Folder-level Mylar-spec series.json (discussion #177). Omnibus writes these itself
/// (metadata_writer) and Mylar-migrated libraries arrive with them. `comicid` is the ComicVine
/// VOLUME id per the Mylar spec — a direct, zero-API series match that works even when the folder's
/// archives are RAR/CBR (where ComicInfo.xml can't be read pre-conversion).
#[derive(Debug, Default)]
struct SeriesJsonInfo {
    comicid: Option<i64>,
    name: Option<String>,
    publisher: Option<String>,
    year: Option<i32>,
    description: Option<String>,
    booktype: Option<String>,
    /// Mapped to Omnibus status values: "Ended" | "Ongoing".
    status: Option<String>,
}

fn parse_series_json(content: &str) -> Option<SeriesJsonInfo> {
    let v: serde_json::Value = serde_json::from_str(content).ok()?;
    let m = v.get("metadata")?;
    if !m.is_object() {
        return None;
    }
    let get_str = |k: &str| m.get(k).and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let comicid = m.get("comicid")
        .and_then(|c| c.as_i64().or_else(|| c.as_str().and_then(|s| s.trim().parse().ok())))
        .filter(|id| *id > 0);
    let year = m.get("year")
        .and_then(|y| y.as_i64().or_else(|| y.as_str().and_then(|s| s.trim().parse().ok())))
        .map(|y| y as i32)
        .filter(|y| *y != 0);
    let status = get_str("status").map(|s| if s.eq_ignore_ascii_case("ended") { "Ended".to_string() } else { "Ongoing".to_string() });
    Some(SeriesJsonInfo {
        comicid,
        name: get_str("name"),
        publisher: get_str("publisher"),
        year,
        description: get_str("description_text"),
        booktype: get_str("booktype"),
        status,
    })
}

/// Reads `<folder>/series.json` if present. Any read/parse failure is a None (the scan proceeds on
/// ComicInfo/folder-name evidence), but a malformed file in a tagged library is worth a log line.
fn read_series_json(folder: &Path) -> Option<SeriesJsonInfo> {
    let path = folder.join("series.json");
    let content = std::fs::read_to_string(&path).ok()?;
    let parsed = parse_series_json(&content);
    if parsed.is_none() {
        log::warn!("[Scanner] {} exists but is not a parseable Mylar-spec series.json — ignoring it.", path.display());
    }
    parsed
}

fn notes_re_issue_id() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)issue\s*id\s*:?\s*#?(\d+)").unwrap())
}
fn notes_re_cvdb() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)CVDB(\d+)").unwrap())
}

/// (cv_issue_id, metron_issue_id) from a ComicTagger/Mylar `<Notes>` tag (discussion #177):
/// "[Issue ID 123456]" (provider named in the surrounding text; Comic Vine unless Metron is named)
/// or the newer short form "[CVDB987]". Older tagged files carry ONLY Notes — no Web, no dedicated
/// id tags — and previously fell all the way through to name-search.
fn notes_issue_ids(notes: &str) -> (Option<i32>, Option<i32>) {
    if let Some(id) = capture_i32(notes_re_cvdb(), notes) {
        return (Some(id), None);
    }
    if let Some(id) = capture_i32(notes_re_issue_id(), notes) {
        if notes.to_lowercase().contains("metron") {
            return (None, Some(id));
        }
        return (Some(id), None);
    }
    (None, None)
}

/// ISO release date (YYYY-MM-DD, the shape providers write and the calendar indexes on) from
/// ComicInfo `<Year>/<Month>/<Day>` (discussion #182 — completes the embed round-trip: the embed
/// writer already emits all three from Issue.releaseDate). A month is REQUIRED: many taggers stamp
/// `<Year>` alone with the SERIES year on every issue (our own embed writer falls back to it), and
/// reading that back as a release date would fabricate per-issue dates. A missing/invalid day
/// rounds to the 1st (ComicVine/Mylar cover-date convention; older ComicTagger omits Day).
pub(crate) fn compose_release_date(year: Option<i32>, month: Option<i32>, day: Option<i32>) -> Option<String> {
    let y = year.filter(|y| (1000..=2999).contains(y))?;
    let m = month.filter(|m| (1..=12).contains(m))?;
    let d = day.filter(|d| (1..=31).contains(d)).unwrap_or(1);
    Some(format!("{:04}-{:02}-{:02}", y, m, d))
}

fn comicinfo_number_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^(-?)0*(\d+(?:\.\d+)?[a-zA-Z]*)$").unwrap())
}

/// Issue number for a scanned file (discussion #182): the file's own ComicInfo `<Number>` wins —
/// it's the tagger's ground truth, where filename parsing only guesses — with the filename as the
/// fallback. Plain numeric shapes normalize like the filename parser's output (leading zeros
/// stripped, sign kept) so is_same_issue dedupe and sorting behave identically for both origins;
/// fancier numbers ("½", "1.MU") are stored verbatim.
fn issue_number_for_file(info: Option<&ScanComicInfo>, file_name: &str, series_hint: Option<&str>) -> String {
    if let Some(num) = info.and_then(|i| i.number.as_deref()).map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(caps) = comicinfo_number_re().captures(num) {
            return format!("{}{}", &caps[1], &caps[2]);
        }
        return num.to_string();
    }
    issue_number_from_filename(file_name, series_hint)
}

/// Per-issue narrative/credit columns from a file's own ComicInfo (discussion #177). Comma-separated
/// list tags become JSON array strings; absent/empty fields stay None — never a literal '[]' — so
/// the provider syncs' fill/never-clobber policies treat them as blanks to fill.
#[derive(Default)]
struct IssueFileMeta {
    name: Option<String>,
    description: Option<String>,
    release_date: Option<String>,
    genres: Option<String>,
    writers: Option<String>,
    artists: Option<String>,
    cover_artists: Option<String>,
    colorists: Option<String>,
    letterers: Option<String>,
    characters: Option<String>,
    teams: Option<String>,
    locations: Option<String>,
    story_arcs: Option<String>,
    // #199 Call-3 Beta A: the last three credit roles gained per-issue columns.
    inker: Option<String>,
    editor: Option<String>,
    translator: Option<String>,
    // #199 Call-3 Beta B: the genuinely-per-issue remainder of the ComicInfo schema.
    tags: Option<String>,
    main_character_or_team: Option<String>,
    alternate_series: Option<String>,
    alternate_number: Option<String>,
    alternate_count: Option<i32>,
    story_arc_number: Option<String>,
    gtin: Option<String>,
    notes: Option<String>,
    scan_information: Option<String>,
    review: Option<String>,
    black_and_white: Option<bool>,
    community_rating: Option<f64>,
}

/// Match state a scanned file's issue row carries (discussion #182, local-first ingest): an issue
/// whose OWN ComicInfo supplied both a provider id AND creative credits is enrichment-complete —
/// DEEP_SYNCED means opening it never costs a provider call (the view-time lazy fetch only fires
/// below DEEP_SYNCED). An id without credits stays MATCHED so lazy enrichment can still fill the
/// gap; no id at all is the caller's UNMATCHED path.
fn scanned_issue_match_state(fm: &IssueFileMeta) -> &'static str {
    if fm.writers.is_some() || fm.artists.is_some() { "DEEP_SYNCED" } else { "MATCHED" }
}

/// Backfill UPDATE promoting a library's MATCHED, file-backed issues that already carry a real
/// provider id AND creative credits (populated from ComicInfo at scan since beta.083, or by the
/// CV list-call credit sync) to DEEP_SYNCED — the state today's scan stamps directly
/// (scanned_issue_match_state). $1 = libraryId.
/// Fill-only UPDATE re-flowing series.json fields into an EXISTING Series row (scan 5F): each
/// column takes the file's value only when the column is blank (publisher's scan-default 'Other'
/// counts as blank); the trailing self-reference keeps a column untouched when the file has
/// nothing either. $1..$5 = description, status, booktype, publisher, year; $6 = series id.
fn series_json_fill_blanks_sql() -> &'static str {
    r#"UPDATE "Series" SET
           description = COALESCE(NULLIF(description, ''), $1, description),
           status      = COALESCE(NULLIF(status, ''), $2, status),
           "bookType"  = COALESCE(NULLIF("bookType", ''), $3, "bookType"),
           publisher   = COALESCE(NULLIF(NULLIF(publisher, ''), 'Other'), $4, publisher),
           year        = COALESCE(NULLIF(year, 0), $5, year)
       WHERE id = $6"#
}

/// #199 read-side (5H): the series-default values a single file's ComicInfo carries, converted to
/// the Series column shapes. Fill-blank only — see the 5H step.
#[derive(Default)]
struct ComicInfoSeriesDefaults {
    imprint: Option<String>,
    tags_json: Option<String>,
    format: Option<String>,
    language_iso: Option<String>,
    age_rating: Option<String>,
    community_rating: Option<f64>,
    black_and_white: Option<bool>,
    gtin: Option<String>,
    notes: Option<String>,
    scan_information: Option<String>,
    review: Option<String>,
    main_character_or_team: Option<String>,
    alternate_series: Option<String>,
    alternate_number: Option<String>,
    alternate_count: Option<i32>,
    story_arc_number: Option<String>,
    inker_json: Option<String>,
    editor_json: Option<String>,
    translator_json: Option<String>,
}

impl ComicInfoSeriesDefaults {
    fn has_any(&self) -> bool {
        self.imprint.is_some() || self.tags_json.is_some() || self.format.is_some()
            || self.language_iso.is_some() || self.age_rating.is_some()
            || self.community_rating.is_some() || self.black_and_white.is_some()
            || self.gtin.is_some() || self.notes.is_some() || self.scan_information.is_some()
            || self.review.is_some() || self.main_character_or_team.is_some()
            || self.alternate_series.is_some() || self.alternate_number.is_some()
            || self.alternate_count.is_some() || self.story_arc_number.is_some()
            || self.inker_json.is_some() || self.editor_json.is_some() || self.translator_json.is_some()
    }
}

fn comicinfo_series_defaults(info: &ScanComicInfo) -> ComicInfoSeriesDefaults {
    let text = |s: &Option<String>| s.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_string);
    let list = |s: &Option<String>| -> Option<String> {
        let j = crate::watched_sync::split_to_json(s.as_deref());
        if j == "[]" { None } else { Some(j) }
    };
    // Per-file tagger fingerprints must not become the series-level note — Mylar/ComicTagger stamp
    // every file's <Notes> with scrape provenance, which is per-issue noise, not series curation.
    let notes = text(&info.notes).filter(|v| {
        let lower = v.to_lowercase();
        !(lower.contains("comictagger") || lower.contains("scraped") || lower.starts_with("issue id"))
    });
    ComicInfoSeriesDefaults {
        imprint: text(&info.imprint),
        tags_json: list(&info.tags),
        format: text(&info.format),
        language_iso: text(&info.language_iso),
        age_rating: text(&info.age_rating),
        community_rating: text(&info.community_rating)
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite())
            .map(|v| v.clamp(0.0, 5.0)),
        // Yes/No only; Unknown (or garbage) stays NULL so a false claim is never invented.
        black_and_white: text(&info.black_and_white).and_then(|v| match v.to_ascii_lowercase().as_str() {
            "yes" => Some(true),
            "no" => Some(false),
            _ => None,
        }),
        gtin: text(&info.gtin),
        notes,
        scan_information: text(&info.scan_information),
        review: text(&info.review),
        main_character_or_team: text(&info.main_character_or_team),
        alternate_series: text(&info.alternate_series),
        alternate_number: text(&info.alternate_number),
        alternate_count: text(&info.alternate_count).and_then(|v| v.parse::<i32>().ok()),
        story_arc_number: text(&info.story_arc_number),
        inker_json: list(&info.inker),
        editor_json: list(&info.editor),
        translator_json: list(&info.translator),
    }
}

/// #199 read-side (5H): series with at least one file-backed issue and ANY blank ComicInfo-default
/// column — candidates for the fill. $1 = libraryId. Most libraries match broadly (few files carry
/// every tag), so the fill reads ONE small archive entry per candidate series, bounded-parallel.
fn comicinfo_defaults_candidates_sql() -> &'static str {
    r#"SELECT s.id AS sid,
              (SELECT i."filePath" FROM "Issue" i
                WHERE i."seriesId" = s.id AND i."filePath" IS NOT NULL AND i."filePath" <> ''
                ORDER BY i.number LIMIT 1) AS fp
       FROM "Series" s
       WHERE s."libraryId" = $1 AND (
             s.imprint IS NULL OR s.imprint = ''
          OR s.tags IS NULL OR s.tags = '' OR s.tags = '[]'
          OR s.format IS NULL OR s.format = ''
          OR s."languageISO" IS NULL OR s."languageISO" = ''
          OR s."ageRating" IS NULL OR s."ageRating" = ''
          OR s."communityRating" IS NULL
          OR s."blackAndWhite" IS NULL
          OR s.gtin IS NULL OR s.gtin = ''
          OR s.notes IS NULL OR s.notes = ''
          OR s."scanInformation" IS NULL OR s."scanInformation" = ''
          OR s.review IS NULL OR s.review = ''
          OR s."mainCharacterOrTeam" IS NULL OR s."mainCharacterOrTeam" = ''
          OR s."alternateSeries" IS NULL OR s."alternateSeries" = ''
          OR s."alternateNumber" IS NULL OR s."alternateNumber" = ''
          OR s."alternateCount" IS NULL
          OR s."storyArcNumber" IS NULL OR s."storyArcNumber" = ''
          OR s.inker IS NULL OR s.inker = '' OR s.inker = '[]'
          OR s.editor IS NULL OR s.editor = '' OR s.editor = '[]'
          OR s.translator IS NULL OR s.translator = '' OR s.translator = '[]')"#
}

/// Fill-only UPDATE for the 5H defaults: each column takes the file's value only when blank, the
/// trailing self-reference keeps it untouched when the file offers nothing either (the 5F pattern).
/// blackAndWhite is interpolated as a literal (true/false/NULL, engine-derived — never user text):
/// Postgres types the column boolean and the Any driver has no portable bool bind (see db.rs).
fn comicinfo_defaults_fill_sql(bw_literal: &str) -> String {
    format!(
        r#"UPDATE "Series" SET
           imprint = COALESCE(NULLIF(imprint, ''), $1, imprint),
           tags = COALESCE(NULLIF(NULLIF(tags, ''), '[]'), $2, tags),
           format = COALESCE(NULLIF(format, ''), $3, format),
           "languageISO" = COALESCE(NULLIF("languageISO", ''), $4, "languageISO"),
           "ageRating" = COALESCE(NULLIF("ageRating", ''), $5, "ageRating"),
           "communityRating" = COALESCE("communityRating", $6),
           gtin = COALESCE(NULLIF(gtin, ''), $7, gtin),
           notes = COALESCE(NULLIF(notes, ''), $8, notes),
           "scanInformation" = COALESCE(NULLIF("scanInformation", ''), $9, "scanInformation"),
           review = COALESCE(NULLIF(review, ''), $10, review),
           "mainCharacterOrTeam" = COALESCE(NULLIF("mainCharacterOrTeam", ''), $11, "mainCharacterOrTeam"),
           "alternateSeries" = COALESCE(NULLIF("alternateSeries", ''), $12, "alternateSeries"),
           "alternateNumber" = COALESCE(NULLIF("alternateNumber", ''), $13, "alternateNumber"),
           "alternateCount" = COALESCE("alternateCount", $14),
           "storyArcNumber" = COALESCE(NULLIF("storyArcNumber", ''), $15, "storyArcNumber"),
           inker = COALESCE(NULLIF(NULLIF(inker, ''), '[]'), $16, inker),
           editor = COALESCE(NULLIF(NULLIF(editor, ''), '[]'), $17, editor),
           translator = COALESCE(NULLIF(NULLIF(translator, ''), '[]'), $18, translator),
           "blackAndWhite" = COALESCE("blackAndWhite", {bw})
       WHERE id = $19"#,
        bw = bw_literal
    )
}

fn restamp_credit_complete_sql() -> &'static str {
    r#"UPDATE "Issue" SET "matchState" = 'DEEP_SYNCED'
       WHERE "matchState" = 'MATCHED'
         AND "filePath" IS NOT NULL AND "filePath" <> ''
         AND "metadataId" IS NOT NULL AND "metadataId" <> '' AND "metadataId" NOT LIKE 'unmatched%'
         AND ((writers IS NOT NULL AND writers <> '' AND writers <> '[]')
              OR (artists IS NOT NULL AND artists <> '' AND artists <> '[]'))
         AND "seriesId" IN (SELECT id FROM "Series" WHERE "libraryId" = $1)"#
}

fn issue_file_meta(info: Option<&ScanComicInfo>) -> IssueFileMeta {
    let Some(i) = info else { return IssueFileMeta::default() };
    let text = |s: &Option<String>| s.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_string);
    let list = |s: &Option<String>| -> Option<String> {
        let j = crate::watched_sync::split_to_json(s.as_deref());
        if j == "[]" { None } else { Some(j) }
    };
    // #199 Call-3 Beta A: Penciller and Inker are separate buckets now that Issue has an inker
    // column (parity with parseComicVineCredits' split) — the old Penciller+Inker merge would
    // double-credit inkers on the next embed.
    IssueFileMeta {
        name: text(&i.title),
        description: text(&i.summary),
        release_date: compose_release_date(
            i.year.as_deref().and_then(parse_i32),
            i.month.as_deref().and_then(parse_i32),
            i.day.as_deref().and_then(parse_i32),
        ),
        genres: list(&i.genre),
        writers: list(&i.writer),
        artists: list(&i.penciller),
        cover_artists: list(&i.cover_artist),
        colorists: list(&i.colorist),
        letterers: list(&i.letterer),
        characters: list(&i.characters),
        teams: list(&i.teams),
        locations: list(&i.locations),
        story_arcs: list(&i.story_arc),
        inker: list(&i.inker),
        editor: list(&i.editor),
        translator: list(&i.translator),
        // Beta B: same conversion rules as the 5H series fill (comicinfo_series_defaults) — with
        // one deliberate difference: per-issue <Notes> keeps tagger fingerprints. On the SERIES
        // they're per-file noise; on the ISSUE they're that file's own provenance, and keeping
        // them means an embed re-emits what the file said instead of clobbering foreign taggers.
        tags: list(&i.tags),
        main_character_or_team: text(&i.main_character_or_team),
        alternate_series: text(&i.alternate_series),
        alternate_number: text(&i.alternate_number),
        alternate_count: text(&i.alternate_count).and_then(|v| v.parse::<i32>().ok()),
        story_arc_number: text(&i.story_arc_number),
        gtin: text(&i.gtin),
        notes: text(&i.notes),
        scan_information: text(&i.scan_information),
        review: text(&i.review),
        black_and_white: text(&i.black_and_white).and_then(|v| match v.to_ascii_lowercase().as_str() {
            "yes" => Some(true),
            "no" => Some(false),
            _ => None,
        }),
        community_rating: text(&i.community_rating)
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite())
            .map(|v| v.clamp(0.0, 5.0)),
    }
}

/// Folder-level identity evidence for the unmatched-retry sweep (matcher.rs): the first comic
/// file's ComicInfo + the folder's series.json — the same precedence the scanner uses — with the
/// live issue-id→volume resolution gated behind `allow_api` (budget-aware callers). Returns
/// (metadataSource, metadataId, cv_id, metron_id) when the files identify the series.
pub(crate) async fn folder_match_evidence(
    db: &Db,
    client: &reqwest::Client,
    folder: &Path,
    allow_api: bool,
) -> Option<(String, String, Option<i32>, Option<i32>)> {
    let f = folder.to_path_buf();
    let (info, sj) = tokio::task::spawn_blocking(move || {
        let first = crate::converter::first_comic_file(&f);
        let info = first.as_ref().and_then(|p| parse_comic_info(p));
        let sj = read_series_json(&f);
        (info, sj)
    })
    .await
    .ok()?;

    let mut derived = info.as_ref().map(derive_meta);
    if let Some(sj_id) = sj.as_ref().and_then(|j| j.comicid) {
        match derived.as_mut() {
            Some(d) => {
                if d.cv_id.is_none() && d.metron_id.is_none() {
                    d.cv_id = Some(sj_id as i32);
                    d.recompute_resolved();
                }
            }
            None => {
                derived = Some(DerivedMeta {
                    cv_id: Some(sj_id as i32),
                    metron_id: None,
                    cv_issue_id: None,
                    metron_issue_id: None,
                    metadata_id: Some(sj_id.to_string()),
                    metadata_issue_id: None,
                    metadata_source: "COMICVINE".to_string(),
                    is_manga: false,
                    parsed_year: sj.as_ref().and_then(|j| j.year),
                });
            }
        }
    }
    if allow_api {
        if let Some(d) = derived.as_mut() {
            if d.metadata_id.is_none() {
                let name = info.as_ref().and_then(|i| i.series.as_deref()).map(str::trim).filter(|s| !s.is_empty())
                    .or_else(|| sj.as_ref().and_then(|j| j.name.as_deref()));
                resolve_dynamic_ids(db, client, d, name).await;
            }
        }
    }
    derived.and_then(|d| d.metadata_id.clone().map(|id| (d.metadata_source.clone(), id, d.cv_id, d.metron_id)))
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

    // Notes fallback (discussion #177): older ComicTagger/Mylar files carry the provider issue id
    // only inside <Notes> ("[Issue ID 123456]" / "[CVDB987]") — no Web URL, no dedicated tags.
    if cv_issue_id.is_none() && metron_issue_id.is_none() {
        if let Some(notes) = &info.notes {
            let (cv_n, metron_n) = notes_issue_ids(notes);
            cv_issue_id = cv_n;
            metron_issue_id = metron_n;
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

/// Offline sanity for embedded issue ids (issue #194 (c2)): within one folder, the same provider
/// issue id claimed by files with DIFFERENT issue numbers is provably wrong for at least one of
/// them (an earlier Omnibus bug wrote crossed ids into ComicInfo.xml — a poisoned file must not
/// take a fresh library hostage). An id's TRUE number can't be verified without an API call (the
/// zero-API scan invariant), but this collision is detectable for free. Conflicted ids are ignored
/// at import (rows land as unmatched_*) and the first sync's number-anchored pairing links them
/// correctly by number.
pub(crate) fn folder_conflicted_issue_ids(
    id_nums: &[(Option<String>, String)],
) -> std::collections::HashSet<String> {
    let mut first_num: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    let mut conflicted: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (id, num) in id_nums {
        let Some(id) = id.as_deref() else { continue };
        match first_num.get(id) {
            Some(seen) if !crate::metadata::is_same_issue(seen, num) => { conflicted.insert(id.to_string()); }
            Some(_) => {}
            None => { first_num.insert(id, num); }
        }
    }
    conflicted
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
        let api_key = crate::secret_crypto::decrypt_setting(&db.pool, api_key).await;
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
        if let Some(auth) = crate::metadata::metron_auth(&db.pool).await {
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
/// Consumes `series` as a case/punctuation-insensitive PREFIX of `file_name`, returning the
/// remainder — or None when the series name isn't a clean prefix (including when a token would be
/// glued into a longer word: series "No" must never half-consume "Nova"). Tokens are the series
/// name's ASCII-alphanumeric runs, so "Kaiju No. 8" matches "Kaiju No.8", "kaiju_no_8", etc.
/// Non-ASCII series names yield no tokens and never strip — a safe no-op.
fn strip_series_prefix(file_name: &str, series: &str) -> Option<String> {
    let tokens: Vec<String> = series
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    let fb = file_name.as_bytes();
    let mut i = 0usize;
    for tok in &tokens {
        while i < fb.len() && !fb[i].is_ascii_alphanumeric() {
            i += 1;
        }
        if i + tok.len() > fb.len() || !file_name[i..i + tok.len()].eq_ignore_ascii_case(tok) {
            return None;
        }
        i += tok.len();
        if i < fb.len() && fb[i].is_ascii_alphanumeric() {
            return None; // glue guard
        }
    }
    Some(file_name[i..].to_string())
}

fn issue_number_from_filename(file_name: &str, series_hint: Option<&str>) -> String {
    // Issue #200: "#½" must parse as "#0.5" instead of falling through every digit rule to the
    // "1" default. Normalized once here (idempotent through the recursive hint call below).
    let normalized = crate::metadata::normalize_fraction_numbers(file_name);
    let file_name = normalized.as_str();
    // 2026-07-25 worklist item 9 (Kaiju No. 8): digits that belong to the TITLE must not be read as
    // issue numbers. When the caller knows the series, its name is stripped as a prefix first; a
    // filename that IS just the series name parses as a one-shot ("1") instead of the title digit.
    // Parity twin: src/lib/utils/issue-parser.ts extractIssueNumber.
    if let Some(series) = series_hint {
        if let Some(rest) = strip_series_prefix(file_name, series) {
            if rest != file_name {
                if rest.bytes().any(|b| b.is_ascii_digit()) {
                    return issue_number_from_filename(&rest, None);
                }
                return "1".to_string();
            }
        }
    }
    issue_number_from_filename_unhinted(file_name)
}

fn issue_number_from_filename_unhinted(file_name: &str) -> String {
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
// Batched scan writes (issue #183)
// ============================================================================
// A 37k-issue scan used to issue every INSERT/UPDATE as its own autocommitting statement —
// tens of thousands of separate commits, each grabbing the shared SQLite write lock that the
// Node app also needs, which is what made the web UI unresponsive during big scans. All scan
// phases now GATHER first (all file I/O — page counts, unrar spawns, image decodes — happens
// outside any transaction) and then FLUSH in short chunked transactions.
//
// INVARIANT: never perform file I/O or network calls between begin() and commit(). A chunk
// holds the write lock only for pure in-memory statement execution, so the Node app's own
// writes interleave between chunks instead of starving for the whole scan.

/// Rows per flush transaction. Small enough that the write lock is held for milliseconds,
/// large enough to collapse ~48k autocommits into a few hundred commits on a big scan.
const WRITE_CHUNK: usize = 250;

/// One fully-prepared Issue INSERT — everything 5A/5B derive per file, including the
/// page count, computed BEFORE the write transaction opens.
struct NewIssueRow {
    issue_id: String,
    series_id: String,
    meta_id: String,
    source: String,
    match_state: &'static str,
    number: String,
    file: String,
    page_count: i32,
    fm: IssueFileMeta,
}

/// A deferred 5B write: either a brand-new issue or a repoint of an existing row whose
/// file was renamed/moved (same-number dedupe).
enum PendingIssueWrite {
    Insert(Box<NewIssueRow>),
    Repoint { issue_id: String, file: String, page_count: i32 },
}

/// The shared 5A/5B Issue INSERT (identical statement, previously duplicated inline).
/// Runs on a transaction connection — see the no-I/O-in-transaction invariant above.
async fn exec_issue_insert(
    conn: &mut sqlx::AnyConnection,
    db: &Db,
    row: &NewIssueRow,
) -> Result<(), sqlx::Error> {
    // blackAndWhite is a SQL literal, not a bind — pg's boolean column has no portable Any bool
    // bind (the 5H lesson); TRUE/FALSE/NULL literals parse on both backends.
    let bw = match row.fm.black_and_white { Some(true) => "true", Some(false) => "false", None => "NULL" };
    sqlx::query(&format!(
        r#"INSERT INTO "Issue"
           (id, "seriesId", "metadataId", "metadataSource", "matchState", number, status, "filePath", "pageCount",
            name, description, "releaseDate", genres, writers, artists, "coverArtists", colorists, letterers, characters, teams, locations, "storyArcs", inker, editor, translator,
            tags, "mainCharacterOrTeam", "alternateSeries", "alternateNumber", "alternateCount", "storyArcNumber", gtin, notes, "scanInformation", review, "communityRating", "blackAndWhite",
            "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, 'DOWNLOADED', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, {bw}, {now}, {now})"#,
        bw = bw,
        now = db.now_expr()
    ))
    .bind(&row.issue_id)
    .bind(&row.series_id)
    .bind(&row.meta_id)
    .bind(&row.source)
    .bind(row.match_state)
    .bind(&row.number)
    .bind(&row.file)
    .bind(row.page_count)
    .bind(&row.fm.name)
    .bind(&row.fm.description)
    .bind(&row.fm.release_date)
    .bind(&row.fm.genres)
    .bind(&row.fm.writers)
    .bind(&row.fm.artists)
    .bind(&row.fm.cover_artists)
    .bind(&row.fm.colorists)
    .bind(&row.fm.letterers)
    .bind(&row.fm.characters)
    .bind(&row.fm.teams)
    .bind(&row.fm.locations)
    .bind(&row.fm.story_arcs)
    .bind(&row.fm.inker)
    .bind(&row.fm.editor)
    .bind(&row.fm.translator)
    .bind(&row.fm.tags)
    .bind(&row.fm.main_character_or_team)
    .bind(&row.fm.alternate_series)
    .bind(&row.fm.alternate_number)
    .bind(row.fm.alternate_count)
    .bind(&row.fm.story_arc_number)
    .bind(&row.fm.gtin)
    .bind(&row.fm.notes)
    .bind(&row.fm.scan_information)
    .bind(&row.fm.review)
    .bind(row.fm.community_rating)
    .execute(&mut *conn)
    .await
    .map(|_| ())
}

/// Open a flush transaction, logging (not propagating) failure — scan phases skip a chunk that
/// can't get a transaction rather than aborting the whole scan, matching the per-row error
/// posture the autocommit code had.
async fn begin_write_tx(db: &Db, phase: &str) -> Option<sqlx::Transaction<'static, sqlx::Any>> {
    match db.pool.begin().await {
        Ok(t) => Some(t),
        Err(e) => {
            log::error!("[Scan] Failed to open {} write transaction: {:?}", phase, e);
            None
        }
    }
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
    let (manga_pubs, western_pubs) = crate::manga_detector::get_detector_settings(&db.pool).await;

    // ---------------------------------------------------------
    // 5A. NEW FOLDERS → new Series + Issues, matched from the first archive's ComicInfo.xml
    // ---------------------------------------------------------
    // Parse each new folder's first-archive ComicInfo in parallel (bounded to CPU count), then insert sequentially.
    let cfg = crate::engine_config::EngineConfig::load(&db.pool).await;
    let parse_sem = Arc::new(Semaphore::new(cfg.scan_workers));

    // Series name / year / publisher derivation, shared by the parallel phase (for manga detection) and
    // the insert loop, so the two can't drift.
    // Identity precedence (discussion #177): per-file ComicInfo -> folder series.json -> folder name.
    fn derive_folder_basics(info: Option<&ScanComicInfo>, sj: Option<&SeriesJsonInfo>, folder_name: &str) -> (String, i32, String) {
        let derived = info.map(derive_meta);
        let clean_name = info.and_then(|i| i.series.clone()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
            .or_else(|| sj.and_then(|j| j.name.clone()))
            .unwrap_or_else(|| {
                let stripped = trailing_year_re().replace(folder_name, "").trim().to_string();
                if stripped.is_empty() { "Unknown Series".to_string() } else { stripped }
            });
        let year = derived.as_ref().and_then(|d| d.parsed_year)
            .or_else(|| sj.and_then(|j| j.year))
            .or_else(|| any_year_re().captures(folder_name).and_then(|c| c[1].parse::<i32>().ok()))
            .unwrap_or(0);
        let publisher = info.and_then(|i| i.publisher.clone()).map(|p| p.trim().to_string()).filter(|p| !p.is_empty())
            .or_else(|| sj.and_then(|j| j.publisher.clone()))
            .unwrap_or_else(|| "Other".to_string());
        (clean_name, year, publisher)
    }

    struct ParsedFolder {
        folder_path: String,
        files: Vec<String>,
        /// Per-file ComicInfo, index-aligned with `files` — each issue carries its OWN identity and
        /// narrative metadata (previously only the first archive was parsed, which stamped the first
        /// issue's provider id onto every issue in the folder — discussion #177).
        infos: Vec<Option<ScanComicInfo>>,
        /// Folder-level Mylar-spec series.json, when present.
        sj: Option<SeriesJsonInfo>,
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

            // Parse EVERY file's ComicInfo (not just the first) plus the folder's series.json in one
            // blocking task — per-issue identity/metadata and a zero-API series id (discussion #177).
            let fp = folder_path.clone();
            let fl = files.clone();
            let (infos, sj) = tokio::task::spawn_blocking(move || {
                let infos: Vec<Option<ScanComicInfo>> = fl.iter().map(|f| parse_comic_info(Path::new(f))).collect();
                let sj = read_series_json(Path::new(&fp));
                (infos, sj)
            })
            .await
            .unwrap_or((Vec::new(), None));

            let folder_name = Path::new(&folder_path).file_name().unwrap_or_default().to_string_lossy().to_string();
            let first_info = infos.first().and_then(|o| o.as_ref());
            let (clean_name, year, publisher) = derive_folder_basics(first_info, sj.as_ref(), &folder_name);
            // 3-tier manga detection runs HERE (in the bounded parallel phase) instead of one-at-a-time in
            // the sequential insert loop below — otherwise the AniList HTTP call (10s timeout, 3rd tier)
            // serialized across every unknown-publisher folder during a large first scan.
            let comicinfo_manga = first_info.map(derive_meta).map(|d| d.is_manga).unwrap_or(false);
            let is_manga = if comicinfo_manga || lib_is_manga {
                true
            } else {
                crate::manga_detector::detect_manga(&client, &clean_name, &publisher, year, &manga_pubs, &western_pubs).await
            };

            ParsedFolder { folder_path, files, infos, sj, clean_name, year, publisher, is_manga }
        });
    }
    let mut parsed_folders: Vec<ParsedFolder> = Vec::new();
    while let Some(res) = folder_parse_set.join_next().await {
        if let Ok(t) = res { parsed_folders.push(t); }
    }

    for pf in parsed_folders {
        let ParsedFolder { folder_path, files, infos, sj, clean_name, year, publisher, is_manga } = pf;

        log::debug!("[Scanner Debug] Indexing new folder ({} archives): {}", files.len(), folder_path);

        let first_info = infos.first().and_then(|o| o.as_ref());
        let mut derived = first_info.map(derive_meta);

        // series.json identity (discussion #177): the Mylar-spec comicid is the ComicVine VOLUME id —
        // a direct match with ZERO API calls that also covers RAR/CBR folders (ComicInfo unreadable).
        // ComicInfo ids (when present) still take precedence; series.json fills the gap.
        if let Some(sj_id) = sj.as_ref().and_then(|j| j.comicid) {
            match derived.as_mut() {
                Some(d) => {
                    if d.cv_id.is_none() && d.metron_id.is_none() {
                        d.cv_id = Some(sj_id as i32);
                        d.recompute_resolved();
                        log::debug!("[Scanner Debug] series.json comicid {} matched folder {}.", sj_id, folder_path);
                    }
                }
                None => {
                    derived = Some(DerivedMeta {
                        cv_id: Some(sj_id as i32),
                        metron_id: None,
                        cv_issue_id: None,
                        metron_issue_id: None,
                        metadata_id: Some(sj_id.to_string()),
                        metadata_issue_id: None,
                        metadata_source: "COMICVINE".to_string(),
                        is_manga: false,
                        parsed_year: sj.as_ref().and_then(|j| j.year),
                    });
                    log::debug!("[Scanner Debug] series.json comicid {} matched folder {} (no readable ComicInfo).", sj_id, folder_path);
                }
            }
        }

        // Dynamic resolution (parity with parseComicInfo step 3): files tagged with only an issue id
        // get their owning volume/series id resolved live, so they land MATCHED. Sequential + cached —
        // one API call per unique series name/year across the whole scan. A series.json comicid above
        // already satisfies the volume id, so tagged Mylar libraries skip this entirely.
        if let Some(d) = derived.as_mut() {
            let series_name = first_info.and_then(|i| i.series.as_deref()).map(str::trim).filter(|s| !s.is_empty())
                .or_else(|| sj.as_ref().and_then(|j| j.name.as_deref()));
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
        let series_group = first_info
            .and_then(|i| i.series_group.clone())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        // ON CONFLICT DO NOTHING guards the @@unique([metadataSource, metadataId]) constraint —
        // a duplicate matched series is skipped (parity with Node's create-throws-then-skip).
        // Narrative series fields ride along from series.json when present (fill-at-create; the
        // provider sync's fill/never-clobber policies own later updates).
        let sj_description = sj.as_ref().and_then(|j| j.description.clone());
        let sj_status = sj.as_ref().and_then(|j| j.status.clone());
        let sj_booktype = sj.as_ref().and_then(|j| j.booktype.clone());

        // GATHER (file I/O): derive every issue row — including its page count, which may spawn
        // unrar — BEFORE any transaction opens. See the no-I/O-in-transaction invariant above.
        // Each issue carries its OWN provider identity + narrative metadata from its own ComicInfo
        // (discussion #177). The old shape stamped the FIRST archive's issue id onto every issue in
        // the folder — issue #2..#N all carried issue #1's provider id (marked MATCHED), so the
        // view-time enrichment fetched issue #1's credits for all of them until a sync self-healed.
        // Folder-level embedded-id collision check (issue #194 (c2)): the same issue id under two
        // different numbers means at least one file is mistagged — trust neither.
        let folder_id_nums: Vec<(Option<String>, String)> = files.iter().enumerate().map(|(idx, file)| {
            let fname = Path::new(file).file_name().unwrap_or_default().to_string_lossy().to_string();
            let finfo = infos.get(idx).and_then(|o| o.as_ref());
            (finfo.map(derive_meta).and_then(|d| d.metadata_issue_id), issue_number_for_file(finfo, &fname, Some(&clean_name)))
        }).collect();
        let conflicted_ids = folder_conflicted_issue_ids(&folder_id_nums);

        let mut issue_rows: Vec<NewIssueRow> = Vec::with_capacity(files.len());
        for (idx, file) in files.iter().enumerate() {
            let file_name = Path::new(file).file_name().unwrap_or_default().to_string_lossy().to_string();
            let file_info = infos.get(idx).and_then(|o| o.as_ref());
            let issue_num = issue_number_for_file(file_info, &file_name, Some(&clean_name));
            let file_derived = file_info.map(derive_meta);
            let fm = issue_file_meta(file_info);
            let (issue_meta_id, issue_source, issue_match_state) = match &file_derived {
                Some(d) if d.metadata_issue_id.as_deref().is_some_and(|id| conflicted_ids.contains(id)) => {
                    log::warn!("[Scanner] Embedded issue id {} appears under multiple issue numbers in this folder — ignoring it for \"{}\" (issue #194 guard); the next sync links by number.", d.metadata_issue_id.as_deref().unwrap_or(""), file_name);
                    (format!("unmatched_{}", Uuid::new_v4()), metadata_source.clone(), "UNMATCHED")
                }
                Some(d) if d.metadata_issue_id.is_some() => (
                    d.metadata_issue_id.clone().unwrap(),
                    d.metadata_source.clone(),
                    scanned_issue_match_state(&fm),
                ),
                _ => (format!("unmatched_{}", Uuid::new_v4()), metadata_source.clone(), "UNMATCHED"),
            };

            // pageCount feeds OPDS-PSE (pse:count) — without it every scanned issue reads "0 pages".
            let page_count = count_pages_blocking(file).await;

            issue_rows.push(NewIssueRow {
                issue_id: Uuid::new_v4().to_string(),
                series_id: series_id.clone(),
                meta_id: issue_meta_id,
                source: issue_source,
                match_state: issue_match_state,
                number: issue_num,
                file: file.clone(),
                page_count,
                fm,
            });
        }

        // FLUSH: one short transaction per folder — the Series row and all of its issues land
        // atomically. A folder is a natural chunk (typically well under WRITE_CHUNK files).
        let mut tx = match db.pool.begin().await {
            Ok(t) => t,
            Err(e) => {
                log::error!("[Scanner Debug] Failed to open write transaction for {}: {:?}", folder_path, e);
                continue;
            }
        };

        let insert_res = sqlx::query(&format!(
            r#"INSERT INTO "Series"
               (id, "folderPath", name, year, publisher, "metadataId", "metadataSource", "matchState", "cvId", "metronId", "isManga", "seriesGroup", "libraryId", description, status, "bookType", "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, {now}, {now})
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
        .bind(&sj_description)
        .bind(&sj_status)
        .bind(&sj_booktype)
        .execute(&mut *tx)
        .await;

        match insert_res {
            Ok(r) if r.rows_affected() == 0 => {
                log::debug!(
                    "[Scanner Debug] Skipping folder {} — a series already exists for ({}, {}).",
                    folder_path, metadata_source, series_meta_id
                );
                let _ = tx.rollback().await;
                continue;
            }
            Err(e) => {
                log::error!("[Scanner Debug] Failed to index folder {}: {:?}", folder_path, e);
                let _ = tx.rollback().await;
                continue;
            }
            Ok(_) => {}
        }

        let mut folder_issue_count = 0;
        for row in &issue_rows {
            if let Err(e) = exec_issue_insert(&mut tx, &db, row).await {
                log::error!("[Scanner Debug] Failed to insert issue for {}: {:?}", row.file, e);
                continue;
            }
            folder_issue_count += 1;
        }

        match tx.commit().await {
            Ok(()) => {
                series_inserted += 1;
                issues_inserted += folder_issue_count;
                log::info!("[Scan] Found and indexed new series: {} with {} issues.", clean_name, folder_issue_count);
            }
            Err(e) => {
                log::error!("[Scanner Debug] Commit failed for folder {} — its series/issues will index on the next scan: {:?}", folder_path, e);
            }
        }
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
    let mut series_meta_nums: std::collections::HashMap<String, Vec<(String, String)>> = std::collections::HashMap::new();
    if !involved_series.is_empty() {
        // Portable IN (...) list — see the ghost-purge note above on `= ANY($1)`.
        let ph = Db::in_placeholders(1, involved_series.len());
        let sql = format!(r#"SELECT "seriesId", id, number, "metadataId" FROM "Issue" WHERE "seriesId" IN ({})"#, ph);
        let mut q = sqlx::query(&sql);
        for sid in &involved_series {
            q = q.bind(sid);
        }
        let rows = q.fetch_all(&db.pool).await.unwrap_or_default();
        for r in rows {
            let sid = r.get::<String, _>("seriesId");
            series_issue_nums.entry(sid.clone()).or_default()
                .push((r.get::<String, _>("id"), r.get::<String, _>("number")));
            // (metadataId, number) per series for the embedded-id conflict check below (#194 (c2)).
            if let Ok(Some(mid)) = r.try_get::<Option<String>, _>("metadataId") {
                if !mid.is_empty() && !mid.starts_with("unmatched") {
                    series_meta_nums.entry(sid).or_default().push((mid, r.get::<String, _>("number")));
                }
            }
        }
    }

    // GATHER (file I/O): decide repoint-vs-insert and compute page counts for every file BEFORE
    // any transaction opens (invariant above). The dedupe fold-in stays order-dependent: a number
    // gathered earlier in this batch parks in series_issue_nums so a later same-number file
    // repoints against it instead of double-inserting, even though the INSERT itself flushes later.
    let mut pending_writes: Vec<PendingIssueWrite> = Vec::new();
    for (series_id, file, info) in parsed_files {
        let file_name = Path::new(&file).file_name().unwrap_or_default().to_string_lossy().to_string();
        // The folder-derived series name isn't in scope on this path (files landing in EXISTING
        // series); the file's own embedded ComicInfo series tag is the next-best title hint.
        let series_hint = info.as_ref().and_then(|i| i.series.as_deref().map(|s| s.to_string()));
        let issue_num = issue_number_for_file(info.as_ref(), &file_name, series_hint.as_deref());

        // Dedupe against the series' existing issues by number. On a match the file was renamed/moved —
        // repoint the existing row's filePath rather than inserting a second row for the same issue.
        let dup_id: Option<String> = series_issue_nums.get(&series_id)
            .and_then(|v| v.iter().find(|(_, n)| crate::metadata::is_same_issue(n, &issue_num)).map(|(id, _)| id.clone()));
        if let Some(eid) = dup_id {
            // Repointed file: refresh the page count too (a 0-count row may finally have a readable zip).
            let page_count = count_pages_blocking(&file).await;
            pending_writes.push(PendingIssueWrite::Repoint { issue_id: eid, file, page_count });
            continue;
        }

        // Narrative metadata from the file's own ComicInfo (discussion #177) — same as 5A.
        let fm = issue_file_meta(info.as_ref());
        let derived = info.as_ref().map(derive_meta);
        let (issue_meta_id, issue_source, issue_match_state) = match &derived {
            Some(d) => match &d.metadata_issue_id {
                // #194 (c2): an embedded id already held by a same-series row with a DIFFERENT
                // number is provably mistagged for one of the two — don't import it; the next
                // sync's number-anchored pairing links this row correctly.
                Some(id) if series_meta_nums.get(&series_id).is_some_and(|v|
                    v.iter().any(|(mid, num)| mid == id && !crate::metadata::is_same_issue(num, &issue_num))
                ) => {
                    log::warn!("[Scanner] Embedded issue id {} on \"{}\" conflicts with an existing issue of a different number — ignoring it (issue #194 guard).", id, file_name);
                    (format!("unmatched_{}", Uuid::new_v4()), d.metadata_source.clone(), "UNMATCHED")
                }
                Some(id) => (id.clone(), d.metadata_source.clone(), scanned_issue_match_state(&fm)),
                None => (format!("unmatched_{}", Uuid::new_v4()), d.metadata_source.clone(), "UNMATCHED"),
            },
            None => (format!("unmatched_{}", Uuid::new_v4()), "LOCAL".to_string(), "UNMATCHED"),
        };

        let issue_id = Uuid::new_v4().to_string();
        let page_count = count_pages_blocking(&file).await;
        // Track the number so another file with the same number later in this batch dedupes
        // against it instead of inserting a second row.
        series_issue_nums.entry(series_id.clone()).or_default().push((issue_id.clone(), issue_num.clone()));
        pending_writes.push(PendingIssueWrite::Insert(Box::new(NewIssueRow {
            issue_id,
            series_id,
            meta_id: issue_meta_id,
            source: issue_source,
            match_state: issue_match_state,
            number: issue_num,
            file,
            page_count,
            fm,
        })));
    }

    // FLUSH in short chunked transactions (invariant above: no file I/O from here to commit).
    for chunk in pending_writes.chunks(WRITE_CHUNK) {
        let mut tx = match db.pool.begin().await {
            Ok(t) => t,
            Err(e) => {
                log::error!("[Scanner Debug] Failed to open 5B write transaction: {:?}", e);
                continue;
            }
        };
        let mut chunk_inserted = 0;
        for write in chunk {
            match write {
                PendingIssueWrite::Repoint { issue_id, file, page_count } => {
                    if let Err(e) = sqlx::query(&format!(
                        r#"UPDATE "Issue" SET "filePath"=$1, status='DOWNLOADED',
                               "pageCount"=CASE WHEN $2 > 0 THEN $2 ELSE "pageCount" END,
                               "updatedAt"={now} WHERE id=$3"#,
                        now = db.now_expr()
                    ))
                    .bind(file).bind(*page_count).bind(issue_id).execute(&mut *tx).await
                    {
                        log::error!("[Scanner Debug] Failed to repoint existing issue {}: {:?}", file, e);
                    }
                }
                PendingIssueWrite::Insert(row) => {
                    if let Err(e) = exec_issue_insert(&mut tx, &db, row).await {
                        log::error!("[Scanner Debug] Failed to append issue {}: {:?}", row.file, e);
                    } else {
                        chunk_inserted += 1;
                    }
                }
            }
        }
        match tx.commit().await {
            Ok(()) => issues_inserted += chunk_inserted,
            Err(e) => log::error!("[Scanner Debug] 5B chunk commit failed — {} write(s) deferred to the next scan: {:?}", chunk.len(), e),
        }
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
            // GATHER the rendered covers, then FLUSH the URL updates in chunked transactions
            // (the renders above are the file I/O — none of it happens inside a transaction).
            let mut cover_updates: Vec<(String, String)> = Vec::new();
            while let Some(res) = cover_set.join_next().await {
                if let Ok(Some(pair)) = res { cover_updates.push(pair); }
            }
            let mut covered = 0;
            for chunk in cover_updates.chunks(WRITE_CHUNK) {
                let Some(mut tx) = begin_write_tx(&db, "5C cover").await else { continue };
                let mut n = 0;
                for (id, url) in chunk {
                    if sqlx::query(r#"UPDATE "Series" SET "coverUrl" = $1 WHERE id = $2"#)
                        .bind(url).bind(id).execute(&mut *tx).await.is_ok()
                    {
                        n += 1;
                    }
                }
                if tx.commit().await.is_ok() { covered += n; }
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
                // count_archive_pages, not count_zip_pages: this backfill is what heals RAR
                // libraries scanned by pre-native-reading builds (the Panels "0 pages" fix).
                let count = tokio::task::spawn_blocking(move || {
                    crate::converter::count_archive_pages(Path::new(&file_path))
                })
                .await
                .ok()
                .flatten();
                (id, count)
            });
        }
        // GATHER counts (the archive reads above), then FLUSH in chunked transactions.
        let mut count_updates: Vec<(String, i32)> = Vec::new();
        while let Some(res) = count_set.join_next().await {
            if let Ok((id, Some(count))) = res {
                if count > 0 { count_updates.push((id, count)); }
            }
        }
        let mut backfilled = 0;
        for chunk in count_updates.chunks(WRITE_CHUNK) {
            let Some(mut tx) = begin_write_tx(&db, "5D page-count").await else { continue };
            let mut n = 0;
            for (id, count) in chunk {
                if sqlx::query(r#"UPDATE "Issue" SET "pageCount" = $1 WHERE id = $2"#)
                    .bind(count).bind(id).execute(&mut *tx).await.is_ok()
                {
                    n += 1;
                }
            }
            if tx.commit().await.is_ok() { backfilled += n; }
        }
        if backfilled > 0 { log::info!("[Scan] Backfilled page counts for {} issue(s).", backfilled); }
    }

    // ---------------------------------------------------------
    // 5E. SERIES GENRES FROM FILES (discussion #182 — local-first ingest)
    // ---------------------------------------------------------
    // The series-level genres column previously only ever came from a provider sync. A tagged
    // library already carries genres per issue (ComicInfo <Genre>), so blank series columns fill
    // with the DISTINCT union of their own issues' genres — fill-blank only; a provider or manual
    // value always wins. Without this, the sync's new file-completeness skip would leave tagged
    // libraries without series genres forever.
    let genre_rows = sqlx::query(
        r#"SELECT s.id AS sid, i.genres AS g FROM "Issue" i
           JOIN "Series" s ON i."seriesId" = s.id
           WHERE s."libraryId" = $1 AND (s.genres IS NULL OR s.genres = '' OR s.genres = '[]')
             AND i.genres IS NOT NULL AND i.genres <> '[]'"#,
    )
    .bind(&library_id)
    .fetch_all(&db.pool)
    .await
    .unwrap_or_default();

    if !genre_rows.is_empty() {
        let mut per_series: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        for row in &genre_rows {
            let sid: String = row.get("sid");
            let g: String = row.try_get("g").unwrap_or_default();
            if let Ok(list) = serde_json::from_str::<Vec<String>>(&g) {
                let bucket = per_series.entry(sid).or_default();
                for genre in list {
                    let t = genre.trim().to_string();
                    if !t.is_empty() && !bucket.iter().any(|x| x == &t) {
                        bucket.push(t);
                    }
                }
            }
        }
        let genre_updates: Vec<(String, String)> = per_series.into_iter()
            .filter(|(_, genres)| !genres.is_empty())
            .filter_map(|(sid, genres)| serde_json::to_string(&genres).ok().map(|json| (json, sid)))
            .collect();
        let mut genre_filled = 0;
        for chunk in genre_updates.chunks(WRITE_CHUNK) {
            let Some(mut tx) = begin_write_tx(&db, "5E genres").await else { continue };
            let mut n = 0;
            for (json, sid) in chunk {
                // Blank-guard re-checked in the UPDATE — a concurrent sync writing real provider
                // genres between our SELECT and now must not be clobbered.
                if sqlx::query(r#"UPDATE "Series" SET genres = $1 WHERE id = $2 AND (genres IS NULL OR genres = '' OR genres = '[]')"#)
                    .bind(json).bind(sid).execute(&mut *tx).await.is_ok()
                {
                    n += 1;
                }
            }
            if tx.commit().await.is_ok() { genre_filled += n; }
        }
        if genre_filled > 0 { log::info!("[Scan] Filled series genres from file metadata for {} series.", genre_filled); }
    }

    // ---------------------------------------------------------
    // 5F. SERIES.JSON FILL-BLANKS FOR EXISTING SERIES (discussion #182 — local-first ingest)
    // ---------------------------------------------------------
    // The series INSERT above is ON CONFLICT DO NOTHING and 5B never touches an existing parent
    // Series row, so a series.json edited (or added) AFTER first index never re-flowed — the only
    // recourse was delete-and-rescan. Fill-only: blanks fill from the folder's series.json; any
    // existing value (provider, manual, or first-scan) always wins, so this can never clobber.
    let blank_series = sqlx::query(
        r#"SELECT id, "folderPath" FROM "Series"
           WHERE "libraryId" = $1 AND "folderPath" IS NOT NULL AND "folderPath" <> ''
             AND (description IS NULL OR description = ''
                  OR status IS NULL OR status = ''
                  OR "bookType" IS NULL OR "bookType" = ''
                  OR publisher IS NULL OR publisher = '' OR publisher = 'Other'
                  OR year IS NULL OR year = 0)"#,
    )
    .bind(&library_id)
    .fetch_all(&db.pool)
    .await
    .unwrap_or_default();

    if !blank_series.is_empty() {
        // Bounded-parallel series.json reads (tiny files, but the library may sit on a network
        // mount); series without one drop out here at the cost of a single failed open each.
        let sj_sem = Arc::new(Semaphore::new(cfg.scan_workers));
        let mut sj_set: JoinSet<Option<(String, SeriesJsonInfo)>> = JoinSet::new();
        for row in blank_series {
            let id: String = row.get("id");
            let folder: String = row.get("folderPath");
            let sem = sj_sem.clone();
            sj_set.spawn(async move {
                let _permit = sem.acquire_owned().await.ok();
                tokio::task::spawn_blocking(move || read_series_json(Path::new(&folder)).map(|sj| (id, sj)))
                    .await
                    .ok()
                    .flatten()
            });
        }
        // GATHER the series.json reads (network-mount I/O above), then FLUSH chunked.
        let mut sj_updates: Vec<(String, SeriesJsonInfo)> = Vec::new();
        while let Some(res) = sj_set.join_next().await {
            let Ok(Some((sid, sj))) = res else { continue };
            if sj.description.is_none() && sj.status.is_none() && sj.booktype.is_none()
                && sj.publisher.is_none() && sj.year.is_none()
            {
                continue;
            }
            sj_updates.push((sid, sj));
        }
        let mut sj_filled = 0;
        for chunk in sj_updates.chunks(WRITE_CHUNK) {
            let Some(mut tx) = begin_write_tx(&db, "5F series.json").await else { continue };
            let mut n = 0;
            for (sid, sj) in chunk {
                // Per-column blank guards live in the UPDATE itself (same reasoning as 5E), so a
                // concurrent provider sync writing a real value between our SELECT and now can't be
                // clobbered.
                if sqlx::query(series_json_fill_blanks_sql())
                .bind(&sj.description)
                .bind(&sj.status)
                .bind(&sj.booktype)
                .bind(&sj.publisher)
                .bind(sj.year)
                .bind(sid)
                .execute(&mut *tx)
                .await
                .is_ok()
                {
                    n += 1;
                }
            }
            if tx.commit().await.is_ok() { sj_filled += n; }
        }
        if sj_filled > 0 { log::info!("[Scan] Re-flowed series.json fields into {} existing series (fill-blank only).", sj_filled); }
    }

    // ---------------------------------------------------------
    // 5G. RE-STAMP CREDIT-COMPLETE ISSUES (discussion #182 — local-first ingest)
    // ---------------------------------------------------------
    // Libraries scanned by pre-beta.090 builds carry issues whose ComicInfo credits already sit in
    // the DB but whose matchState stayed MATCHED — so opening each one still costs a provider call
    // and the file-complete sync skip never engages. Promote them the way today's scan would have
    // (scanned_issue_match_state): a real provider id + creative credits = enrichment-complete.
    match sqlx::query(restamp_credit_complete_sql())
        .bind(&library_id)
        .execute(&db.pool)
        .await
    {
        Ok(r) if r.rows_affected() > 0 => {
            log::info!("[Scan] Re-stamped {} credit-complete issue(s) to DEEP_SYNCED (no provider call needed on open).", r.rows_affected());
        }
        Ok(_) => {}
        Err(e) => log::warn!("[Scan] Credit-complete re-stamp failed: {:?}", e),
    }

    // ---------------------------------------------------------
    // 5H. COMICINFO SERIES DEFAULTS FROM FILES (#199 read-side)
    // ---------------------------------------------------------
    // The #199 series-wide ComicInfo defaults (imprint, ageRating, tags, credits-only-on-series, …)
    // are embedded into every issue's ComicInfo.xml by the writer but previously had no read path —
    // a DB wipe/rebuild lost them and pre-tagged foreign libraries never contributed them. The
    // fields are series-wide by definition, so ONE file speaks for the series: read one file-backed
    // issue's ComicInfo per candidate series (bounded-parallel, one small archive entry each) and
    // fill BLANK columns only — a provider, manual, or earlier value always wins.
    let ci_candidates = sqlx::query(comicinfo_defaults_candidates_sql())
        .bind(&library_id)
        .fetch_all(&db.pool)
        .await
        .unwrap_or_default();

    if !ci_candidates.is_empty() {
        let ci_sem = Arc::new(Semaphore::new(cfg.scan_workers));
        let mut ci_set: JoinSet<Option<(String, ComicInfoSeriesDefaults)>> = JoinSet::new();
        for row in ci_candidates {
            let sid: String = row.get("sid");
            let Some(fp) = row.try_get::<Option<String>, _>("fp").unwrap_or(None) else { continue };
            let sem = ci_sem.clone();
            ci_set.spawn(async move {
                let _permit = sem.acquire_owned().await.ok();
                tokio::task::spawn_blocking(move || {
                    parse_comic_info(Path::new(&fp)).map(|info| (sid, comicinfo_series_defaults(&info)))
                })
                .await
                .ok()
                .flatten()
            });
        }
        // GATHER the archive reads, then FLUSH chunked (the 5F pattern).
        let mut ci_updates: Vec<(String, ComicInfoSeriesDefaults)> = Vec::new();
        while let Some(res) = ci_set.join_next().await {
            let Ok(Some((sid, d))) = res else { continue };
            if d.has_any() {
                ci_updates.push((sid, d));
            }
        }
        let mut ci_filled = 0;
        for chunk in ci_updates.chunks(WRITE_CHUNK) {
            let Some(mut tx) = begin_write_tx(&db, "5H comicinfo defaults").await else { continue };
            let mut n = 0;
            for (sid, d) in chunk {
                let bw = match d.black_and_white { Some(true) => "true", Some(false) => "false", None => "NULL" };
                if sqlx::query(&comicinfo_defaults_fill_sql(bw))
                    .bind(&d.imprint)
                    .bind(&d.tags_json)
                    .bind(&d.format)
                    .bind(&d.language_iso)
                    .bind(&d.age_rating)
                    .bind(d.community_rating)
                    .bind(&d.gtin)
                    .bind(&d.notes)
                    .bind(&d.scan_information)
                    .bind(&d.review)
                    .bind(&d.main_character_or_team)
                    .bind(&d.alternate_series)
                    .bind(&d.alternate_number)
                    .bind(d.alternate_count)
                    .bind(&d.story_arc_number)
                    .bind(&d.inker_json)
                    .bind(&d.editor_json)
                    .bind(&d.translator_json)
                    .bind(sid)
                    .execute(&mut *tx)
                    .await
                    .is_ok()
                {
                    n += 1;
                }
            }
            if tx.commit().await.is_ok() { ci_filled += n; }
        }
        if ci_filled > 0 {
            log::info!("[Scan] Filled series ComicInfo defaults from file metadata for {} series (fill-blank only, #199).", ci_filled);
        }
    }

    // A big scan appends thousands of WAL frames; SQLite's passive auto-checkpoint often can't
    // drain them while the Node app keeps read snapshots open, and every reader slows as the WAL
    // grows (issue #183). Reclaim it now that the write burst is over. TRUNCATE waits on the
    // busy_timeout for stragglers and simply reports SQLITE_BUSY if readers won't yield — purely
    // opportunistic, so failure is logged and ignored.
    if db.dialect == Dialect::Sqlite {
        match sqlx::query("PRAGMA wal_checkpoint(TRUNCATE);").execute(&db.pool).await {
            Ok(_) => log::debug!("[Scan] WAL checkpoint (TRUNCATE) completed."),
            Err(e) => log::debug!("[Scan] WAL checkpoint skipped (readers active?): {:?}", e),
        }
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

    // ==== Discussion #182: local-first ingest — file-complete issues skip provider enrichment. ====

    #[test]
    fn scanned_issue_match_state_deep_syncs_credit_complete_files() {
        // No credits: the id is known but enrichment can still add value → MATCHED (lazy fetch stays).
        let fm = IssueFileMeta::default();
        assert_eq!(scanned_issue_match_state(&fm), "MATCHED");

        // Writers from ComicInfo → enrichment-complete; opening the issue must cost zero API calls.
        let fm = IssueFileMeta { writers: Some(r#"["Chip Zdarsky"]"#.to_string()), ..Default::default() };
        assert_eq!(scanned_issue_match_state(&fm), "DEEP_SYNCED");

        // Artists alone also count as creative credits.
        let fm = IssueFileMeta { artists: Some(r#"["Marco Checchetto"]"#.to_string()), ..Default::default() };
        assert_eq!(scanned_issue_match_state(&fm), "DEEP_SYNCED");

        // A summary without credits is NOT enrichment-complete.
        let fm = IssueFileMeta { description: Some("A synopsis".to_string()), ..Default::default() };
        assert_eq!(scanned_issue_match_state(&fm), "MATCHED");
    }

    #[test]
    fn compose_release_date_requires_year_and_month() {
        // Full Y/M/D → ISO date, zero-padded (lexical = chronological for the calendar index).
        assert_eq!(compose_release_date(Some(2011), Some(9), Some(21)).as_deref(), Some("2011-09-21"));
        // Missing/invalid day rounds to the 1st (cover-date convention; older ComicTagger omits Day).
        assert_eq!(compose_release_date(Some(2011), Some(9), None).as_deref(), Some("2011-09-01"));
        assert_eq!(compose_release_date(Some(2011), Some(9), Some(0)).as_deref(), Some("2011-09-01"));
        // Year alone is NOT a release date — taggers stamp <Year> with the series year on every
        // issue, and reading that back would fabricate per-issue dates.
        assert_eq!(compose_release_date(Some(2011), None, Some(21)), None);
        // Nonsense values never produce a date.
        assert_eq!(compose_release_date(Some(2011), Some(13), None), None);
        assert_eq!(compose_release_date(Some(0), Some(9), None), None);
        assert_eq!(compose_release_date(None, Some(9), Some(21)), None);
    }

    #[test]
    fn issue_file_meta_release_date_round_trips_embed_writer_output() {
        // The embed writer emits <Year>09</Year>-style zero-padded strings — they must parse back.
        let info = ScanComicInfo {
            year: Some("2016".to_string()),
            month: Some("03".to_string()),
            day: Some("09".to_string()),
            ..Default::default()
        };
        assert_eq!(issue_file_meta(Some(&info)).release_date.as_deref(), Some("2016-03-09"));
        // <Year> only (our own writer's series-year fallback) → no fabricated date.
        let year_only = ScanComicInfo { year: Some("2016".to_string()), ..Default::default() };
        assert!(issue_file_meta(Some(&year_only)).release_date.is_none());
    }

    #[test]
    fn issue_number_prefers_comicinfo_number_over_filename() {
        let with = |n: &str| ScanComicInfo { number: Some(n.to_string()), ..Default::default() };
        // ComicInfo <Number> is the tagger's ground truth — it outranks the filename guess.
        assert_eq!(issue_number_for_file(Some(&with("7")), "Saga 012.cbz", None), "7");
        // Normalized like the filename parser's output so is_same_issue dedupe matches both origins.
        assert_eq!(issue_number_for_file(Some(&with("007")), "x.cbz", None), "7");
        assert_eq!(issue_number_for_file(Some(&with("-001")), "x.cbz", None), "-1");
        assert_eq!(issue_number_for_file(Some(&with("00.5")), "x.cbz", None), "0.5");
        assert_eq!(issue_number_for_file(Some(&with("12a")), "x.cbz", None), "12a");
        assert_eq!(issue_number_for_file(Some(&with(" 4 ")), "x.cbz", None), "4");
        // Non-plain shapes are stored verbatim (the DB number column is a string).
        assert_eq!(issue_number_for_file(Some(&with("½")), "x.cbz", None), "½");
        assert_eq!(issue_number_for_file(Some(&with("1.MU")), "x.cbz", None), "1.MU");
        // Blank/absent <Number> falls back to filename parsing.
        assert_eq!(issue_number_for_file(Some(&with("  ")), "Saga 012.cbz", None), "12");
        assert_eq!(issue_number_for_file(None, "Saga 012.cbz", None), "12");
        assert_eq!(issue_number_for_file(Some(&ScanComicInfo::default()), "Batman #5.cbz", None), "5");
    }

    #[tokio::test]
    async fn restamp_promotes_only_matched_file_backed_credit_complete_issues() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(sqlx::any::install_default_drivers);
        let pool = sqlx::any::AnyPoolOptions::new()
            .max_connections(1) // each :memory: connection is its own DB — keep exactly one
            .connect("sqlite::memory:").await.unwrap();
        sqlx::query(r#"CREATE TABLE "Series" (id TEXT PRIMARY KEY, "libraryId" TEXT)"#)
            .execute(&pool).await.unwrap();
        sqlx::query(r#"CREATE TABLE "Issue" (id TEXT PRIMARY KEY, "seriesId" TEXT, "filePath" TEXT, "matchState" TEXT, "metadataId" TEXT, writers TEXT, artists TEXT)"#)
            .execute(&pool).await.unwrap();
        sqlx::query(r#"INSERT INTO "Series" (id, "libraryId") VALUES ('s1', 'lib1'), ('s2', 'lib2')"#)
            .execute(&pool).await.unwrap();

        for (id, sid, fp, ms, mid, w, a) in [
            // i1: MATCHED + file + real id + writers → PROMOTES (the pre-beta.090 scan shape).
            ("i1", "s1", Some("/a.cbz"), "MATCHED", "111", Some(r#"["Zdarsky"]"#), None::<&str>),
            // i2: artists alone also count as credits → PROMOTES.
            ("i2", "s1", Some("/b.cbz"), "MATCHED", "112", None, Some(r#"["Checchetto"]"#)),
            // i3: credits but an unmatched placeholder id → stays (no provider identity to trust).
            ("i3", "s1", Some("/c.cbz"), "MATCHED", "unmatched_x", Some(r#"["W"]"#), None),
            // i4: no credits → stays (enrichment can still add value).
            ("i4", "s1", Some("/d.cbz"), "MATCHED", "114", Some("[]"), Some("")),
            // i5: WANTED skeleton without a file → stays (never opened, not a lazy-fetch source).
            ("i5", "s1", None, "MATCHED", "115", Some(r#"["W"]"#), None),
            // i6: already DEEP_SYNCED → untouched.
            ("i6", "s1", Some("/e.cbz"), "DEEP_SYNCED", "116", Some(r#"["W"]"#), None),
            // i7: other library → out of scope for this scan.
            ("i7", "s2", Some("/f.cbz"), "MATCHED", "117", Some(r#"["W"]"#), None),
        ] {
            sqlx::query(r#"INSERT INTO "Issue" (id, "seriesId", "filePath", "matchState", "metadataId", writers, artists) VALUES ($1, $2, $3, $4, $5, $6, $7)"#)
                .bind(id).bind(sid).bind(fp).bind(ms).bind(mid).bind(w).bind(a)
                .execute(&pool).await.unwrap();
        }

        let res = sqlx::query(restamp_credit_complete_sql()).bind("lib1").execute(&pool).await.unwrap();
        assert_eq!(res.rows_affected(), 2, "exactly i1 + i2 promote");
        let promoted: Vec<String> = sqlx::query(r#"SELECT id FROM "Issue" WHERE "matchState" = 'DEEP_SYNCED' ORDER BY id"#)
            .fetch_all(&pool).await.unwrap()
            .iter().map(|r| r.get::<String, _>("id")).collect();
        assert_eq!(promoted, vec!["i1", "i2", "i6"]);
    }

    #[tokio::test]
    async fn series_json_fill_blanks_never_clobbers_existing_values() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(sqlx::any::install_default_drivers);
        let pool = sqlx::any::AnyPoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:").await.unwrap();
        sqlx::query(r#"CREATE TABLE "Series" (id TEXT PRIMARY KEY, description TEXT, status TEXT, "bookType" TEXT, publisher TEXT, year INTEGER)"#)
            .execute(&pool).await.unwrap();
        // s1: everything blank (publisher at the scan default 'Other', year 0) → all fill.
        // s2: everything already set → NOTHING moves, even though the file offers values.
        sqlx::query(r#"INSERT INTO "Series" VALUES ('s1', NULL, '', NULL, 'Other', 0), ('s2', 'kept', 'Ongoing', 'TPB', 'Marvel', 1999)"#)
            .execute(&pool).await.unwrap();

        for sid in ["s1", "s2"] {
            sqlx::query(series_json_fill_blanks_sql())
                .bind(Some("The Dark Knight.")).bind(Some("Ended")).bind(Some("Print"))
                .bind(Some("DC Comics")).bind(Some(2011))
                .bind(sid)
                .execute(&pool).await.unwrap();
        }
        let rows = sqlx::query(r#"SELECT * FROM "Series" ORDER BY id"#).fetch_all(&pool).await.unwrap();
        let s1 = &rows[0];
        assert_eq!(s1.get::<String, _>("description"), "The Dark Knight.");
        assert_eq!(s1.get::<String, _>("status"), "Ended");
        assert_eq!(s1.get::<String, _>("bookType"), "Print");
        assert_eq!(s1.get::<String, _>("publisher"), "DC Comics");
        assert_eq!(s1.get::<i64, _>("year"), 2011);
        let s2 = &rows[1];
        assert_eq!(s2.get::<String, _>("description"), "kept");
        assert_eq!(s2.get::<String, _>("status"), "Ongoing");
        assert_eq!(s2.get::<String, _>("bookType"), "TPB");
        assert_eq!(s2.get::<String, _>("publisher"), "Marvel");
        assert_eq!(s2.get::<i64, _>("year"), 1999);

        // A series.json missing every field (all-None binds) leaves a blank row blank — the
        // trailing self-reference in each COALESCE keeps NULL instead of erroring or fabricating.
        sqlx::query(r#"INSERT INTO "Series" VALUES ('s3', NULL, NULL, NULL, '', NULL)"#)
            .execute(&pool).await.unwrap();
        sqlx::query(series_json_fill_blanks_sql())
            .bind(None::<String>).bind(None::<String>).bind(None::<String>)
            .bind(None::<String>).bind(None::<i32>)
            .bind("s3")
            .execute(&pool).await.unwrap();
        let s3 = sqlx::query(r#"SELECT description, publisher FROM "Series" WHERE id = 's3'"#)
            .fetch_one(&pool).await.unwrap();
        assert_eq!(s3.get::<Option<String>, _>("description"), None);
        // The self-reference preserves the ORIGINAL blank ('' stays '', not NULL).
        assert_eq!(s3.get::<Option<String>, _>("publisher"), Some(String::new()));
    }

    // ==== Discussion #177: trust embedded file metadata (Mylar-migrated libraries). ====

    // #199 read-side: the two all-caps serde renames (LanguageISO, GTIN) are the regression risk —
    // PascalCase alone would derive LanguageIso/Gtin and silently read nothing.
    #[test]
    fn parse_comicinfo_reads_199_series_default_tags() {
        let xml = r#"<?xml version="1.0"?>
<ComicInfo>
  <Series>X</Series>
  <Imprint>Vertigo</Imprint>
  <Tags>ninja, school life</Tags>
  <Editor>Ed One</Editor>
  <Translator>Tr One</Translator>
  <Format>TPB</Format>
  <LanguageISO>it</LanguageISO>
  <AgeRating>Mature 17+</AgeRating>
  <CommunityRating>4.5</CommunityRating>
  <BlackAndWhite>Yes</BlackAndWhite>
  <GTIN>9781234567890</GTIN>
  <ScanInformation>Scanned by X</ScanInformation>
  <Review>Great</Review>
  <MainCharacterOrTeam>Batman</MainCharacterOrTeam>
  <AlternateSeries>Alt</AlternateSeries>
  <AlternateNumber>7A</AlternateNumber>
  <AlternateCount>6</AlternateCount>
  <StoryArcNumber>2</StoryArcNumber>
</ComicInfo>"#;
        let info: ScanComicInfo = quick_xml::de::from_str(xml).expect("parse 199 tags");
        assert_eq!(info.language_iso.as_deref(), Some("it"));
        assert_eq!(info.gtin.as_deref(), Some("9781234567890"));
        assert_eq!(info.imprint.as_deref(), Some("Vertigo"));
        assert_eq!(info.age_rating.as_deref(), Some("Mature 17+"));

        let d = comicinfo_series_defaults(&info);
        assert_eq!(d.tags_json.as_deref(), Some(r#"["ninja","school life"]"#));
        assert_eq!(d.editor_json.as_deref(), Some(r#"["Ed One"]"#));
        assert_eq!(d.translator_json.as_deref(), Some(r#"["Tr One"]"#));
        assert_eq!(d.community_rating, Some(4.5));
        assert_eq!(d.black_and_white, Some(true));
        assert_eq!(d.alternate_count, Some(6));
        assert_eq!(d.story_arc_number.as_deref(), Some("2"));
        assert!(d.has_any());
    }

    #[test]
    fn comicinfo_series_defaults_validation_and_junk_notes() {
        let info = ScanComicInfo {
            black_and_white: Some("Unknown".to_string()),
            community_rating: Some("9.9".to_string()),
            alternate_count: Some("six".to_string()),
            notes: Some("Tagged with ComicTagger 1.6 using info from Comic Vine".to_string()),
            ..Default::default()
        };
        let d = comicinfo_series_defaults(&info);
        assert_eq!(d.black_and_white, None, "Unknown never becomes a stored claim");
        assert_eq!(d.community_rating, Some(5.0), "clamped to ComicInfo's 0-5 range");
        assert_eq!(d.alternate_count, None, "garbage int stays unset");
        assert_eq!(d.notes, None, "tagger fingerprints never become the series note");

        let info2 = ScanComicInfo {
            black_and_white: Some("No".to_string()),
            notes: Some("A real curated note".to_string()),
            ..Default::default()
        };
        let d2 = comicinfo_series_defaults(&info2);
        assert_eq!(d2.black_and_white, Some(false), "an explicit foreign No is honored");
        assert_eq!(d2.notes.as_deref(), Some("A real curated note"));
    }

    #[test]
    fn parse_comic_info_reads_rar_archives() {
        // ComicInfo.xml must be readable from CBR/RAR too — a CBR-only tagged library previously got
        // NOTHING from ComicInfo at scan (zip-only reader), leaving series.json as the only evidence.
        // Fixture: tests/fixtures/comicinfo_pack.cbr (real RAR: ComicInfo.xml + one page). Skips when
        // unrar isn't on PATH (CI installs it; the Docker image ships it).
        if std::process::Command::new("unrar").arg("-?").output().is_err() {
            eprintln!("skipping: unrar not on PATH");
            return;
        }
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/comicinfo_pack.cbr");
        let info = parse_comic_info(&fixture).expect("ComicInfo should parse out of the RAR");
        assert_eq!(info.series.as_deref(), Some("Wolverine"));
        assert_eq!(info.title.as_deref(), Some("Trial by Fire"));
        assert_eq!(info.characters.as_deref(), Some("Wolverine, Nightcrawler"));

        let d = derive_meta(&info);
        // The Web URL issue id (4000-1071543) resolves; Notes corroborates it.
        assert_eq!(d.cv_issue_id, Some(1071543));
        assert_eq!(d.metadata_source, "COMICVINE");
    }

    #[test]
    fn parse_comic_info_reads_7z_archives() {
        // ComicInfo.xml must read out of a native .cb7 too (no conversion). Fixture
        // comicinfo_pack.cb7 carries the SAME ComicInfo.xml bytes as its .cbr twin, so the
        // assertions match. NO skip guard: the 7z decoder is pure Rust (sevenz-rust2).
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/comicinfo_pack.cb7");
        let info = parse_comic_info(&fixture).expect("ComicInfo should parse out of the 7z");
        assert_eq!(info.series.as_deref(), Some("Wolverine"));
        assert_eq!(info.title.as_deref(), Some("Trial by Fire"));
        assert_eq!(info.characters.as_deref(), Some("Wolverine, Nightcrawler"));

        let d = derive_meta(&info);
        assert_eq!(d.cv_issue_id, Some(1071543));
        assert_eq!(d.metadata_source, "COMICVINE");
    }

    #[test]
    fn series_json_parses_mylar_spec() {
        // The exact shape Omnibus's own metadata_writer exports (Mylar v1.0.2) — guaranteed round-trip.
        let mylar = r#"{
            "version": "1.0.2",
            "metadata": {
                "type": "comicSeries",
                "publisher": "DC Comics",
                "imprint": null,
                "name": "Batman",
                "comicid": 796,
                "year": 2011,
                "description_text": "The Dark Knight.",
                "description_formatted": null,
                "volume": null,
                "booktype": "Print",
                "age_rating": null,
                "collects": null,
                "comic_image": "",
                "total_issues": 57,
                "publication_run": "2011 - 2016",
                "status": "Ended"
            }
        }"#;
        let sj = parse_series_json(mylar).unwrap();
        assert_eq!(sj.comicid, Some(796));
        assert_eq!(sj.name.as_deref(), Some("Batman"));
        assert_eq!(sj.publisher.as_deref(), Some("DC Comics"));
        assert_eq!(sj.year, Some(2011));
        assert_eq!(sj.description.as_deref(), Some("The Dark Knight."));
        assert_eq!(sj.booktype.as_deref(), Some("Print"));
        assert_eq!(sj.status.as_deref(), Some("Ended"));

        // Mylar-in-the-wild variants: comicid as a string; "Continuing" maps to Ongoing.
        let cont = r#"{"metadata": {"comicid": "12345", "status": "Continuing"}}"#;
        let sj = parse_series_json(cont).unwrap();
        assert_eq!(sj.comicid, Some(12345));
        assert_eq!(sj.status.as_deref(), Some("Ongoing"));

        // Garbage / missing metadata object → None (never a half-parsed identity).
        assert!(parse_series_json("not json").is_none());
        assert!(parse_series_json(r#"{"version": "1.0.2"}"#).is_none());
        // comicid 0 / negative is not a real id.
        assert!(parse_series_json(r#"{"metadata": {"comicid": 0}}"#).unwrap().comicid.is_none());
    }

    #[test]
    fn notes_issue_ids_extract_comictagger_and_mylar_patterns() {
        // ComicTagger / Mylar long form (Comic Vine): "[Issue ID 123456]"
        assert_eq!(
            notes_issue_ids("Tagged with ComicTagger 1.6.0 using info from Comic Vine on 2023-01-01 12:00:00. [Issue ID 123456]"),
            (Some(123456), None)
        );
        // Newer ComicTagger short form: "[CVDB987]"
        assert_eq!(notes_issue_ids("Tagged with the ninjas.walk.alone fork [CVDB987]"), (Some(987), None));
        // Metron-tagged files own the plain "Issue ID" form when the notes name Metron.
        assert_eq!(notes_issue_ids("Tagged with ComicTagger using info from Metron on 2024-05-05. [Issue ID 55]"), (None, Some(55)));
        // No recognizable ids.
        assert_eq!(notes_issue_ids("hand-tagged, no provider"), (None, None));
    }

    #[test]
    fn derive_meta_falls_back_to_notes_issue_id() {
        // Files tagged with Notes-but-no-Web (older ComicTagger) must still resolve an issue id.
        let info = ScanComicInfo {
            notes: Some("Tagged with ComicTagger using info from Comic Vine [Issue ID 4242]".to_string()),
            ..Default::default()
        };
        let d = derive_meta(&info);
        assert_eq!(d.cv_issue_id, Some(4242));
        assert_eq!(d.metadata_source, "COMICVINE");
        assert_eq!(d.metadata_issue_id.as_deref(), Some("4242"));

        // Dedicated tags and the Web URL still outrank Notes.
        let info = ScanComicInfo {
            comic_vine_issue_id: Some("1".to_string()),
            notes: Some("[CVDB2]".to_string()),
            ..Default::default()
        };
        assert_eq!(derive_meta(&info).cv_issue_id, Some(1));
    }

    // ==== Issue #194 (c2): folder-level embedded-id collision guard ====

    #[test]
    fn folder_conflicted_ids_detect_cross_numbered_dupes() {
        let pairs = vec![
            (Some("821401".to_string()), "1".to_string()),
            (Some("821401".to_string()), "4".to_string()),   // same id under a different number → conflicted
            (Some("819000".to_string()), "2".to_string()),
            (Some("819000".to_string()), "002".to_string()), // padding-equivalent numbers → NOT a conflict
            (None, "3".to_string()),
        ];
        let c = folder_conflicted_issue_ids(&pairs);
        assert!(c.contains("821401"));
        assert!(!c.contains("819000"));
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn issue_file_meta_maps_comicinfo_narrative_fields() {
        let info = ScanComicInfo {
            title: Some("The Long Halloween".to_string()),
            summary: Some("A killer strikes on holidays.".to_string()),
            genre: Some("Crime, Super-Hero".to_string()),
            writer: Some("Jeph Loeb".to_string()),
            penciller: Some("Tim Sale".to_string()),
            inker: Some("Tim Sale, Someone Else".to_string()),
            cover_artist: Some("Tim Sale".to_string()),
            colorist: Some("Gregory Wright".to_string()),
            letterer: Some("Richard Starkings".to_string()),
            characters: Some("Batman, Harvey Dent".to_string()),
            teams: Some("GCPD".to_string()),
            locations: Some("Gotham City".to_string()),
            story_arc: Some("The Long Halloween".to_string()),
            ..Default::default()
        };
        let m = issue_file_meta(Some(&info));
        assert_eq!(m.name.as_deref(), Some("The Long Halloween"));
        assert_eq!(m.description.as_deref(), Some("A killer strikes on holidays."));
        assert_eq!(m.genres.as_deref(), Some(r#"["Crime","Super-Hero"]"#));
        assert_eq!(m.writers.as_deref(), Some(r#"["Jeph Loeb"]"#));
        // Call-3 Beta A: Penciller and Inker are separate buckets now — the old merge would
        // double-credit inkers once the embed emits a real <Inker> tag from the issue.
        assert_eq!(m.artists.as_deref(), Some(r#"["Tim Sale"]"#));
        assert_eq!(m.inker.as_deref(), Some(r#"["Tim Sale","Someone Else"]"#));
        assert_eq!(m.cover_artists.as_deref(), Some(r#"["Tim Sale"]"#));
        assert_eq!(m.colorists.as_deref(), Some(r#"["Gregory Wright"]"#));
        assert_eq!(m.letterers.as_deref(), Some(r#"["Richard Starkings"]"#));
        assert_eq!(m.characters.as_deref(), Some(r#"["Batman","Harvey Dent"]"#));
        assert_eq!(m.teams.as_deref(), Some(r#"["GCPD"]"#));
        assert_eq!(m.locations.as_deref(), Some(r#"["Gotham City"]"#));
        assert_eq!(m.story_arcs.as_deref(), Some(r#"["The Long Halloween"]"#));
        // Editor/Translator flow per-issue too (blank here → None, pinned below).
        assert!(m.editor.is_none() && m.translator.is_none());

        // Beta B: the per-issue remainder converts with the 5H rules (parse/clamp/tri-state)…
        let info_b = ScanComicInfo {
            tags: Some("noir, one-shot".to_string()),
            gtin: Some("9791234567897".to_string()),
            notes: Some("Tagged with ComicTagger 1.6".to_string()),
            alternate_series: Some("Legends of the Dark Knight".to_string()),
            alternate_number: Some("19B".to_string()),
            alternate_count: Some("6".to_string()),
            story_arc_number: Some("2".to_string()),
            scan_information: Some("ScanGroup v2".to_string()),
            review: Some("A classic.".to_string()),
            main_character_or_team: Some("Batman".to_string()),
            black_and_white: Some("No".to_string()),
            community_rating: Some("9.9".to_string()),
            ..Default::default()
        };
        let b = issue_file_meta(Some(&info_b));
        assert_eq!(b.tags.as_deref(), Some(r#"["noir","one-shot"]"#));
        assert_eq!(b.gtin.as_deref(), Some("9791234567897"));
        // Per-issue notes KEEP tagger fingerprints — that's the file's own provenance (unlike the
        // 5H series fill, which filters them as per-file noise).
        assert_eq!(b.notes.as_deref(), Some("Tagged with ComicTagger 1.6"));
        assert_eq!(b.alternate_series.as_deref(), Some("Legends of the Dark Knight"));
        assert_eq!(b.alternate_number.as_deref(), Some("19B"));
        assert_eq!(b.alternate_count, Some(6));
        assert_eq!(b.story_arc_number.as_deref(), Some("2"));
        assert_eq!(b.scan_information.as_deref(), Some("ScanGroup v2"));
        assert_eq!(b.review.as_deref(), Some("A classic."));
        assert_eq!(b.main_character_or_team.as_deref(), Some("Batman"));
        assert_eq!(b.black_and_white, Some(false), "an explicit No is honored per-issue");
        assert_eq!(b.community_rating, Some(5.0), "clamped to ComicInfo's 0-5 range");

        // Absent fields stay None — never a literal '[]' (the provider-sync fill policies key on NULL).
        let empty = issue_file_meta(Some(&ScanComicInfo::default()));
        assert!(empty.name.is_none() && empty.writers.is_none() && empty.genres.is_none());
        let none = issue_file_meta(None);
        assert!(none.name.is_none() && none.characters.is_none());
    }

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
        assert_eq!(issue_number_from_filename("Saga 2014 012.cbz", None), "12");
        assert_eq!(issue_number_from_filename("X-Men 1991 05.cbz", None), "5");
        assert_eq!(issue_number_from_filename("Batman 001 (2011).cbz", None), "1");
        assert_eq!(issue_number_from_filename("Series 2020.cbz", None), "1"); // only a year -> default
    }

    #[test]
    fn issue_number_markers() {
        assert_eq!(issue_number_from_filename("Spider-Man #15.cbz", None), "15");
        assert_eq!(issue_number_from_filename("Series #0.5.cbz", None), "0.5");
        // Issue #200: fraction filenames parse instead of defaulting to "1" (which collided a
        // renamed half-issue with the real #1). Parity with the Node #200 extractor tests.
        assert_eq!(issue_number_from_filename("X-Men #½ (1998).cbz", None), "0.5");
        assert_eq!(issue_number_from_filename("X-Men #½ (1998).cbz", Some("X-Men")), "0.5");
        assert_eq!(issue_number_from_filename("Wizard #1½.cbz", None), "1.5");
        assert_eq!(issue_number_from_filename("Chapter 7.cbz", None), "7");
        assert_eq!(issue_number_from_filename("Vol 3.cbz", None), "3");
        assert_eq!(issue_number_from_filename("007.cbz", None), "7");
        assert_eq!(issue_number_from_filename("Amazing Series 12a.cbz", None), "12a");
    }

    // Mirrors Node __tests__/lib/utils/issue-parser.test.ts (beta.023/035 negative-number support).
    #[test]
    fn issue_number_explicit_negatives() {
        assert_eq!(issue_number_from_filename("Spider-Man #-1.cbz", None), "-1");
        assert_eq!(issue_number_from_filename("Deadpool Issue -005.cbz", None), "-5");
        assert_eq!(issue_number_from_filename("X-Men Vol -2.cbz", None), "-2");
        assert_eq!(issue_number_from_filename("Batman (2016) Issue -1.cbz", None), "-1");
    }

    #[test]
    fn issue_number_title_separators_stay_positive() {
        assert_eq!(issue_number_from_filename("Spider-Man - 1.cbz", None), "1");
        assert_eq!(issue_number_from_filename("Batman - 002.cbz", None), "2");
        assert_eq!(issue_number_from_filename("Batman 2016 #001.cbz", None), "1");
    }

    // Worklist item 9 (Kaiju No. 8): the series-name hint keeps TITLE digits out of the issue
    // number. Without it, "Kaiju No.8 v01" parsed as issue 8 — the vol token was removed, the
    // bare-number sweep found the title's 8, and every volume collapsed into one dup-flagged row.
    #[test]
    fn series_hint_strips_title_digits_before_extraction() {
        assert_eq!(issue_number_from_filename("Kaiju No.8 v01.cbz", Some("Kaiju No. 8")), "1");
        assert_eq!(issue_number_from_filename("Kaiju No. 8 v02.cbz", Some("Kaiju No. 8")), "2");
        assert_eq!(issue_number_from_filename("Kaiju No. 8 - Chapter 105.cbz", Some("Kaiju No. 8")), "105");
        assert_eq!(issue_number_from_filename("Kaiju No.8 008.cbz", Some("Kaiju No. 8")), "8");
        // A file named exactly like the series is a one-shot, not the title digit.
        assert_eq!(issue_number_from_filename("Kaiju No. 8.cbz", Some("Kaiju No. 8")), "1");
        // Status quo without the hint (documents the pre-fix behavior for unhinted callers).
        assert_eq!(issue_number_from_filename("Kaiju No.8 v01.cbz", None), "8");
        // Not a prefix / glue guard: "No" must not half-consume "Nova"; unrelated hints no-op.
        assert_eq!(issue_number_from_filename("Nova 003.cbz", Some("No")), "3");
        assert_eq!(issue_number_from_filename("Batman 005.cbz", Some("Superman")), "5");
        assert_eq!(issue_number_from_filename("Batman 005 (2016).cbz", Some("Batman")), "5");
    }

    #[test]
    fn issue_number_prefers_trailing_numbers_over_volume_tokens() {
        assert_eq!(issue_number_from_filename("Uncanny X-Men-V1-001.cbz", None), "1");
        assert_eq!(issue_number_from_filename("Uncanny X-Men-V1-023.cbz", None), "23");
        assert_eq!(issue_number_from_filename("Uncanny X-Men-V1-066.cbz", None), "66");
        assert_eq!(issue_number_from_filename("Spider-Man v2 #5.cbz", None), "5");
        assert_eq!(issue_number_from_filename("Batman Vol 2 Issue 12.cbz", None), "12");
        // Volume only as the LAST resort.
        assert_eq!(issue_number_from_filename("Batman Vol 4.cbz", None), "4");
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
    // Dual-backend spike: the same end-to-end scan → re-scan → metadata-sync/embed flow runs
    // against a real Prisma-created database on EITHER backend through the Any pool.
    // Env-gated so normal `cargo test` runs skip them:
    //   OMNIBUS_SPIKE_DB     — SQLite file path (`prisma db push` of the sqlite-provider schema)
    //   OMNIBUS_SPIKE_LIB    — scratch library root for the SQLite run
    //   OMNIBUS_SPIKE_PG     — postgres:// URL (`prisma db push` of this repo's schema), e.g. a
    //                          throwaway container:
    //                          docker run --name omnibus-spike-pg -e POSTGRES_USER=spike \
    //                            -e POSTGRES_PASSWORD=spike -e POSTGRES_DB=spike \
    //                            -p 127.0.0.1:55432:5432 -d postgres:15-alpine
    //   OMNIBUS_SPIKE_PG_LIB — scratch library root for the Postgres run
    // Proves: Any-driver connect, $N binds, bool/i64/String/NULL decode, ON CONFLICT, the
    // per-dialect now/now-UTC/ISO expressions, scan idempotency, and the embed pipeline.
    // ------------------------------------------------------------------
    #[tokio::test]
    async fn sqlite_spike_end_to_end_scan() {
        let (Ok(db_path), Ok(lib_dir)) = (std::env::var("OMNIBUS_SPIKE_DB"), std::env::var("OMNIBUS_SPIKE_LIB")) else {
            eprintln!("OMNIBUS_SPIKE_DB / OMNIBUS_SPIKE_LIB unset — skipping SQLite spike test");
            return;
        };
        spike_end_to_end(&format!("file:{}", db_path), &lib_dir, crate::db::Dialect::Sqlite).await;
    }

    #[tokio::test]
    async fn postgres_spike_end_to_end_scan() {
        let (Ok(url), Ok(lib_dir)) = (std::env::var("OMNIBUS_SPIKE_PG"), std::env::var("OMNIBUS_SPIKE_PG_LIB")) else {
            eprintln!("OMNIBUS_SPIKE_PG / OMNIBUS_SPIKE_PG_LIB unset — skipping Postgres spike test");
            return;
        };
        spike_end_to_end(&url, &lib_dir, crate::db::Dialect::Postgres).await;
    }

    async fn spike_end_to_end(db_url: &str, lib_dir: &str, expected_dialect: crate::db::Dialect) {
        // Fixture: <lib>/Spike Series (2020)/Spike Series 001 (2020).cbz — a zip whose 3 image-named
        // entries make count_zip_pages report 3 (it counts entries, it never decodes).
        let series_dir = Path::new(lib_dir).join("Spike Series (2020)");
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

        let db = crate::db::Db::connect(db_url, 2).await.expect("Any-driver connect");
        assert_eq!(db.dialect, expected_dialect);
        let lib_dir = lib_dir.to_string();

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
        // is read as epoch-ms TEXT via a per-dialect expression: SQLite stores Prisma DateTime as
        // epoch-ms already; Postgres converts its timestamp with EXTRACT(EPOCH ...).
        let created_expr = match db.dialect {
            crate::db::Dialect::Sqlite => r#"CAST("createdAt" AS TEXT)"#,
            crate::db::Dialect::Postgres => r#"CAST(CAST(EXTRACT(EPOCH FROM "createdAt") * 1000 AS BIGINT) AS TEXT)"#,
        };
        let row = sqlx::query(&format!(r#"SELECT id, name, CAST("isManga" AS INTEGER) AS "isManga", "matchState", {created_expr} AS "createdAt" FROM "Series" WHERE "libraryId" = 'spike_lib'"#))
            .fetch_one(&db.pool).await.unwrap();
        assert_eq!(row.get::<String, _>("name"), "Spike Series");
        assert_eq!(row.get::<i64, _>("isManga"), 1, "isManga reads back as 1 through CAST");
        assert_eq!(row.get::<String, _>("matchState"), "UNMATCHED");
        // now_expr() must have written a sane "now" (sanity: within a day of the host clock).
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
        // read paths (Series bool/Option<bool> reads, Issue joins) against live rows.
        scan_library(db.clone(), lib_dir.clone(), "spike_lib".to_string(), None).await.expect("second scan");
        let series_count2: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM "Series" WHERE "libraryId" = 'spike_lib'"#)
            .fetch_one(&db.pool).await.unwrap();
        let issue_count2: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*) FROM "Issue" i JOIN "Series" s ON i."seriesId" = s.id WHERE s."libraryId" = 'spike_lib'"#,
        )
        .fetch_one(&db.pool).await.unwrap();
        assert_eq!(series_count2, 1, "re-scan must not duplicate the series");
        assert_eq!(issue_count2, 1, "re-scan must not duplicate the issue");

        // Ported metadata pipeline, no network needed: a LOCAL-source series skips the
        // provider fetch but still runs the CAST/ISO series select, the embed job (a REAL
        // ComicInfo.xml injection into the fixture cbz via metadata_writer), and the
        // updatedAt/lastMetadataSync bump through the per-dialect now/now-UTC expressions.
        let series_id_owned: String = row.get("id");
        crate::metadata::sync_metadata(db.clone(), Some(vec![series_id_owned.clone()]))
            .await
            .expect("sync_metadata through the Any pool");

        let last_sync: Option<String> = sqlx::query_scalar(&format!(
            r#"SELECT {} FROM "Series" WHERE id = $1"#,
            db.iso_utc_expr(r#""lastMetadataSync""#)
        ))
        .bind(&series_id_owned)
        .fetch_one(&db.pool)
        .await
        .expect("read lastMetadataSync via iso_utc_expr");
        let iso = last_sync.expect("lastMetadataSync set by sync_metadata");
        assert!(
            iso.len() == 20 && iso.ends_with('Z') && iso.contains('T'),
            "ISO-8601Z shape from iso_utc_expr, got {}",
            iso
        );

        let f = File::open(&cbz).unwrap();
        let mut za = ZipArchive::new(f).unwrap();
        let has_comicinfo = (0..za.len()).any(|i| {
            za.by_index(i).map(|e| e.name().eq_ignore_ascii_case("comicinfo.xml")).unwrap_or(false)
        });
        assert!(has_comicinfo, "embed job wrote ComicInfo.xml into the fixture cbz");
    }

    // ------------------------------------------------------------------
    // Discussion #182 Phase 3 acceptance: the full local-first round trip.
    //
    // A provider-synced library that has been embedded (ComicInfo.xml) and exported (series.json)
    // must survive a complete DB wipe — a rescan rebuilds the same series and issue rows from the
    // FILES ALONE, and the rebuilt series is file-complete so the scheduled sync never spends
    // provider calls on it. "Zero API" is structural: the test DB carries no provider credentials
    // (any accidental fetch would fail loudly), and the embedded ComicInfo carries the volume id,
    // so the scanner never even attempts dynamic resolution. Self-contained — a real file-backed
    // SQLite DB (a :memory: pool would give every connection its own database) and a real cbz.
    // ------------------------------------------------------------------
    #[tokio::test]
    async fn round_trip_embed_export_wipe_rescan_rebuilds_identically_with_zero_api() {
        let base = std::env::temp_dir().join(format!("omnibus_rt_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let series_dir = base.join("Batman (2011)");
        std::fs::create_dir_all(&series_dir).expect("create fixture series dir");

        // The filename deliberately says "001" while the DB (and therefore the embedded
        // ComicInfo <Number>) says "5" — the rescan must trust the tag, not the filename.
        let cbz = series_dir.join("Batman 001 (2011).cbz");
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

        let db_file = base.join("rt.db");
        File::create(&db_file).expect("pre-create sqlite file");
        let db_url = format!("file:{}", db_file.to_string_lossy().replace('\\', "/"));
        let db = crate::db::Db::connect(&db_url, 2).await.expect("connect file-backed sqlite");

        // Minimal Prisma-shaped schema — just the columns the scan/embed/export paths touch.
        for ddl in [
            r#"CREATE TABLE "Library" (id TEXT PRIMARY KEY, name TEXT, path TEXT, "isManga" INTEGER DEFAULT 0)"#,
            r#"CREATE TABLE "Request" ("volumeId" TEXT, status TEXT)"#,
            r#"CREATE TABLE "SystemSetting" (key TEXT PRIMARY KEY, value TEXT)"#,
            r#"CREATE TABLE "ReadProgress" ("issueId" TEXT)"#,
            r#"CREATE TABLE "Series" (id TEXT PRIMARY KEY, "folderPath" TEXT, name TEXT, year INTEGER, publisher TEXT,
                "metadataId" TEXT, "metadataSource" TEXT, "matchState" TEXT, "cvId" INTEGER, "metronId" INTEGER,
                "isManga" INTEGER DEFAULT 0, "seriesGroup" TEXT, "libraryId" TEXT, description TEXT, status TEXT,
                "bookType" TEXT, genres TEXT, universe TEXT, monitored INTEGER DEFAULT 0, "coverUrl" TEXT,
                "remoteCoverUrl" TEXT, "hasCustomCover" INTEGER DEFAULT 0, "seriesJsonWritten" INTEGER DEFAULT 0,
                writers TEXT, artists TEXT, "coverArtists" TEXT, colorists TEXT, letterers TEXT, characters TEXT,
                teams TEXT, locations TEXT, "storyArcs" TEXT, inker TEXT, editor TEXT, translator TEXT,
                imprint TEXT, tags TEXT, format TEXT, "languageISO" TEXT, "ageRating" TEXT,
                "communityRating" REAL, "blackAndWhite" INTEGER, gtin TEXT, notes TEXT, "scanInformation" TEXT,
                review TEXT, "mainCharacterOrTeam" TEXT, "alternateSeries" TEXT, "alternateNumber" TEXT,
                "alternateCount" INTEGER, "storyArcNumber" TEXT,
                "createdAt" TEXT, "updatedAt" TEXT, UNIQUE("metadataSource", "metadataId"))"#,
            r#"CREATE TABLE "Issue" (id TEXT PRIMARY KEY, "seriesId" TEXT, "metadataId" TEXT, "metadataSource" TEXT,
                "matchState" TEXT, number TEXT, status TEXT, "filePath" TEXT, "pageCount" INTEGER DEFAULT 0,
                name TEXT, description TEXT, "releaseDate" TEXT, genres TEXT, writers TEXT, artists TEXT,
                "coverArtists" TEXT, colorists TEXT, letterers TEXT, characters TEXT, teams TEXT, locations TEXT,
                "storyArcs" TEXT, inker TEXT, editor TEXT, translator TEXT,
                tags TEXT, "mainCharacterOrTeam" TEXT, "alternateSeries" TEXT, "alternateNumber" TEXT,
                "alternateCount" INTEGER, "storyArcNumber" TEXT, gtin TEXT, notes TEXT,
                "scanInformation" TEXT, review TEXT, "communityRating" REAL, "blackAndWhite" INTEGER,
                universe TEXT, "hasCustomMetadata" INTEGER DEFAULT 0, "hasCustomCover" INTEGER DEFAULT 0,
                "coverUrl" TEXT, "createdAt" TEXT, "updatedAt" TEXT)"#,
        ] {
            sqlx::query(ddl).execute(&db.pool).await.expect("create schema");
        }

        // Seed the state a provider sync would have left behind. Publisher "DC Comics" is in the
        // default western list, so manga detection short-circuits before its AniList network tier.
        let folder_str = series_dir.to_string_lossy().replace('\\', "/");
        let cbz_str = cbz.to_string_lossy().replace('\\', "/");
        sqlx::query(r#"INSERT INTO "Library" (id, name, path) VALUES ('rt_lib', 'RT', $1)"#)
            .bind(base.to_string_lossy().replace('\\', "/"))
            .execute(&db.pool).await.unwrap();
        sqlx::query(
            r#"INSERT INTO "Series" (id, "folderPath", name, year, publisher, "metadataId", "metadataSource",
                   "matchState", "cvId", "libraryId", description, status, "bookType", genres,
                   imprint, "ageRating", "communityRating", "blackAndWhite", tags, editor, "languageISO",
                   "storyArcNumber", notes)
               VALUES ('rt_series', $1, 'Batman', 2011, 'DC Comics', '796', 'COMICVINE',
                   'MATCHED', 796, 'rt_lib', 'The Dark Knight returns.', 'Ended', 'Print', '["Crime","Super-Hero"]',
                   'Black Label', 'Mature 17+', 4.5, 1, '["noir"]', '["Mark Doyle"]', 'en',
                   '2', 'Curated series note')"#,
        )
        .bind(&folder_str)
        .execute(&db.pool).await.unwrap();
        sqlx::query(
            r#"INSERT INTO "Issue" (id, "seriesId", "metadataId", "metadataSource", "matchState", number, status,
                   "filePath", "pageCount", name, description, "releaseDate", genres, writers, artists,
                   "coverArtists", colorists, letterers, characters, teams, locations, "storyArcs", inker,
                   gtin, "alternateNumber", "scanInformation")
               VALUES ('rt_issue', 'rt_series', '900001', 'COMICVINE', 'DEEP_SYNCED', '5', 'DOWNLOADED',
                   $1, 3, 'Night of the Owls', 'A conspiracy of owls.', '2012-05-09', '["Crime","Super-Hero"]',
                   '["Scott Snyder"]', '["Greg Capullo"]', '["Greg Capullo"]', '["FCO Plascencia"]',
                   '["Richard Starkings"]', '["Batman"]', '["Court of Owls"]', '["Gotham City"]',
                   '["Night of the Owls"]', '["Jonathan Glapion"]',
                   '9791234567897', '19B', 'ScanGroup v2')"#,
        )
        .bind(&cbz_str)
        .execute(&db.pool).await.unwrap();

        // -- 1. Embed + export. NO export_series_json row exists: this also proves the flipped
        //       default (absent = ON) end-to-end — the embed job must still write series.json.
        let (ok, fail, sj_count) = crate::metadata_writer::process_embed_job(
            db.clone(),
            crate::metadata_writer::EmbedRequest { series_id: Some("rt_series".to_string()), issue_ids: None },
        )
        .await
        .expect("embed job");
        assert_eq!((ok, fail, sj_count), (1, 0, 1), "ComicInfo embedded + series.json exported (default ON)");

        let sj_raw = std::fs::read_to_string(series_dir.join("series.json")).expect("series.json written");
        let sj: serde_json::Value = serde_json::from_str(&sj_raw).unwrap();
        assert_eq!(sj["metadata"]["comicid"], 796);
        assert_eq!(sj["metadata"]["status"], "Ended");
        // #199: the Mylar-spec slots now carry the Series defaults instead of hardcoded nulls.
        assert_eq!(sj["metadata"]["imprint"], "Black Label");
        assert_eq!(sj["metadata"]["age_rating"], "Mature 17+");
        // publication_run derives from Issue.releaseDate — the Phase 2 round-trip feeding this file.
        assert_eq!(sj["metadata"]["publication_run"], "May 2012 - May 2012");

        // -- 2. Wipe the database. The files are now the only source of truth.
        sqlx::query(r#"DELETE FROM "Issue""#).execute(&db.pool).await.unwrap();
        sqlx::query(r#"DELETE FROM "Series""#).execute(&db.pool).await.unwrap();

        // -- 3. Rescan from disk alone.
        scan_library(db.clone(), base.to_string_lossy().replace('\\', "/"), "rt_lib".to_string(), None)
            .await
            .expect("rescan after wipe");

        // -- 4. The series came back identical, from ComicInfo + series.json.
        let s = sqlx::query(
            r#"SELECT id, name, year, publisher, "metadataId", "metadataSource", "matchState",
                      description, status, "bookType", genres FROM "Series" WHERE "libraryId" = 'rt_lib'"#,
        )
        .fetch_one(&db.pool).await.expect("exactly one rebuilt series");
        assert_eq!(s.get::<String, _>("name"), "Batman");
        assert_eq!(s.get::<i64, _>("year"), 2011);
        assert_eq!(s.get::<String, _>("publisher"), "DC Comics");
        assert_eq!(s.get::<Option<String>, _>("metadataId").as_deref(), Some("796"));
        assert_eq!(s.get::<String, _>("metadataSource"), "COMICVINE");
        assert_eq!(s.get::<String, _>("matchState"), "MATCHED");
        assert_eq!(s.get::<Option<String>, _>("description").as_deref(), Some("The Dark Knight returns."));
        assert_eq!(s.get::<Option<String>, _>("status").as_deref(), Some("Ended"));
        assert_eq!(s.get::<Option<String>, _>("bookType").as_deref(), Some("Print"));
        // Series genres re-aggregate from the issues' ComicInfo (scan 5E).
        assert_eq!(s.get::<Option<String>, _>("genres").as_deref(), Some(r#"["Crime","Super-Hero"]"#));

        // #199 read-side (5H): the series-wide ComicInfo defaults ALSO survive the wipe — the embed
        // wrote them into the file's ComicInfo, the rescan read them back, and fill-blank restored
        // the columns. This is the durability half of the beta.012 feature.
        let ci = sqlx::query(
            r#"SELECT imprint, "ageRating", CAST("communityRating" AS TEXT) AS cr,
                      CAST("blackAndWhite" AS INTEGER) AS bw, tags, editor, "languageISO",
                      "storyArcNumber", notes
               FROM "Series" WHERE "libraryId" = 'rt_lib'"#,
        )
        .fetch_one(&db.pool).await.expect("rebuilt series ComicInfo defaults");
        assert_eq!(ci.get::<Option<String>, _>("imprint").as_deref(), Some("Black Label"));
        assert_eq!(ci.get::<Option<String>, _>("ageRating").as_deref(), Some("Mature 17+"));
        assert_eq!(ci.get::<Option<String>, _>("cr").as_deref(), Some("4.5"));
        assert_eq!(ci.get::<Option<i64>, _>("bw"), Some(1));
        assert_eq!(ci.get::<Option<String>, _>("tags").as_deref(), Some(r#"["noir"]"#));
        assert_eq!(ci.get::<Option<String>, _>("editor").as_deref(), Some(r#"["Mark Doyle"]"#));
        assert_eq!(ci.get::<Option<String>, _>("languageISO").as_deref(), Some("en"));
        assert_eq!(ci.get::<Option<String>, _>("storyArcNumber").as_deref(), Some("2"));
        assert_eq!(ci.get::<Option<String>, _>("notes").as_deref(), Some("Curated series note"));

        // -- 5. The issue came back identical, from its own ComicInfo.
        let series_id: String = s.get("id");
        let i = sqlx::query(
            r#"SELECT number, "matchState", "metadataId", "metadataSource", status, "pageCount",
                      name, description, "releaseDate", genres, writers, artists, "coverArtists",
                      colorists, letterers, characters, teams, locations, "storyArcs", inker, editor, translator,
                      gtin, "alternateNumber", "scanInformation", tags, notes
               FROM "Issue" WHERE "seriesId" = $1"#,
        )
        .bind(&series_id)
        .fetch_one(&db.pool).await.expect("exactly one rebuilt issue");
        assert_eq!(i.get::<String, _>("number"), "5", "ComicInfo <Number> beat the '001' in the filename");
        assert_eq!(i.get::<Option<String>, _>("releaseDate").as_deref(), Some("2012-05-09"), "Y/M/D round-tripped");
        assert_eq!(i.get::<String, _>("matchState"), "DEEP_SYNCED", "credits from file → no lazy fetch on open");
        assert_eq!(i.get::<Option<String>, _>("metadataId").as_deref(), Some("900001"));
        assert_eq!(i.get::<String, _>("metadataSource"), "COMICVINE");
        assert_eq!(i.get::<String, _>("status"), "DOWNLOADED");
        assert_eq!(i.get::<i64, _>("pageCount"), 3);
        assert_eq!(i.get::<Option<String>, _>("name").as_deref(), Some("Night of the Owls"));
        assert_eq!(i.get::<Option<String>, _>("description").as_deref(), Some("A conspiracy of owls."));
        assert_eq!(i.get::<Option<String>, _>("genres").as_deref(), Some(r#"["Crime","Super-Hero"]"#));
        assert_eq!(i.get::<Option<String>, _>("writers").as_deref(), Some(r#"["Scott Snyder"]"#));
        // Call-3 Beta A: the split holds through the loop — pencillers stay clean of inkers…
        assert_eq!(i.get::<Option<String>, _>("artists").as_deref(), Some(r#"["Greg Capullo"]"#));
        // …the issue's own inker round-trips via its <Inker> tag…
        assert_eq!(i.get::<Option<String>, _>("inker").as_deref(), Some(r#"["Jonathan Glapion"]"#));
        // …and the series-default editor comes back ON THE ISSUE too: ComicInfo is per-file, so the
        // embedded <Editor> fallback reads back as the issue's own value. Understood + accepted —
        // the file genuinely lists that editor, and the next embed emits the identical XML.
        assert_eq!(i.get::<Option<String>, _>("editor").as_deref(), Some(r#"["Mark Doyle"]"#));
        assert_eq!(i.get::<Option<String>, _>("translator"), None::<String>);
        // Beta B: the issue's own per-file fields survive the wipe via their ComicInfo tags…
        assert_eq!(i.get::<Option<String>, _>("gtin").as_deref(), Some("9791234567897"));
        assert_eq!(i.get::<Option<String>, _>("alternateNumber").as_deref(), Some("19B"));
        assert_eq!(i.get::<Option<String>, _>("scanInformation").as_deref(), Some("ScanGroup v2"));
        // …and series-sourced defaults read back per-issue like editor above (per-file semantics).
        assert_eq!(i.get::<Option<String>, _>("tags").as_deref(), Some(r#"["noir"]"#));
        assert_eq!(i.get::<Option<String>, _>("notes").as_deref(), Some("Curated series note"));
        assert_eq!(i.get::<Option<String>, _>("coverArtists").as_deref(), Some(r#"["Greg Capullo"]"#));
        assert_eq!(i.get::<Option<String>, _>("colorists").as_deref(), Some(r#"["FCO Plascencia"]"#));
        assert_eq!(i.get::<Option<String>, _>("letterers").as_deref(), Some(r#"["Richard Starkings"]"#));
        assert_eq!(i.get::<Option<String>, _>("characters").as_deref(), Some(r#"["Batman"]"#));
        assert_eq!(i.get::<Option<String>, _>("teams").as_deref(), Some(r#"["Court of Owls"]"#));
        assert_eq!(i.get::<Option<String>, _>("locations").as_deref(), Some(r#"["Gotham City"]"#));
        assert_eq!(i.get::<Option<String>, _>("storyArcs").as_deref(), Some(r#"["Night of the Owls"]"#));

        // -- 6. Zero recurring cost: the rebuilt series is file-complete, so the scheduled
        //       metadata sweep excludes it — browsing AND idling spend no provider calls.
        let complete: i64 = sqlx::query_scalar(&format!(
            r#"SELECT COUNT(*) FROM "Series" WHERE "metadataId" IS NOT NULL AND {}"#,
            crate::metadata::file_complete_predicate()
        ))
        .fetch_one(&db.pool).await.unwrap();
        assert_eq!(complete, 1, "the rebuilt series is excluded from the scheduled provider sweep");

        drop(db);
        let _ = std::fs::remove_dir_all(&base);
    }
}
