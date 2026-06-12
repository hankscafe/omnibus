// src/engine_config.rs
//
// Runtime concurrency limits, admin-editable via the SystemSetting table.
//   - scan_workers / convert_workers gate the per-job Semaphores (so a huge library can't fan out
//     thousands of concurrent blocking file ops and thrash disk / exhaust the blocking pool).
//   - cpu_cap configures the tokio worker-thread count AND the rayon global pool at startup.
//   - blocking_threads caps tokio's blocking pool (default 512 is far too high once jobs are bounded).
//   - memory_ceiling_mb softly derates the worker counts (a GC-less Rust process can't hard-cap heap).
//
// Worker counts are re-read per job (so settings changes take effect on the next job); cpu_cap and
// blocking_threads are read once at startup because the runtime can only be sized at construction.

use sqlx::{PgPool, Row};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy)]
pub struct EngineConfig {
    pub scan_workers: usize,
    pub convert_workers: usize,
    pub cpu_cap: usize,
    pub blocking_threads: usize,
    pub memory_ceiling_mb: u64,
}

/// Logical CPU count, used to derive defaults and clamp ceilings.
fn cores() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
}

/// Approximate transient memory per concurrent heavy task (a decoded page bitmap + buffered archive
/// bytes), used to translate a memory ceiling into a worker-count cap.
const PER_TASK_MB: u64 = 64;

impl EngineConfig {
    /// Safe defaults, used when the SystemSetting table is unreadable (e.g. a preflight DB failure).
    pub fn defaults() -> Self {
        Self::resolve(None, None, None, None, None, cores())
    }

    /// Reads the `engine_*` SystemSetting keys and resolves them into clamped, derated limits.
    pub async fn load(db: &PgPool) -> Self {
        let mut map: HashMap<String, String> = HashMap::new();
        match sqlx::query(
            r#"SELECT key, value FROM "SystemSetting" WHERE key IN
               ('engine_max_scan_workers','engine_max_convert_workers','engine_cpu_cap',
                'engine_max_blocking_threads','engine_memory_ceiling_mb')"#,
        )
        .fetch_all(db)
        .await
        {
            Ok(rows) => {
                for row in rows {
                    let k: String = row.get("key");
                    let v: String = row.get("value");
                    map.insert(k, v);
                }
            }
            Err(e) => log::warn!("[Config] Could not read engine concurrency settings ({}); using defaults.", e),
        }

        let num = |key: &str| -> Option<u64> { map.get(key).and_then(|v| v.trim().parse::<u64>().ok()) };

        let cfg = Self::resolve(
            num("engine_max_scan_workers"),
            num("engine_max_convert_workers"),
            num("engine_cpu_cap"),
            num("engine_max_blocking_threads"),
            num("engine_memory_ceiling_mb"),
            cores(),
        );

        // Internal-consistency check: if the blocking-pool ceiling is below the worker count, the
        // semaphores over-promise and offloaded jobs are silently throttled by the blocking pool.
        let max_worker = cfg.scan_workers.max(cfg.convert_workers);
        if cfg.blocking_threads < max_worker {
            log::warn!(
                "[Config] engine_max_blocking_threads ({}) is below the resolved worker count ({}); offloaded jobs will be throttled by the blocking pool.",
                cfg.blocking_threads, max_worker
            );
        }

        cfg
    }

    /// Pure resolution: defaults, clamping, and the memory-ceiling deration. Separated from `load` so
    /// it is unit-testable without a database.
    fn resolve(
        scan: Option<u64>,
        convert: Option<u64>,
        cpu: Option<u64>,
        blocking: Option<u64>,
        memory_ceiling_mb: Option<u64>,
        cores: usize,
    ) -> Self {
        let cores = cores.max(1);
        let max_workers = cores * 4; // generous ceiling so a typo can't spawn thousands of workers

        // 0 or unset => use the default (so the UI can present 0 as "auto").
        let mut scan_workers = scan.filter(|&n| n > 0).map(|n| n as usize).unwrap_or(cores).clamp(1, max_workers);
        let mut convert_workers = convert.filter(|&n| n > 0).map(|n| n as usize).unwrap_or((cores / 2).max(1)).clamp(1, max_workers);
        let cpu_cap = cpu.filter(|&n| n > 0).map(|n| n as usize).unwrap_or(cores).clamp(1, max_workers);
        let blocking_threads = blocking.filter(|&n| n > 0).map(|n| n as usize).unwrap_or(64).clamp(4, 512);
        let memory_ceiling_mb = memory_ceiling_mb.unwrap_or(0);

        // Soft memory ceiling: the dominant transient allocations scale with concurrent workers, so
        // honor the ceiling by derating the worker counts rather than capping the heap directly.
        if memory_ceiling_mb > 0 {
            // Scan tasks are light (file probes / dir walks). A convert task decodes page bitmaps AND
            // fans the pages across the rayon pool (cpu_cap threads), so its transient peak is roughly
            // cpu_cap * PER_TASK_MB — divide the convert budget by cpu_cap so the ceiling is actually
            // respected rather than under-counting by a cpu_cap factor.
            let scan_cap = (memory_ceiling_mb / PER_TASK_MB).max(1) as usize;
            let convert_cap = (memory_ceiling_mb / (PER_TASK_MB * cpu_cap as u64)).max(1) as usize;
            scan_workers = scan_workers.min(scan_cap);
            convert_workers = convert_workers.min(convert_cap);
        }

        Self { scan_workers, convert_workers, cpu_cap, blocking_threads, memory_ceiling_mb }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_derive_from_cores() {
        let c = EngineConfig::resolve(None, None, None, None, None, 8);
        assert_eq!(c.scan_workers, 8);
        assert_eq!(c.convert_workers, 4);
        assert_eq!(c.cpu_cap, 8);
        assert_eq!(c.blocking_threads, 64);
        assert_eq!(c.memory_ceiling_mb, 0);
    }

    #[test]
    fn zero_and_unset_fall_back_to_defaults() {
        let c = EngineConfig::resolve(Some(0), Some(0), Some(0), Some(0), Some(0), 4);
        assert_eq!(c.scan_workers, 4);
        assert_eq!(c.convert_workers, 2);
        assert_eq!(c.cpu_cap, 4);
        assert_eq!(c.blocking_threads, 64);
    }

    #[test]
    fn explicit_values_are_honored_and_clamped() {
        let c = EngineConfig::resolve(Some(2), Some(3), Some(6), Some(128), None, 8);
        assert_eq!(c.scan_workers, 2);
        assert_eq!(c.convert_workers, 3);
        assert_eq!(c.cpu_cap, 6);
        assert_eq!(c.blocking_threads, 128);

        // Absurd values are clamped: workers to 4*cores (=16), blocking to 512.
        let c2 = EngineConfig::resolve(Some(9999), None, Some(9999), Some(9999), None, 4);
        assert_eq!(c2.scan_workers, 16);
        assert_eq!(c2.cpu_cap, 16);
        assert_eq!(c2.blocking_threads, 512);
    }

    #[test]
    fn memory_ceiling_derates_worker_counts() {
        // 128MB ceiling, 16 cores. Scan tasks: 128/64 = 2. Convert tasks fan pages across the rayon
        // pool (cpu_cap), so 128/(64*16) = 0 → floored to 1. cpu_cap itself is never derated.
        let c = EngineConfig::resolve(Some(16), Some(16), None, None, Some(128), 16);
        assert_eq!(c.scan_workers, 2);
        assert_eq!(c.convert_workers, 1);
        assert_eq!(c.cpu_cap, 16);

        // A tiny ceiling still leaves at least 1 worker of each class.
        let c2 = EngineConfig::resolve(Some(8), Some(8), None, None, Some(10), 8);
        assert_eq!(c2.scan_workers, 1);
        assert_eq!(c2.convert_workers, 1);
    }
}
