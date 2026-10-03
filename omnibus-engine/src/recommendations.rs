// Library-aware recommendations, Beta B (field report by robotshavehearts2: "look at my library
// as a whole and surface what I don't have"). FOR_YOU_SYNC rebuilds the `discover_cache_for_you`
// SystemSetting the Node app reads — the page never spends a provider call.
//
// The signal is the SeriesCredit ledger Beta A fills on every volume sync: every person and
// character on every ComicVine volume the library holds, with the provider's appearance count.
//
//   1. SEEDS — the library's strongest people and characters. A credit's weight is the series'
//      weight (how much of it is owned; followed series count double) times the fraction of the
//      volume the credit appears in (a lead, not a cameo). Volume people carry NO role, and the
//      most-shared people in any library are its editors and production staff — a lab library's
//      top "unknown-role" people were every one of them editors — so a person seeds ONLY when the
//      library knows them as a creative: named as writer / artist / inker on an owned issue's
//      credits or the series' ComicInfo. Unknown and staff roles never seed; the pool grows as
//      issues are opened, deep-synced, or tagged. Characters carry no such ambiguity.
//   2. FAN-OUT — people: one cached /person/ call lists every volume they are credited on.
//      Characters: ComicVine's character `volume_credits` is unmaintained (Cyclops → one figurine
//      collection against 11,738 issue appearances), so the newest CHARACTER_RECENT_ISSUES of the
//      character's `issue_credits` are resolved to volumes through batched /issues/ calls — the
//      series the character has appeared in lately, weighted by how often.
//   3. SCORE — a candidate volume's score is the sum over the seeds that credit it of seed weight
//      times that credit's weight, with a bonus when both a person AND a character do; anything
//      the library already holds, tracks as an attachment, or has requested is out.
//   4. DETAILS — one batched /volumes/ call per 50 candidates for name/year/publisher/cover/count,
//      through the SAME Discover blocklist + manga-mode filter the Discover feed uses.
//
// Steps 1 and 3 are pure functions with unit tests below; the provider work is bounded
// (SEED_PEOPLE + SEED_CHARACTERS × (1 + CHARACTER_RECENT_ISSUES/100) + ~2 calls per rebuild) and
// cache-aware.
use anyhow::Result;
use crate::db::Db;
use reqwest::Client;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::{HashMap, HashSet};

/// People / characters used as seeds per rebuild — each is one provider call (cached).
pub(crate) const SEED_PEOPLE: usize = 12;
pub(crate) const SEED_CHARACTERS: usize = 12;
/// Candidate volumes carried into the details fetch and the cache.
pub(crate) const CANDIDATE_LIMIT: usize = 60;
/// Newest issue appearances resolved per character seed (100 per /issues/ call).
pub(crate) const CHARACTER_RECENT_ISSUES: usize = 100;
/// A character's recent appearances in one volume at or above this count weigh in full; fewer
/// weigh proportionally (a one-issue cameo is a third of a lead).
pub(crate) const CHARACTER_FULL_WEIGHT_APPEARANCES: f64 = 3.0;
/// Extra score for a volume that both a person seed and a character seed credit.
pub(crate) const BOTH_KINDS_BONUS: f64 = 0.5;
/// Publishers (lower-cased whole words / phrases) whose ComicVine volumes are translated reprint
/// lines — "Coleccionable Ultimate (Panini España)", "MAX (Panini Verlag)", "DC Definitive Edition
/// (Editorial Televisa)". They credit everyone and everything, so they surface for ANY library,
/// and a downloader user does not want a Spanish or German reprint of what they already collect.
/// The user's own Discover publisher blocklist still applies on top of this.
pub(crate) const FOREIGN_REPRINT_PUBLISHER_WORDS: &[&str] = &[
    "panini", "televisa", "planeta", "salvat", "hachette", "eaglemoss", "fabbri", "delcourt", "glénat", "glenat",
    "semic", "egmont", "juniorpress", "novaro", "bastei", "ehapa", "carlsen", "deagostini", "de agostini", "agostini",
    "editorial", "ediciones", "edizioni", "éditions", "editions", "verlag", "editora", "lug", "arédit", "aredit",
    "urban comics", "norma", "lion comics", "star comics", "marvel italia", "marvel deutschland", "marvel france",
    "marvel méxico", "marvel mexico", "marvel uk", "ecc", "rw edizioni",
];

/// True for a publisher on the translated-reprint list (whole-word match on the lower-cased name).
pub(crate) fn is_foreign_reprint_publisher(publisher: &str) -> bool {
    let p = publisher.trim().to_lowercase();
    if p.is_empty() { return false; }
    FOREIGN_REPRINT_PUBLISHER_WORDS.iter().any(|w| crate::discover::contains_word(&p, w))
}
/// A ComicVine rate-limit flag younger than this skips the rebuild (the next scheduled run tries again).
const RATE_LIMIT_COOLDOWN_MS: i64 = 60 * 60 * 1000;

pub(crate) const CACHE_KEY: &str = "discover_cache_for_you";

/// One SeriesCredit row.
#[derive(Debug, Clone)]
pub(crate) struct CreditRow {
    pub series_id: String,
    pub kind: String, // "PERSON" | "CHARACTER"
    pub provider_id: String,
    pub name: String,
    pub count: i64,
}

/// What the library knows about one credited series.
#[derive(Debug, Clone, Default)]
pub(crate) struct SeriesFacts {
    pub owned: i64,     // issues on disk (main run)
    pub total: i64,     // issues tracked (main run) ≈ the volume's count_of_issues once synced
    pub followed: bool, // anyone follows it
    /// Lower-cased names credited in a CREATIVE role (writer, penciller/artist, inker) on an owned
    /// issue or the series' ComicInfo fallbacks.
    pub creative: HashSet<String>,
    /// Lower-cased names credited only in a STAFF role (editor, letterer, colorist, cover, translator).
    pub staff: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Seed {
    pub kind: String,
    pub provider_id: String,
    pub name: String,
    /// Normalized within its kind to (0, 1].
    pub weight: f64,
    pub series: usize,
    pub role: &'static str, // "creative" | "character"
}

pub(crate) struct SeedConfig {
    pub people: usize,
    pub characters: usize,
}

impl Default for SeedConfig {
    fn default() -> Self {
        Self { people: SEED_PEOPLE, characters: SEED_CHARACTERS }
    }
}

/// How much one series counts: ln(1 + owned) — a 30-issue run outweighs a 1-issue stub, but not
/// thirty-fold — floored at 0.5 so a monitored-but-unowned series (something the user ASKED for)
/// still speaks; followed series count double.
pub(crate) fn series_weight(f: &SeriesFacts) -> f64 {
    let base = ((1 + f.owned.max(0)) as f64).ln().max(0.5);
    if f.followed { base * 2.0 } else { base }
}

/// The fraction of the volume a credit appears in, in (0, 1]: a lead character on 31 of 36 issues
/// is ~0.86, a one-issue cameo ~0.03. An unknown total counts the credit in full.
pub(crate) fn credit_fraction(count: i64, total: i64) -> f64 {
    if total <= 0 { return 1.0; }
    (count.max(1) as f64 / total as f64).min(1.0)
}

/// Step 1: the library's seeds. Pure; see the module doc for the rules.
pub(crate) fn build_seeds(rows: &[CreditRow], facts: &HashMap<String, SeriesFacts>, cfg: &SeedConfig) -> Vec<Seed> {
    struct Acc { name: String, weight: f64, series: HashSet<String> }
    let mut acc: HashMap<(String, String), Acc> = HashMap::new();

    for r in rows {
        let Some(f) = facts.get(&r.series_id) else { continue };
        let w = series_weight(f) * credit_fraction(r.count, f.total);
        let e = acc.entry((r.kind.clone(), r.provider_id.clone())).or_insert_with(|| Acc { name: r.name.clone(), weight: 0.0, series: HashSet::new() });
        e.weight += w;
        e.series.insert(r.series_id.clone());
    }

    let mut people: Vec<Seed> = Vec::new();
    let mut characters: Vec<Seed> = Vec::new();
    for ((kind, provider_id), a) in acc {
        if a.weight <= 0.0 { continue; }
        let role: &'static str = if kind == "CHARACTER" {
            "character"
        } else {
            // Only a person the library KNOWS as a creative seeds. Volume people carry no role,
            // and without one the widely-shared names are editors and production staff: a
            // "because you collect <editor>" is worse than no person seed at all.
            let lc = a.name.trim().to_lowercase();
            let creative = a.series.iter().any(|s| facts.get(s).is_some_and(|f| f.creative.contains(&lc)));
            if !creative { continue; }
            "creative"
        };
        let seed = Seed { kind: kind.clone(), provider_id, name: a.name, weight: a.weight, series: a.series.len(), role };
        if kind == "CHARACTER" { characters.push(seed) } else { people.push(seed) }
    }

    let finish = |mut v: Vec<Seed>, take: usize| -> Vec<Seed> {
        v.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.name.cmp(&b.name)));
        v.truncate(take);
        let max = v.first().map(|s| s.weight).unwrap_or(1.0).max(f64::EPSILON);
        for s in v.iter_mut() { s.weight /= max; }
        v
    };
    let mut out = finish(people, cfg.people);
    out.extend(finish(characters, cfg.characters));
    out
}

/// One volume a seed is credited on, with how strongly: a person's volume_credits entry is a
/// full 1.0; a character's recent-appearance count maps through [`appearance_weight`].
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SeedVolume {
    pub volume_id: String,
    pub name: String,
    pub weight: f64,
}

/// Weight of `count` recent appearances of a character in one volume, in (0, 1].
pub(crate) fn appearance_weight(count: usize) -> f64 {
    (count.max(1) as f64 / CHARACTER_FULL_WEIGHT_APPEARANCES).min(1.0)
}

/// The newest `n` of a character's issue appearances — ComicVine issue ids grow with time, so the
/// highest ids are the latest. Pure.
pub(crate) fn newest_issue_ids(ids: &[i64], n: usize) -> Vec<i64> {
    let mut v: Vec<i64> = ids.to_vec();
    v.sort_unstable_by(|a, b| b.cmp(a));
    v.dedup();
    v.truncate(n);
    v
}

/// Folds resolved (volume id, volume name) pairs — one per recent issue — into weighted seed
/// volumes, most-appeared first. Pure.
pub(crate) fn volumes_from_recent_issues(resolved: &[(String, String)]) -> Vec<SeedVolume> {
    let mut counts: HashMap<&str, (usize, &str)> = HashMap::new();
    for (id, name) in resolved {
        let e = counts.entry(id.as_str()).or_insert((0, name.as_str()));
        e.0 += 1;
    }
    let mut out: Vec<SeedVolume> = counts.into_iter()
        .map(|(id, (n, name))| SeedVolume { volume_id: id.to_string(), name: name.to_string(), weight: appearance_weight(n) })
        .collect();
    out.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.name.cmp(&b.name)));
    out
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Candidate {
    pub volume_id: String,
    pub name: String,
    pub score: f64,
    /// (kind, provider id, name) of every seed that credits this volume, strongest first.
    pub because: Vec<(String, String, String)>,
}

/// Step 3: score candidate volumes from the seeds' credit lists. `seed_volumes[i]` belongs to
/// `seeds[i]`. Pure.
pub(crate) fn score_candidates(seeds: &[Seed], seed_volumes: &[Vec<SeedVolume>], excluded: &HashSet<String>, take: usize) -> Vec<Candidate> {
    let mut acc: HashMap<String, Candidate> = HashMap::new();
    for (seed, vols) in seeds.iter().zip(seed_volumes.iter()) {
        let mut seen: HashSet<&str> = HashSet::new();
        for v in vols {
            if excluded.contains(&v.volume_id) || !seen.insert(v.volume_id.as_str()) { continue; }
            let c = acc.entry(v.volume_id.clone()).or_insert_with(|| Candidate { volume_id: v.volume_id.clone(), name: v.name.clone(), score: 0.0, because: Vec::new() });
            c.score += seed.weight * v.weight.clamp(0.0, 1.0);
            c.because.push((seed.kind.clone(), seed.provider_id.clone(), seed.name.clone()));
        }
    }
    let mut out: Vec<Candidate> = acc.into_values().map(|mut c| {
        let kinds: HashSet<&str> = c.because.iter().map(|b| b.0.as_str()).collect();
        if kinds.len() > 1 { c.score += BOTH_KINDS_BONUS; }
        c
    }).collect();
    out.sort_by(|a, b| {
        b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.because.len().cmp(&a.because.len()))
            .then_with(|| a.name.cmp(&b.name))
    });
    out.truncate(take);
    out
}

fn parse_names(raw: Option<String>) -> Vec<String> {
    raw.and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_array().cloned())
        .map(|arr| arr.iter().filter_map(|x| x.as_str()).map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default()
}

/// Loads the ledger and the per-series facts the seed builder needs.
async fn load_signal(db: &Db) -> Result<(Vec<CreditRow>, HashMap<String, SeriesFacts>)> {
    let rows = sqlx::query(r#"SELECT "seriesId", kind, "providerId", name, count FROM "SeriesCredit" WHERE source = 'COMICVINE'"#)
        .fetch_all(&db.pool).await?
        .iter()
        .map(|r| CreditRow {
            series_id: r.get("seriesId"), kind: r.get("kind"), provider_id: r.get("providerId"), name: r.get("name"),
            count: r.try_get::<i64, _>("count").unwrap_or(0),
        })
        .collect::<Vec<_>>();

    // owned/total count the MAIN run only (attached annuals/trades are their own numbering domain);
    // "followed" is CASE'd to an integer — SQLite booleans have no Any-driver mapping.
    let facts_rows = sqlx::query(
        r#"SELECT s.id,
                  (SELECT COUNT(*) FROM "Issue" i WHERE i."seriesId" = s.id AND i."filePath" IS NOT NULL AND i."attachedVolumeId" IS NULL) AS owned,
                  (SELECT COUNT(*) FROM "Issue" i WHERE i."seriesId" = s.id AND i."attachedVolumeId" IS NULL) AS total,
                  CASE WHEN EXISTS (SELECT 1 FROM "SeriesFollow" f WHERE f."seriesId" = s.id) THEN 1 ELSE 0 END AS followed,
                  s.writers, s.artists, s.inker, s."coverArtists", s.colorists, s.letterers, s.editor, s.translator
           FROM "Series" s
           WHERE s."metadataSource" = 'COMICVINE' AND s."creditsSyncedAt" IS NOT NULL"#,
    ).fetch_all(&db.pool).await?;
    let mut facts: HashMap<String, SeriesFacts> = HashMap::new();
    for r in &facts_rows {
        let id: String = r.get("id");
        let mut f = SeriesFacts {
            owned: r.try_get::<i64, _>("owned").unwrap_or(0),
            total: r.try_get::<i64, _>("total").unwrap_or(0),
            followed: r.try_get::<i64, _>("followed").unwrap_or(0) != 0,
            ..Default::default()
        };
        for col in ["writers", "artists", "inker"] { f.creative.extend(parse_names(r.try_get(col).ok().flatten())); }
        for col in ["coverArtists", "colorists", "letterers", "editor", "translator"] { f.staff.extend(parse_names(r.try_get(col).ok().flatten())); }
        facts.insert(id, f);
    }

    // Per-issue credits DO carry roles (the volume's people don't): every owned issue's writer /
    // artist / inker names upgrade a person to "creative"; staff-only names stay staff.
    let issue_rows = sqlx::query(
        r#"SELECT i."seriesId", i.writers, i.artists, i.inker, i."coverArtists", i.colorists, i.letterers, i.editor, i.translator
           FROM "Issue" i JOIN "Series" s ON s.id = i."seriesId"
           WHERE s."metadataSource" = 'COMICVINE' AND s."creditsSyncedAt" IS NOT NULL
             AND (i.writers IS NOT NULL OR i.artists IS NOT NULL OR i.inker IS NOT NULL OR i."coverArtists" IS NOT NULL
                  OR i.colorists IS NOT NULL OR i.letterers IS NOT NULL OR i.editor IS NOT NULL OR i.translator IS NOT NULL)"#,
    ).fetch_all(&db.pool).await?;
    for r in &issue_rows {
        let sid: String = r.get("seriesId");
        let Some(f) = facts.get_mut(&sid) else { continue };
        for col in ["writers", "artists", "inker"] { f.creative.extend(parse_names(r.try_get(col).ok().flatten())); }
        for col in ["coverArtists", "colorists", "letterers", "editor", "translator"] { f.staff.extend(parse_names(r.try_get(col).ok().flatten())); }
    }
    // A name credited creatively anywhere is creative everywhere — staff-only means ONLY staff.
    for f in facts.values_mut() {
        let creative = f.creative.clone();
        f.staff.retain(|n| !creative.contains(n));
    }
    Ok((rows, facts))
}

/// Volumes the library already holds, tracks as attachments, or has requested — never recommended.
async fn load_excluded(db: &Db) -> Result<HashSet<String>> {
    let mut out: HashSet<String> = HashSet::new();
    for sql in [
        r#"SELECT "metadataId" AS v FROM "Series" WHERE "metadataSource" = 'COMICVINE' AND "metadataId" IS NOT NULL"#,
        r#"SELECT "volumeId" AS v FROM "AttachedVolume" WHERE "metadataSource" = 'COMICVINE'"#,
        r#"SELECT DISTINCT "volumeId" AS v FROM "Request" WHERE "volumeId" IS NOT NULL"#,
    ] {
        for r in sqlx::query(sql).fetch_all(&db.pool).await? {
            if let Ok(v) = r.try_get::<String, _>("v") { if !v.is_empty() { out.insert(v); } }
        }
    }
    Ok(out)
}

/// One cached ComicVine GET (usage-logged only on a real upstream call). A 429 marks the
/// cv_rate_limit_time flag and fails the rebuild — the next scheduled run tries again.
async fn cv_get(db: &Db, client: &Client, api_key: &str, url: &str, query: &[(&str, &str)]) -> Result<Value> {
    let mut q: Vec<(&str, &str)> = vec![("api_key", api_key), ("format", "json")];
    q.extend_from_slice(query);
    let req = client.get(url).query(&q).header("User-Agent", "Omnibus/1.0").timeout(std::time::Duration::from_secs(20)).build()?;
    let full = req.url().to_string();
    if let Some(hit) = crate::metadata_cache::get(db, "comicvine", &full).await {
        return Ok(hit);
    }
    let resp = client.execute(req).await?;
    crate::api_usage::log(&db.pool, "comicvine", url).await;
    if crate::metadata::is_cv_rate_limited(resp.status()) {
        crate::metadata::mark_flag(db, "cv_rate_limit_time").await;
        anyhow::bail!("ComicVine rate limited (429/420) on {}", url);
    }
    let j: Value = resp.error_for_status()?.json().await?;
    crate::metadata_cache::put(db, "comicvine", &full, &j).await;
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    Ok(j)
}

async fn rate_limit_flag_is_fresh(db: &Db) -> bool {
    let raw: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'cv_rate_limit_time'"#)
        .fetch_optional(&db.pool).await.ok().flatten();
    let Some(ms) = raw.and_then(|s| s.trim().parse::<i64>().ok()) else { return false };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    now - ms < RATE_LIMIT_COOLDOWN_MS
}

/// A person's credited volumes: one /person/ call, volume_credits is complete for people.
async fn fetch_person_volumes(db: &Db, client: &Client, api_key: &str, seed: &Seed) -> Result<Vec<SeedVolume>> {
    let url = format!("https://comicvine.gamespot.com/api/person/4040-{}/", seed.provider_id);
    let j = cv_get(db, client, api_key, &url, &[("field_list", "id,name,volume_credits")]).await?;
    Ok(j.pointer("/results/volume_credits").and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| {
            let id = v.get("id").and_then(|x| x.as_i64())?;
            Some(SeedVolume { volume_id: id.to_string(), name: v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(), weight: 1.0 })
        }).collect())
        .unwrap_or_default())
}

/// A character's recently-appeared-in volumes: the newest CHARACTER_RECENT_ISSUES of its
/// issue_credits, resolved to volumes 100 ids per /issues/ call (the arc-missing-series pattern).
async fn fetch_character_volumes(db: &Db, client: &Client, api_key: &str, seed: &Seed) -> Result<Vec<SeedVolume>> {
    let url = format!("https://comicvine.gamespot.com/api/character/4005-{}/", seed.provider_id);
    let j = cv_get(db, client, api_key, &url, &[("field_list", "id,name,issue_credits")]).await?;
    let ids: Vec<i64> = j.pointer("/results/issue_credits").and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.get("id").and_then(|x| x.as_i64())).collect())
        .unwrap_or_default();
    let recent = newest_issue_ids(&ids, CHARACTER_RECENT_ISSUES);
    let mut resolved: Vec<(String, String)> = Vec::with_capacity(recent.len());
    for chunk in recent.chunks(100) {
        let filter = format!("id:{}", chunk.iter().map(|i| i.to_string()).collect::<Vec<_>>().join("|"));
        let page = cv_get(db, client, api_key, "https://comicvine.gamespot.com/api/issues/", &[
            ("filter", filter.as_str()), ("field_list", "id,volume"), ("limit", "100"),
        ]).await?;
        if let Some(arr) = page.get("results").and_then(|v| v.as_array()) {
            for issue in arr {
                if let Some(vid) = issue.pointer("/volume/id").and_then(|x| x.as_i64()) {
                    resolved.push((vid.to_string(), issue.pointer("/volume/name").and_then(|x| x.as_str()).unwrap_or("").to_string()));
                }
            }
        }
    }
    Ok(volumes_from_recent_issues(&resolved))
}

/// FOR_YOU_SYNC. Returns (items written, summary).
pub async fn run_for_you_sync(db: Db) -> Result<(usize, String)> {
    let (cfg, _config) = crate::discover::load_discover_config(&db).await?;
    if rate_limit_flag_is_fresh(&db).await {
        anyhow::bail!("ComicVine is rate-limited right now; the For-You rebuild will try again on the next run.");
    }

    let (rows, facts) = load_signal(&db).await?;
    if rows.is_empty() {
        crate::discover::upsert_setting(&db, CACHE_KEY, &json!({ "builtAt": chrono::Utc::now().to_rfc3339(), "seeds": [], "items": [], "reason": "no_credits" }).to_string()).await?;
        return Ok((0, "No volume credits yet — the metadata sweep fills them in; nothing to recommend from.".to_string()));
    }
    let seeds = build_seeds(&rows, &facts, &SeedConfig::default());
    if seeds.is_empty() {
        crate::discover::upsert_setting(&db, CACHE_KEY, &json!({ "builtAt": chrono::Utc::now().to_rfc3339(), "seeds": [], "items": [], "reason": "no_seeds" }).to_string()).await?;
        return Ok((0, "The library's credits produced no usable seeds.".to_string()));
    }
    let excluded = load_excluded(&db).await?;
    let client = Client::builder().user_agent("Omnibus/1.0").build()?;

    // Fan-out per seed. A seed whose fetch fails (other than a 429) simply contributes nothing.
    let mut seed_volumes: Vec<Vec<SeedVolume>> = Vec::with_capacity(seeds.len());
    let mut calls_failed = 0usize;
    for seed in &seeds {
        let fetched = if seed.kind == "CHARACTER" {
            fetch_character_volumes(&db, &client, &cfg.cv_api_key, seed).await
        } else {
            fetch_person_volumes(&db, &client, &cfg.cv_api_key, seed).await
        };
        match fetched {
            Ok(vols) => {
                log::debug!("[For You] {} {} ({}): {} credited volumes", seed.kind, seed.name, seed.provider_id, vols.len());
                seed_volumes.push(vols);
            }
            Err(e) => {
                if e.to_string().contains("429") { return Err(e); }
                log::warn!("[For You] Seed fetch failed for {} {}: {}", seed.kind, seed.name, e);
                calls_failed += 1;
                seed_volumes.push(Vec::new());
            }
        }
    }

    let candidates = score_candidates(&seeds, &seed_volumes, &excluded, CANDIDATE_LIMIT);

    // Details in batches; the SAME Discover filter (blocklists + manga mode) applies.
    let mut details: HashMap<String, Value> = HashMap::new();
    for chunk in candidates.chunks(50) {
        let filter = format!("id:{}", chunk.iter().map(|c| c.volume_id.as_str()).collect::<Vec<_>>().join("|"));
        match cv_get(&db, &client, &cfg.cv_api_key, "https://comicvine.gamespot.com/api/volumes/", &[
            ("filter", filter.as_str()), ("limit", "100"),
            ("field_list", "id,name,start_year,publisher,image,count_of_issues,deck,description,concepts,site_detail_url"),
        ]).await {
            Ok(j) => {
                if let Some(arr) = j.get("results").and_then(|v| v.as_array()) {
                    for v in arr {
                        if let Some(id) = v.get("id").and_then(|x| x.as_i64()) { details.insert(id.to_string(), v.clone()); }
                    }
                }
            }
            Err(e) => {
                if e.to_string().contains("429") { return Err(e); }
                log::warn!("[For You] Volume details fetch failed: {}", e);
            }
        }
    }

    let mut items: Vec<Value> = Vec::new();
    let mut filtered = 0usize;
    let mut reprints = 0usize;
    for c in &candidates {
        let Some(v) = details.get(&c.volume_id) else { continue };
        let count = v.get("count_of_issues").and_then(|x| x.as_i64()).unwrap_or(0);
        if count <= 0 { continue; }
        if is_foreign_reprint_publisher(v.pointer("/publisher/name").and_then(|x| x.as_str()).unwrap_or("")) {
            reprints += 1;
            continue;
        }
        // Discover's is_valid reads an issue-shaped item: wrap the volume the way that feed sees it.
        let wrapped = json!({ "volume": v, "deck": v.get("deck").cloned().unwrap_or(Value::Null), "description": v.get("description").cloned().unwrap_or(Value::Null) });
        if !cfg.is_valid(&wrapped) { filtered += 1; continue; }
        let deck = v.get("deck").and_then(|x| x.as_str()).unwrap_or("").trim();
        items.push(json!({
            "volumeId": c.volume_id,
            "name": v.get("name").and_then(|x| x.as_str()).unwrap_or(c.name.as_str()),
            "startYear": v.get("start_year").and_then(|x| x.as_str()).and_then(|s| s.trim().parse::<i64>().ok()),
            "publisher": v.pointer("/publisher/name").and_then(|x| x.as_str()).unwrap_or("Unknown"),
            "image": v.pointer("/image/medium_url").and_then(|x| x.as_str()).or_else(|| v.pointer("/image/super_url").and_then(|x| x.as_str())),
            "countOfIssues": count,
            "description": if deck.is_empty() { Value::Null } else { Value::String(deck.to_string()) },
            "siteUrl": v.get("site_detail_url").cloned().unwrap_or(Value::Null),
            "score": (c.score * 1000.0).round() / 1000.0,
            "because": c.because.iter().map(|(k, id, n)| json!({ "kind": k, "id": id, "name": n })).collect::<Vec<_>>(),
            "metadataSource": "COMICVINE",
        }));
    }

    let payload = json!({
        "builtAt": chrono::Utc::now().to_rfc3339(),
        "seeds": seeds.iter().map(|s| json!({ "kind": s.kind, "id": s.provider_id, "name": s.name, "weight": (s.weight * 1000.0).round() / 1000.0, "series": s.series, "role": s.role })).collect::<Vec<_>>(),
        "items": items,
    });
    crate::discover::upsert_setting(&db, CACHE_KEY, &payload.to_string()).await?;

    let n = payload["items"].as_array().map(|a| a.len()).unwrap_or(0);
    Ok((n, format!(
        "Rebuilt the For-You cache: {} recommendations from {} seeds ({} people, {} characters) over {} credited series; {} translated reprint line(s) dropped, {} candidates filtered by blocklist/manga mode{}.",
        n, seeds.len(), seeds.iter().filter(|s| s.kind != "CHARACTER").count(), seeds.iter().filter(|s| s.kind == "CHARACTER").count(),
        facts.len(), reprints, filtered,
        if calls_failed > 0 { format!("; {} seed fetch(es) failed", calls_failed) } else { String::new() }
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(owned: i64, total: i64, followed: bool) -> SeriesFacts {
        SeriesFacts { owned, total, followed, ..Default::default() }
    }
    fn row(series: &str, kind: &str, id: &str, name: &str, count: i64) -> CreditRow {
        CreditRow { series_id: series.into(), kind: kind.into(), provider_id: id.into(), name: name.into(), count }
    }
    fn seed(kind: &str, id: &str, name: &str, weight: f64) -> Seed {
        Seed { kind: kind.into(), provider_id: id.into(), name: name.into(), weight, series: 1, role: if kind == "CHARACTER" { "character" } else { "creative" } }
    }
    fn sv(pairs: &[(&str, &str)]) -> Vec<SeedVolume> {
        pairs.iter().map(|(id, n)| SeedVolume { volume_id: id.to_string(), name: n.to_string(), weight: 1.0 }).collect()
    }

    #[test]
    fn series_weight_grows_with_ownership_floors_a_stub_and_doubles_a_follow() {
        assert!((series_weight(&facts(0, 10, false)) - 0.5).abs() < 1e-9, "an unowned monitored series still speaks");
        assert!(series_weight(&facts(30, 30, false)) > series_weight(&facts(3, 30, false)));
        assert!((series_weight(&facts(3, 30, true)) - 2.0 * series_weight(&facts(3, 30, false))).abs() < 1e-9);
    }

    #[test]
    fn credit_fraction_is_lead_versus_cameo_and_full_when_the_total_is_unknown() {
        assert!((credit_fraction(31, 36) - 31.0 / 36.0).abs() < 1e-9);
        assert!((credit_fraction(1, 36) - 1.0 / 36.0).abs() < 1e-9);
        assert_eq!(credit_fraction(0, 36), 1.0 / 36.0); // a zero count still counts once
        assert_eq!(credit_fraction(50, 36), 1.0);       // never above 1
        assert_eq!(credit_fraction(3, 0), 1.0);         // unknown total = in full
    }

    #[test]
    fn only_people_the_library_knows_as_creatives_seed_characters_always_do() {
        // Ten credited series. The editor is on all ten and the rare production name on one —
        // neither has a creative credit anywhere; the writer is on four and named as a writer on
        // one owned issue. Role is the ONLY thing that separates them: volume people carry none,
        // and the lab proved every widely-shared "unknown" was an editor.
        let mut facts_map: HashMap<String, SeriesFacts> = HashMap::new();
        let mut rows = Vec::new();
        for i in 0..10 {
            let sid = format!("s{i}");
            let mut f = facts(10, 10, false);
            if i == 0 { f.creative.insert("jed mackay".into()); }
            facts_map.insert(sid.clone(), f);
            rows.push(row(&sid, "PERSON", "1", "C.B. Cebulski", 10));
            if i < 4 { rows.push(row(&sid, "PERSON", "2", "Jed MacKay", 10)); }
            if i == 0 { rows.push(row(&sid, "PERSON", "3", "Some Designer", 10)); }
            rows.push(row(&sid, "CHARACTER", "9", "Wolverine", 10));
        }
        let seeds = build_seeds(&rows, &facts_map, &SeedConfig::default());
        let names: Vec<&str> = seeds.iter().map(|s| s.name.as_str()).collect();
        assert!(!names.contains(&"C.B. Cebulski"), "unknown role never seeds, however widely shared: {names:?}");
        assert!(!names.contains(&"Some Designer"), "unknown role never seeds, however rare: {names:?}");
        assert!(names.contains(&"Jed MacKay"), "a known creative seeds: {names:?}");
        assert!(names.contains(&"Wolverine"), "characters need no role: {names:?}");
        assert_eq!(seeds.iter().find(|s| s.name == "Jed MacKay").unwrap().role, "creative");
        assert_eq!(seeds.iter().find(|s| s.name == "Wolverine").unwrap().role, "character");
    }

    #[test]
    fn a_creative_credit_on_any_series_qualifies_the_person_everywhere() {
        // Known as a writer on s1 (an owned tagged issue), credited with no role on s2: seeds
        // once, with both series' weight behind them.
        let mut f1 = facts(5, 5, false);
        f1.creative.insert("scott snyder".into());
        let facts_map: HashMap<String, SeriesFacts> = [("s1".to_string(), f1), ("s2".to_string(), facts(5, 5, false))].into_iter().collect();
        let rows = vec![row("s1", "PERSON", "7", "Scott Snyder", 5), row("s2", "PERSON", "7", "Scott Snyder", 5)];
        let seeds = build_seeds(&rows, &facts_map, &SeedConfig::default());
        assert_eq!(seeds.len(), 1);
        assert_eq!(seeds[0].series, 2);
    }

    #[test]
    fn seeds_never_come_from_staff_roles_and_creative_wins_over_staff() {
        let mut f = facts(5, 5, false);
        f.staff.insert("rachelle rosenberg".into());
        f.creative.insert("stan lee".into());
        let facts_map: HashMap<String, SeriesFacts> = [("s1".to_string(), f)].into_iter().collect();
        let rows = vec![
            row("s1", "PERSON", "1", "Rachelle Rosenberg", 5), // colorist: never
            row("s1", "PERSON", "2", "Stan Lee", 5),           // writer: yes
        ];
        let seeds = build_seeds(&rows, &facts_map, &SeedConfig::default());
        assert_eq!(seeds.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["Stan Lee"]);
    }

    #[test]
    fn seeds_are_ranked_by_ownership_times_appearance_and_normalized_per_kind() {
        let facts_map: HashMap<String, SeriesFacts> = [
            ("big".to_string(), facts(30, 36, false)),   // a run mostly owned
            ("stub".to_string(), facts(0, 36, false)),   // a monitored stub
        ].into_iter().collect();
        let rows = vec![
            row("big", "CHARACTER", "1", "Cyclops", 31),  // lead on the big run
            row("big", "CHARACTER", "2", "Cameo", 1),     // one cameo on the big run
            row("stub", "CHARACTER", "3", "Storm", 36),   // lead, but on an unowned stub
        ];
        let seeds = build_seeds(&rows, &facts_map, &SeedConfig::default());
        let order: Vec<&str> = seeds.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(order, vec!["Cyclops", "Storm", "Cameo"]);
        assert_eq!(seeds[0].weight, 1.0, "the strongest seed of a kind is normalized to 1");
        assert!(seeds[2].weight < 0.1, "a cameo is a whisper: {}", seeds[2].weight);
    }

    #[test]
    fn seeds_respect_the_per_kind_caps() {
        let mut f = facts(5, 5, false);
        for i in 100..110 { f.creative.insert(format!("p{i}")); }
        let facts_map: HashMap<String, SeriesFacts> = [("s".to_string(), f)].into_iter().collect();
        let mut rows = Vec::new();
        for i in 0..20 { rows.push(row("s", "CHARACTER", &i.to_string(), &format!("C{i}"), 5 - (i % 5))); }
        for i in 100..110 { rows.push(row("s", "PERSON", &i.to_string(), &format!("P{i}"), 5)); }
        let seeds = build_seeds(&rows, &facts_map, &SeedConfig { people: 3, characters: 4 });
        assert_eq!(seeds.iter().filter(|s| s.kind == "PERSON").count(), 3);
        assert_eq!(seeds.iter().filter(|s| s.kind == "CHARACTER").count(), 4);
    }

    #[test]
    fn candidates_add_seed_weights_exclude_the_library_and_reward_both_kinds() {
        let seeds = vec![seed("PERSON", "p1", "Writer", 1.0), seed("CHARACTER", "c1", "Hero", 0.6), seed("CHARACTER", "c2", "Sidekick", 0.4)];
        let seed_volumes = vec![
            sv(&[("10", "Owned Run"), ("20", "Writer + Hero"), ("30", "Writer Only")]),
            sv(&[("20", "Writer + Hero"), ("40", "Hero + Sidekick"), ("20", "dup within one seed")]),
            sv(&[("40", "Hero + Sidekick"), ("50", "Sidekick Only")]),
        ];
        let excluded: HashSet<String> = ["10".to_string()].into_iter().collect();
        let out = score_candidates(&seeds, &seed_volumes, &excluded, 10);
        let ids: Vec<&str> = out.iter().map(|c| c.volume_id.as_str()).collect();
        assert!(!ids.contains(&"10"), "the library's own volume is never a candidate");
        // 20 = 1.0 + 0.6 + both-kinds bonus 0.5 = 2.1; 40 = 0.6 + 0.4 = 1.0 (one kind, no bonus);
        // 30 = 1.0; 50 = 0.4. A duplicate volume inside ONE seed's list counts once.
        assert_eq!(ids[0], "20");
        assert!((out[0].score - 2.1).abs() < 1e-9, "{}", out[0].score);
        assert_eq!(out[0].because.len(), 2);
        assert_eq!(ids[1..3].iter().copied().collect::<HashSet<_>>(), ["30", "40"].into_iter().collect());
        assert_eq!(ids[3], "50");
        // Ties break on how many seeds agree, then name: 40 has two seeds, 30 has one.
        assert_eq!(ids[1], "40");
    }

    #[test]
    fn candidates_are_capped() {
        let seeds = vec![seed("CHARACTER", "c", "Hero", 1.0)];
        let vols: Vec<SeedVolume> = (0..100).map(|i| SeedVolume { volume_id: i.to_string(), name: format!("V{i}"), weight: 1.0 }).collect();
        assert_eq!(score_candidates(&seeds, &[vols], &HashSet::new(), 7).len(), 7);
    }

    #[test]
    fn a_seed_volume_weight_scales_that_seed_s_contribution() {
        // A character seed's lead book (weight 1.0) beats its cameo book (weight 1/3).
        let seeds = vec![seed("CHARACTER", "c", "Hero", 0.9)];
        let vols = vec![
            SeedVolume { volume_id: "1".into(), name: "Cameo".into(), weight: appearance_weight(1) },
            SeedVolume { volume_id: "2".into(), name: "Lead".into(), weight: appearance_weight(8) },
        ];
        let out = score_candidates(&seeds, &[vols], &HashSet::new(), 10);
        assert_eq!(out[0].name, "Lead");
        assert!((out[0].score - 0.9).abs() < 1e-9);
        assert!((out[1].score - 0.3).abs() < 1e-9);
    }

    #[test]
    fn translated_reprint_publishers_are_recognised_by_whole_word_and_real_publishers_are_not() {
        for p in ["Panini España", "Panini Verlag", "Editorial Televisa", "Planeta DeAgostini", "Norma Editorial", "ECC Ediciones", "Urban Comics", "Marvel UK"] {
            assert!(is_foreign_reprint_publisher(p), "{p} is a translated reprint line");
        }
        for p in ["Marvel", "DC Comics", "Image", "Dark Horse", "Titan Comics", "Boom! Studios", "IDW Publishing", "Dynamite Entertainment", "Oni Press", ""] {
            assert!(!is_foreign_reprint_publisher(p), "{p} must never be dropped");
        }
        // Whole words only: "Semic" is on the list, "Semicolon Press" is not.
        assert!(!is_foreign_reprint_publisher("Semicolon Press"));
    }

    #[test]
    fn character_fan_out_helpers_take_the_newest_appearances_and_weight_by_frequency() {
        assert_eq!(newest_issue_ids(&[5, 900, 12, 900, 300], 3), vec![900, 300, 12]);
        assert_eq!(newest_issue_ids(&[], 3), Vec::<i64>::new());
        assert_eq!(appearance_weight(0), 1.0 / 3.0);
        assert_eq!(appearance_weight(1), 1.0 / 3.0);
        assert_eq!(appearance_weight(3), 1.0);
        assert_eq!(appearance_weight(40), 1.0);
        let resolved = vec![
            ("10".to_string(), "X-Men".to_string()), ("10".to_string(), "X-Men".to_string()), ("10".to_string(), "X-Men".to_string()),
            ("20".to_string(), "Avengers".to_string()),
        ];
        assert_eq!(volumes_from_recent_issues(&resolved), vec![
            SeedVolume { volume_id: "10".into(), name: "X-Men".into(), weight: 1.0 },
            SeedVolume { volume_id: "20".into(), name: "Avengers".into(), weight: 1.0 / 3.0 },
        ]);
    }
}
