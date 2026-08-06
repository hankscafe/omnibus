use crate::db::Db;
use sqlx::Row;
use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::OnceLock;
use regex::Regex;
use serde::Deserialize;
use tokio::task::JoinSet;
use zip::{ZipArchive, ZipWriter, write::FileOptions};

#[derive(Deserialize, Debug)]
pub struct EmbedRequest {
    pub series_id: Option<String>,
    pub issue_ids: Option<Vec<String>>,
}

struct EmbedTask {
    file_path: String,
    xml_content: String,
    series_id: String,
}

fn escape_xml(input: &str) -> String {
    input.replace('&', "&amp;")
         .replace('<', "&lt;")
         .replace('>', "&gt;")
         .replace('"', "&quot;")
         .replace('\'', "&apos;")
}

/// Strips HTML tags (parity with the Node `.replace(/<[^>]*>?/gm, '')`).
fn strip_html(s: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"<[^>]*>?").unwrap());
    re.replace_all(s, "").trim().to_string()
}

/// Parses a JSON string array, returning [] on any failure.
fn parse_json_array(raw: Option<&str>) -> Vec<String> {
    raw.and_then(|s| serde_json::from_str::<Vec<String>>(s).ok()).unwrap_or_default()
}

/// Joins a JSON string array with ", " (parity with `JSON.parse(x).join(', ')`).
fn clean_json_array(raw: Option<&str>) -> String {
    parse_json_array(raw).join(", ")
}

pub async fn process_embed_job(db: Db, payload: EmbedRequest) -> anyhow::Result<(i32, i32, i32)> {
    // isManga is CAST for the Any driver — SQLite's BOOLEAN decltype has no Any mapping.
    // #199 ComicInfo defaults: the s.* mirror columns (series_writers, …) are the Smart Matcher's
    // series-wide values — build_comic_info_xml uses them only when the issue's own column is empty.
    // CASTs follow the Any-driver rules (src/db.rs): BOOLEAN → INTEGER read as i64, and the numeric
    // Float/Int defaults → TEXT so both backends deliver one portable type.
    let base = r#"SELECT i.id, i."filePath", i.number, i.name as issue_name, i.description as issue_desc,
               i.writers, i.artists, i.characters, i."coverArtists", i.colorists, i.letterers, i.teams, i.locations,
               i.inker, i.editor, i.translator,
               i.tags as issue_tags, i."mainCharacterOrTeam" as issue_main_character, i."alternateSeries" as issue_alt_series,
               i."alternateNumber" as issue_alt_number, CAST(i."alternateCount" AS TEXT) as issue_alt_count_text,
               i."storyArcNumber" as issue_story_arc_number, i.gtin as issue_gtin, i.notes as issue_notes,
               i."scanInformation" as issue_scan_information, i.review as issue_review,
               CAST(i."communityRating" AS TEXT) as issue_community_rating_text,
               CAST(i."blackAndWhite" AS INTEGER) as issue_black_and_white_int,
               i."releaseDate", i.universe as issue_universe,
               i.genres, i."storyArcs", i."metadataId" as issue_meta_id, i."metadataSource" as issue_meta_source,
               s.id as series_id, s.name as series_name, s.publisher, s.year, s."folderPath",
               s.universe as series_universe, s."seriesGroup" as series_group, CAST(s."isManga" AS INTEGER) AS "isManga", s."metadataId" as series_meta_id, s."metadataSource" as series_meta_source,
               s.genres as series_genres,
               s.writers as series_writers, s.artists as series_artists, s."coverArtists" as series_cover_artists,
               s.colorists as series_colorists, s.letterers as series_letterers, s.characters as series_characters,
               s.teams as series_teams, s.locations as series_locations, s."storyArcs" as series_story_arcs,
               s.inker as series_inker, s.editor as series_editor, s.translator as series_translator,
               s.imprint, s.tags as series_tags, s.format, s."languageISO", s."ageRating",
               CAST(s."communityRating" AS TEXT) AS "communityRatingText",
               CAST(s."blackAndWhite" AS INTEGER) AS "blackAndWhiteInt",
               s.gtin, s.notes, s."scanInformation", s.review,
               s."mainCharacterOrTeam", s."alternateSeries", s."alternateNumber",
               CAST(s."alternateCount" AS TEXT) AS "alternateCountText", s."storyArcNumber"
        FROM "Issue" i
        JOIN "Series" s ON i."seriesId" = s.id
        WHERE LOWER(i."filePath") LIKE '%.cbz'"#;
    // LOWER(): SQLite LIKE is case-insensitive but Postgres LIKE is not — without it, files with
    // an uppercase .CBZ extension were silently skipped on the Postgres profile.

    // User-controlled ids are bound (NOT interpolated); only the fixed WHERE clause is appended.
    let rows = if let Some(s_id) = payload.series_id {
        sqlx::query(&format!("{} AND s.id = $1", base)).bind(s_id).fetch_all(&db.pool).await?
    } else if let Some(i_ids) = payload.issue_ids {
        if i_ids.is_empty() {
            Vec::new()
        } else {
            // Portable IN (...) list — `= ANY($1)` array binds are Postgres-only (see src/db.rs).
            let sql = format!("{} AND i.id IN ({})", base, Db::in_placeholders(1, i_ids.len()));
            let mut q = sqlx::query(&sql);
            for id in &i_ids {
                q = q.bind(id);
            }
            q.fetch_all(&db.pool).await?
        }
    } else {
        sqlx::query(&format!("{} AND s.\"metadataSource\" IN ('COMICVINE', 'METRON')", base)).fetch_all(&db.pool).await?
    };

    // Embed guard (issue #194 (c3)): an issue id shared by rows with DIFFERENT numbers in the same
    // series is provably wrong for at least one of them — never write such an id into a file, where
    // it would outlive the DB and re-poison future scans. Detected offline from the series' rows.
    let involved_series: Vec<String> = rows.iter()
        .map(|r| r.get::<String, _>("series_id"))
        .collect::<std::collections::HashSet<_>>().into_iter().collect();
    let mut conflicted_ids: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    if !involved_series.is_empty() {
        let sql = format!(
            r#"SELECT "seriesId", "metadataId", number FROM "Issue" WHERE "seriesId" IN ({}) AND "metadataId" IS NOT NULL AND "metadataId" <> '' AND "metadataId" NOT LIKE 'unmatched%'"#,
            Db::in_placeholders(1, involved_series.len())
        );
        let mut q = sqlx::query(&sql);
        for sid in &involved_series { q = q.bind(sid); }
        let id_rows = q.fetch_all(&db.pool).await.unwrap_or_default();
        let mut first_num: std::collections::HashMap<(String, String), String> = std::collections::HashMap::new();
        for r in id_rows {
            let key = (r.get::<String, _>("seriesId"), r.get::<String, _>("metadataId"));
            let num = r.get::<String, _>("number");
            match first_num.get(&key) {
                Some(seen) if !crate::metadata::is_same_issue(seen, &num) => { conflicted_ids.insert(key); }
                Some(_) => {}
                None => { first_num.insert(key, num); }
            }
        }
    }

    // 1. Build the full ComicInfo XML for each issue (in the async context, where we have the data).
    let mut tasks = Vec::new();
    for row in &rows {
        let file_path: String = row.get("filePath");
        let series_id: String = row.get("series_id");
        let series_name: String = row.try_get("series_name").unwrap_or_default();
        let number: String = row.try_get("number").unwrap_or_default();

        let issue_meta_id: Option<String> = row.try_get("issue_meta_id").unwrap_or(None);
        let omit_issue_id = issue_meta_id
            .as_ref()
            .is_some_and(|mid| conflicted_ids.contains(&(series_id.clone(), mid.clone())));
        if omit_issue_id {
            log::warn!("[Writer] Issue id on {} #{} is duplicated across different numbers in the series — omitting it from ComicInfo.xml (issue #194 guard).", series_name, number);
        }

        let xml_content = build_comic_info_xml(row, omit_issue_id);
        log::debug!("[Metadata Writer Debug] Generated XML content for: {} #{}", series_name, number);

        tasks.push(EmbedTask { file_path, xml_content, series_id });
    }

    // 2. Inject concurrently, BOUNDED so a full-library embed can't fan out hundreds of concurrent
    //    full-archive ZIP rewrites and thrash the disk / exhaust the blocking pool.
    let cfg = crate::engine_config::EngineConfig::load(&db.pool).await;
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(cfg.convert_workers));
    let mut join_set = JoinSet::new();
    for task in tasks {
        let sem = sem.clone();
        join_set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            tokio::task::spawn_blocking(move || {
                let ok = inject_xml_into_zip(&task.file_path, &task.xml_content);
                (ok, task.series_id)
            })
            .await
            .unwrap_or((false, String::new()))
        });
    }

    let mut success_count = 0;
    let mut fail_count = 0;
    let mut series_json_count = 0;
    let mut seen_series: HashSet<String> = HashSet::new();

    while let Some(res) = join_set.join_next().await {
        if let Ok((ok, series_id)) = res {
            if ok { success_count += 1; } else { fail_count += 1; }

            // Write series.json once per series (gated by the export flag).
            if seen_series.insert(series_id.clone())
                && write_series_json(&db, &series_id).await {
                    series_json_count += 1;
                }
        }
    }

    Ok((success_count, fail_count, series_json_count))
}

/// Builds the full ComicInfo.xml (parity with metadata-writer.ts writeComicInfo — all ~21 tags).
/// `omit_issue_id` blanks the issue-level provider id (issue #194 (c3)): a suspect id must never
/// be embedded into a file, where it would outlive the DB and re-poison future scans.
fn build_comic_info_xml(row: &sqlx::any::AnyRow, omit_issue_id: bool) -> String {
    let g = |c: &str| -> Option<String> { row.try_get::<Option<String>, _>(c).unwrap_or(None) };

    let series_name = g("series_name").unwrap_or_default();
    let issue_name = g("issue_name").unwrap_or_default();
    let number = g("number").unwrap_or_default();
    let year: i32 = row.try_get("year").unwrap_or(0);
    let publisher = g("publisher").unwrap_or_default();
    // CAST to INTEGER in the SELECT (Any driver); != 0 recovers the bool.
    let is_manga: bool = row.try_get::<i64, _>("isManga").map(|v| v != 0).unwrap_or(false);

    let universe = g("issue_universe").filter(|s| !s.is_empty())
        .or_else(|| g("series_universe").filter(|s| !s.is_empty()))
        .unwrap_or_default();

    // #199: the issue's own value wins when non-empty; otherwise the Smart Matcher's series-wide
    // default fills in (same contract as `universe` above) — the admin's default applies until an
    // issue gains its own provider/manual credits.
    let paired = |issue_col: &str, series_col: &str| -> String {
        let iv = clean_json_array(g(issue_col).as_deref());
        if !iv.is_empty() { iv } else { clean_json_array(g(series_col).as_deref()) }
    };
    let writers = paired("writers", "series_writers");
    let artists = paired("artists", "series_artists");
    let characters = paired("characters", "series_characters");
    let cover_artists = paired("coverArtists", "series_cover_artists");
    let colorists = paired("colorists", "series_colorists");
    let letterers = paired("letterers", "series_letterers");
    let teams = paired("teams", "series_teams");
    let locations = paired("locations", "series_locations");
    let summary = strip_html(&g("issue_desc").unwrap_or_default());

    let mut genre_list = parse_json_array(g("genres").as_deref());
    if genre_list.is_empty() {
        genre_list = parse_json_array(g("series_genres").as_deref());
    }
    if is_manga && !genre_list.iter().any(|x| x == "Manga") {
        genre_list.push("Manga".to_string());
    }
    let genres = genre_list.join(", ");

    let mut story_arc_list = parse_json_array(g("storyArcs").as_deref());
    if story_arc_list.is_empty() {
        story_arc_list = parse_json_array(g("series_story_arcs").as_deref());
    }
    let story_arcs = story_arc_list.into_iter().filter(|a| a != "NONE").collect::<Vec<_>>().join(", ");

    let series_group = g("series_group").unwrap_or_default();

    // #199 Call-3 Beta A: inker/editor/translator gained per-issue columns — same issue-wins
    // pairing as the other credits (the Series value stays as the fill-blanks default).
    let inker = paired("inker", "series_inker");
    let editor = paired("editor", "series_editor");
    let translator = paired("translator", "series_translator");
    // Series-only ComicInfo defaults (#199): uniform-per-run fields, always taken straight from
    // Series, like Publisher. Everything else below pairs issue-wins since Call-3 Beta B.
    let imprint = g("imprint").unwrap_or_default();
    let format = g("format").unwrap_or_default();
    let language_iso = g("languageISO").unwrap_or_default();
    let age_rating = g("ageRating").unwrap_or_default();
    // #199 Call-3 Beta B: the genuinely-per-issue fields flip to the same issue-wins pairing as
    // the credits — the issue's own non-empty value beats the series default.
    let scalar_paired = |issue_key: &str, series_key: &str| -> String {
        g(issue_key).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
            .or_else(|| g(series_key))
            .unwrap_or_default()
    };
    let tags = {
        let iv = clean_json_array(g("issue_tags").as_deref());
        if !iv.is_empty() { iv } else { clean_json_array(g("series_tags").as_deref()) }
    };
    let community_rating = scalar_paired("issue_community_rating_text", "communityRatingText");
    let gtin = scalar_paired("issue_gtin", "gtin");
    let notes = scalar_paired("issue_notes", "notes");
    let scan_information = scalar_paired("issue_scan_information", "scanInformation");
    let review = scalar_paired("issue_review", "review");
    let main_character_or_team = scalar_paired("issue_main_character", "mainCharacterOrTeam");
    let alternate_series = scalar_paired("issue_alt_series", "alternateSeries");
    let alternate_number = scalar_paired("issue_alt_number", "alternateNumber");
    let alternate_count = scalar_paired("issue_alt_count_text", "alternateCountText");
    let story_arc_number = scalar_paired("issue_story_arc_number", "storyArcNumber");
    // CAST to INTEGER in the SELECT (Any driver, the isManga trick); a NULL (never set) reads as
    // None → "Unknown". Beta B: the issue's own stored claim (Yes OR No) beats the series default —
    // a B&W backup issue in a color series emits its own truth.
    let black_and_white = row.try_get::<Option<i64>, _>("issue_black_and_white_int").unwrap_or(None)
        .or_else(|| row.try_get::<Option<i64>, _>("blackAndWhiteInt").unwrap_or(None));
    let black_and_white_tag = match black_and_white {
        Some(v) if v != 0 => "Yes",
        Some(_) => "No",
        None => "Unknown",
    };

    // <Volume> = series start year (blank when unknown/0). <Year>/<Month>/<Day> from releaseDate, year falling back to Volume.
    let volume = if year != 0 { year.to_string() } else { String::new() };
    let mut y = volume.clone();
    let mut m = String::new();
    let mut d = String::new();
    if let Some(rd) = g("releaseDate") {
        // Only accept a well-formed date; a hand-entered slash/text date would otherwise corrupt <Year>.
        // Full ISO (YYYY-MM-DD, optional trailing time) -> Y/M/D; bare year (YYYY) -> Year; anything else
        // keeps the series-year fallback above. Mirrors the Node writeComicInfo guard (#35).
        let rd = rd.trim();
        let b = rd.as_bytes();
        let is_iso_full = rd.len() >= 10
            && b[..4].iter().all(u8::is_ascii_digit)
            && b[4] == b'-'
            && b[5..7].iter().all(u8::is_ascii_digit)
            && b[7] == b'-'
            && b[8..10].iter().all(u8::is_ascii_digit);
        let is_year_only = rd.len() == 4 && b.iter().all(u8::is_ascii_digit);
        if is_iso_full {
            y = rd[0..4].to_string();
            m = rd[5..7].to_string();
            d = rd[8..10].to_string();
        } else if is_year_only {
            y = rd.to_string();
        }
    }

    let issue_meta_id = g("issue_meta_id");
    let issue_meta_source = g("issue_meta_source").unwrap_or_default();
    let series_meta_id = g("series_meta_id");
    let series_meta_source = g("series_meta_source").unwrap_or_default();

    // Never emit placeholder unmatched_* ids, and never emit a suspect (omitted) id — an id baked
    // into a file outlives the DB and would re-poison future scans (issue #194 (c3)).
    let issue_id_ok = issue_meta_id.as_deref()
        .filter(|s| !s.is_empty() && !s.starts_with("unmatched") && !omit_issue_id);
    let series_id_ok = series_meta_id.as_deref().filter(|s| !s.is_empty());

    let is_cv_series = series_meta_source == "COMICVINE";
    let is_metron_series = series_meta_source == "METRON";
    let is_cv_issue = issue_meta_source == "COMICVINE";
    let is_metron_issue = issue_meta_source == "METRON";

    // Priority order preserved: metron-issue → metron-series → cv-issue → cv-series → none.
    let web_url = match (issue_id_ok, series_id_ok) {
        (Some(id), _) if is_metron_issue => format!("https://metron.cloud/issue/{}/", id),
        (_, Some(id)) if is_metron_series => format!("https://metron.cloud/series/{}/", id),
        (Some(id), _) if is_cv_issue => format!("https://comicvine.gamespot.com/issue/4000-{}/", id),
        (_, Some(id)) if is_cv_series => format!("https://comicvine.gamespot.com/volume/4050-{}/", id),
        _ => String::new(),
    };

    let cv_vol_id = if is_cv_series { series_id_ok.unwrap_or("") } else { "" };
    let cv_issue_id = if is_cv_issue { issue_id_ok.unwrap_or("") } else { "" };
    let metron_id = if is_metron_series { series_id_ok.unwrap_or("") } else { "" };
    let metron_issue_id = if is_metron_issue { issue_id_ok.unwrap_or("") } else { "" };

    let manga_tag = if is_manga { "YesAndRightToLeft" } else { "No" };

    // Tag order follows the anansi-project ComicInfo schema listing (#199 widened the set from ~21
    // to the full complement). Consumers match by name, so the order is cosmetic — but keeping the
    // schema's order makes diffs against other tools' output readable.
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Series>{}</Series>
  <Title>{}</Title>
  <Number>{}</Number>
  <Volume>{}</Volume>
  <AlternateSeries>{}</AlternateSeries>
  <AlternateNumber>{}</AlternateNumber>
  <AlternateCount>{}</AlternateCount>
  <Summary>{}</Summary>
  <Notes>{}</Notes>
  <Year>{}</Year>
  <Month>{}</Month>
  <Day>{}</Day>
  <Writer>{}</Writer>
  <Penciller>{}</Penciller>
  <Inker>{}</Inker>
  <Colorist>{}</Colorist>
  <Letterer>{}</Letterer>
  <CoverArtist>{}</CoverArtist>
  <Editor>{}</Editor>
  <Translator>{}</Translator>
  <Publisher>{}</Publisher>
  <Imprint>{}</Imprint>
  <Universe>{}</Universe>
  <Genre>{}</Genre>
  <Tags>{}</Tags>
  <Web>{}</Web>
  <LanguageISO>{}</LanguageISO>
  <Format>{}</Format>
  <BlackAndWhite>{}</BlackAndWhite>
  <Manga>{}</Manga>
  <Characters>{}</Characters>
  <Teams>{}</Teams>
  <Locations>{}</Locations>
  <MainCharacterOrTeam>{}</MainCharacterOrTeam>
  <ScanInformation>{}</ScanInformation>
  <StoryArc>{}</StoryArc>
  <StoryArcNumber>{}</StoryArcNumber>
  <SeriesGroup>{}</SeriesGroup>
  <AgeRating>{}</AgeRating>
  <CommunityRating>{}</CommunityRating>
  <Review>{}</Review>
  <GTIN>{}</GTIN>
  <ComicVineVolumeId>{}</ComicVineVolumeId>
  <ComicVineIssueId>{}</ComicVineIssueId>
  <MetronId>{}</MetronId>
  <MetronIssueId>{}</MetronIssueId>
</ComicInfo>"#,
        escape_xml(&series_name),
        escape_xml(&issue_name),
        escape_xml(&number),
        volume,
        escape_xml(&alternate_series),
        escape_xml(&alternate_number),
        escape_xml(&alternate_count),
        escape_xml(&summary),
        escape_xml(&notes),
        y, m, d,
        escape_xml(&writers),
        escape_xml(&artists),
        escape_xml(&inker),
        escape_xml(&colorists),
        escape_xml(&letterers),
        escape_xml(&cover_artists),
        escape_xml(&editor),
        escape_xml(&translator),
        escape_xml(&publisher),
        escape_xml(&imprint),
        escape_xml(&universe),
        escape_xml(&genres),
        escape_xml(&tags),
        escape_xml(&web_url),
        escape_xml(&language_iso),
        escape_xml(&format),
        black_and_white_tag,
        manga_tag,
        escape_xml(&characters),
        escape_xml(&teams),
        escape_xml(&locations),
        escape_xml(&main_character_or_team),
        escape_xml(&scan_information),
        escape_xml(&story_arcs),
        escape_xml(&story_arc_number),
        escape_xml(&series_group),
        escape_xml(&age_rating),
        escape_xml(&community_rating),
        escape_xml(&review),
        escape_xml(&gtin),
        cv_vol_id,
        cv_issue_id,
        metron_id,
        metron_issue_id,
    )
}

const MONTH_NAMES: [&str; 12] = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

/// Formats a "YYYY-MM-DD" release date as "Month YYYY" (e.g. "March 1999").
fn format_month_year(date_str: &str) -> String {
    let mut parts = date_str.split('-');
    let year = parts.next().unwrap_or("").to_string();
    match parts.next().and_then(|m| m.parse::<usize>().ok()) {
        Some(m) if (1..=12).contains(&m) => format!("{} {}", MONTH_NAMES[m - 1], year),
        _ => year,
    }
}

/// Writes a Mylar-spec (v1.0.2) series.json — the format Komga, Kavita, and Mylar consume.
/// Gated on `export_series_json` + DB-tracked file ownership. Parity with writeSeriesJson
/// (metadata-writer.ts, beta.032-034).
pub(crate) async fn write_series_json(db: &Db, series_id: &str) -> bool {
    // Default ON since discussion #182 (local-first ingest): the export is what makes a wipe/
    // rebuild or a Komga/Kavita share round-trip without re-paying provider calls, and the
    // ownership guard below already protects curated Mylar libraries. Only an explicit admin
    // opt-out ("false") disables it; an absent row is the new default.
    let enabled = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'export_series_json'"#)
        .fetch_optional(&db.pool).await.ok().flatten();
    if enabled.as_deref() == Some("false") {
        return false;
    }

    let series = match sqlx::query(
        // seriesJsonWritten is CAST for the Any driver — SQLite's BOOLEAN decltype has no mapping.
        r#"SELECT name, publisher, status, description, year, "cvId", "metadataSource", "metadataId",
                  "folderPath", "bookType", "remoteCoverUrl", "coverUrl", imprint, "ageRating",
                  CAST("seriesJsonWritten" AS INTEGER) AS "seriesJsonWritten"
           FROM "Series" WHERE id = $1"#,
    )
    .bind(series_id)
    .fetch_optional(&db.pool)
    .await
    {
        Ok(Some(r)) => r,
        _ => return false,
    };

    let folder: String = series.try_get::<Option<String>, _>("folderPath").unwrap_or(None).unwrap_or_default();
    if folder.is_empty() || !Path::new(&folder).exists() {
        return false;
    }
    let json_path = Path::new(&folder).join("series.json");

    let name: String = series.try_get("name").unwrap_or_default();
    let json_written: bool = series.try_get::<i64, _>("seriesJsonWritten").map(|v| v != 0).unwrap_or(false);

    // Never clobber a series.json Omnibus didn't create (e.g. a curated Mylar library).
    // Ownership is tracked in the DB; the one exception is our own legacy Komga-style format
    // from before ownership tracking existed, which is recognizable (no version key,
    // Komga-only fields) and safe to upgrade.
    if !json_written && json_path.exists() {
        let is_legacy_omnibus_file = std::fs::read_to_string(&json_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .map(|existing| existing["version"].is_null() && !existing["metadata"]["readingDirection"].is_null())
            .unwrap_or(false); // unreadable or not JSON — treat as foreign

        if !is_legacy_omnibus_file {
            log::warn!("[Writer] Skipping series.json for {}: the existing file was not created by Omnibus.", name);
            return false;
        }
    }

    // comicid is the ComicVine volume ID per the Mylar spec; never substitute a Metron ID.
    let meta_source: String = series.try_get("metadataSource").unwrap_or_default();
    let meta_id: Option<String> = series.try_get("metadataId").unwrap_or(None);
    let mut comicid: Option<i64> = series.try_get::<Option<i32>, _>("cvId").unwrap_or(None).map(|v| v as i64);
    if comicid.is_none() && meta_source == "COMICVINE" {
        comicid = meta_id.as_deref().and_then(|s| s.trim().parse::<i64>().ok());
    }

    let status: Option<String> = series.try_get("status").unwrap_or(None);
    let is_ended = status.as_deref() == Some("Ended");

    let mut release_dates: Vec<String> = sqlx::query(r#"SELECT "releaseDate" FROM "Issue" WHERE "seriesId" = $1"#)
        .bind(series_id)
        .fetch_all(&db.pool)
        .await
        .unwrap_or_default()
        .iter()
        .filter_map(|r| r.try_get::<Option<String>, _>("releaseDate").unwrap_or(None))
        .filter(|d| !d.is_empty())
        .collect();
    release_dates.sort();
    let total_issues = sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM "Issue" WHERE "seriesId" = $1"#)
        .bind(series_id)
        .fetch_one(&db.pool)
        .await
        .unwrap_or(0);

    let year: Option<i32> = series.try_get::<Option<i32>, _>("year").unwrap_or(None);
    let publication_run = if let (Some(first), Some(last)) = (release_dates.first(), release_dates.last()) {
        let start = format_month_year(first);
        let end = if is_ended { format_month_year(last) } else { "Present".to_string() };
        format!("{} - {}", start, end)
    } else if let Some(y) = year.filter(|y| *y != 0) {
        if is_ended { y.to_string() } else { format!("{} - Present", y) }
    } else {
        String::new()
    };

    let raw_desc: String = series.try_get::<Option<String>, _>("description").unwrap_or(None).unwrap_or_default();
    let description_text = strip_html(&raw_desc);
    let description_formatted = {
        static RE_BR: OnceLock<Regex> = OnceLock::new();
        let re_br = RE_BR.get_or_init(|| Regex::new(r"(?i)<br\s*/?>").unwrap());
        strip_html(&re_br.replace_all(&raw_desc, "\n"))
    };

    // comic_image prefers the remote ComicVine/Metron cover URL. When that isn't known, fall
    // back to the locally cached cover served through Omnibus (made absolute via NEXTAUTH_URL)
    // so the field is never empty when a cover exists.
    let remote_cover: Option<String> = series.try_get("remoteCoverUrl").unwrap_or(None);
    let cover_url: Option<String> = series.try_get("coverUrl").unwrap_or(None);
    let comic_image: Option<String> = remote_cover.filter(|s| !s.is_empty()).or_else(|| {
        cover_url.filter(|s| !s.is_empty()).map(|c| {
            if c.starts_with("http") {
                c
            } else {
                let base = std::env::var("NEXTAUTH_URL").unwrap_or_else(|_| "http://localhost:3000".to_string());
                let base = base.trim_end_matches('/');
                if c.starts_with('/') {
                    format!("{}{}", base, c)
                } else {
                    format!("{}/api/library/cover?path={}", base, urlencoding::encode(&c))
                }
            }
        })
    });

    let publisher: Option<String> = series.try_get::<Option<String>, _>("publisher").unwrap_or(None).filter(|s| !s.is_empty());
    let book_type: Option<String> = series.try_get("bookType").unwrap_or(None);
    // #199: the Mylar 1.0.2 spec has always had these slots; now the Series columns can fill them.
    let imprint: Option<String> = series.try_get::<Option<String>, _>("imprint").unwrap_or(None).filter(|s| !s.is_empty());
    let age_rating: Option<String> = series.try_get::<Option<String>, _>("ageRating").unwrap_or(None).filter(|s| !s.is_empty());

    // Mylar series.json schema v1.0.2. Unknown values are null, never "": Komga ignores nulls
    // but chokes on blanks. https://github.com/mylar3/mylar3/wiki/series.json-schema-(version-1.0.2)
    let series_json = serde_json::json!({
        "version": "1.0.2",
        "metadata": {
            "type": "comicSeries",
            "publisher": publisher,
            "imprint": imprint,
            "name": name,
            "comicid": comicid,
            "year": year,
            "description_text": Some(description_text).filter(|s| !s.is_empty()),
            "description_formatted": Some(description_formatted).filter(|s| !s.is_empty()),
            "volume": serde_json::Value::Null,
            "booktype": book_type.filter(|s| !s.is_empty()).unwrap_or_else(|| "Print".to_string()),
            "age_rating": age_rating,
            "collects": serde_json::Value::Null,
            "comic_image": comic_image,
            "total_issues": total_issues,
            "publication_run": Some(publication_run.clone()).filter(|s| !s.is_empty()),
            "status": if is_ended { "Ended" } else { "Continuing" }
        }
    });

    log::debug!("[Metadata Writer Debug] Exporting Mylar-spec series.json to: {:?}", json_path);
    match std::fs::write(&json_path, serde_json::to_string_pretty(&series_json).unwrap_or_default()) {
        Ok(_) => {
            // Claim ownership so future runs keep this file updated.
            if !json_written {
                let _ = sqlx::query(r#"UPDATE "Series" SET "seriesJsonWritten" = true WHERE id = $1"#)
                    .bind(series_id)
                    .execute(&db.pool)
                    .await;
            }
            true
        }
        Err(e) => {
            log::error!("[Writer] Failed to write series.json for '{}': {:?}", name, e);
            false
        }
    }
}

/// Standalone series.json export over all (or selected) provider-matched series — the Node
/// EXPORT_SERIES_JSON job forwards here. Returns (exported, total considered).
pub async fn run_series_json_export(db: &Db, series_ids: Option<Vec<String>>) -> (i64, i64) {
    let rows = match &series_ids {
        // An explicit (even empty) id list filters, matching the Node `id: { in: [...] }` behavior.
        // Empty list → zero rows without touching the DB (`IN ()` is invalid SQL; Postgres's old
        // `= ANY('{}')` behavior returned nothing).
        Some(ids) if ids.is_empty() => Ok(Vec::new()),
        Some(ids) => {
            let sql = format!(
                r#"SELECT id FROM "Series" WHERE "metadataSource" IN ('COMICVINE','METRON') AND id IN ({})"#,
                Db::in_placeholders(1, ids.len())
            );
            let mut q = sqlx::query(&sql);
            for id in ids {
                q = q.bind(id);
            }
            q.fetch_all(&db.pool).await
        }
        None => {
            sqlx::query(r#"SELECT id FROM "Series" WHERE "metadataSource" IN ('COMICVINE','METRON')"#)
                .fetch_all(&db.pool)
                .await
        }
    }
    .unwrap_or_default();

    let total = rows.len() as i64;
    let mut exported = 0i64;
    for row in &rows {
        let id: String = row.get("id");
        if write_series_json(db, &id).await {
            exported += 1;
        }
    }
    (exported, total)
}

/// Reads the archive's ComicInfo.xml entry, if present. Cheap (only the small XML entry is read).
fn read_comicinfo_from_zip(path: &Path) -> anyhow::Result<Option<String>> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if entry.name().eq_ignore_ascii_case("comicinfo.xml") {
            let mut s = String::new();
            entry.read_to_string(&mut s)?;
            return Ok(Some(s));
        }
    }
    Ok(None)
}

/// Rewrites the ZIP to include the new ComicInfo.xml, preserving the source compression of every entry.
fn inject_xml_into_zip(file_path: &str, xml_content: &str) -> bool {
    let path = Path::new(file_path);
    if !path.exists() { return false; }

    // Skip the full repack when the archive already holds byte-identical ComicInfo.xml. A metadata
    // sync re-embeds unchanged data every run; rewriting every page entry just to write the same XML
    // is pure disk churn that scales with total library size. On any read error we fall through and
    // rewrite (safe default). build_comic_info_xml is deterministic, so unchanged data → identical XML.
    if let Ok(Some(existing)) = read_comicinfo_from_zip(path) {
        if existing == xml_content {
            log::debug!("[Embed Debug] ComicInfo.xml unchanged for {} — skipping repack.", file_path);
            return true;
        }
    }

    let tmp_path = path.with_extension("cbz.tmp");

    let result = (|| -> anyhow::Result<()> {
        let file = File::open(path)?;
        let mut archive = ZipArchive::new(file)?;

        let tmp_file = File::create(&tmp_path)?;
        let mut zip_writer = ZipWriter::new(tmp_file);

        for i in 0..archive.len() {
            let mut inner_file = archive.by_index(i)?;
            if inner_file.name().eq_ignore_ascii_case("comicinfo.xml") { continue; }

            // Preserve the original entry's compression method instead of forcing Stored.
            let options = FileOptions::default().compression_method(inner_file.compression());
            zip_writer.start_file(inner_file.name(), options)?;
            std::io::copy(&mut inner_file, &mut zip_writer)?;
        }

        let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip_writer.start_file("ComicInfo.xml", options)?;
        zip_writer.write_all(xml_content.as_bytes())?;
        zip_writer.finish()?;

        Ok(())
    })();

    match result {
        Ok(_) => std::fs::rename(&tmp_path, path).is_ok(),
        Err(e) => {
            log::error!("Failed to inject XML into {}: {}", file_path, e);
            let _ = std::fs::remove_file(&tmp_path);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inject_xml_skips_repack_when_unchanged() {
        use std::io::{Cursor, Write as _};
        // Build a cbz with a page + an existing ComicInfo.xml, written to a temp file.
        let build = |xml: &str| -> Vec<u8> {
            let mut buf = Vec::new();
            {
                let mut zw = ZipWriter::new(Cursor::new(&mut buf));
                let opts: FileOptions = FileOptions::default();
                zw.start_file("page1.jpg", opts).unwrap();
                zw.write_all(b"not-a-real-image").unwrap();
                zw.start_file("ComicInfo.xml", opts).unwrap();
                zw.write_all(xml.as_bytes()).unwrap();
                zw.finish().unwrap();
            }
            buf
        };
        let dir = std::env::temp_dir();
        let path = dir.join(format!("omni_inject_test_{}.cbz", std::process::id()));
        std::fs::write(&path, build("<ComicInfo>OLD</ComicInfo>")).unwrap();
        let before = std::fs::read(&path).unwrap();

        // Same XML → skipped: the file bytes are untouched (no repack).
        assert!(inject_xml_into_zip(path.to_str().unwrap(), "<ComicInfo>OLD</ComicInfo>"));
        assert_eq!(std::fs::read(&path).unwrap(), before, "unchanged XML must not rewrite the archive");

        // Different XML → repacked: the embedded ComicInfo.xml now reflects the new content.
        assert!(inject_xml_into_zip(path.to_str().unwrap(), "<ComicInfo>NEW</ComicInfo>"));
        assert_eq!(
            read_comicinfo_from_zip(&path).unwrap().as_deref(),
            Some("<ComicInfo>NEW</ComicInfo>")
        );

        let _ = std::fs::remove_file(&path);
    }

    // #199: the full ComicInfo default set — issue-wins pairing, series-only tags, and the B&W
    // tri-state — proven end-to-end through the real embed job against a file-backed SQLite +
    // real cbz (the round-trip test's fixture pattern).
    #[tokio::test]
    async fn embed_emits_full_comicinfo_defaults_with_issue_wins_pairing() {
        let base = std::env::temp_dir().join(format!("omnibus_ci199_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let cbz = base.join("Caravan 001.cbz");
        {
            let f = File::create(&cbz).unwrap();
            let mut zw = ZipWriter::new(f);
            zw.start_file("01.jpg", FileOptions::default()).unwrap();
            zw.write_all(&[0xFF, 0xD8, 0xFF, 0xE0]).unwrap();
            zw.finish().unwrap();
        }

        let db_file = base.join("ci.db");
        File::create(&db_file).unwrap();
        let db_url = format!("file:{}", db_file.to_string_lossy().replace('\\', "/"));
        let db = crate::db::Db::connect(&db_url, 2).await.expect("connect file-backed sqlite");

        for ddl in [
            r#"CREATE TABLE "SystemSetting" (key TEXT PRIMARY KEY, value TEXT)"#,
            r#"CREATE TABLE "Series" (id TEXT PRIMARY KEY, name TEXT, publisher TEXT, year INTEGER,
                "folderPath" TEXT, universe TEXT, "seriesGroup" TEXT, "isManga" INTEGER DEFAULT 0,
                "metadataId" TEXT, "metadataSource" TEXT, genres TEXT,
                writers TEXT, artists TEXT, "coverArtists" TEXT, colorists TEXT, letterers TEXT,
                characters TEXT, teams TEXT, locations TEXT, "storyArcs" TEXT,
                inker TEXT, editor TEXT, translator TEXT, imprint TEXT, tags TEXT, format TEXT,
                "languageISO" TEXT, "ageRating" TEXT, "communityRating" REAL, "blackAndWhite" INTEGER,
                gtin TEXT, notes TEXT, "scanInformation" TEXT, review TEXT, "mainCharacterOrTeam" TEXT,
                "alternateSeries" TEXT, "alternateNumber" TEXT, "alternateCount" INTEGER, "storyArcNumber" TEXT)"#,
            r#"CREATE TABLE "Issue" (id TEXT PRIMARY KEY, "seriesId" TEXT, "filePath" TEXT, number TEXT,
                name TEXT, description TEXT, "releaseDate" TEXT, universe TEXT, genres TEXT, "storyArcs" TEXT,
                writers TEXT, artists TEXT, characters TEXT, "coverArtists" TEXT, colorists TEXT,
                letterers TEXT, teams TEXT, locations TEXT, inker TEXT, editor TEXT, translator TEXT,
                tags TEXT, "mainCharacterOrTeam" TEXT, "alternateSeries" TEXT, "alternateNumber" TEXT,
                "alternateCount" INTEGER, "storyArcNumber" TEXT, gtin TEXT, notes TEXT,
                "scanInformation" TEXT, review TEXT, "communityRating" REAL, "blackAndWhite" INTEGER,
                "metadataId" TEXT, "metadataSource" TEXT)"#,
        ] {
            sqlx::query(ddl).execute(&db.pool).await.expect("create schema");
        }

        // series.json export off — this test is about the ComicInfo.xml alone.
        sqlx::query(r#"INSERT INTO "SystemSetting" (key, value) VALUES ('export_series_json', 'false')"#)
            .execute(&db.pool).await.unwrap();

        sqlx::query(
            r#"INSERT INTO "Series" (id, name, publisher, year, "metadataId", "metadataSource",
                   writers, artists, inker, editor, translator, imprint, tags, format, "languageISO",
                   "ageRating", "communityRating", "blackAndWhite", gtin, notes, "scanInformation",
                   review, "mainCharacterOrTeam", "alternateSeries", "alternateNumber", "alternateCount",
                   "storyArcNumber", genres, "storyArcs")
               VALUES ('s199', 'Caravan', 'Sergio Bonelli Editore', 2009, '111', 'COMICVINE',
                   '["Series Writer"]', '["Series Artist"]', '["Ink Person"]', '["Ed Itor"]', '["Trans Lator"]',
                   'Vertigo', '["ninja","school life"]', 'TPB', 'it',
                   'Mature 17+', 4.5, 1, '9781234567890', 'Some notes', 'Scanned by X',
                   'A review', 'Batman', 'Alt Series', '7A', 6,
                   '2', '["Sci-Fi"]', '["Big Arc"]')"#,
        ).execute(&db.pool).await.unwrap();

        let cbz_str = cbz.to_string_lossy().replace('\\', "/");
        // The issue has its OWN writers/inker (Beta A) and notes/alternateNumber (Beta B) — all
        // must win; blank artists/editor/translator/tags/etc. fall back to the series defaults.
        sqlx::query(
            r#"INSERT INTO "Issue" (id, "seriesId", "filePath", number, writers, inker, notes, "alternateNumber", "metadataId", "metadataSource")
               VALUES ('i199', 's199', $1, '1', '["Issue Writer"]', '["Issue Inker"]', 'Tagged by CT 2024', '19B', '900', 'COMICVINE')"#,
        ).bind(&cbz_str).execute(&db.pool).await.unwrap();

        let (ok, fail, sj) = process_embed_job(
            db.clone(),
            EmbedRequest { series_id: Some("s199".to_string()), issue_ids: None },
        ).await.expect("embed job");
        assert_eq!((ok, fail, sj), (1, 0, 0), "one embed, series.json export disabled");

        let xml = read_comicinfo_from_zip(&cbz).unwrap().expect("ComicInfo.xml embedded");
        // Pairing: the issue's writers win; the blank artists fall back to the series default.
        assert!(xml.contains("<Writer>Issue Writer</Writer>"), "issue value must win:\n{xml}");
        assert!(xml.contains("<Penciller>Series Artist</Penciller>"), "series default must fill:\n{xml}");
        // Issue-empty genre/arc fall back to the series values too.
        assert!(xml.contains("<Genre>Sci-Fi</Genre>"));
        assert!(xml.contains("<StoryArc>Big Arc</StoryArc>"));
        // Paired credits (Call-3 Beta A): the issue's own inker wins; blank editor/translator
        // fall back to the series defaults.
        assert!(xml.contains("<Inker>Issue Inker</Inker>"), "issue inker must win:\n{xml}");
        assert!(!xml.contains("Ink Person"), "series inker default must NOT override the issue's own:\n{xml}");
        assert!(xml.contains("<Editor>Ed Itor</Editor>"));
        assert!(xml.contains("<Translator>Trans Lator</Translator>"));
        assert!(xml.contains("<Imprint>Vertigo</Imprint>"));
        assert!(xml.contains("<Tags>ninja, school life</Tags>"));
        assert!(xml.contains("<Format>TPB</Format>"));
        assert!(xml.contains("<LanguageISO>it</LanguageISO>"));
        assert!(xml.contains("<AgeRating>Mature 17+</AgeRating>"));
        assert!(xml.contains("<CommunityRating>4.5</CommunityRating>"));
        assert!(xml.contains("<BlackAndWhite>Yes</BlackAndWhite>"));
        assert!(xml.contains("<GTIN>9781234567890</GTIN>"));
        // Beta B pairing: the issue's own notes/alternateNumber win over the series defaults…
        assert!(xml.contains("<Notes>Tagged by CT 2024</Notes>"), "issue notes must win:\n{xml}");
        assert!(!xml.contains("Some notes"), "series notes default must not override:\n{xml}");
        assert!(xml.contains("<AlternateNumber>19B</AlternateNumber>"), "issue alt-number must win:\n{xml}");
        assert!(!xml.contains("7A"));
        // …while blank issue fields still fall back to the series defaults.
        assert!(xml.contains("<ScanInformation>Scanned by X</ScanInformation>"));
        assert!(xml.contains("<Review>A review</Review>"));
        assert!(xml.contains("<MainCharacterOrTeam>Batman</MainCharacterOrTeam>"));
        assert!(xml.contains("<AlternateSeries>Alt Series</AlternateSeries>"));
        assert!(xml.contains("<AlternateCount>6</AlternateCount>"));
        assert!(xml.contains("<StoryArcNumber>2</StoryArcNumber>"));

        // Unset B&W reads back as Unknown — never a false "No" claim.
        sqlx::query(r#"UPDATE "Series" SET "blackAndWhite" = NULL WHERE id = 's199'"#)
            .execute(&db.pool).await.unwrap();
        let (ok2, _, _) = process_embed_job(
            db.clone(),
            EmbedRequest { series_id: Some("s199".to_string()), issue_ids: None },
        ).await.expect("embed job 2");
        assert_eq!(ok2, 1);
        let xml2 = read_comicinfo_from_zip(&cbz).unwrap().unwrap();
        assert!(xml2.contains("<BlackAndWhite>Unknown</BlackAndWhite>"), "unset must read Unknown:\n{xml2}");

        // Beta B: the issue's OWN B&W claim (an explicit No) beats even a series-level Yes — a
        // color series' one B&W backup issue emits its own truth.
        sqlx::query(r#"UPDATE "Series" SET "blackAndWhite" = 1 WHERE id = 's199'"#)
            .execute(&db.pool).await.unwrap();
        sqlx::query(r#"UPDATE "Issue" SET "blackAndWhite" = 0 WHERE id = 'i199'"#)
            .execute(&db.pool).await.unwrap();
        let (ok3, _, _) = process_embed_job(
            db.clone(),
            EmbedRequest { series_id: Some("s199".to_string()), issue_ids: None },
        ).await.expect("embed job 3");
        assert_eq!(ok3, 1);
        let xml3 = read_comicinfo_from_zip(&cbz).unwrap().unwrap();
        assert!(xml3.contains("<BlackAndWhite>No</BlackAndWhite>"), "issue's explicit No must beat series Yes:\n{xml3}");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn strip_html_removes_tags() {
        assert_eq!(strip_html("<p>Hello <b>world</b></p>"), "Hello world");
        assert_eq!(strip_html("Plain text"), "Plain text");
        assert_eq!(strip_html("  <i>x</i>  "), "x");
    }

    #[test]
    fn json_array_helpers() {
        assert_eq!(clean_json_array(Some(r#"["a","b"]"#)), "a, b");
        assert_eq!(clean_json_array(None), "");
        assert_eq!(clean_json_array(Some("not json")), "");
        assert_eq!(parse_json_array(Some(r#"["x"]"#)), vec!["x".to_string()]);
    }

    #[test]
    fn month_year_formatting_for_publication_run() {
        assert_eq!(format_month_year("1999-03-15"), "March 1999");
        assert_eq!(format_month_year("2020-12"), "December 2020");
        assert_eq!(format_month_year("2020"), "2020"); // no month -> year only
        assert_eq!(format_month_year("2020-00-01"), "2020"); // invalid month index
        assert_eq!(format_month_year("2020-13"), "2020");
    }
}
