// Runtime-selected database backend (PostgreSQL or SQLite) via sqlx's Any driver.
//
// This is the migration seam for dual-database support: modules move off the hard-typed PgPool
// onto `Db` one at a time (scanner is first). `Db` carries the resolved dialect so the handful of
// SQL constructs that differ between backends (NOW(), array binds) can be emitted per-dialect.
// When the last module flips, the PgPool in main.rs and the transitional `*_any` helper variants
// in secret_crypto/metadata/manga_detector/engine_config are deleted.
//
// Dialect ground rules for queries running on this pool (enforced by convention, verified by the
// spike test in scanner.rs):
//   - Placeholders are `$1..$N`, in order, none reused — valid in BOTH Postgres and SQLite, and
//     the Any driver binds positionally.
//   - No `= ANY($1)` array binds (Postgres-only; the Any driver cannot bind Vec<T>). Use
//     `IN (...)` with `in_placeholders()` instead.
//   - No bare NOW() — use `now_expr()`. Prisma's SQLite connector stores DateTime columns as
//     INTEGER epoch-milliseconds, so the SQLite arm emits exactly that.

use sqlx::any::AnyPoolOptions;
use sqlx::AnyPool;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dialect {
    Postgres,
    Sqlite,
}

#[derive(Clone)]
pub struct Db {
    pub pool: AnyPool,
    pub dialect: Dialect,
}

impl Db {
    /// Normalize a Prisma-style DATABASE_URL into what sqlx's Any driver expects and detect the
    /// dialect. Prisma SQLite URLs look like `file:/config/omnibus.db`; sqlx wants `sqlite:<path>`.
    pub fn normalize_url(url: &str) -> (String, Dialect) {
        let trimmed = url.trim();
        if let Some(path) = trimmed.strip_prefix("file:") {
            (format!("sqlite:{}", path), Dialect::Sqlite)
        } else if trimmed.starts_with("sqlite:") {
            (trimmed.to_string(), Dialect::Sqlite)
        } else {
            (trimmed.to_string(), Dialect::Postgres)
        }
    }

    pub async fn connect(url: &str, max_connections: u32) -> anyhow::Result<Self> {
        sqlx::any::install_default_drivers();
        let (url, dialect) = Self::normalize_url(url);
        let mut options = AnyPoolOptions::new().max_connections(max_connections);
        if dialect == Dialect::Sqlite {
            // The engine shares the SQLite file with the Node app — two writer processes. WAL lets
            // readers proceed alongside a writer (and is sticky per database file); busy_timeout is
            // per-connection, so it must be set on every pooled connection, and makes lock
            // contention wait instead of failing immediately with SQLITE_BUSY.
            options = options.after_connect(|conn, _meta| {
                Box::pin(async move {
                    sqlx::query("PRAGMA journal_mode = WAL;").execute(&mut *conn).await?;
                    sqlx::query("PRAGMA busy_timeout = 10000;").execute(&mut *conn).await?;
                    Ok(())
                })
            });
        }
        let pool = options.connect(&url).await?;
        Ok(Self { pool, dialect })
    }

    /// SQL expression for "now" matching what Prisma stores natively on each backend: Postgres
    /// timestamps take NOW(); Prisma's SQLite connector stores DateTime as INTEGER epoch-ms.
    pub fn now_expr(&self) -> &'static str {
        match self.dialect {
            Dialect::Postgres => "NOW()",
            Dialect::Sqlite => "CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER)",
        }
    }

    /// `$start, $start+1, ..` placeholder list for a portable `IN (...)` — replaces Postgres's
    /// `= ANY($1)` array bind, which neither SQLite nor the Any driver supports.
    pub fn in_placeholders(start: usize, n: usize) -> String {
        (0..n).map(|i| format!("${}", start + i)).collect::<Vec<_>>().join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_prisma_sqlite_urls() {
        assert_eq!(
            Db::normalize_url("file:/config/omnibus.db"),
            ("sqlite:/config/omnibus.db".to_string(), Dialect::Sqlite)
        );
        assert_eq!(
            Db::normalize_url("file:C:/data/omnibus.db"),
            ("sqlite:C:/data/omnibus.db".to_string(), Dialect::Sqlite)
        );
        let (url, d) = Db::normalize_url("postgresql://omnibus:pw@db:5432/omnibus?schema=public");
        assert_eq!(d, Dialect::Postgres);
        assert!(url.starts_with("postgresql://"));
    }

    #[test]
    fn in_placeholders_shape() {
        assert_eq!(Db::in_placeholders(1, 3), "$1, $2, $3");
        assert_eq!(Db::in_placeholders(4, 1), "$4");
    }
}
