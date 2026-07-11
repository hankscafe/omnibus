// Provider API-usage accounting (parity with Node's logApiUsage in src/lib/utils/system-flags.ts).
//
// The health check reads SystemSetting cv_api_usage / metron_api_usage ({endpoint: [ms timestamps]},
// pruned to the provider's window) to show quota consumption and fire the approaching-limit warning
// (ComicVine 200/hr, Metron 5,000/day — per metron.cloud's API best-practices). On the unified build
// the ENGINE makes most provider calls (metadata sync, monitor, discover), so without engine-side
// accounting those counters under-report and the warnings can never fire.

use sqlx::AnyPool;

/// Rolling usage window per provider (ComicVine limits are hourly; Metron limits are daily).
fn service_key_window(service: &str) -> (&'static str, i64) {
    if service == "comicvine" {
        ("cv_api_usage", 60 * 60 * 1000)
    } else {
        ("metron_api_usage", 24 * 60 * 60 * 1000)
    }
}

/// Normalizes a request URL to a stable endpoint key: strips scheme/host/query, drops a leading
/// /api, and folds numeric path segments to {id} so per-resource URLs don't grow the JSON unbounded.
/// "https://metron.cloud/api/series/123/issue_list/?page=2" → "/series/{id}/issue_list".
pub fn endpoint_key(url: &str) -> String {
    let path = url
        .split('#').next().unwrap_or("")
        .split('?').next().unwrap_or("");
    let path = match path.find("://") {
        Some(i) => match path[i + 3..].find('/') {
            Some(j) => &path[i + 3 + j..],
            None => "/",
        },
        None => path,
    };
    let mut segments: Vec<String> = Vec::new();
    for seg in path.split('/').filter(|s| !s.is_empty()) {
        if seg == "api" && segments.is_empty() { continue; }
        // CV ids look like "4050-12345"; Metron ids are bare numbers — fold both.
        let numericish = !seg.is_empty() && seg.chars().all(|c| c.is_ascii_digit() || c == '-');
        segments.push(if numericish { "{id}".to_string() } else { seg.to_string() });
    }
    if segments.is_empty() { "/".to_string() } else { format!("/{}", segments.join("/")) }
}

/// Appends `count` timestamps for `endpoint` into the usage JSON and prunes every endpoint to the
/// window (dropping empties). Malformed/absent existing JSON starts fresh — exact parity with Node.
pub fn merge_usage_json(existing: Option<&str>, endpoint: &str, count: usize, now_ms: i64, window_ms: i64) -> String {
    let mut usage: serde_json::Map<String, serde_json::Value> = existing
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    let entry = usage.entry(endpoint.to_string()).or_insert_with(|| serde_json::Value::Array(Vec::new()));
    if let Some(arr) = entry.as_array_mut() {
        for _ in 0..count {
            arr.push(serde_json::Value::from(now_ms));
        }
    }

    let keys: Vec<String> = usage.keys().cloned().collect();
    for k in keys {
        let keep: Vec<serde_json::Value> = usage[&k]
            .as_array()
            .map(|a| a.iter().filter(|t| t.as_i64().map(|ts| now_ms - ts < window_ms).unwrap_or(false)).cloned().collect())
            .unwrap_or_default();
        if keep.is_empty() {
            usage.remove(&k);
        } else {
            usage.insert(k, serde_json::Value::Array(keep));
        }
    }

    serde_json::Value::Object(usage).to_string()
}

/// Best-effort: records `count` calls against the provider's rolling window. Never fails the caller —
/// usage accounting must not break a sync. Last-write-wins with concurrent Node writers is acceptable
/// (Node's own read-modify-write has the same property).
pub async fn log_n(pool: &AnyPool, service: &str, url: &str, count: usize) {
    if count == 0 { return; }
    let (key, window_ms) = service_key_window(service);
    let endpoint = endpoint_key(url);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let existing: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = $1"#)
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();

    let merged = merge_usage_json(existing.as_deref(), &endpoint, count, now_ms, window_ms);

    let _ = sqlx::query(
        r#"INSERT INTO "SystemSetting" (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"#,
    )
    .bind(key)
    .bind(&merged)
    .execute(pool)
    .await;
}

/// Single-call convenience wrapper.
pub async fn log(pool: &AnyPool, service: &str, url: &str) {
    log_n(pool, service, url, 1).await;
}

/// Total calls across ALL endpoints inside the rolling window — the budget gate for the
/// unmatched-retry sweep (matcher.rs). Malformed/absent JSON counts as zero.
pub fn count_recent(usage_json: Option<&str>, now_ms: i64, window_ms: i64) -> usize {
    usage_json
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v.as_object().cloned())
        .map(|m| {
            m.values()
                .map(|arr| {
                    arr.as_array()
                        .map(|a| a.iter().filter(|t| t.as_i64().map(|ts| now_ms - ts < window_ms).unwrap_or(false)).count())
                        .unwrap_or(0)
                })
                .sum()
        })
        .unwrap_or(0)
}

/// ComicVine calls recorded in the last hour (Node + engine combined).
pub async fn cv_calls_last_hour(pool: &AnyPool) -> usize {
    let usage: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'cv_api_usage'"#)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    count_recent(usage.as_deref(), now_ms, 60 * 60 * 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_key_normalizes_urls() {
        assert_eq!(endpoint_key("https://metron.cloud/api/series/123/issue_list/?page=2"), "/series/{id}/issue_list");
        assert_eq!(endpoint_key("https://metron.cloud/api/issue/?store_date_range_after=2026-01-01"), "/issue");
        assert_eq!(endpoint_key("https://comicvine.gamespot.com/api/volume/4050-154911/"), "/volume/{id}");
        assert_eq!(endpoint_key("https://comicvine.gamespot.com/api/issues/?filter=volume:1"), "/issues");
        // Pathless / degenerate inputs never panic.
        assert_eq!(endpoint_key("https://metron.cloud"), "/");
        assert_eq!(endpoint_key(""), "/");
    }

    #[test]
    fn count_recent_sums_calls_inside_the_window() {
        let now: i64 = 1_000_000_000_000;
        let hour: i64 = 3_600_000;
        let json = format!(
            r#"{{"/issues": [{}, {}, {}], "/volume/{{id}}": [{}]}}"#,
            now - 1_000, now - 2_000, now - hour - 5, // two fresh, one stale
            now - 10_000                              // one fresh on another endpoint
        );
        assert_eq!(count_recent(Some(&json), now, hour), 3);
        assert_eq!(count_recent(None, now, hour), 0);
        assert_eq!(count_recent(Some("not json"), now, hour), 0);
    }

    #[test]
    fn merge_usage_appends_prunes_and_survives_bad_json() {
        let now: i64 = 1_000_000_000_000;
        let hour: i64 = 3_600_000;

        // Existing endpoint with one fresh + one stale timestamp; a second endpoint fully stale.
        let existing = format!(
            r#"{{"/issues": [{}, {}], "/volume/{{id}}": [{}]}}"#,
            now - 10_000,          // fresh — kept
            now - hour - 1,        // stale — pruned
            now - hour - 5         // stale — endpoint removed entirely
        );

        let merged = merge_usage_json(Some(&existing), "/issues", 2, now, hour);
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();

        // /issues: 1 surviving old + 2 new = 3; the all-stale endpoint is gone.
        assert_eq!(v["/issues"].as_array().unwrap().len(), 3);
        assert!(v.get("/volume/{id}").is_none(), "empty endpoints must be dropped: {merged}");

        // Malformed existing JSON starts a fresh object rather than erroring.
        let fresh = merge_usage_json(Some("not json"), "/issue", 1, now, hour);
        let v: serde_json::Value = serde_json::from_str(&fresh).unwrap();
        assert_eq!(v["/issue"].as_array().unwrap().len(), 1);

        // No existing value at all.
        let first = merge_usage_json(None, "/issue", 3, now, hour);
        let v: serde_json::Value = serde_json::from_str(&first).unwrap();
        assert_eq!(v["/issue"].as_array().unwrap().len(), 3);
    }
}
