use regex::Regex;
use sqlx::Row;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use serde::Deserialize;
use crate::prowlarr::ProwlarrResult;

#[derive(Deserialize, Debug)]
pub struct ScoringRule {
    pub term: String,
    pub score: i32,
}

// ---- Hot regexes compiled once (PERF: previously rebuilt per-result/per-call) ----
fn re_ext_strip() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\.\w+$").unwrap())
}
fn re_year_brackets_strip() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\[\d{4}(?:-\d{4})?\]|\(\d{4}(?:-\d{4})?\)").unwrap())
}
fn re_year_find() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[\(\[]?(19\d{2}|20\d{2})[\)\]]?").unwrap())
}
fn re_brackets_parens_strip() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\[.*?\]|\(.*?\)").unwrap())
}
fn re_bounded_variant() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)\bnoir\b|\bb&w\b|\bsketch\b|\bblank\b|\bvirgin\b|\buncut\b").unwrap()
    })
}

/// Normalizes a release title to a comparable "edition" key (parity with automation.ts normalizeTitle).
/// Used to detect when GetComics returns multiple distinct editions for one request.
pub fn normalize_edition_title(t: &str) -> String {
    fn lazy(slot: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
        slot.get_or_init(|| Regex::new(pat).unwrap())
    }
    static RE_PARENS: OnceLock<Regex> = OnceLock::new();
    static RE_BRACKETS: OnceLock<Regex> = OnceLock::new();
    static RE_NONALNUM: OnceLock<Regex> = OnceLock::new();
    static RE_KEYWORDS: OnceLock<Regex> = OnceLock::new();
    static RE_SPACES: OnceLock<Regex> = OnceLock::new();

    let lower = t.to_lowercase();
    let s = lazy(&RE_PARENS, r"\(.*?\)").replace_all(&lower, "");
    let s = lazy(&RE_BRACKETS, r"\[.*?\]").replace_all(&s, "");
    let s = lazy(&RE_NONALNUM, r"[^a-z0-9\s]").replace_all(&s, " ");
    let s = lazy(&RE_KEYWORDS, r"\b(?:issue|vol|volume|book|ch|chapter|part)\b").replace_all(&s, "");
    let s = lazy(&RE_SPACES, r"\s+").replace_all(&s, "");
    s.trim().to_string()
}

/// Recognized automation search sources. Default order = GetComics then Prowlarr (legacy behavior);
/// Anna's Archive is OFF by default (opt-in + API-key-gated at save time on the Node side).
pub const KNOWN_SEARCH_SOURCES: [&str; 3] = ["getcomics", "annas_archive", "prowlarr"];

/// Parse the `search_source_priority` setting into an ordered list of ENABLED source keys (mirrors the
/// hoster-priority parser in getcomics.rs). Accepts a bare string array (all enabled, in order) or an
/// object array of `{"source","enabled"}`. Unknown source keys and disabled entries are dropped; the
/// order and first occurrence are preserved. Unset, unparsable, or empty-after-filter falls back to the
/// default order so automation never ends up with zero sources. This only decides the ORDER and whether
/// Anna's Archive participates: `getcomics` (via ddl_enabled) and `prowlarr` (via its config) stay
/// independently gated downstream, so listing them here cannot force a disabled source to run.
pub fn parse_search_source_order(value: Option<&str>) -> Vec<String> {
    let default = || vec!["getcomics".to_string(), "prowlarr".to_string()];
    let Some(val) = value.map(str::trim).filter(|v| !v.is_empty()) else { return default(); };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(val) else { return default(); };
    let Some(arr) = parsed.as_array() else { return default(); };

    let mut out: Vec<String> = Vec::new();
    for v in arr {
        let (source, enabled) = if let Some(s) = v.as_str() {
            (s.to_string(), true)
        } else if let Some(s) = v.get("source").and_then(|s| s.as_str()) {
            (s.to_string(), v.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true))
        } else {
            continue;
        };
        if enabled && KNOWN_SEARCH_SOURCES.contains(&source.as_str()) && !out.contains(&source) {
            out.push(source);
        }
    }

    if out.is_empty() { default() } else { out }
}

pub async fn get_custom_acronyms(db: &sqlx::AnyPool) -> anyhow::Result<HashMap<String, String>> {
    let mut ac_map = HashMap::new();
    ac_map.insert("tmnt".to_string(), "teenage mutant ninja turtles".to_string());
    ac_map.insert("asm".to_string(), "amazing spider-man".to_string());
    ac_map.insert("f4".to_string(), "fantastic four".to_string());
    ac_map.insert("jla".to_string(), "justice league of america".to_string());

    let rows = sqlx::query(r#"SELECT key, value FROM "SearchAcronym""#).fetch_all(db).await?;
    for row in rows {
        let key: String = row.get("key");
        let val: String = row.get("value");
        if !key.is_empty() && !val.is_empty() { ac_map.insert(key.to_lowercase(), val.to_lowercase()); }
    }
    Ok(ac_map)
}

/// Insertion-ordered de-dup push (replaces the old HashSet so query order is deterministic —
/// the Prowlarr loop returns on the first non-empty query, so order is load-bearing).
fn add_query(vec: &mut Vec<String>, seen: &mut HashSet<String>, val: String) {
    let v = val.trim().to_string();
    if !v.is_empty() && seen.insert(v.clone()) {
        vec.push(v);
    }
}

/// Drops a trailing descriptive subtitle from a single-issue request name:
/// "Batman: Gargoyle of Gotham #1: Book One" -> "Batman: Gargoyle of Gotham #1".
/// Only applies when an issue marker (#/issue/chapter + number) is present, so a genuine TPB request
/// like "Batman Book One" is left intact. Without this, a subtitle keyword such as "Book"/"Volume"
/// trips TPB/omnibus detection AND the subtitle words ("book", "one") get enforced as required title
/// words — which rejects every real single-issue file, since the GetComics uploader never includes the
/// subtitle. Shared by query generation and relevance filtering so both derive the same core name.
/// `-?` keeps negative issue numbers (e.g. "Batman #-1") recognized as single issues (beta.023+).
pub(crate) fn strip_issue_subtitle(name: &str) -> String {
    static RE_HAS_ISSUE: OnceLock<Regex> = OnceLock::new();
    static RE_SPLIT: OnceLock<Regex> = OnceLock::new();
    let re_has_issue = RE_HAS_ISSUE.get_or_init(|| Regex::new(r"(?i)(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*-?\d+").unwrap());
    if !re_has_issue.is_match(name) { return name.to_string(); }
    let re_split = RE_SPLIT.get_or_init(|| Regex::new(r"(?i)^(.*?(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*-?\d+(?:\.\d+)?[a-zA-Z]?)\s*[:\-]\s*.*$").unwrap());
    match re_split.captures(name) {
        Some(caps) => caps[1].trim().to_string(),
        None => name.to_string(),
    }
}

/// Strips a trailing comic/archive file extension so a download filename (e.g. a retry's
/// activeDownloadName "Wolverine #3 (2024).cbz") doesn't leak "cbz" into the generated queries or the
/// relevance filter.
pub(crate) fn strip_file_extension(name: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)\.(cbz|cbr|cb7|cbt|zip|rar|7z|pdf|epub)$").unwrap());
    re.replace(name.trim(), "").trim().to_string()
}

/// Normalizes a request name for searching: drops a trailing file extension AND a trailing descriptive
/// subtitle. "Wolverine #3 (2024).cbz" -> "Wolverine #3 (2024)"; "Batman #1: Book One" -> "Batman #1".
/// Query generation and relevance filtering both route through this so they derive the same core name.
pub(crate) fn normalize_request_name(name: &str) -> String {
    strip_issue_subtitle(&strip_file_extension(name))
}

pub fn generate_search_queries(
    name: &str,
    year: &str,
    acronyms: &HashMap<String, String>,
    prioritize_packs: bool,
    use_packs: bool,
) -> Vec<String> {
    let search_name = normalize_request_name(name);

    // Two insertion-ordered groups, each de-duped within itself (parity with Node's two Sets).
    let mut primary: Vec<String> = Vec::new();
    let mut primary_seen: HashSet<String> = HashSet::new();
    let mut secondary: Vec<String> = Vec::new();
    let mut secondary_seen: HashSet<String> = HashSet::new();

    let base_name = search_name.replace('#', "").trim().to_string();
    // Strip both straight and curly-apostrophe possessives ("Wolverine's" / "Wolverine’s" → "Wolverine")
    // so a stray "s" token isn't later enforced as a required title word (parity with search-engine.ts).
    let re_possessive = Regex::new(r"(?i)['’]s\b|\s s\b").unwrap();
    let no_possessive = re_possessive.replace_all(&base_name, "").to_string();

    let re_symbols = Regex::new(r"[^a-zA-Z0-9\s]").unwrap();
    let re_spaces = Regex::new(r"\s+").unwrap();
    let broad_clean = re_spaces.replace_all(&re_symbols.replace_all(&no_possessive, " "), " ").trim().to_string();

    let mut main_part = search_name.clone();
    let mut has_subtitle = false;

    if search_name.contains(" - ") {
        let parts: Vec<&str> = search_name.split(" - ").collect();
        main_part = parts[0].trim().to_string();
        has_subtitle = true;
    } else if search_name.contains(": ") {
        let parts: Vec<&str> = search_name.split(": ").collect();
        main_part = parts[0].trim().to_string();
        has_subtitle = true;
    }

    if has_subtitle {
        let main_part_clean = main_part.replace('#', "").trim().to_string();
        let main_no_possessive = re_possessive.replace_all(&main_part_clean, "").to_string();
        let main_broad_clean = re_spaces.replace_all(&re_symbols.replace_all(&main_no_possessive, " "), " ").trim().to_string();

        if main_broad_clean.len() > 2 {
            if !year.is_empty() { add_query(&mut primary, &mut primary_seen, format!("{} {}", main_broad_clean, year)); }
            add_query(&mut primary, &mut primary_seen, main_broad_clean.clone());

            let mut main_expanded = main_broad_clean.clone();
            for (ac, full) in acronyms {
                let re_ac = Regex::new(&format!(r"(?i)\b{}\b", regex::escape(ac))).unwrap();
                main_expanded = re_ac.replace_all(&main_expanded, full).to_string();
            }
            if main_expanded.to_lowercase() != main_broad_clean.to_lowercase() {
                if !year.is_empty() { add_query(&mut primary, &mut primary_seen, format!("{} {}", main_expanded, year)); }
                add_query(&mut primary, &mut primary_seen, main_expanded);
            }
        }
    }

    if !year.is_empty() { add_query(&mut secondary, &mut secondary_seen, format!("{} {}", base_name, year)); }
    add_query(&mut secondary, &mut secondary_seen, base_name.clone());
    if !year.is_empty() { add_query(&mut secondary, &mut secondary_seen, format!("{} {}", broad_clean, year)); }
    add_query(&mut secondary, &mut secondary_seen, broad_clean.clone());

    let re_dash = Regex::new(r"[/:&]").unwrap();
    if re_dash.is_match(&base_name) {
        let dashed = re_spaces.replace_all(&re_dash.replace_all(&base_name, " - "), " ").trim().to_string();
        if !year.is_empty() { add_query(&mut secondary, &mut secondary_seen, format!("{} {}", dashed, year)); }
        add_query(&mut secondary, &mut secondary_seen, dashed);
    }

    let mut expanded = broad_clean.clone();
    for (ac, full) in acronyms {
        let re_ac = Regex::new(&format!(r"(?i)\b{}\b", regex::escape(ac))).unwrap();
        expanded = re_ac.replace_all(&expanded, full).to_string();
    }
    if expanded.to_lowercase() != broad_clean.to_lowercase() {
        if !year.is_empty() { add_query(&mut secondary, &mut secondary_seen, format!("{} {}", expanded, year)); }
        add_query(&mut secondary, &mut secondary_seen, expanded);
    }

    // --- PACK GENERATOR (beta.035): a separate gated group, optionally ordered first. ---
    let mut packs: Vec<String> = Vec::new();
    let mut packs_seen: HashSet<String> = HashSet::new();
    if use_packs {
        let re_series_only = Regex::new(r"(?i)\s\d+(?:\.\d+)?$").unwrap();
        let series_only_name = re_series_only.replace(&broad_clean, "").trim().to_string();
        if series_only_name.len() > 2 {
            if series_only_name != broad_clean {
                add_query(&mut packs, &mut packs_seen, series_only_name.clone());
            }
            add_query(&mut packs, &mut packs_seen, format!("{} collection", series_only_name));
            add_query(&mut packs, &mut packs_seen, format!("{} story arc", series_only_name));
            add_query(&mut packs, &mut packs_seen, format!("{} pack", series_only_name));
        }
    }

    // The bare main-title queries (e.g. "X Men" / "X Men 2026" from a colon-split "X-Men: Outback #1")
    // live in `primary`; the full, specific name variants (series + subtitle + issue number) live in
    // `secondary`. Search the SPECIFIC variants FIRST so a series whose name legitimately contains a
    // colon/dash isn't immediately matched against its entire line by an over-broad title-only query —
    // which also drops the issue number, disabling the indexer's issue filter and letting any issue win.
    // The broad title query is retained as a fallback for when the specific variants find nothing.
    let final_queries: Vec<String> = if prioritize_packs && use_packs {
        let mut fq = packs;
        fq.extend(secondary);
        fq.extend(primary);
        fq
    } else {
        let mut fq = secondary;
        fq.extend(primary);
        fq.extend(packs);
        fq
    };

    // Issue #176 change A: scene/Usenet releases zero-pad the issue number to 3 digits, so a query
    // ending in a bare "3" can miss "…003…" hits on tokenizing newznab indexers. Emit a padded companion
    // for each query that ends in the requested issue number, ordered just before its bare form so the
    // interactive first-hit path tries the more specific shape first. Automated (exhaustive) search sends
    // every variant anyway, so this is purely additive recall — the result filter still enforces the
    // exact issue number, so a padded query can't loosen precision.
    apply_issue_padding(final_queries, &search_name)
}

/// The requested issue as (bare, zero-padded-to-3) — e.g. ("3", "003") — but ONLY when the name carries
/// an explicit issue marker (#/issue/chapter) and the number is 1–2 digits (so padding actually differs).
/// Keying on the marker avoids ever mistaking a title number (Batman '89, Spider-Man 2099) for the issue.
fn issue_pad_forms(name: &str) -> Option<(String, String)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(\d{1,2})\b").unwrap());
    let n: u32 = re.captures(name)?.get(1)?.as_str().parse().ok()?;
    if n == 0 { return None; }
    let bare = n.to_string();
    let padded = format!("{:03}", n);
    if bare == padded { None } else { Some((bare, padded)) }
}

/// If `query` ends in the bare issue number as its own token (optionally followed by a 4-digit year),
/// return the query with that number zero-padded; otherwise None. Anchored to the end so an in-title
/// number (e.g. the "23" of "X 23 001") is never touched.
fn pad_trailing_issue(query: &str, bare: &str, padded: &str) -> Option<String> {
    let re = Regex::new(&format!(r"(^|\s){}(\s\d{{4}})?$", regex::escape(bare))).ok()?;
    let caps = re.captures(query)?;
    let m = caps.get(0)?;
    let lead = caps.get(1).map_or("", |x| x.as_str());
    let year = caps.get(2).map_or("", |x| x.as_str());
    Some(format!("{}{}{}{}", &query[..m.start()], lead, padded, year))
}

/// Insert a zero-padded issue variant immediately before each query that ends in the bare issue number,
/// de-duping. A no-op when the name has no explicit issue marker (so existing pack/title-only tests and
/// number-less requests are unaffected).
fn apply_issue_padding(queries: Vec<String>, name: &str) -> Vec<String> {
    let (bare, padded) = match issue_pad_forms(name) {
        Some(p) => p,
        None => return queries,
    };
    let mut out: Vec<String> = Vec::with_capacity(queries.len() + 4);
    let mut seen: HashSet<String> = HashSet::new();
    for q in queries {
        if let Some(pq) = pad_trailing_issue(&q, &bare, &padded) {
            if seen.insert(pq.clone()) { out.push(pq); }
        }
        if seen.insert(q.clone()) { out.push(q); }
    }
    out
}

// Extract number faithfully porting Node.js regex fallbacks without using lookarounds.
pub(crate) fn extract_number(title: &str, is_manga: bool, strip_vol: bool) -> Option<f32> {
    static RE_VOL_STRIP: OnceLock<Regex> = OnceLock::new();
    static RE_ISSUE: OnceLock<Regex> = OnceLock::new();
    static RE_VOL_PURE: OnceLock<Regex> = OnceLock::new();
    static RE_FALLBACK: OnceLock<Regex> = OnceLock::new();
    let re_vol_strip = RE_VOL_STRIP.get_or_init(|| Regex::new(r"(?i)(?:vol(?:ume)?\s*\.?|v\s*\.?|book\s*\.?)\s*0*\d+(?:\.\d+)?").unwrap());
    let re_issue = RE_ISSUE.get_or_init(|| Regex::new(r"(?i)(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)").unwrap());
    let re_vol_pure = RE_VOL_PURE.get_or_init(|| Regex::new(r"(?i)(?:vol(?:ume)?\s*\.?|v\s*\.?)\s*0*(\d{1,3}(?:\.\d+)?)\b").unwrap());
    let re_fallback = RE_FALLBACK.get_or_init(|| Regex::new(r"\b0*(\d+(?:\.\d+)?)\b").unwrap());

    let mut stripped = title.to_string();
    // Only the RESULT (title) side strips vol/v/book; the request side keeps a volume number as the
    // requested number (parity with Node's reqNum vs the strippedForNumbers torNum in getcomics.ts).
    if !is_manga && strip_vol {
        stripped = re_vol_strip.replace_all(&stripped, "").to_string();
    }

    if let Some(caps) = re_issue.captures(&stripped) {
        return caps.get(1).and_then(|m| m.as_str().parse::<f32>().ok());
    }
    if let Some(caps) = re_vol_pure.captures(&stripped) {
        return caps.get(1).and_then(|m| m.as_str().parse::<f32>().ok());
    }

    let mut fallbacks = Vec::new();
    for caps in re_fallback.captures_iter(&stripped) {
        if let Some(m) = caps.get(1) {
            if let Ok(num) = m.as_str().parse::<f32>() { fallbacks.push(num); }
        }
    }
    for num in fallbacks.into_iter().rev() {
        if (1900.0..=2099.0).contains(&num) { continue; } // Ignore years
        return Some(num);
    }
    None
}

/// Issue/volume number from a RESULT title: strips the file extension + bracketed/paren years first,
/// then defers to extract_number. Shared by filter_and_score and getcomics::search.
pub(crate) fn extract_title_number(title_lower: &str, is_manga: bool) -> Option<f32> {
    let clean = re_ext_strip().replace(title_lower, "").to_string();
    let clean = re_year_brackets_strip().replace_all(&clean, "").to_string();
    extract_number(&clean, is_manga, true)
}

/// First 4-digit year (1900–2099) found in a title, e.g. "(2014)" → "2014".
pub(crate) fn find_title_year(title_lower: &str) -> Option<String> {
    re_year_find().captures(title_lower).and_then(|c| c.get(1)).map(|m| m.as_str().to_string())
}

/// Whether a title contains a bounded-variant keyword (noir/b&w/sketch/blank/virgin/uncut).
pub(crate) fn matches_bounded_variant(title_lower: &str) -> bool {
    re_bounded_variant().is_match(title_lower)
}

/// Core-title match-ratio reverse-validation (parity with prowlarr.ts:147-167).
/// Returns true if the result should be REJECTED.
fn fails_match_ratio(significant_query_words: &[String], result_words: &[String], is_pack: bool, ratio_config: f64) -> bool {
    if is_pack { return false; }
    let extra_words = result_words.iter().filter(|w| !significant_query_words.contains(w)).count();
    let matches = significant_query_words.iter().filter(|w| result_words.contains(w)).count();
    let max_len = significant_query_words.len().max(result_words.len());
    let match_ratio = if max_len > 0 { matches as f64 / max_len as f64 } else { 0.0 };
    match_ratio < ratio_config && extra_words > 2
}

/// Reduce a release title to its core series words: strip [tags], (year)/(group), bare years and
/// issue/cover numbers, then drop noise. What remains should be ONLY the series name. Used by the
/// beta.068 reverse guard to detect a differently-titled series (e.g. "Wolverine - Blood Hunt 003").
fn core_series_words(title: &str, noise: &HashSet<String>) -> Vec<String> {
    static RE_BRACKETS: OnceLock<Regex> = OnceLock::new();
    static RE_PARENS: OnceLock<Regex> = OnceLock::new();
    static RE_YEAR: OnceLock<Regex> = OnceLock::new();
    static RE_NUM: OnceLock<Regex> = OnceLock::new();
    let re_brackets = RE_BRACKETS.get_or_init(|| Regex::new(r"\[[^\]]*\]").unwrap());
    let re_parens = RE_PARENS.get_or_init(|| Regex::new(r"\([^)]*\)").unwrap());
    let re_year = RE_YEAR.get_or_init(|| Regex::new(r"\b(?:19|20)\d{2}\b").unwrap());
    let re_num = RE_NUM.get_or_init(|| Regex::new(r"#?\d+(?:\.\d+)?").unwrap());
    let t = title.to_lowercase();
    let t = re_brackets.replace_all(&t, " ");
    let t = re_parens.replace_all(&t, " ");
    let t = re_year.replace_all(&t, " ");
    let t = re_num.replace_all(&t, " ");
    let cleaned: String = t.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' }).collect();
    cleaned
        .split_whitespace()
        .filter(|w| w.chars().count() > 2 && !noise.contains(*w))
        .map(|s| s.to_string())
        .collect()
}

#[allow(clippy::too_many_arguments)]
pub async fn filter_and_score(
    db: &sqlx::AnyPool,
    results: Vec<ProwlarrResult>,
    target_query: &str,
    is_manga: bool,
    req_year: Option<String>,
    series_year: Option<String>,
    skip_relevance: bool,
    allow_packs_override: Option<bool>,
) -> anyhow::Result<Option<ProwlarrResult>> {

    let junk_words_str = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'filter_junk_words'"#)
        .fetch_optional(db).await?.unwrap_or_else(|| "preview, sample, ashcan, cropped, scanned, fixed, incomplete, damaged, partial, promo, teaser".to_string());
    let exclude_groups_str = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'filter_exclude_groups'"#)
        .fetch_optional(db).await?.unwrap_or_default();
    let mut allow_bulk_packs = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'allow_bulk_packs'"#)
        .fetch_optional(db).await?.unwrap_or_default() == "true";
    // Isolated-issue requests (series already has downloaded files) suppress packs even when the
    // global setting allows them — parity with prowlarr.ts allowPacksOverride (beta.035).
    if allow_packs_override == Some(false) {
        allow_bulk_packs = false;
    }
    let scoring_rules_str = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'release_scoring_rules'"#)
        .fetch_optional(db).await?.unwrap_or_default();
    let match_ratio_str = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'filter_match_ratio'"#)
        .fetch_optional(db).await?.unwrap_or_default();
    let ratio_config = match_ratio_str.parse::<f64>().unwrap_or(60.0) / 100.0;
    // Issue #176 change B (opt-in, default OFF): accept undated Prowlarr/Usenet releases instead of
    // hard-rejecting them, but demote them below any dated candidate (year = validator/tiebreaker).
    let accept_yearless = sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = 'prowlarr_accept_yearless'"#)
        .fetch_optional(db).await?.unwrap_or_default() == "true";

    // Default scoring rules — full 8-rule set matching automation.ts:269-273 (was truncated to 2).
    let mut scoring_rules: Vec<ScoringRule> = vec![
        ScoringRule { term: ".cbz".to_string(), score: 500 },
        ScoringRule { term: "(digital)".to_string(), score: 300 },
        ScoringRule { term: "[digital]".to_string(), score: 300 },
        ScoringRule { term: "webrip".to_string(), score: 200 },
        ScoringRule { term: "web-dl".to_string(), score: 200 },
        ScoringRule { term: ".cbr".to_string(), score: -400 },
        ScoringRule { term: ".rar".to_string(), score: -400 },
        ScoringRule { term: "vapi".to_string(), score: -400 },
    ];
    if !scoring_rules_str.is_empty() {
        if let Ok(parsed) = serde_json::from_str::<Vec<ScoringRule>>(&scoring_rules_str) {
            if !parsed.is_empty() { scoring_rules = parsed; }
        }
    }

    let junk_words: Vec<String> = junk_words_str.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
    let exclude_groups: Vec<String> = exclude_groups_str.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();

    // Normalize ("#1: Book One" -> "#1", "….cbz" -> "…") so a subtitle keyword or a leaked file
    // extension doesn't trip TPB/omnibus detection or get enforced as a required title word.
    let core_query = normalize_request_name(target_query);
    let clean_original = core_query.replace(&[':', '-', '&'][..], " ")
        .split_whitespace().collect::<Vec<&str>>().join(" ").to_lowercase();

    let stop_words: HashSet<&str> = ["the", "a", "an", "of", "and", "or", "vol", "volume", "issue", "black", "white", "blood"].into_iter().collect();

    let bounded_variant_keywords = ["noir", "b&w", "sketch", "blank", "virgin", "uncut"];
    let open_variant_keywords = ["variant", "special edition", "director's cut", "directors cut", "facsimile", "black and white", "extended"];

    let user_wants_variant = bounded_variant_keywords.iter().any(|k| clean_original.contains(k)) ||
                             open_variant_keywords.iter().any(|k| clean_original.contains(k));

    let req_num = extract_number(&clean_original, is_manga, false);

    let mut tpb_terms = vec!["omnibus", "tpb", "compendium", "collection", "hc", "hardcover", "trade paperback"];
    if !is_manga { tpb_terms.extend_from_slice(&["vol ", "volume ", "book "]); }
    let is_looking_for_omnibus = tpb_terms.iter().any(|term| clean_original.contains(term));
    let pack_terms = ["story arc", "pack", "complete", "collection", "bundle", "run", "chronological"];
    let is_looking_for_annual = clean_original.contains("annual");

    let original_query_words: Vec<String> = clean_original.chars().map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>().split_whitespace()
        .filter(|&w| !stop_words.contains(w))
        .map(|s| s.to_string()).collect();

    // Significant words for the core-title match-ratio (parity: !stopword && len > 2).
    let significant_query_words: Vec<String> = original_query_words.iter()
        .filter(|w| w.chars().count() > 2)
        .cloned()
        .collect();

    // Noise set for the beta.068 reverse guard — stop words, junk/format tokens, variant keywords, and
    // common scan tags. Dropped symmetrically from both the request and the release-title core words, so a
    // real "Black, White & Blood" series still matches its own releases (parity with automation.ts reverseNoise).
    let reverse_noise: HashSet<String> = {
        let mut s: HashSet<String> = stop_words.iter().map(|w| w.to_string()).collect();
        for w in ["eng", "cbz", "cbr", "cb7", "zip", "rar", "webrip", "digital", "vol", "volume", "ch", "chapter", "issue", "tpb", "rip", "the", "and", "of", "by", "gn"] { s.insert(w.to_string()); }
        for w in &bounded_variant_keywords { s.insert(w.to_string()); }
        for k in &open_variant_keywords { for w in k.split_whitespace() { s.insert(w.to_string()); } }
        for w in ["cover", "covers", "scan", "scans", "noads", "c2c", "empire", "mobile"] { s.insert(w.to_string()); }
        s
    };

    // Evaluate each result: None = rejected; Some(year_unconfirmed) = kept, where `true` marks an
    // undated release admitted only via the opt-in `prowlarr_accept_yearless` (issue #176 change B).
    // Unconfirmed survivors sort BELOW every dated candidate regardless of score, so an undated release
    // only ever auto-downloads when nothing dated exists.
    let evaluate = |res: &ProwlarrResult| -> Option<bool> {
        let title_lower = res.title.to_lowercase();
        let is_ddl = res.protocol == "ddl";

        for junk in &junk_words { if title_lower.contains(junk) { return None; } }
        for group in &exclude_groups { if title_lower.contains(group) { return None; } }
        if res.seeders == 0 && res.protocol != "usenet" && !is_ddl { return None; }

        // Pre-filtered sources (GetComics, already validated per-query in getcomics::search) only get
        // the operator's junk/exclude lists + scoring — not this relevance filter, which is keyed on the
        // merged target_query rather than the specific query that produced the result.
        if skip_relevance { return Some(false); }

        let is_pack = allow_bulk_packs && pack_terms.iter().any(|term| title_lower.contains(term));

        if req_num.is_some() && !is_looking_for_omnibus && !is_pack {
            let unexpected_tpb_terms: Vec<&&str> = tpb_terms.iter().filter(|t| !clean_original.contains(**t)).collect();
            if unexpected_tpb_terms.iter().any(|term| title_lower.contains(**term)) { return None; }
        }

        // Variant rejection is a GetComics/DDL-only filter in Node (getcomics.ts); prowlarr.ts never
        // rejects variants, so gate on is_ddl to avoid dropping legitimate Prowlarr torrents.
        if is_ddl && !user_wants_variant {
            if open_variant_keywords.iter().any(|k| title_lower.contains(k)) { return None; }
            if re_bounded_variant().is_match(&title_lower) { return None; }
        }

        let clean_tor = re_ext_strip().replace(&title_lower, "").to_string();
        let clean_tor = re_year_brackets_strip().replace_all(&clean_tor, "").to_string();
        let tor_num = extract_number(&clean_tor, is_manga, true);

        if let Some(rn) = &req_num {
            if !is_looking_for_omnibus && !is_pack {
                match &tor_num {
                    Some(tn) if tn != rn => return None,
                    None => return None,
                    _ => {}
                }
            }
        }

        // Year anchor. tor_year is the year found in the title (if any).
        let tor_year: Option<String> = re_year_find().captures(&title_lower)
            .and_then(|c| c.get(1)).map(|m| m.as_str().to_string());

        // A pack/collection is dated by its SERIES start year, not the requested issue's release year
        // (beta.069): "Wolverine Complete Collection (2024)" legitimately serves a 2026 issue. So packs
        // anchor on series_year (falling back to req_year); single issues stay on the per-issue req_year.
        let effective_year = if is_pack {
            series_year.as_ref().or(req_year.as_ref())
        } else {
            req_year.as_ref()
        };

        let mut year_unconfirmed = false;
        if let Some(req_y) = effective_year {
            if let Some(ty_str) = &tor_year {
                if let (Ok(ry), Ok(ty)) = (req_y.parse::<i32>(), ty_str.parse::<i32>()) {
                    // A present-but-wrong year is ALWAYS a hard reject — this is the volume discriminator
                    // for rebooted series and is never relaxed by the opt-in below.
                    if (ry - ty).abs() > 1 { return None; }
                }
            } else if !is_ddl && !title_lower.contains(req_y.as_str()) {
                // Prowlarr, undated title (PG-7 default: reject). Scene/Usenet releases often omit the
                // year, so with prowlarr_accept_yearless=true the release is KEPT but flagged, and the
                // tiered sort below prefers any dated candidate over it (issue #176 change B).
                if accept_yearless { year_unconfirmed = true; } else { return None; }
            }
        }

        // Annual rejection is GetComics/DDL-only in Node (getcomics.ts:258-262); prowlarr.ts has none.
        if is_ddl && !is_looking_for_annual && title_lower.contains("annual") { return None; }

        // REVERSE GUARD (Prowlarr single-issue only): the required-word/ratio checks can't tell the
        // requested series from a differently-titled one that merely CONTAINS its words — e.g. "Wolverine
        // - Blood Hunt 003" for a plain "Wolverine #3" ("blood" is a stop word, so the ratio gate sees only
        // 2 extra tokens and its ">2 extra words" rule lets it through). Reject a single-issue release whose
        // core title (tags/year/issue stripped) introduces a series word the request lacks. Skipped for
        // packs, which legitimately carry extra words ("Complete Collection"). (beta.068)
        if !is_ddl && req_num.is_some() && !is_pack && !significant_query_words.is_empty() {
            let extra: Vec<String> = core_series_words(&res.title, &reverse_noise)
                .into_iter()
                .filter(|t| !significant_query_words.contains(t))
                .collect();
            if !extra.is_empty() {
                log::debug!("[Automation Debug] Discarding off-series Prowlarr release \"{}\" — extra series words {:?} not in requested \"{}\".", res.title, extra, clean_original);
                return None;
            }
        }

        // Core-title match-ratio reverse-validation — Prowlarr only (H-12).
        if !is_ddl && !significant_query_words.is_empty() {
            let stripped_title = re_brackets_parens_strip().replace_all(&title_lower, "").to_string();
            let result_words: Vec<String> = stripped_title.chars()
                .map(|c| if c.is_alphanumeric() { c } else { ' ' })
                .collect::<String>()
                .split_whitespace()
                .filter(|w| !stop_words.contains(*w) && w.chars().count() > 2 && Some(*w) != tor_year.as_deref())
                .map(|s| s.to_string())
                .collect();
            if fails_match_ratio(&significant_query_words, &result_words, is_pack, ratio_config) {
                return None;
            }
        }

        let mut words_to_enforce = original_query_words.clone();
        if req_num.is_some() && !is_looking_for_omnibus {
            if let Some(idx) = words_to_enforce.iter().position(|w| w.parse::<f32>().ok() == req_num) {
                words_to_enforce.truncate(idx);
            }
        }
        for w in &words_to_enforce {
            if !w.chars().all(char::is_numeric) && !title_lower.contains(w) { return None; }
        }

        Some(year_unconfirmed)
    };

    let mut kept: Vec<(ProwlarrResult, bool)> = Vec::new();
    for res in results {
        if let Some(unconfirmed) = evaluate(&res) {
            kept.push((res, unconfirmed));
        }
    }

    if kept.is_empty() { return Ok(None); }

    // Tiered sort: year-confirmed (false) before unconfirmed (true), then score within each tier.
    // With prowlarr_accept_yearless off no survivor is ever flagged, so this reduces to the original
    // pure score ordering — the default path is bit-for-bit the old behavior.
    kept.sort_by(|a, b| {
        a.1.cmp(&b.1).then_with(|| {
            let score_a = calculate_score(&a.0, &scoring_rules);
            let score_b = calculate_score(&b.0, &scoring_rules);
            score_b.partial_cmp(&score_a).unwrap_or(std::cmp::Ordering::Equal)
        })
    });

    Ok(Some(kept.remove(0).0))
}

/// Parity with automation.ts scoreRelease: `seeders + peers*0.5 + rule scores`.
/// No indexer-priority term (the old `priority * 1_000_000` made priority dominate and
/// picked the wrong release to auto-download).
fn calculate_score(res: &ProwlarrResult, rules: &[ScoringRule]) -> f64 {
    let mut score = res.seeders as f64 + (res.peers as f64) * 0.5;
    let title_lower = res.title.to_lowercase();
    for rule in rules {
        if title_lower.contains(&rule.term.to_lowercase()) {
            score += rule.score as f64;
        }
    }
    score
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prowlarr::ProwlarrResult;

    fn res(title: &str, seeders: i32, peers: i32) -> ProwlarrResult {
        ProwlarrResult {
            guid: "g".into(), title: title.into(), size: 0, indexer: "idx".into(),
            seeders, peers, info_url: String::new(), download_url: String::new(),
            protocol: "torrent".into(), publish_date: String::new(), info_hash: None,
        }
    }

    fn default_rules() -> Vec<ScoringRule> {
        vec![
            ScoringRule { term: ".cbz".into(), score: 500 },
            ScoringRule { term: ".cbr".into(), score: -400 },
        ]
    }

    fn sv(items: &[&str]) -> Vec<String> { items.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn search_source_order_defaults_and_parses() {
        // Unset / blank / invalid JSON → default (GetComics then Prowlarr; Anna's Archive off).
        assert_eq!(parse_search_source_order(None), sv(&["getcomics", "prowlarr"]));
        assert_eq!(parse_search_source_order(Some("   ")), sv(&["getcomics", "prowlarr"]));
        assert_eq!(parse_search_source_order(Some("not json")), sv(&["getcomics", "prowlarr"]));
        // Object array honors order + enabled flags; unknown keys + disabled entries dropped.
        let json = r#"[{"source":"annas_archive","enabled":true},{"source":"prowlarr","enabled":false},{"source":"getcomics","enabled":true},{"source":"bogus","enabled":true}]"#;
        assert_eq!(parse_search_source_order(Some(json)), sv(&["annas_archive", "getcomics"]));
        // Bare string array → all enabled, in order.
        assert_eq!(parse_search_source_order(Some(r#"["prowlarr","getcomics"]"#)), sv(&["prowlarr", "getcomics"]));
        // All-disabled → fall back to default (automation never gets zero sources).
        assert_eq!(parse_search_source_order(Some(r#"[{"source":"getcomics","enabled":false}]"#)), sv(&["getcomics", "prowlarr"]));
        // Dedup keeps the first occurrence.
        assert_eq!(parse_search_source_order(Some(r#"["getcomics","getcomics","annas_archive"]"#)), sv(&["getcomics", "annas_archive"]));
    }

    #[test]
    fn score_is_seeders_plus_half_peers_plus_rules_no_priority() {
        let rules = default_rules();
        // seeders 10 + peers 4*0.5 = 2 + .cbz +500 = 512
        assert_eq!(calculate_score(&res("Series 01 (digital).cbz", 10, 4), &rules), 512.0);
        // A heavily-seeded .cbr (-400) must rank below a low-seed .cbz — priority no longer dominates.
        let cbr = calculate_score(&res("Series 01.cbr", 100, 0), &rules);
        let cbz = calculate_score(&res("Series 01.cbz", 5, 0), &rules);
        assert!(cbz > cbr, "cbz {} should outrank cbr {}", cbz, cbr);
    }

    #[test]
    fn match_ratio_rejects_loose_titles() {
        let sig = vec!["batman".to_string(), "robin".to_string()];
        // 0 of 2 significant words match and there are >2 extra words -> reject.
        let loose = vec!["spawn".to_string(), "hellspawn".to_string(), "image".to_string(), "comics".to_string()];
        assert!(fails_match_ratio(&sig, &loose, false, 0.6));
        // Both significant words present -> keep.
        let good = vec!["batman".to_string(), "robin".to_string(), "rebirth".to_string()];
        assert!(!fails_match_ratio(&sig, &good, false, 0.6));
        // Approved bulk packs bypass the ratio gate.
        let pack = vec!["a".to_string(), "b".to_string(), "c".to_string(), "d".to_string()];
        assert!(!fails_match_ratio(&sig, &pack, true, 0.6));
    }

    #[test]
    fn extract_number_skips_years() {
        assert_eq!(extract_number("batman 012 (2011)", false, true), Some(12.0));
        assert_eq!(extract_number("batman #5", false, true), Some(5.0));
        assert_eq!(extract_number("saga 2014", false, true), None); // only a year -> none
        // Request side (strip_vol=false) keeps a volume number; result side (true) strips it.
        assert_eq!(extract_number("hellboy v2", false, false), Some(2.0));
        assert_eq!(extract_number("hellboy v2", false, true), None);
    }

    #[test]
    fn core_series_words_isolates_series_for_reverse_guard() {
        // Mirrors the stop-word half of the production reverse_noise ("blood" is a stop word).
        let noise: HashSet<String> = ["the", "a", "an", "of", "and", "or", "vol", "volume", "issue", "black", "white", "blood"]
            .iter().map(|s| s.to_string()).collect();
        // "blood" is noise (dropped), the (year) + issue number strip → "hunt" survives as an EXTRA series
        // word not present in a "Wolverine #3" request, so the reverse guard would discard this off-series grab.
        assert_eq!(core_series_words("Wolverine - Blood Hunt 003 (2026)", &noise), vec!["wolverine".to_string(), "hunt".to_string()]);
        // A plain issue of the requested series reduces to only the series word — nothing extra, so it's kept.
        assert_eq!(core_series_words("Wolverine 003 (2026) (digital)", &noise), vec!["wolverine".to_string()]);
    }

    #[test]
    fn edition_normalization_detects_distinct_editions() {
        // Same edition, cosmetic differences -> identical key.
        assert_eq!(
            normalize_edition_title("Batman #1 (2016) (Digital)"),
            normalize_edition_title("Batman #1 [webrip]")
        );
        // Distinct editions -> different keys.
        assert_ne!(
            normalize_edition_title("Batman Vol 1"),
            normalize_edition_title("Batman Annual 1")
        );
    }

    #[test]
    fn strips_issue_subtitle_only_when_issue_present() {
        // Subtitle after an issue number is dropped (the GetComics file never carries it).
        assert_eq!(strip_issue_subtitle("Batman: Gargoyle of Gotham #1: Book One"), "Batman: Gargoyle of Gotham #1");
        assert_eq!(strip_issue_subtitle("Wolverine #3: Hunter and Hunted"), "Wolverine #3");
        assert_eq!(strip_issue_subtitle("Daredevil #1 - The Red Fist Saga"), "Daredevil #1");
        // No issue marker -> a genuine TPB/subtitle request is left fully intact.
        assert_eq!(strip_issue_subtitle("Batman: The Long Halloween"), "Batman: The Long Halloween");
        assert_eq!(strip_issue_subtitle("Batman Book One"), "Batman Book One");
        // Issue marker but no trailing subtitle -> unchanged (and a pre-number hyphen is preserved).
        assert_eq!(strip_issue_subtitle("Spider-Man #1"), "Spider-Man #1");
        assert_eq!(strip_issue_subtitle("Detective Comics #1000"), "Detective Comics #1000");
    }

    #[test]
    fn subtitle_with_tpb_keyword_no_longer_forces_omnibus_words() {
        // Regression for "Batman: Gargoyle of Gotham #1: Book One": before the strip, "book" made the
        // request look like an omnibus and "book"/"one" became required title words. After stripping the
        // subtitle the enforced core is just the series name + issue number.
        let core = strip_issue_subtitle("Batman: Gargoyle of Gotham #1: Book One");
        let clean = core.replace([':', '-', '&'], " ").split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
        let tpb_terms = ["omnibus", "tpb", "compendium", "collection", "hc", "hardcover", "trade paperback", "vol ", "volume ", "book "];
        assert!(!tpb_terms.iter().any(|t| clean.contains(t)), "subtitle keyword should not survive into clean_original: {clean}");
        assert!(!clean.contains("one"), "subtitle word 'one' should be gone: {clean}");
        assert!(clean.contains("gargoyle") && clean.contains("gotham"), "core series name must remain: {clean}");
    }

    #[test]
    fn strips_trailing_file_extension_and_composes_with_subtitle() {
        // A retry's activeDownloadName carries the file extension; it must not leak into queries.
        assert_eq!(strip_file_extension("Wolverine #3 (2024).cbz"), "Wolverine #3 (2024)");
        assert_eq!(strip_file_extension("Batman 001.CBR"), "Batman 001");
        assert_eq!(strip_file_extension("Saga v1.pdf"), "Saga v1");
        // No known extension -> untouched (parens and version dots are preserved).
        assert_eq!(strip_file_extension("Wolverine #3 (2024)"), "Wolverine #3 (2024)");
        assert_eq!(strip_file_extension("Spawn Vol.1"), "Spawn Vol.1");
        // Combined normalization drops BOTH a file extension and a trailing subtitle.
        assert_eq!(normalize_request_name("Wolverine #3 (2024).cbz"), "Wolverine #3 (2024)");
        assert_eq!(normalize_request_name("Batman: Gargoyle of Gotham #1: Book One.cbz"), "Batman: Gargoyle of Gotham #1");
    }

    #[test]
    fn query_generation_is_deterministic() {
        let ac = HashMap::new();
        let a = generate_search_queries("Saga", "2014", &ac, false, true);
        let b = generate_search_queries("Saga", "2014", &ac, false, true);
        assert_eq!(a, b);
        // No duplicates within the result.
        let mut seen = HashSet::new();
        for q in &a { assert!(seen.insert(q.clone()), "duplicate query: {}", q); }
    }

    #[test]
    fn pack_queries_are_gated_and_orderable() {
        let ac = HashMap::new();

        // use_packs=false -> no pack/collection/story-arc queries at all.
        let no_packs = generate_search_queries("Batman 5", "2016", &ac, false, false);
        assert!(no_packs.iter().all(|q| !q.contains("collection") && !q.contains("story arc") && !q.ends_with(" pack")));

        // use_packs=true -> the pack group exists and sits LAST by default.
        let with_packs = generate_search_queries("Batman 5", "2016", &ac, false, true);
        assert!(with_packs.iter().any(|q| q == "Batman collection"));
        assert!(with_packs.iter().any(|q| q == "Batman pack"));
        assert!(with_packs.iter().any(|q| q == "Batman")); // series-only name (number stripped)
        let first_pack_idx = with_packs.iter().position(|q| q == "Batman collection").unwrap();
        let base_idx = with_packs.iter().position(|q| q == "Batman 5").unwrap();
        assert!(first_pack_idx > base_idx, "packs must come after standard queries by default");

        // prioritize_packs=true -> the pack group comes FIRST.
        let prioritized = generate_search_queries("Batman 5", "2016", &ac, true, true);
        assert_eq!(prioritized.first().map(|s| s.as_str()), Some("Batman"));
        let p_pack_idx = prioritized.iter().position(|q| q == "Batman collection").unwrap();
        let p_base_idx = prioritized.iter().position(|q| q == "Batman 5").unwrap();
        assert!(p_pack_idx < p_base_idx, "prioritize_packs must order packs first");

        // A name with no trailing number still gets the 3 pack terms (beta.035), minus the bare name.
        let no_number = generate_search_queries("Saga", "2014", &ac, false, true);
        assert!(no_number.iter().any(|q| q == "Saga collection"));
        assert!(no_number.iter().any(|q| q == "Saga pack"));
    }

    // ---- Issue #176 characterization: query normalization ALREADY strips punctuation and the year is
    // never a hard query constraint (year-less variants are always emitted). These assert current
    // behavior on this branch (they pass without any change) — proving the "auto sends only the
    // fully-punctuated query" symptom from the reporter's beta.076 no longer applies here.
    #[test]
    fn normalization_folds_punctuation_current_behavior() {
        let ac = HashMap::new();

        // Batman '89: Echoes #3 (2024) — apostrophe/colon/# folded to a clean broad query, plus a
        // title-only fallback from the colon split. The '89 digits are preserved (never stripped).
        let batman = generate_search_queries("Batman '89: Echoes #3", "2024", &ac, false, false);
        assert!(batman.iter().any(|q| q == "Batman 89 Echoes 3"), "clean broad query missing: {:?}", batman);
        assert!(batman.iter().any(|q| q == "Batman 89"), "title-only fallback missing: {:?}", batman);
        assert!(batman.iter().any(|q| q == "Batman 89 Echoes 3"), "yearless variant must exist: {:?}", batman);

        // Title digits are kept, only punctuation is folded (never strip 2099 / the X-23 hyphen number).
        let spidey = generate_search_queries("Spider-Man 2099 #1", "1992", &ac, false, false);
        assert!(spidey.iter().any(|q| q == "Spider Man 2099 1"), "2099 title digits must survive: {:?}", spidey);
        let x23 = generate_search_queries("X-23 #1", "2010", &ac, false, false);
        assert!(x23.iter().any(|q| q == "X 23 1"), "X-23 hyphen split kept: {:?}", x23);

        // Ampersand / period fold to spaces.
        let br = generate_search_queries("Batman & Robin #5", "2011", &ac, false, false);
        assert!(br.iter().any(|q| q == "Batman Robin 5"), "ampersand fold missing: {:?}", br);
        let ms = generate_search_queries("Ms. Marvel #12", "2014", &ac, false, false);
        assert!(ms.iter().any(|q| q == "Ms Marvel 12"), "period fold missing: {:?}", ms);

        // KNOWN DELTA vs the issue's table: the engine drops a possessive "'s" entirely ("Marvel's" ->
        // "Marvel"), whereas the issue expects "Marvels". That is deliberate (a stray "s" token would be
        // enforced as a required title word) and is OUT OF SCOPE for change A — documented here so the
        // difference is visible, not silently assumed.
        let mv = generate_search_queries("Marvel's Voices #1", "2020", &ac, false, false);
        assert!(mv.iter().any(|q| q == "Marvel Voices 1"), "current possessive handling: {:?}", mv);
    }

    // ---- Issue #176 change A: zero-padded issue-number variants (scene releases pad to 3 digits).
    // FAILS before the change is implemented, PASSES after.
    #[test]
    fn zero_pads_issue_number_variants_change_a() {
        let ac = HashMap::new();

        let batman = generate_search_queries("Batman '89: Echoes #3", "2024", &ac, false, false);
        // #3 gains a padded "003" companion on the clean query...
        assert!(batman.iter().any(|q| q == "Batman 89 Echoes 003"), "padded issue variant missing: {:?}", batman);
        // ...and it's tried BEFORE its bare counterpart (interactive first-hit ordering).
        let padded = batman.iter().position(|q| q == "Batman 89 Echoes 003");
        let bare = batman.iter().position(|q| q == "Batman 89 Echoes 3");
        assert!(padded.is_some() && bare.is_some() && padded < bare, "padded must precede bare: {:?}", batman);
        // The title-only "Batman 89" must NOT be padded — '89 is part of the title, not the issue.
        assert!(batman.iter().all(|q| !q.contains("089")), "title '89 must not be padded: {:?}", batman);

        // Issue #1 -> 001, while the 2099 title digits are left alone.
        let spidey = generate_search_queries("Spider-Man 2099 #1", "1992", &ac, false, false);
        assert!(spidey.iter().any(|q| q == "Spider Man 2099 001"), "issue #1 should pad to 001: {:?}", spidey);
        assert!(spidey.iter().all(|q| !q.contains("02099")), "2099 must not be padded: {:?}", spidey);

        // Two-digit issue -> zero-padded to three; hyphen-number title kept.
        let ms = generate_search_queries("Ms. Marvel #12", "2014", &ac, false, false);
        assert!(ms.iter().any(|q| q == "Ms Marvel 012"), "issue #12 should pad to 012: {:?}", ms);
        let x23 = generate_search_queries("X-23 #1", "2010", &ac, false, false);
        assert!(x23.iter().any(|q| q == "X 23 001"), "issue #1 padded; 23 title kept: {:?}", x23);
        assert!(x23.iter().all(|q| !q.contains("X 023")), "the title 23 must not be padded: {:?}", x23);
    }

    // ==== Issue #176 change B: the year gate in filter_and_score, exercised END-TO-END against an
    // in-memory SQLite AnyPool (the real settings-read path), because this filter decides what
    // auto-downloads and must not be tested by proxy.

    fn res_p(title: &str, seeders: i32, peers: i32, protocol: &str) -> ProwlarrResult {
        ProwlarrResult {
            guid: format!("g-{}", title), title: title.into(), size: 0, indexer: "idx".into(),
            seeders, peers, info_url: String::new(), download_url: format!("u-{}", title),
            protocol: protocol.into(), publish_date: String::new(), info_hash: None,
        }
    }

    async fn mem_pool(settings: &[(&str, &str)]) -> sqlx::AnyPool {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(sqlx::any::install_default_drivers);
        let pool = sqlx::any::AnyPoolOptions::new()
            .max_connections(1) // each :memory: connection is its own DB — keep exactly one
            .connect("sqlite::memory:").await.unwrap();
        sqlx::query(r#"CREATE TABLE "SystemSetting" (key TEXT PRIMARY KEY, value TEXT)"#)
            .execute(&pool).await.unwrap();
        for (k, v) in settings {
            sqlx::query(r#"INSERT INTO "SystemSetting" (key, value) VALUES ($1, $2)"#)
                .bind(*k).bind(*v).execute(&pool).await.unwrap();
        }
        pool
    }

    const REQ: &str = "Batman '89: Echoes #3";
    const UNDATED: &str = "Batman 89 Echoes 003 (Digital) (Zone-Empire)";
    const DATED: &str = "Batman 89 Echoes 003 (2024) (Digital)";
    const WRONG_YEAR: &str = "Batman 89 Echoes 003 (1989) (Digital)";

    async fn run_filter(pool: &sqlx::AnyPool, results: Vec<ProwlarrResult>) -> Option<ProwlarrResult> {
        filter_and_score(pool, results, REQ, false, Some("2024".into()), None, false, Some(false))
            .await.unwrap()
    }

    // Characterization (current behavior, no setting): PG-7 hard-rejects an undated Prowlarr/Usenet
    // release; a dated release within ±1 year is kept; a wrong-year release is rejected; DDL undated
    // releases were always exempt. This test must KEEP passing after change B (default off).
    #[tokio::test]
    async fn year_gate_default_rejects_undated_prowlarr_keeps_dated_and_ddl() {
        let pool = mem_pool(&[]).await;

        // Undated usenet release -> rejected (the reporter's residual symptom).
        assert!(run_filter(&pool, vec![res_p(UNDATED, 0, 0, "usenet")]).await.is_none());

        // Dated within ±1 -> kept.
        let kept = run_filter(&pool, vec![res_p(DATED, 5, 0, "usenet")]).await;
        assert_eq!(kept.map(|r| r.title), Some(DATED.to_string()));

        // Wrong year -> rejected.
        assert!(run_filter(&pool, vec![res_p(WRONG_YEAR, 5, 0, "usenet")]).await.is_none());

        // DDL undated -> kept (existing exemption, unchanged).
        let ddl = run_filter(&pool, vec![res_p(UNDATED, 0, 0, "ddl")]).await;
        assert_eq!(ddl.map(|r| r.title), Some(UNDATED.to_string()));
    }

    // Change B, part 1: with prowlarr_accept_yearless=true, an undated release is ACCEPTED when it is
    // the only candidate (the reporter's NZBGeek case: scene titles usually omit the year).
    #[tokio::test]
    async fn year_gate_opt_in_accepts_undated_when_only_candidate() {
        let pool = mem_pool(&[("prowlarr_accept_yearless", "true")]).await;
        let got = run_filter(&pool, vec![res_p(UNDATED, 0, 0, "usenet")]).await;
        assert_eq!(got.map(|r| r.title), Some(UNDATED.to_string()));
    }

    // Change B, part 2: the year acts as a VALIDATOR/TIEBREAKER — a dated candidate always outranks an
    // undated one, even when the undated release would win on raw score (seeders). An undated release
    // can be the wrong volume of a rebooted series; a dated one is confirmed. This is what makes the
    // opt-in safe: undated only downloads when nothing dated exists.
    #[tokio::test]
    async fn year_gate_opt_in_dated_release_outranks_undated() {
        let pool = mem_pool(&[("prowlarr_accept_yearless", "true")]).await;
        let got = run_filter(&pool, vec![
            res_p(UNDATED, 500, 100, "torrent"), // huge score
            res_p(DATED, 5, 0, "torrent"),       // tiny score, but year-confirmed
        ]).await;
        assert_eq!(got.map(|r| r.title), Some(DATED.to_string()), "dated must win regardless of score");
    }

    // Change B guard: opting in must NOT weaken the wrong-year rejection — a release dated outside ±1
    // is still discarded. (Passes today too; pinned so B can't accidentally loosen it.)
    #[tokio::test]
    async fn year_gate_opt_in_still_rejects_wrong_year() {
        let pool = mem_pool(&[("prowlarr_accept_yearless", "true")]).await;
        assert!(run_filter(&pool, vec![res_p(WRONG_YEAR, 500, 0, "usenet")]).await.is_none());
    }

    // Change B guard: with the setting ABSENT the tie-break sort must be inert — among dated survivors
    // ordering stays purely score-based (pin against the sort-key refactor changing default behavior).
    #[tokio::test]
    async fn year_gate_default_sort_stays_score_based() {
        let pool = mem_pool(&[]).await;
        let low = "Batman 89 Echoes 003 (2024)";
        let high = "Batman 89 Echoes 003 (2024) (Digital)";
        let got = run_filter(&pool, vec![
            res_p(low, 5, 0, "torrent"),
            res_p(high, 50, 0, "torrent"),
        ]).await;
        assert_eq!(got.map(|r| r.title), Some(high.to_string()));
    }
}
