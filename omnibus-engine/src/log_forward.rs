// omnibus-engine/src/log_forward.rs
//
// Mirrors the engine's `log` records into the Node app's unified logger so engine activity shows up
// inline in the same UI log viewer / omnibus.log as the Node side — one troubleshooting view across
// the hybrid. Stdout logging (the container logs) is UNCHANGED; this is an additional sink.
//
// Forwarding is fire-and-forget: it never blocks a job and silently drops lines if Node is
// unreachable. It mirrors exactly what env_logger prints (so RUST_LOG controls verbosity — info by
// default, `RUST_LOG=debug` surfaces the deep `[* Debug]` lines on demand).

use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

#[derive(serde::Serialize)]
struct LogLine {
    level: &'static str,
    message: String,
}

static SENDER: OnceLock<UnboundedSender<LogLine>> = OnceLock::new();
static RECEIVER: OnceLock<Mutex<Option<UnboundedReceiver<LogLine>>>> = OnceLock::new();

// Records from these targets are never forwarded: the HTTP POST that forwards a line is itself made
// with reqwest/hyper, which emit their own records — forwarding those would feed back into the
// channel in an endless loop. (Stdout still shows them.)
const SKIP_TARGETS: &[&str] = &[
    "hyper", "reqwest", "h2", "rustls", "want", "mio", "tokio_util", "tower",
    "omnibus_engine::log_forward",
];

/// A log target is skipped (never forwarded to Node) when it belongs to the HTTP/async plumbing that
/// the forwarder itself uses — otherwise forwarding a line would emit new reqwest/hyper records and
/// feed back into the channel endlessly.
fn is_skipped_target(target: &str) -> bool {
    SKIP_TARGETS.iter().any(|t| target.starts_with(t))
}

struct ForwardingLogger {
    inner: env_logger::Logger,
}

impl log::Log for ForwardingLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        self.inner.enabled(metadata)
    }

    fn log(&self, record: &log::Record) {
        // 1. Print to the container's stdout/stderr exactly as before.
        self.inner.log(record);

        // 2. Mirror to Node only if the record passed env_logger's full filter and isn't self-traffic.
        if !self.inner.matches(record) || record.level() == log::Level::Trace {
            return;
        }
        let target = record.target();
        if is_skipped_target(target) {
            return;
        }
        if let Some(tx) = SENDER.get() {
            let level = match record.level() {
                log::Level::Error => "error",
                log::Level::Warn => "warn",
                log::Level::Debug => "debug",
                _ => "info",
            };
            // Non-blocking; ignored if the drain task hasn't started or has gone away.
            let _ = tx.send(LogLine { level, message: format!("{}", record.args()) });
        }
    }

    fn flush(&self) {
        self.inner.flush();
    }
}

/// Installs the global logger (stdout + Node mirror). Call ONCE, before any logging. If the global
/// logger is already set, this is a no-op and stdout logging falls back to whatever was installed.
pub fn init() {
    let inner = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).build();
    let level = inner.filter();
    let (tx, rx) = unbounded_channel();
    let _ = SENDER.set(tx);
    let _ = RECEIVER.set(Mutex::new(Some(rx)));

    if log::set_boxed_logger(Box::new(ForwardingLogger { inner })).is_ok() {
        log::set_max_level(level);
    }
}

/// Spawns the background task that batches buffered log lines and POSTs them to the Node app's
/// `/api/internal/log`. Call once from within the tokio runtime (in `run`). No-op if `init` was not
/// called or this was already invoked.
pub fn spawn_forwarder() {
    let rx = match RECEIVER.get().and_then(|m| m.lock().ok().and_then(|mut g| g.take())) {
        Some(rx) => rx,
        None => return,
    };

    let node_url = std::env::var("OMNIBUS_NODE_URL").unwrap_or_else(|_| "http://localhost:3000".to_string());
    let secret = std::env::var("NEXTAUTH_SECRET").ok().filter(|s| !s.is_empty());
    let endpoint = format!("{}/api/internal/log", node_url.trim_end_matches('/'));

    tokio::spawn(async move {
        let client = match reqwest::Client::builder().timeout(Duration::from_secs(5)).build() {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut rx = rx;
        let mut batch: Vec<LogLine> = Vec::with_capacity(64);
        // Block on the first line, then drain whatever else is queued so a burst (e.g. a scan) goes
        // out in a few batched POSTs instead of one request per line.
        while let Some(first) = rx.recv().await {
            batch.push(first);
            while batch.len() < 100 {
                match rx.try_recv() {
                    Ok(line) => batch.push(line),
                    Err(_) => break,
                }
            }
            let payload = serde_json::json!({ "lines": batch });
            let mut req = client.post(&endpoint).json(&payload);
            if let Some(s) = &secret {
                req = req.header("X-Internal-Secret", s);
            }
            // Errors (Node down, network blip) are intentionally ignored — logging must never disrupt jobs.
            let _ = req.send().await;
            batch.clear();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skip_targets_block_self_traffic_but_allow_engine_modules() {
        // The forwarder's own HTTP/async plumbing is skipped (prefix match, so submodules too).
        assert!(is_skipped_target("hyper"));
        assert!(is_skipped_target("hyper::client::conn"));
        assert!(is_skipped_target("reqwest::connect"));
        assert!(is_skipped_target("omnibus_engine::log_forward"));
        // Real engine work is forwarded.
        assert!(!is_skipped_target("omnibus_engine::scanner"));
        assert!(!is_skipped_target("omnibus_engine"));
        assert!(!is_skipped_target("sqlx::query"));
    }
}
