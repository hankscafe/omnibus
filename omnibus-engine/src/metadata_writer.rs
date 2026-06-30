use sqlx::{PgPool, Row};
use std::collections::HashSet;
use std::fs::File;
use std::io::Write;
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

pub async fn process_embed_job(db: PgPool, payload: EmbedRequest) -> anyhow::Result<(i32, i32, i32)> {
    let base = r#"SELECT i.id, i."filePath", i.number, i.name as issue_name, i.description as issue_desc,
               i.writers, i.artists, i.characters, i."coverArtists", i.colorists, i.letterers, i.teams, i.locations,
               i."releaseDate", i.universe as issue_universe,
               i.genres, i."storyArcs", i."metadataId" as issue_meta_id, i."metadataSource" as issue_meta_source,
               s.id as series_id, s.name as series_name, s.publisher, s.year, s."folderPath",
               s.universe as series_universe, s."seriesGroup" as series_group, s."isManga", s."metadataId" as series_meta_id, s."metadataSource" as series_meta_source
        FROM "Issue" i
        JOIN "Series" s ON i."seriesId" = s.id
        WHERE i."filePath" LIKE '%.cbz'"#;

    // User-controlled ids are bound (NOT interpolated); only the fixed WHERE clause is appended.
    let rows = if let Some(s_id) = payload.series_id {
        sqlx::query(&format!("{} AND s.id = $1", base)).bind(s_id).fetch_all(&db).await?
    } else if let Some(i_ids) = payload.issue_ids {
        if i_ids.is_empty() {
            Vec::new()
        } else {
            sqlx::query(&format!("{} AND i.id = ANY($1)", base)).bind(i_ids).fetch_all(&db).await?
        }
    } else {
        sqlx::query(&format!("{} AND s.\"metadataSource\" IN ('COMICVINE', 'METRON')", base)).fetch_all(&db).await?
    };

    // 1. Build the full ComicInfo XML for each issue (in the async context, where we have the data).
    let mut tasks = Vec::new();
    for row in &rows {
        let file_path: String = row.get("filePath");
        let series_id: String = row.get("series_id");
        let series_name: String = row.try_get("series_name").unwrap_or_default();
        let number: String = row.try_get("number").unwrap_or_default();

        let xml_content = build_comic_info_xml(row);
        log::debug!("[Metadata Writer Debug] Generated XML content for: {} #{}", series_name, number);

        tasks.push(EmbedTask { file_path, xml_content, series_id });
    }

    // 2. Inject concurrently, BOUNDED so a full-library embed can't fan out hundreds of concurrent
    //    full-archive ZIP rewrites and thrash the disk / exhaust the blocking pool.
    let cfg = crate::engine_config::EngineConfig::load(&db).await;
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
fn build_comic_info_xml(row: &sqlx::postgres::PgRow) -> String {
    let g = |c: &str| -> Option<String> { row.try_get::<Option<String>, _>(c).unwrap_or(None) };

    let series_name = g("series_name").unwrap_or_default();
    let issue_name = g("issue_name").unwrap_or_default();
    let number = g("number").unwrap_or_default();
    let year: i32 = row.try_get("year").unwrap_or(0);
    let publisher = g("publisher").unwrap_or_default();
    let is_manga: bool = row.try_get("isManga").unwrap_or(false);

    let universe = g("issue_universe").filter(|s| !s.is_empty())
        .or_else(|| g("series_universe").filter(|s| !s.is_empty()))
        .unwrap_or_default();

    let writers = clean_json_array(g("writers").as_deref());
    let artists = clean_json_array(g("artists").as_deref());
    let characters = clean_json_array(g("characters").as_deref());
    let cover_artists = clean_json_array(g("coverArtists").as_deref());
    let colorists = clean_json_array(g("colorists").as_deref());
    let letterers = clean_json_array(g("letterers").as_deref());
    let teams = clean_json_array(g("teams").as_deref());
    let locations = clean_json_array(g("locations").as_deref());
    let summary = strip_html(&g("issue_desc").unwrap_or_default());

    let mut genre_list = parse_json_array(g("genres").as_deref());
    if is_manga && !genre_list.iter().any(|x| x == "Manga") {
        genre_list.push("Manga".to_string());
    }
    let genres = genre_list.join(", ");

    let story_arcs = parse_json_array(g("storyArcs").as_deref())
        .into_iter().filter(|a| a != "NONE").collect::<Vec<_>>().join(", ");

    let series_group = g("series_group").unwrap_or_default();

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

    let issue_id_ok = issue_meta_id.as_deref().filter(|s| !s.is_empty());
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

    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Series>{}</Series>
  <Title>{}</Title>
  <Number>{}</Number>
  <Volume>{}</Volume>
  <Summary>{}</Summary>
  <Year>{}</Year>
  <Month>{}</Month>
  <Day>{}</Day>
  <Publisher>{}</Publisher>
  <Universe>{}</Universe>
  <Genre>{}</Genre>
  <StoryArc>{}</StoryArc>
  <SeriesGroup>{}</SeriesGroup>
  <Writer>{}</Writer>
  <Penciller>{}</Penciller>
  <Colorist>{}</Colorist>
  <Letterer>{}</Letterer>
  <CoverArtist>{}</CoverArtist>
  <Characters>{}</Characters>
  <Teams>{}</Teams>
  <Locations>{}</Locations>
  <Web>{}</Web>
  <Manga>{}</Manga>
  <ComicVineVolumeId>{}</ComicVineVolumeId>
  <ComicVineIssueId>{}</ComicVineIssueId>
  <MetronId>{}</MetronId>
  <MetronIssueId>{}</MetronIssueId>
</ComicInfo>"#,
        escape_xml(&series_name),
        escape_xml(&issue_name),
        escape_xml(&number),
        volume,
        escape_xml(&summary),
        y, m, d,
        escape_xml(&publisher),
        escape_xml(&universe),
        escape_xml(&genres),
        escape_xml(&story_arcs),
        escape_xml(&series_group),
        escape_xml(&writers),
        escape_xml(&artists),
        escape_xml(&colorists),
        escape_xml(&letterers),
        escape_xml(&cover_artists),
        escape_xml(&characters),
        escape_xml(&teams),
        escape_xml(&locations),
        escape_xml(&web_url),
        manga_tag,
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
pub(crate) async fn write_series_json(db: &PgPool, series_id: &str) -> bool {
    let enabled = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'export_series_json'"#)
        .fetch_optional(db).await.ok().flatten();
    if enabled.as_deref() != Some("true") {
        return false;
    }

    let series = match sqlx::query(
        r#"SELECT name, publisher, status, description, year, "cvId", "metadataSource", "metadataId",
                  "folderPath", "bookType", "remoteCoverUrl", "coverUrl", "seriesJsonWritten"
           FROM "Series" WHERE id = $1"#,
    )
    .bind(series_id)
    .fetch_optional(db)
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
    let json_written: bool = series.try_get("seriesJsonWritten").unwrap_or(false);

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
        .fetch_all(db)
        .await
        .unwrap_or_default()
        .iter()
        .filter_map(|r| r.try_get::<Option<String>, _>("releaseDate").unwrap_or(None))
        .filter(|d| !d.is_empty())
        .collect();
    release_dates.sort();
    let total_issues = sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM "Issue" WHERE "seriesId" = $1"#)
        .bind(series_id)
        .fetch_one(db)
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

    // Mylar series.json schema v1.0.2. Unknown values are null, never "": Komga ignores nulls
    // but chokes on blanks. https://github.com/mylar3/mylar3/wiki/series.json-schema-(version-1.0.2)
    let series_json = serde_json::json!({
        "version": "1.0.2",
        "metadata": {
            "type": "comicSeries",
            "publisher": publisher,
            "imprint": serde_json::Value::Null,
            "name": name,
            "comicid": comicid,
            "year": year,
            "description_text": Some(description_text).filter(|s| !s.is_empty()),
            "description_formatted": Some(description_formatted).filter(|s| !s.is_empty()),
            "volume": serde_json::Value::Null,
            "booktype": book_type.filter(|s| !s.is_empty()).unwrap_or_else(|| "Print".to_string()),
            "age_rating": serde_json::Value::Null,
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
                    .execute(db)
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
pub async fn run_series_json_export(db: &PgPool, series_ids: Option<Vec<String>>) -> (i64, i64) {
    let rows = match &series_ids {
        // An explicit (even empty) id list filters, matching the Node `id: { in: [...] }` behavior.
        Some(ids) => {
            sqlx::query(r#"SELECT id FROM "Series" WHERE "metadataSource" IN ('COMICVINE','METRON') AND id = ANY($1)"#)
                .bind(ids)
                .fetch_all(db)
                .await
        }
        None => {
            sqlx::query(r#"SELECT id FROM "Series" WHERE "metadataSource" IN ('COMICVINE','METRON')"#)
                .fetch_all(db)
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

/// Rewrites the ZIP to include the new ComicInfo.xml, preserving the source compression of every entry.
fn inject_xml_into_zip(file_path: &str, xml_content: &str) -> bool {
    let path = Path::new(file_path);
    if !path.exists() { return false; }

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
