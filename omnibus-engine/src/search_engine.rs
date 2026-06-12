use regex::Regex;
use sqlx::{PgPool, Row};
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

pub async fn get_custom_acronyms(db: &PgPool) -> anyhow::Result<HashMap<String, String>> {
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

pub fn generate_search_queries(
    name: &str,
    year: &str,
    acronyms: &HashMap<String, String>,
    prioritize_packs: bool,
    use_packs: bool,
) -> Vec<String> {
    let mut search_name = name.to_string();

    // `-?` keeps negative issue numbers (e.g. "Batman #-1") recognized as single issues (beta.023+).
    let re_single_issue = Regex::new(r"(?i)(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*-?\d+").unwrap();
    if re_single_issue.is_match(name) {
        let split_re = Regex::new(r"(?i)^(.*?(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*-?\d+(?:\.\d+)?[a-zA-Z]?)\s*[:\-]\s*(.*)$").unwrap();
        if let Some(caps) = split_re.captures(name) { search_name = caps[1].trim().to_string(); }
    }

    // Two insertion-ordered groups, each de-duped within itself (parity with Node's two Sets).
    let mut primary: Vec<String> = Vec::new();
    let mut primary_seen: HashSet<String> = HashSet::new();
    let mut secondary: Vec<String> = Vec::new();
    let mut secondary_seen: HashSet<String> = HashSet::new();

    let base_name = search_name.replace('#', "").trim().to_string();
    let re_possessive = Regex::new(r"(?i)'s\b|\s s\b").unwrap();
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

    if prioritize_packs && use_packs {
        let mut final_queries = packs;
        final_queries.extend(primary);
        final_queries.extend(secondary);
        return final_queries;
    }

    let mut final_queries: Vec<String> = primary;
    final_queries.extend(secondary);
    final_queries.extend(packs);
    final_queries
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

pub async fn filter_and_score(
    db: &PgPool,
    mut results: Vec<ProwlarrResult>,
    target_query: &str,
    is_manga: bool,
    req_year: Option<String>,
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

    let clean_original = target_query.replace(&[':', '-', '&'][..], " ")
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

    results.retain(|res| {
        let title_lower = res.title.to_lowercase();
        let is_ddl = res.protocol == "ddl";

        for junk in &junk_words { if title_lower.contains(junk) { return false; } }
        for group in &exclude_groups { if title_lower.contains(group) { return false; } }
        if res.seeders == 0 && res.protocol != "usenet" && !is_ddl { return false; }

        // Pre-filtered sources (GetComics, already validated per-query in getcomics::search) only get
        // the operator's junk/exclude lists + scoring — not this relevance retain, which is keyed on the
        // merged target_query rather than the specific query that produced the result.
        if skip_relevance { return true; }

        let is_pack = allow_bulk_packs && pack_terms.iter().any(|term| title_lower.contains(term));

        if req_num.is_some() && !is_looking_for_omnibus && !is_pack {
            let unexpected_tpb_terms: Vec<&&str> = tpb_terms.iter().filter(|t| !clean_original.contains(**t)).collect();
            if unexpected_tpb_terms.iter().any(|term| title_lower.contains(**term)) { return false; }
        }

        // Variant rejection is a GetComics/DDL-only filter in Node (getcomics.ts); prowlarr.ts never
        // rejects variants, so gate on is_ddl to avoid dropping legitimate Prowlarr torrents.
        if is_ddl && !user_wants_variant {
            if open_variant_keywords.iter().any(|k| title_lower.contains(k)) { return false; }
            if re_bounded_variant().is_match(&title_lower) { return false; }
        }

        let clean_tor = re_ext_strip().replace(&title_lower, "").to_string();
        let clean_tor = re_year_brackets_strip().replace_all(&clean_tor, "").to_string();
        let tor_num = extract_number(&clean_tor, is_manga, true);

        if let Some(rn) = &req_num {
            if !is_looking_for_omnibus && !is_pack {
                match &tor_num {
                    Some(tn) if tn != rn => return false,
                    None => return false,
                    _ => {}
                }
            }
        }

        // Year anchor. tor_year is the year found in the title (if any).
        let tor_year: Option<String> = re_year_find().captures(&title_lower)
            .and_then(|c| c.get(1)).map(|m| m.as_str().to_string());

        if let Some(req_y) = &req_year {
            if let Some(ty_str) = &tor_year {
                if let (Ok(ry), Ok(ty)) = (req_y.parse::<i32>(), ty_str.parse::<i32>()) {
                    if (ry - ty).abs() > 1 { return false; }
                }
            } else if !is_ddl {
                // Prowlarr: a yearless title is rejected unless it literally contains the requested year (PG-7).
                if !title_lower.contains(req_y.as_str()) { return false; }
            }
        }

        // Annual rejection is GetComics/DDL-only in Node (getcomics.ts:258-262); prowlarr.ts has none.
        if is_ddl && !is_looking_for_annual && title_lower.contains("annual") { return false; }

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
                return false;
            }
        }

        let mut words_to_enforce = original_query_words.clone();
        if req_num.is_some() && !is_looking_for_omnibus {
            if let Some(idx) = words_to_enforce.iter().position(|w| w.parse::<f32>().ok() == req_num) {
                words_to_enforce.truncate(idx);
            }
        }
        for w in &words_to_enforce {
            if !w.chars().all(char::is_numeric) && !title_lower.contains(w) { return false; }
        }

        true
    });

    if results.is_empty() { return Ok(None); }

    results.sort_by(|a, b| {
        let score_a = calculate_score(a, &scoring_rules);
        let score_b = calculate_score(b, &scoring_rules);
        score_b.partial_cmp(&score_a).unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(Some(results[0].clone()))
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
}
