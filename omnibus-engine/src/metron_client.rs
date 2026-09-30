//! The engine's one Metron API client (Metron's published best practices; #216 follow-up).
//!
//! Every engine call to the Metron API goes through `metron_get`, which:
//! - authenticates with an API token (`Authorization: Bearer`) when one is configured, else HTTP
//!   Basic with the username/password (Metron is retiring Basic auth);
//! - paces from Metron's own `X-RateLimit-*` headers the way their reference client (Mokkari's
//!   HeaderPacedRateLimiter) does: a rolling log of our sends against the burst (per-minute) limit the
//!   server reports, background work spaced evenly across that window, a 429 blocks every caller for
//!   its `Retry-After`, and an exhausted daily (sustained) window stops work instead of waiting hours;
//! - retries only 429 and 5xx (5xx with exponential backoff, 1 s doubling to a 60 s cap) and never
//!   another 4xx;
//! - shares the latest rate-limit state through SystemSetting `metron_rate_status`, which the Node app
//!   reads and writes too - both processes use the same Metron account, and each only sees its own
//!   sends otherwise;
//! - identifies itself as `Omnibus/<version> (+repo URL)`.
use reqwest::header::HeaderMap;
use reqwest::{Client, RequestBuilder};
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex;

use crate::db::Db;

/// Where Metron can find out who we are (sent in the User-Agent).
pub(crate) const PROJECT_URL: &str = "https://github.com/hankscafe/omnibus";
/// SystemSetting key holding the rate-limit state shared with the Node app.
pub(crate) const RATE_STATUS_KEY: &str = "metron_rate_status";
/// Metron's burst window, in milliseconds.
const BURST_PERIOD_MS: i64 = 60_000;
/// Metron's documented burst floor, used until a response reports the real limit.
const DEFAULT_BURST_LIMIT: i64 = 20;
/// A 429 whose Retry-After is longer than this stops the job instead of waiting it out.
const MAX_INLINE_RETRY_AFTER_S: i64 = 60;

/// How to authenticate against Metron.
#[derive(Clone, PartialEq)]
pub(crate) enum MetronAuth {
    /// An API token from metron.cloud → Profile → API Tokens (`Authorization: Bearer <token>`).
    Token(String),
    /// Username + password (HTTP Basic) — being retired by Metron.
    Basic(String, String),
}

/// Says which kind of credential it is, never the secret itself: a `{:?}` of it in a log line, an error
/// or a failed assertion must not put the token or the password in the logs.
impl std::fmt::Debug for MetronAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MetronAuth::Token(_) => f.write_str("Token(********)"),
            MetronAuth::Basic(user, _) => write!(f, "Basic({:?}, ********)", user),
        }
    }
}

impl MetronAuth {
    pub(crate) fn apply(&self, req: RequestBuilder) -> RequestBuilder {
        match self {
            MetronAuth::Token(token) => req.bearer_auth(token),
            MetronAuth::Basic(user, pass) => req.basic_auth(user, Some(pass)),
        }
    }
}

/// A usable credential value: not blank, and not the settings UI's `********` mask.
fn usable(value: &str) -> Option<&str> {
    let v = value.trim();
    if v.is_empty() || v == "********" { None } else { Some(v) }
}

/// Picks the credentials from already-decrypted settings: a token wins, else username + password.
/// Blank values and the settings UI's `********` mask are never credentials.
pub(crate) fn auth_from_settings(token: &str, user: &str, pass: &str) -> Option<MetronAuth> {
    if let Some(t) = usable(token) {
        return Some(MetronAuth::Token(t.to_string()));
    }
    match (usable(user), usable(pass)) {
        (Some(u), Some(p)) => Some(MetronAuth::Basic(u.to_string(), p.to_string())),
        _ => None,
    }
}

/// Loads (and decrypts) the configured Metron credentials.
pub(crate) async fn load_auth(pool: &sqlx::AnyPool) -> Option<MetronAuth> {
    use sqlx::Row;
    let rows = sqlx::query(r#"SELECT key, value FROM "SystemSetting" WHERE key IN ('metron_api_token','metron_user','metron_pass')"#)
        .fetch_all(pool).await.unwrap_or_default();
    let (mut token, mut user, mut pass) = (String::new(), String::new(), String::new());
    for row in rows {
        let key: String = row.get("key");
        let value: String = row.get("value");
        match key.as_str() {
            "metron_api_token" => token = value,
            "metron_user" => user = value,
            "metron_pass" => pass = value,
            _ => {}
        }
    }
    // The token and the password are stored encrypted at rest (parity with Node); the username isn't.
    let token = crate::secret_crypto::decrypt_setting(pool, Some(token)).await.unwrap_or_default();
    let pass = crate::secret_crypto::decrypt_setting(pool, Some(pass)).await.unwrap_or_default();
    auth_from_settings(&token, &user, &pass)
}

/// `Omnibus/<release version> (+https://github.com/hankscafe/omnibus)`.
pub(crate) fn user_agent() -> &'static str {
    static UA: OnceLock<String> = OnceLock::new();
    UA.get_or_init(|| {
        let (version, _) = crate::resolve_version(std::fs::read_to_string(crate::VERSION_FILE).ok());
        format!("Omnibus/{} (+{})", version, PROJECT_URL)
    })
}

/// One rate-limit window as Metron reports it. `reset` is a Unix epoch in seconds.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct Window {
    pub limit: Option<i64>,
    pub remaining: Option<i64>,
    pub reset: Option<i64>,
}

/// The rate-limit state both processes share (SystemSetting `metron_rate_status`, camelCase JSON).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RateStatus {
    #[serde(default)]
    pub burst: Window,
    #[serde(default)]
    pub sustained: Window,
    /// Epoch ms until which nobody may send (set by a 429).
    #[serde(default)]
    pub blocked_until: Option<i64>,
    /// Epoch ms of the response this snapshot came from.
    #[serde(default)]
    pub updated_at: Option<i64>,
}

/// Reads `X-RateLimit-{Burst,Sustained}-{Limit,Remaining,Reset}` from a response.
pub(crate) fn parse_rate_headers(headers: &HeaderMap) -> (Window, Window) {
    let num = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<i64>().ok());
    let window = |scope: &str| Window {
        limit: num(&format!("x-ratelimit-{}-limit", scope)),
        remaining: num(&format!("x-ratelimit-{}-remaining", scope)),
        reset: num(&format!("x-ratelimit-{}-reset", scope)),
    };
    (window("burst"), window("sustained"))
}

/// A window whose `remaining` is used up and whose reset is still ahead: Some(ms until the reset).
fn exhausted_for_ms(w: &Window, now_ms: i64) -> Option<i64> {
    match (w.remaining, w.reset) {
        (Some(r), Some(reset)) if r <= 0 && reset * 1000 > now_ms => Some(reset * 1000 - now_ms),
        _ => None,
    }
}


/// Why a request may not be sent at all right now.
#[derive(Debug, PartialEq)]
pub(crate) enum Refusal {
    /// The daily (sustained) window is used up; it resets in this many seconds.
    DailyLimit { retry_after_s: i64 },
}

/// The pacing state for this process. Time is passed in (epoch ms) so the rules are testable.
#[derive(Debug, Default)]
pub(crate) struct Limiter {
    sends: VecDeque<i64>,
    last_send: Option<i64>,
    burst_limit: Option<i64>,
    blocked_until: i64,
    sustained: Window,
}

impl Limiter {
    fn burst_limit(&self) -> i64 {
        self.burst_limit.filter(|l| *l > 0).unwrap_or(DEFAULT_BURST_LIMIT)
    }

    /// Milliseconds to wait before the next send may go out (0 = now), or a refusal.
    pub(crate) fn wait_ms(&mut self, now_ms: i64, shared: &RateStatus) -> Result<i64, Refusal> {
        // The daily window, as this process or the other one last saw it.
        for w in [&self.sustained, &shared.sustained] {
            if let Some(ms) = exhausted_for_ms(w, now_ms) {
                return Err(Refusal::DailyLimit { retry_after_s: (ms + 999) / 1000 });
            }
        }

        let mut wait = self.blocked_until - now_ms;
        if let Some(until) = shared.blocked_until {
            wait = wait.max(until - now_ms);
        }
        // The other process was told the burst window is empty until its reset.
        if let Some(ms) = exhausted_for_ms(&shared.burst, now_ms) {
            wait = wait.max(ms);
        }

        // Our own sends in the last burst period against the limit Metron reports.
        let limit = self.burst_limit();
        while self.sends.front().is_some_and(|&t| t <= now_ms - BURST_PERIOD_MS) {
            self.sends.pop_front();
        }
        if self.sends.len() as i64 >= limit {
            let oldest_that_must_expire = self.sends[self.sends.len() - limit as usize];
            wait = wait.max(oldest_that_must_expire + BURST_PERIOD_MS - now_ms);
        }

        // Sends go out evenly spaced across the window rather than back-to-back until it's empty (all
        // engine traffic is background work).
        if let Some(last) = self.last_send {
            wait = wait.max(last + BURST_PERIOD_MS / limit - now_ms);
        }
        Ok(wait.max(0))
    }

    /// Records a send at `now_ms`.
    pub(crate) fn record_send(&mut self, now_ms: i64) {
        self.sends.push_back(now_ms);
        self.last_send = Some(now_ms);
    }

    /// Takes in the windows a response reported.
    pub(crate) fn observe(&mut self, burst: &Window, sustained: &Window) {
        if let Some(limit) = burst.limit.filter(|l| *l > 0) {
            self.burst_limit = Some(limit);
        }
        if sustained.remaining.is_some() {
            // Only ever tightened within one daily window, so a late response can't make it look
            // roomier than a more exhausted state already seen; a new reset time is a new window.
            let new_window = sustained.reset.is_some() && sustained.reset != self.sustained.reset;
            if new_window || self.sustained.remaining.is_none() || sustained.remaining < self.sustained.remaining {
                self.sustained = Window {
                    limit: sustained.limit.or(self.sustained.limit),
                    remaining: sustained.remaining,
                    reset: sustained.reset.or(self.sustained.reset),
                };
            }
        }
    }

    /// A 429: nobody sends for `retry_after_s` (a full burst window when Metron sent none). Returns
    /// the epoch ms the block lasts until.
    pub(crate) fn on_rate_limited(&mut self, retry_after_s: i64, now_ms: i64) -> i64 {
        let delay_ms = if retry_after_s > 0 { retry_after_s * 1000 } else { BURST_PERIOD_MS };
        self.blocked_until = self.blocked_until.max(now_ms + delay_ms);
        self.blocked_until
    }
}

/// Metron's base daily limit — only a fallback for when no response has reported the real one.
const BASE_DAILY_LIMIT: i64 = 5_000;

/// Whether optional bulk work (the per-issue detail pass) should stop so normal syncing keeps room in
/// the account's daily window: less than 10% (never under 500) of the limit left. Metron's own
/// Sustained headers decide when they're current (the limit varies by donor tier); without them, our
/// rolling 24h count against the base limit.
pub(crate) fn optional_budget_spent(sustained: &Window, now_ms: i64, local_calls_24h: usize) -> bool {
    let current = sustained.reset.is_some_and(|r| r * 1000 > now_ms);
    match (current, sustained.limit, sustained.remaining) {
        (true, Some(limit), Some(remaining)) => remaining < (limit / 10).max(500),
        _ => local_calls_24h as i64 + (BASE_DAILY_LIMIT / 10) >= BASE_DAILY_LIMIT,
    }
}

/// `optional_budget_spent` against the shared state and our own usage counter.
pub(crate) async fn optional_budget_exhausted(db: &Db) -> bool {
    let status = read_status(db).await;
    let calls = crate::api_usage::metron_calls_last_day(&db.pool).await;
    optional_budget_spent(&status.sustained, now_ms(), calls)
}

/// Seconds to wait before retry `attempt` (0-based) of a 5xx / network failure: 1, 2, 4 … capped at 60.
pub(crate) fn backoff_secs(attempt: u32) -> u64 {
    2u64.saturating_pow(attempt).min(60)
}

/// One Metron GET.
pub(crate) struct MetronRequest<'a> {
    pub url: &'a str,
    pub timeout_secs: u64,
    pub max_attempts: u32,
    pub if_modified_since: Option<&'a str>,
    /// Use the shared MetadataCache (metadata_cache_enabled) for plain 200s.
    pub use_cache: bool,
}

impl<'a> MetronRequest<'a> {
    /// A background GET: 15 s timeout, 3 attempts, cached, not conditional.
    pub(crate) fn new(url: &'a str) -> Self {
        MetronRequest { url, timeout_secs: 15, max_attempts: 3, if_modified_since: None, use_cache: true }
    }
}

fn limiter() -> &'static Mutex<Limiter> {
    static LIMITER: OnceLock<Mutex<Limiter>> = OnceLock::new();
    LIMITER.get_or_init(|| Mutex::new(Limiter::default()))
}

/// GETs a Metron API URL through the shared limiter. Returns (status, body); 304 and 204 come back with
/// a Null body, and 404 with whatever Metron sent. Errors carry `FATAL_RATE_LIMIT` when the job must
/// stop (a long 429, or the daily limit is used up).
pub(crate) async fn metron_get(db: &Db, client: &Client, auth: &MetronAuth, req: MetronRequest<'_>) -> anyhow::Result<(u16, Value)> {
    metron_get_with(limiter(), db, client, auth, req).await
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(crate) async fn metron_get_with(lim: &Mutex<Limiter>, db: &Db, client: &Client, auth: &MetronAuth, req: MetronRequest<'_>) -> anyhow::Result<(u16, Value)> {
    // Shared response cache (metadata_cache_enabled): conditional requests bypass it — their whole
    // point is asking Metron "did this change". A hit is not an upstream call.
    if req.use_cache && req.if_modified_since.is_none() {
        if let Some(hit) = crate::metadata_cache::get(db, "metron", req.url).await {
            return Ok((200, hit));
        }
    }
    log::debug!("[Metron] GET {}{}", req.url, if req.if_modified_since.is_some() { " (conditional)" } else { "" });

    let attempts = req.max_attempts.max(1);
    let mut last_err = anyhow::anyhow!("Metron max retries reached");
    for attempt in 0..attempts {
        // Wait for a slot. The lock is only held to decide, never across a sleep; a wait longer than
        // Metron's inline limit means a block (a long 429) - the job stops instead of sleeping.
        loop {
            let shared = read_status(db).await;
            let decision = {
                let mut l = lim.lock().await;
                let now = now_ms();
                match l.wait_ms(now, &shared) {
                    Ok(0) => { l.record_send(now); None }
                    Ok(ms) => Some(ms),
                    Err(Refusal::DailyLimit { retry_after_s }) => {
                        anyhow::bail!("FATAL_RATE_LIMIT: Metron's daily request limit is used up; it resets in {}s", retry_after_s)
                    }
                }
            };
            match decision {
                None => break,
                Some(ms) if ms > MAX_INLINE_RETRY_AFTER_S * 1000 => {
                    anyhow::bail!("FATAL_RATE_LIMIT: Metron has asked us to wait another {}s", (ms + 999) / 1000)
                }
                Some(ms) => tokio::time::sleep(Duration::from_millis(ms as u64)).await,
            }
        }

        let mut rb = auth.apply(client.get(req.url))
            .header("User-Agent", user_agent())
            .timeout(Duration::from_secs(req.timeout_secs));
        if let Some(ims) = req.if_modified_since {
            rb = rb.header("If-Modified-Since", ims);
        }
        let resp = match rb.send().await {
            Ok(r) => r,
            Err(e) => {
                log::debug!("[Metron] Attempt {}/{} failed to connect: {}", attempt + 1, attempts, e);
                last_err = e.into();
                if attempt + 1 < attempts { tokio::time::sleep(Duration::from_secs(backoff_secs(attempt))).await; }
                continue;
            }
        };
        // Every response is a request against the account's daily window.
        crate::api_usage::log(&db.pool, "metron", req.url).await;

        let status = resp.status().as_u16();
        let (burst, sustained) = parse_rate_headers(resp.headers());
        lim.lock().await.observe(&burst, &sustained);

        if status == 429 {
            let retry_after = resp.headers().get("retry-after").and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse::<i64>().ok()).unwrap_or(0);
            let effective = if retry_after > 0 { retry_after } else { BURST_PERIOD_MS / 1000 };
            let until = lim.lock().await.on_rate_limited(retry_after, now_ms());
            record_status(db, &burst, &sustained, Some(until)).await;
            if effective > MAX_INLINE_RETRY_AFTER_S {
                crate::metadata::mark_flag(db, "metron_rate_limit_time").await;
                log::error!("[Metron] Rate limited: Metron asked us to wait {}s. Stopping this job.", effective);
                anyhow::bail!("FATAL_RATE_LIMIT: Metron asked us to wait {}s", effective);
            }
            log::warn!("[Metron] Rate limited: waiting {}s before retrying.", effective);
            last_err = anyhow::anyhow!("Metron HTTP 429 (rate limited)");
            continue; // the next slot is after the block
        }
        record_status(db, &burst, &sustained, None).await;

        if status >= 500 {
            last_err = anyhow::anyhow!("Metron HTTP Error: {}", status);
            if attempt + 1 < attempts { tokio::time::sleep(Duration::from_secs(backoff_secs(attempt))).await; }
            continue;
        }
        let valid = (200..300).contains(&status) || status == 304 || status == 404;
        if !valid {
            // Metron's best practices: a 4xx other than 429 won't improve on retry.
            anyhow::bail!("Metron HTTP Error: {} (not retried)", status);
        }
        if status == 204 || status == 304 {
            return Ok((status, Value::Null));
        }
        // A body that doesn't parse is a real failure (a truncated response must never overwrite good
        // data) - retried like a server error.
        match resp.json::<Value>().await {
            Ok(data) => {
                if status == 200 && req.use_cache && req.if_modified_since.is_none() {
                    crate::metadata_cache::put(db, "metron", req.url, &data).await;
                }
                return Ok((status, data));
            }
            Err(e) => {
                log::warn!("[Metron] Response body for {} did not parse as JSON (attempt {}/{}): {}", req.url, attempt + 1, attempts, e);
                last_err = anyhow::anyhow!("Metron returned an unparseable body for {}", req.url);
                if attempt + 1 < attempts { tokio::time::sleep(Duration::from_secs(backoff_secs(attempt))).await; }
            }
        }
    }
    Err(last_err)
}

/// The shared state, or the default when nothing has been recorded yet.
pub(crate) async fn read_status(db: &Db) -> RateStatus {
    use sqlx::Row;
    sqlx::query(r#"SELECT value FROM "SystemSetting" WHERE key = $1"#)
        .bind(RATE_STATUS_KEY)
        .fetch_optional(&db.pool).await.ok().flatten()
        .and_then(|row| serde_json::from_str::<RateStatus>(&row.get::<String, _>("value")).ok())
        .unwrap_or_default()
}

/// Folds a response's windows (and a 429's block) into the shared state. Read-modify-write: the Node
/// app writes the same row, and the freshest windows win.
async fn record_status(db: &Db, burst: &Window, sustained: &Window, blocked_until: Option<i64>) {
    let mut status = read_status(db).await;
    let now = now_ms();
    if burst.limit.is_some() || burst.remaining.is_some() || burst.reset.is_some() {
        status.burst = *burst;
    }
    if sustained.limit.is_some() || sustained.remaining.is_some() || sustained.reset.is_some() {
        status.sustained = *sustained;
    }
    if let Some(until) = blocked_until {
        status.blocked_until = Some(status.blocked_until.filter(|b| *b > now).unwrap_or(0).max(until));
    }
    status.updated_at = Some(now);
    if let Ok(json) = serde_json::to_string(&status) {
        let _ = sqlx::query(
            r#"INSERT INTO "SystemSetting" (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"#,
        )
        .bind(RATE_STATUS_KEY)
        .bind(json)
        .execute(&db.pool)
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::State, http::{HeaderMap as AxumHeaders, StatusCode}, response::IntoResponse, routing::get, Router};
    use std::sync::{Arc, Mutex as StdMutex};

    // ---------------------------------------------------------------- auth

    #[test]
    fn a_token_wins_over_username_and_password() {
        assert_eq!(auth_from_settings(" tok123 ", "adam", "pw"), Some(MetronAuth::Token("tok123".into())));
        assert_eq!(auth_from_settings("", "adam", "pw"), Some(MetronAuth::Basic("adam".into(), "pw".into())));
    }

    #[test]
    fn blank_or_masked_values_are_never_credentials() {
        assert_eq!(auth_from_settings("********", "adam", "pw"), Some(MetronAuth::Basic("adam".into(), "pw".into())));
        assert_eq!(auth_from_settings("", "adam", "********"), None);
        assert_eq!(auth_from_settings("", "", "pw"), None);
        assert_eq!(auth_from_settings("  ", "adam", ""), None);
        assert_eq!(auth_from_settings("", "", ""), None);
    }

    #[test]
    fn auth_is_sent_as_bearer_or_basic() {
        let client = Client::new();
        let bearer = MetronAuth::Token("tok123".into()).apply(client.get("https://metron.cloud/api/issue/")).build().unwrap();
        assert_eq!(bearer.headers()["authorization"], "Bearer tok123");
        let basic = MetronAuth::Basic("adam".into(), "pw".into()).apply(client.get("https://metron.cloud/api/issue/")).build().unwrap();
        assert_eq!(basic.headers()["authorization"], "Basic YWRhbTpwdw==");
    }

    // Metron beta 3: nothing logs the credentials today, but a `{:?}` of them - in a log line, an error,
    // a failed assertion - must never print the token or the password either.
    #[test]
    fn debug_output_never_contains_the_token_or_the_password() {
        let token = format!("{:?}", MetronAuth::Token("tok_SECRET".into()));
        let basic = format!("{:?}", MetronAuth::Basic("adam".into(), "pw_SECRET".into()));
        assert!(!token.contains("SECRET") && !basic.contains("SECRET"), "{} / {}", token, basic);
        assert!(token.starts_with("Token") && basic.contains("adam"), "still says which kind (and the username isn't a secret): {} / {}", token, basic);
    }

    #[test]
    fn the_user_agent_names_the_version_and_the_project() {
        let ua = user_agent();
        assert!(ua.starts_with("Omnibus/"), "{}", ua);
        assert!(!ua.starts_with("Omnibus/1.0 "), "a real version, not the old fixed 1.0: {}", ua);
        assert!(ua.ends_with("(+https://github.com/hankscafe/omnibus)"), "{}", ua);
    }

    // ---------------------------------------------------------------- headers

    #[test]
    fn all_six_rate_limit_headers_are_read() {
        let mut h = HeaderMap::new();
        h.insert("x-ratelimit-burst-limit", "20".parse().unwrap());
        h.insert("x-ratelimit-burst-remaining", "17".parse().unwrap());
        h.insert("x-ratelimit-burst-reset", "1790700060".parse().unwrap());
        h.insert("X-RateLimit-Sustained-Limit", "10000".parse().unwrap());
        h.insert("X-RateLimit-Sustained-Remaining", "9876".parse().unwrap());
        h.insert("X-RateLimit-Sustained-Reset", "1790780000".parse().unwrap());
        let (burst, sustained) = parse_rate_headers(&h);
        assert_eq!(burst, Window { limit: Some(20), remaining: Some(17), reset: Some(1_790_700_060) });
        assert_eq!(sustained, Window { limit: Some(10_000), remaining: Some(9_876), reset: Some(1_790_780_000) });
        assert_eq!(parse_rate_headers(&HeaderMap::new()), (Window::default(), Window::default()));
    }

    #[test]
    fn the_shared_state_reads_what_the_node_app_writes() {
        // Node omits unknown fields; the engine writes nulls. Both must read the same row.
        let from_node: RateStatus = serde_json::from_str(r#"{"burst":{"limit":600},"sustained":{},"blockedUntil":1790700045000,"updatedAt":1790700000000}"#).unwrap();
        assert_eq!(from_node.burst, Window { limit: Some(600), remaining: None, reset: None });
        assert_eq!(from_node.sustained, Window::default());
        assert_eq!(from_node.blocked_until, Some(1_790_700_045_000));
        let round_trip: RateStatus = serde_json::from_str(&serde_json::to_string(&from_node).unwrap()).unwrap();
        assert_eq!(round_trip, from_node);
        assert!(serde_json::to_string(&from_node).unwrap().contains("\"blockedUntil\""), "camelCase for the Node app");
    }

    // ---------------------------------------------------------------- limiter

    const T0: i64 = 1_790_700_000_000;
    fn none() -> RateStatus { RateStatus::default() }

    #[test]
    fn sends_are_spaced_evenly_across_the_burst_window() {
        let mut l = Limiter::default();
        assert_eq!(l.wait_ms(T0, &none()), Ok(0));
        l.record_send(T0);
        // Metron's floor of 20/min until a response says otherwise: 60 s / 20 = 3 s apart.
        assert_eq!(l.wait_ms(T0, &none()), Ok(3_000));
        assert_eq!(l.wait_ms(T0 + 1_000, &none()), Ok(2_000));
        assert_eq!(l.wait_ms(T0 + 3_000, &none()), Ok(0));
    }

    #[test]
    fn the_burst_limit_follows_what_metron_reports() {
        let mut l = Limiter::default();
        l.observe(&Window { limit: Some(30), remaining: Some(29), reset: None }, &Window::default());
        l.record_send(T0);
        assert_eq!(l.wait_ms(T0, &none()), Ok(2_000)); // 60 s / 30
    }

    #[test]
    fn a_full_burst_window_waits_for_its_oldest_send_to_age_out() {
        let mut l = Limiter::default();
        for i in 0..20 { l.record_send(T0 + i * 100); }
        // 20 sends in the last minute: the next fits when the first (T0) is 60 s old.
        assert_eq!(l.wait_ms(T0 + 5_000, &none()), Ok(55_000));
        assert_eq!(l.wait_ms(T0 + 60_000, &none()), Ok(0));
    }

    #[test]
    fn a_429_blocks_every_caller_for_its_retry_after() {
        let mut l = Limiter::default();
        assert_eq!(l.on_rate_limited(30, T0), T0 + 30_000);
        assert_eq!(l.wait_ms(T0 + 10_000, &none()), Ok(20_000));
        assert_eq!(l.wait_ms(T0 + 30_000, &none()), Ok(0));
        // No Retry-After: a full burst window.
        let mut l = Limiter::default();
        assert_eq!(l.on_rate_limited(0, T0), T0 + 60_000);
    }

    #[test]
    fn a_used_up_daily_window_refuses_instead_of_waiting_hours() {
        let mut l = Limiter::default();
        let reset_s = T0 / 1000 + 3_600;
        l.observe(&Window::default(), &Window { limit: Some(5_000), remaining: Some(0), reset: Some(reset_s) });
        assert_eq!(l.wait_ms(T0, &none()), Err(Refusal::DailyLimit { retry_after_s: 3_600 }));
        // Once the reset time passes, the window has rolled over.
        assert_eq!(l.wait_ms(T0 + 3_600_000, &none()), Ok(0));
    }

    #[test]
    fn the_other_process_state_is_honoured() {
        let mut l = Limiter::default();
        // The Node app hit a 429 and recorded a block.
        let blocked = RateStatus { blocked_until: Some(T0 + 45_000), ..RateStatus::default() };
        assert_eq!(l.wait_ms(T0, &blocked), Ok(45_000));
        // Metron told the Node app its burst window is empty until reset.
        let empty = RateStatus { burst: Window { limit: Some(20), remaining: Some(0), reset: Some(T0 / 1000 + 12) }, ..RateStatus::default() };
        assert_eq!(l.wait_ms(T0, &empty), Ok(12_000));
        // …and its daily window is used up.
        let daily = RateStatus { sustained: Window { limit: Some(5_000), remaining: Some(0), reset: Some(T0 / 1000 + 600) }, ..RateStatus::default() };
        assert_eq!(l.wait_ms(T0, &daily), Err(Refusal::DailyLimit { retry_after_s: 600 }));
        // Stale state (reset already passed) is ignored.
        let stale = RateStatus { burst: Window { limit: Some(20), remaining: Some(0), reset: Some(T0 / 1000 - 5) }, ..RateStatus::default() };
        assert_eq!(l.wait_ms(T0, &stale), Ok(0));
    }

    #[test]
    fn optional_bulk_work_leaves_a_tenth_of_the_real_daily_limit() {
        let now = T0;
        let future = Some(T0 / 1000 + 3_600);
        let w = |limit, remaining| Window { limit: Some(limit), remaining: Some(remaining), reset: future };
        // Metron's own numbers win: under 10% (at least 500) of the account's limit left = stop.
        assert!(optional_budget_spent(&w(5_000, 400), now, 0));
        assert!(!optional_budget_spent(&w(5_000, 600), now, 0));
        assert!(optional_budget_spent(&w(25_000, 2_000), now, 0), "a Mega Sponsor's reserve is 2,500");
        assert!(!optional_budget_spent(&w(25_000, 9_000), now, 4_900), "a donor tier isn't capped at 5,000");
        // No current headers (never seen, or the window already reset): our own 24h count vs the base limit.
        assert!(optional_budget_spent(&Window::default(), now, 4_600));
        assert!(!optional_budget_spent(&Window::default(), now, 4_000));
        let stale = Window { limit: Some(5_000), remaining: Some(0), reset: Some(T0 / 1000 - 1) };
        assert!(!optional_budget_spent(&stale, now, 100));
    }

    #[test]
    fn server_errors_back_off_exponentially_to_a_minute() {
        assert_eq!((0..8).map(backoff_secs).collect::<Vec<_>>(), vec![1, 2, 4, 8, 16, 32, 60, 60]);
    }

    // ---------------------------------------------------------------- HTTP (a local fake Metron)

    /// One scripted reply: status, extra headers, body.
    type Reply = (u16, Vec<(&'static str, String)>, String);
    type ScriptedReply = (u16, Vec<(&'static str, String)>, &'static str);

    #[derive(Clone, Default)]
    struct Fake {
        /// Replies served in order; the last one repeats.
        script: Arc<StdMutex<Vec<Reply>>>,
        seen_auth: Arc<StdMutex<Vec<String>>>,
        seen_ua: Arc<StdMutex<Vec<String>>>,
    }

    async fn serve(State(f): State<Fake>, headers: AxumHeaders) -> impl IntoResponse {
        f.seen_auth.lock().unwrap().push(headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").to_string());
        f.seen_ua.lock().unwrap().push(headers.get("user-agent").and_then(|v| v.to_str().ok()).unwrap_or("").to_string());
        let (status, extra, body) = {
            let mut s = f.script.lock().unwrap();
            if s.len() > 1 { s.remove(0) } else { s[0].clone() }
        };
        let mut h = AxumHeaders::new();
        // A generous burst limit keeps background spacing short in tests (60 s / 600 = 100 ms).
        h.insert("x-ratelimit-burst-limit", "600".parse().unwrap());
        for (k, v) in extra { h.insert(k, v.parse().unwrap()); }
        (StatusCode::from_u16(status).unwrap(), h, body)
    }

    async fn fake_metron(script: Vec<ScriptedReply>) -> (String, Fake) {
        let fake = Fake {
            script: Arc::new(StdMutex::new(script.into_iter().map(|(s, h, b)| (s, h, b.to_string())).collect())),
            ..Fake::default()
        };
        let app = Router::new().route("/api/issue/", get(serve)).with_state(fake.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{}/api/issue/", addr), fake)
    }

    async fn fixture(tag: &str) -> Db {
        let base = std::env::temp_dir().join(format!("omnibus_mc_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let file = base.join("mc.db");
        std::fs::File::create(&file).unwrap();
        let db = Db::connect(&format!("file:{}", file.to_string_lossy().replace('\\', "/")), 2).await.unwrap();
        sqlx::query(r#"CREATE TABLE "SystemSetting" (key TEXT PRIMARY KEY, value TEXT)"#).execute(&db.pool).await.unwrap();
        db
    }

    fn quick(url: &str) -> MetronRequest<'_> {
        MetronRequest { url, timeout_secs: 5, max_attempts: 3, if_modified_since: None, use_cache: false }
    }

    async fn setting(db: &Db, key: &str) -> Option<String> {
        use sqlx::Row;
        sqlx::query(r#"SELECT value FROM "SystemSetting" WHERE key = $1"#).bind(key).fetch_optional(&db.pool).await.unwrap().map(|r| r.get::<String, _>("value"))
    }

    #[tokio::test]
    async fn a_token_is_sent_as_bearer_with_our_user_agent() {
        let db = fixture("bearer").await;
        let (url, fake) = fake_metron(vec![(200, vec![], r#"{"results":[]}"#)]).await;
        let lim = Mutex::new(Limiter::default());
        let (status, body) = metron_get_with(&lim, &db, &Client::new(), &MetronAuth::Token("tok123".into()), quick(&url)).await.unwrap();
        assert_eq!(status, 200);
        assert_eq!(body["results"], serde_json::json!([]));
        assert_eq!(fake.seen_auth.lock().unwrap().as_slice(), ["Bearer tok123"]);
        assert_eq!(fake.seen_ua.lock().unwrap()[0], user_agent());
    }

    #[tokio::test]
    async fn a_short_429_waits_its_retry_after_then_succeeds() {
        let db = fixture("short429").await;
        let (url, fake) = fake_metron(vec![
            (429, vec![("retry-after", "1".into())], "{}"),
            (200, vec![], r#"{"ok":true}"#),
        ]).await;
        let lim = Mutex::new(Limiter::default());
        let started = std::time::Instant::now();
        let (status, body) = metron_get_with(&lim, &db, &Client::new(), &MetronAuth::Token("t".into()), quick(&url)).await.unwrap();
        assert_eq!((status, body["ok"].as_bool()), (200, Some(true)));
        assert!(started.elapsed() >= Duration::from_millis(1_000), "waited out Retry-After: {:?}", started.elapsed());
        assert_eq!(fake.seen_auth.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_long_429_stops_the_job_and_blocks_both_processes() {
        let db = fixture("long429").await;
        let (url, fake) = fake_metron(vec![(429, vec![("retry-after", "600".into())], "{}")]).await;
        let lim = Mutex::new(Limiter::default());
        let err = metron_get_with(&lim, &db, &Client::new(), &MetronAuth::Token("t".into()), quick(&url)).await.unwrap_err();
        assert!(err.to_string().contains("FATAL_RATE_LIMIT"), "{}", err);
        assert_eq!(fake.seen_auth.lock().unwrap().len(), 1, "never retried");
        // The block is shared through the database (the Node app honours it too) and the health flag is raised.
        let status = read_status(&db).await;
        let until = status.blocked_until.expect("blocked_until recorded");
        assert!(until > chrono::Utc::now().timestamp_millis() + 590_000, "{}", until);
        assert!(setting(&db, "metron_rate_limit_time").await.is_some());
        // A second call is refused without reaching Metron.
        let err = metron_get_with(&lim, &db, &Client::new(), &MetronAuth::Token("t".into()), quick(&url)).await.unwrap_err();
        assert!(err.to_string().contains("FATAL_RATE_LIMIT"), "{}", err);
        assert_eq!(fake.seen_auth.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn another_client_error_is_never_retried() {
        let db = fixture("401").await;
        let (url, fake) = fake_metron(vec![(401, vec![], r#"{"detail":"Invalid token."}"#)]).await;
        let lim = Mutex::new(Limiter::default());
        let err = metron_get_with(&lim, &db, &Client::new(), &MetronAuth::Token("bad".into()), quick(&url)).await.unwrap_err();
        assert!(err.to_string().contains("401"), "{}", err);
        assert_eq!(fake.seen_auth.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_server_error_is_retried_after_a_backoff() {
        let db = fixture("5xx").await;
        let (url, fake) = fake_metron(vec![(503, vec![], "{}"), (200, vec![], r#"{"ok":true}"#)]).await;
        let lim = Mutex::new(Limiter::default());
        let started = std::time::Instant::now();
        let (status, _) = metron_get_with(&lim, &db, &Client::new(), &MetronAuth::Token("t".into()), quick(&url)).await.unwrap();
        assert_eq!(status, 200);
        assert!(started.elapsed() >= Duration::from_millis(1_000), "1 s backoff: {:?}", started.elapsed());
        assert_eq!(fake.seen_auth.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn the_reported_windows_are_shared_and_a_used_up_day_stops_further_calls() {
        let db = fixture("daily").await;
        let reset = chrono::Utc::now().timestamp() + 3_600;
        let (url, fake) = fake_metron(vec![(200, vec![
            ("x-ratelimit-sustained-limit", "10000".into()),
            ("x-ratelimit-sustained-remaining", "0".into()),
            ("x-ratelimit-sustained-reset", reset.to_string()),
        ], r#"{"ok":true}"#)]).await;
        let lim = Mutex::new(Limiter::default());
        metron_get_with(&lim, &db, &Client::new(), &MetronAuth::Token("t".into()), quick(&url)).await.unwrap();
        let status = read_status(&db).await;
        assert_eq!(status.sustained, Window { limit: Some(10_000), remaining: Some(0), reset: Some(reset) });
        assert_eq!(status.burst.limit, Some(600));
        let err = metron_get_with(&lim, &db, &Client::new(), &MetronAuth::Token("t".into()), quick(&url)).await.unwrap_err();
        assert!(err.to_string().contains("FATAL_RATE_LIMIT"), "{}", err);
        assert_eq!(fake.seen_auth.lock().unwrap().len(), 1, "the used-up day refused before sending");
    }
}
