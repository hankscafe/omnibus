//! Issue.fileAddedAt — when a row's current file ARRIVED (#206 follow-up), the engine half of the
//! Node helper `src/lib/file-added.ts`. Issue.createdAt is row birth: a file that fills a WANTED
//! placeholder keeps the skeleton's old createdAt, so everything that meant "new in your library"
//! (Recently Added, the Updates feed, the bell, the weekly digest, Paperback's "Recently updated
//! series") missed the most common arrival there is. The rules, as SQL `SET` fragments:
//!   arrival — a file lands on a row (watched-folder import): stamped now, unless the row already
//!             had a file (a replacement is not a new issue);
//!   rescan  — a scan points a row at a file: an existing stamp stands (a file renamed outside
//!             Omnibus did not arrive again); a row without one takes now if it had no file, else
//!             its birth.
//! A brand-new row is stamped with `db.now_expr()` in its INSERT. Every fragment reads the row's
//! PRE-update `"filePath"`, which SQL guarantees for all expressions in one UPDATE's SET list.

use crate::db::Db;

/// `SET` fragment for a file landing on an existing row (a download or watched-folder import):
/// now when the row had no file, its current stamp otherwise. Twin of Node's `arrivalStamp`.
pub fn arrival_set(db: &Db) -> String {
    format!(
        r#""fileAddedAt" = CASE WHEN "filePath" IS NULL OR "filePath" = '' THEN {now} ELSE "fileAddedAt" END"#,
        now = db.now_expr()
    )
}

/// `SET` fragment for a scan re-pointing a row at a file on disk: an existing stamp stands; a row
/// without one takes now when it had no file, else its own createdAt (a file-backed row that
/// predates the column — the value the startup backfill would give it). Twin of `rescanStamp`.
pub fn rescan_set(db: &Db) -> String {
    format!(
        r#""fileAddedAt" = CASE WHEN "fileAddedAt" IS NOT NULL THEN "fileAddedAt"
                               WHEN "filePath" IS NULL OR "filePath" = '' THEN {now}
                               ELSE "createdAt" END"#,
        now = db.now_expr()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;

    async fn fixture(tag: &str) -> Db {
        let base = std::env::temp_dir().join(format!("omnibus_file_added_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("create fixture dir");
        let db_file = base.join("fa.db");
        std::fs::File::create(&db_file).expect("pre-create sqlite file");
        let db_url = format!("file:{}", db_file.to_string_lossy().replace('\\', "/"));
        let db = Db::connect(&db_url, 2).await.expect("connect file-backed sqlite");
        sqlx::query(r#"CREATE TABLE "Issue" (id TEXT PRIMARY KEY, "filePath" TEXT, "fileAddedAt" INTEGER, "createdAt" INTEGER)"#)
            .execute(&db.pool).await.expect("create schema");
        db
    }

    const OLD: i64 = 1_780_000_000_000; // 2026-05-28
    const BORN: i64 = 1_775_000_000_000; // 2026-03-31

    async fn seed(db: &Db, id: &str, file: Option<&str>, added: Option<i64>) {
        sqlx::query(r#"INSERT INTO "Issue" (id, "filePath", "fileAddedAt", "createdAt") VALUES ($1, $2, $3, $4)"#)
            .bind(id).bind(file).bind(added).bind(BORN)
            .execute(&db.pool).await.unwrap();
    }

    /// Point a row at a file with the given rule, as the scanner and watched sync do.
    async fn point(db: &Db, id: &str, file: &str, rule: &str) {
        sqlx::query(&format!(r#"UPDATE "Issue" SET "filePath" = $1, {rule} WHERE id = $2"#))
            .bind(file).bind(id)
            .execute(&db.pool).await.unwrap();
    }

    async fn stamp(db: &Db, id: &str) -> (Option<i64>, String) {
        let r = sqlx::query(r#"SELECT "fileAddedAt" AS fa, typeof("fileAddedAt") AS t FROM "Issue" WHERE id = $1"#)
            .bind(id).fetch_one(&db.pool).await.unwrap();
        (r.try_get::<i64, _>("fa").ok(), r.get::<String, _>("t"))
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
    }

    fn is_now(v: Option<i64>) -> bool {
        v.map(|ms| (now_ms() - ms).abs() < 60_000).unwrap_or(false)
    }

    #[tokio::test]
    async fn arrival_stamps_a_placeholder_and_a_re_download_but_never_a_replacement() {
        let db = fixture("arrival").await;
        seed(&db, "placeholder", None, None).await;
        seed(&db, "deleted_then_redownloaded", None, Some(OLD)).await;
        seed(&db, "owned", Some("/comics/Batman/Batman #001.cbr"), Some(OLD)).await;
        seed(&db, "owned_unstamped", Some("/comics/Batman/Batman #002.cbr"), None).await;
        let rule = arrival_set(&db);

        for (id, file) in [
            ("placeholder", "/comics/Batman/Batman #003.cbz"),
            ("deleted_then_redownloaded", "/comics/Batman/Batman #004.cbz"),
            ("owned", "/comics/Batman/Batman #001.cbz"),
            ("owned_unstamped", "/comics/Batman/Batman #002.cbz"),
        ] {
            point(&db, id, file, &rule).await;
        }

        let (placeholder, kind) = stamp(&db, "placeholder").await;
        assert!(is_now(placeholder), "the placeholder a download fills is a new arrival: {:?}", placeholder);
        // Prisma's SQLite connector stores DateTime as INTEGER epoch-ms; a text stamp would sort
        // apart from every Node-written one.
        assert_eq!(kind, "integer");
        assert!(is_now(stamp(&db, "deleted_then_redownloaded").await.0), "a re-download after deletion is a real arrival");
        assert_eq!(stamp(&db, "owned").await.0, Some(OLD), "a replacement keeps the row's arrival time");
        assert_eq!(stamp(&db, "owned_unstamped").await.0, None, "a replacement never invents one (the startup backfill does)");
    }

    #[tokio::test]
    async fn rescan_keeps_a_stamp_and_fills_one_only_where_it_is_missing() {
        let db = fixture("rescan").await;
        seed(&db, "ghosted", None, Some(OLD)).await; // full-scan ghost pass nulled a renamed file's path
        seed(&db, "renamed", Some("/comics/Batman/old name.cbz"), Some(OLD)).await;
        seed(&db, "placeholder", None, None).await;
        seed(&db, "legacy", Some("/comics/Batman/legacy.cbz"), None).await; // file-backed, predates the column
        let rule = rescan_set(&db);

        for (id, file) in [
            ("ghosted", "/comics/Batman/new name.cbz"),
            ("renamed", "/comics/Batman/new name 2.cbz"),
            ("placeholder", "/comics/Batman/Batman #005.cbz"),
            ("legacy", "/comics/Batman/legacy renamed.cbz"),
        ] {
            point(&db, id, file, &rule).await;
        }

        assert_eq!(stamp(&db, "ghosted").await.0, Some(OLD), "a file renamed outside Omnibus did not arrive again");
        assert_eq!(stamp(&db, "renamed").await.0, Some(OLD));
        let (placeholder, kind) = stamp(&db, "placeholder").await;
        assert!(is_now(placeholder), "a placeholder the scan fills is new: {:?}", placeholder);
        assert_eq!(kind, "integer");
        assert_eq!(stamp(&db, "legacy").await.0, Some(BORN), "a file-backed row without a stamp takes its birth");
    }
}
