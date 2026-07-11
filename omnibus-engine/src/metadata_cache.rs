// Shared ComicVine/Metron response cache — engine side (opt-in, metadata_cache_enabled).
//
// EXACT parity with src/lib/metadata/metadata-cache.ts: same URL normalization (api_key stripped,
// query sorted), same sha256 keys, same detail/list classification, same read-time TTL semantics
// (createdAt + the CURRENT admin settings, so TTL changes apply to existing rows immediately).
// Node and the engine read/write the same MetadataCache table — a response either side fetched is
// a saved API call for both. Change one implementation, change both.
//
// Callers: check `get()` before the HTTP request (a hit must NOT be api_usage-logged — it isn't an
// upstream call) and `put()` after parsing a 200 body. Conditional (If-Modified-Since) requests
// bypass the cache entirely — their point is asking the provider "did this change".

use crate::db::Db;
use sha2::{Digest, Sha256};
use sqlx::Row;

pub const MAX_CACHE_BODY_BYTES: usize = 512 * 1024;

const DEFAULT_DETAIL_DAYS: f64 = 7.0;
const DEFAULT_LIST_HOURS: f64 = 12.0;

/// Strips volatile/secret query params (the CV api_key) and sorts the query for a stable key.
/// Mirrors Node: URLSearchParams.delete('api_key') + .sort() + toString().
pub fn normalize_url(url: &str) -> String {
    let mut parsed = match reqwest::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return url.to_string(),
    };
    let mut pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(k, _)| k != "api_key")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0)); // stable: equal keys keep insertion order, like JS .sort()
    if pairs.is_empty() {
        parsed.set_query(None);
    } else {
        let query = pairs
            .iter()
            .fold(form_urlencoded_serializer(), |mut s, (k, v)| {
                s.append_pair(k, v);
                s
            })
            .finish();
        parsed.set_query(Some(&query));
    }
    parsed.to_string()
}

fn form_urlencoded_serializer() -> url::form_urlencoded::Serializer<'static, String> {
    url::form_urlencoded::Serializer::new(String::new())
}

/// Cache class of a provider URL — None means "never cache". Same regex set as the Node side:
/// detail = immutable-ish by-id lookups (long TTL); list = searches/paginated lists (short TTL).
pub fn classify(url: &str) -> Option<&'static str> {
    let path = match reqwest::Url::parse(url) {
        Ok(u) => u.path().to_string(),
        Err(_) => return None,
    };
    let p = path.to_lowercase();
    // ComicVine
    if regex_is_match(r"/api/(volume|issue|story_arc|person|character)/\d{4}-\d+", &p) {
        return Some("detail");
    }
    if regex_is_match(r"/api/(search|issues|volumes|story_arcs|characters|people)/?$", &p) {
        return Some("list");
    }
    // Metron
    if regex_is_match(r"/api/series/\d+/issue_list/?$", &p) {
        return Some("list");
    }
    if regex_is_match(r"/api/(issue|series|arc|character|team|publisher)/\d+/?$", &p) {
        return Some("detail");
    }
    if regex_is_match(r"/api/(issue|series|arc|character|team|publisher)/?$", &p) {
        return Some("list");
    }
    None
}

fn regex_is_match(pattern: &str, haystack: &str) -> bool {
    regex::Regex::new(pattern).map(|r| r.is_match(haystack)).unwrap_or(false)
}

/// `{provider}:{sha256-hex}` — byte-for-byte identical to the Node implementation.
pub fn cache_key(provider: &str, normalized_url: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalized_url.as_bytes());
    format!("{}:{:x}", provider, hasher.finalize())
}

async fn setting(db: &Db, key: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = $1"#)
        .bind(key)
        .fetch_optional(&db.pool)
        .await
        .ok()
        .flatten()
}

async fn enabled(db: &Db) -> bool {
    setting(db, "metadata_cache_enabled").await.as_deref() == Some("true")
}

/// (detail_ttl_secs, list_ttl_secs) from the live admin settings.
async fn ttl_secs(db: &Db) -> (u64, u64) {
    let detail_days = setting(db, "metadata_cache_detail_days")
        .await
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|n| *n > 0.0)
        .unwrap_or(DEFAULT_DETAIL_DAYS);
    let list_hours = setting(db, "metadata_cache_list_hours")
        .await
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|n| *n > 0.0)
        .unwrap_or(DEFAULT_LIST_HOURS);
    ((detail_days * 86400.0) as u64, (list_hours * 3600.0) as u64)
}

/// Fresh cached body for `url`, or None (miss / expired / disabled / uncacheable / error).
pub async fn get(db: &Db, provider: &str, url: &str) -> Option<serde_json::Value> {
    classify(url)?;
    if !enabled(db).await {
        return None;
    }
    let key = cache_key(provider, &normalize_url(url));
    let (detail_secs, list_secs) = ttl_secs(db).await;
    // Staleness is decided in SQL per-kind (older_than handles the dialect datetime math);
    // both predicates are computed and the row's own kind picks the applicable one.
    let sql = format!(
        r#"SELECT value, kind,
                  CAST(CASE WHEN {stale_detail} THEN 1 ELSE 0 END AS INTEGER) AS "staleDetail",
                  CAST(CASE WHEN {stale_list} THEN 1 ELSE 0 END AS INTEGER) AS "staleList"
           FROM "MetadataCache" WHERE key = $1"#,
        stale_detail = db.older_than(r#""createdAt""#, detail_secs),
        stale_list = db.older_than(r#""createdAt""#, list_secs),
    );
    let row = sqlx::query(&sql).bind(&key).fetch_optional(&db.pool).await.ok().flatten()?;
    let kind: String = row.try_get("kind").ok()?;
    let stale: i64 = if kind == "detail" {
        row.try_get("staleDetail").unwrap_or(1)
    } else {
        row.try_get("staleList").unwrap_or(1)
    };
    if stale != 0 {
        return None;
    }
    let value: String = row.try_get("value").ok()?;
    serde_json::from_str(&value).ok()
}

/// Stores a 200 body under `url`. Best-effort — a cache failure never fails the sync; oversized
/// bodies are skipped. A rewrite refreshes createdAt (a fresh fetch restarts the TTL clock).
pub async fn put(db: &Db, provider: &str, url: &str, body: &serde_json::Value) {
    let Some(kind) = classify(url) else { return };
    if !enabled(db).await {
        return;
    }
    let value = body.to_string();
    if value.len() > MAX_CACHE_BODY_BYTES {
        return;
    }
    let normalized = normalize_url(url);
    let key = cache_key(provider, &normalized);
    let sql = format!(
        r#"INSERT INTO "MetadataCache" (key, url, kind, value, "createdAt")
           VALUES ($1, $2, $3, $4, {now})
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, kind = EXCLUDED.kind, "createdAt" = {now}"#,
        now = db.now_expr()
    );
    if let Err(e) = sqlx::query(&sql).bind(&key).bind(&normalized).bind(kind).bind(&value).execute(&db.pool).await {
        log::debug!("[MetadataCache] Write failed for {}: {:?}", url, e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_api_key_and_sorts() {
        let url = "https://comicvine.gamespot.com/api/issues/?format=json&api_key=SECRET&filter=volume:123&offset=0";
        let n = normalize_url(url);
        assert!(!n.contains("SECRET") && !n.contains("api_key"), "{n}");
        // Sorted: filter < format < offset.
        let q = n.split('?').nth(1).unwrap();
        let keys: Vec<&str> = q.split('&').map(|p| p.split('=').next().unwrap()).collect();
        assert_eq!(keys, vec!["filter", "format", "offset"], "{n}");
        // Same request with a DIFFERENT key and different param order → the same cache key.
        let other = "https://comicvine.gamespot.com/api/issues/?offset=0&filter=volume:123&api_key=OTHER&format=json";
        assert_eq!(cache_key("comicvine", &normalize_url(url)), cache_key("comicvine", &normalize_url(other)));
    }

    #[test]
    fn cache_keys_match_the_node_implementation() {
        // Literals produced by the Node implementation (metadata-cache.ts) — both sides MUST hash
        // to the same key or they silently stop sharing the cache. If this fails, the two
        // normalizers diverged (encoding, sorting, or api_key stripping).
        assert_eq!(
            normalize_url("https://metron.cloud/api/issue/5555/"),
            "https://metron.cloud/api/issue/5555/"
        );
        assert_eq!(
            cache_key("metron", "https://metron.cloud/api/issue/5555/"),
            "metron:9a66f85b10bde831683415a6c18279ab92eebe087361dca79044212f4a4b3986"
        );
        assert_eq!(
            normalize_url("https://comicvine.gamespot.com/api/issues/?offset=0&filter=volume:123&api_key=SECRET&format=json"),
            "https://comicvine.gamespot.com/api/issues/?filter=volume%3A123&format=json&offset=0"
        );
        assert_eq!(
            cache_key("comicvine", "https://comicvine.gamespot.com/api/issues/?filter=volume%3A123&format=json&offset=0"),
            "comicvine:668d64706ea6e2b275307724eb8aec8a3115c8e78302de0bbd6fdcdda0d4aadb"
        );
    }

    #[test]
    fn classify_matches_the_node_taxonomy() {
        // ComicVine
        assert_eq!(classify("https://comicvine.gamespot.com/api/volume/4050-123/?format=json"), Some("detail"));
        assert_eq!(classify("https://comicvine.gamespot.com/api/issue/4000-99/"), Some("detail"));
        assert_eq!(classify("https://comicvine.gamespot.com/api/story_arc/4045-1/"), Some("detail"));
        assert_eq!(classify("https://comicvine.gamespot.com/api/issues/?filter=volume:1"), Some("list"));
        assert_eq!(classify("https://comicvine.gamespot.com/api/search/?query=spawn"), Some("list"));
        assert_eq!(classify("https://comicvine.gamespot.com/api/volumes/"), Some("list"));
        // Metron
        assert_eq!(classify("https://metron.cloud/api/issue/5555/"), Some("detail"));
        assert_eq!(classify("https://metron.cloud/api/series/123/"), Some("detail"));
        assert_eq!(classify("https://metron.cloud/api/series/123/issue_list/?page=2"), Some("list"));
        assert_eq!(classify("https://metron.cloud/api/series/?name=spawn"), Some("list"));
        assert_eq!(classify("https://metron.cloud/api/issue/?store_date_range_after=2026-01-01"), Some("list"));
        // Never cached
        assert_eq!(classify("https://comicvine.gamespot.com/api/types/"), None);
        assert_eq!(classify("not a url"), None);
    }
}
