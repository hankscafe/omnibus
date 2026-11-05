// Who set a series' book type (Series."bookTypeSource"), and what may replace it. Twin of
// src/lib/book-type.ts, which explains the sources: ADMIN is never replaced; evidence (a file's
// <Format>, Metron's series_type) fills a blank and replaces a Print nobody chose; a guess (the
// ComicVine one-shot heuristic) or a series.json read-back only fills a blank.

/// Evidence may write when the type is blank, or is a Print nobody chose: one with no source (set
/// before sources were recorded), a guess, or a series.json read-back.
pub(crate) const EVIDENCE_MAY_REPLACE: &str =
    r#"(COALESCE("bookType", '') = '' OR ("bookType" = 'Print' AND COALESCE("bookTypeSource", '') IN ('', 'GUESS', 'SERIES_JSON')))"#;

/// A guess or a series.json value only fills a blank.
pub(crate) const BLANK: &str = r#"COALESCE("bookType", '') = ''"#;

/// The SET clauses writing bookType and its source when `cond` holds. `$value` and `$source` are bound
/// together - the source None when there is no value - so a NULL value changes nothing. Two
/// placeholders for one decision because the Any driver binds positionally and never reuses one
/// (db.rs). Both CASEs read the row as it was before the UPDATE, as SQL SET expressions do.
pub(crate) fn set_clauses(cond: &str, value: usize, source: usize) -> String {
    format!(
        r#""bookType" = CASE WHEN {cond} THEN COALESCE(${value}, "bookType") ELSE "bookType" END,
           "bookTypeSource" = CASE WHEN {cond} THEN COALESCE(${source}, "bookTypeSource") ELSE "bookTypeSource" END"#
    )
}

/// The source bound beside a value: present only when there is a value.
pub(crate) fn source_for(value: Option<&str>, source: &'static str) -> Option<&'static str> {
    value.map(|_| source)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn series_table() -> sqlx::AnyPool {
        sqlx::any::install_default_drivers();
        let pool = sqlx::any::AnyPoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query(r#"CREATE TABLE "Series" (id TEXT PRIMARY KEY, "bookType" TEXT, "bookTypeSource" TEXT)"#)
            .execute(&pool).await.unwrap();
        pool
    }

    async fn apply(cond: &str, stored: (Option<&str>, Option<&str>), value: Option<&str>, source: &'static str) -> (Option<String>, Option<String>) {
        let pool = series_table().await;
        sqlx::query(r#"INSERT INTO "Series" (id, "bookType", "bookTypeSource") VALUES ('s', $1, $2)"#)
            .bind(stored.0).bind(stored.1).execute(&pool).await.unwrap();
        sqlx::query(&format!(r#"UPDATE "Series" SET {} WHERE id = $3"#, set_clauses(cond, 1, 2)))
            .bind(value).bind(source_for(value, source)).bind("s").execute(&pool).await.unwrap();
        let row: (Option<String>, Option<String>) = sqlx::query_as(r#"SELECT "bookType", "bookTypeSource" FROM "Series" WHERE id = 's'"#)
            .fetch_one(&pool).await.unwrap();
        row
    }

    fn own(v: (&str, &str)) -> (Option<String>, Option<String>) {
        (Some(v.0.to_string()), Some(v.1.to_string()))
    }

    #[tokio::test]
    async fn evidence_fills_a_blank_and_replaces_a_print_nobody_chose() {
        assert_eq!(apply(EVIDENCE_MAY_REPLACE, (None, None), Some("TPB"), "FILE").await, own(("TPB", "FILE")));
        assert_eq!(apply(EVIDENCE_MAY_REPLACE, (Some(""), None), Some("GN"), "METRON").await, own(("GN", "METRON")));
        for weak in [None, Some("GUESS"), Some("SERIES_JSON")] {
            assert_eq!(apply(EVIDENCE_MAY_REPLACE, (Some("Print"), weak), Some("TPB"), "FILE").await, own(("TPB", "FILE")), "{weak:?}");
        }
    }

    #[tokio::test]
    async fn evidence_never_replaces_the_admins_choice_or_any_other_type() {
        assert_eq!(apply(EVIDENCE_MAY_REPLACE, (Some("Print"), Some("ADMIN")), Some("TPB"), "FILE").await, own(("Print", "ADMIN")));
        assert_eq!(apply(EVIDENCE_MAY_REPLACE, (Some("Print"), Some("METRON")), Some("TPB"), "FILE").await, own(("Print", "METRON")));
        assert_eq!(apply(EVIDENCE_MAY_REPLACE, (Some("OneShot"), None), Some("TPB"), "METRON").await, (Some("OneShot".into()), None));
    }

    #[tokio::test]
    async fn no_value_changes_nothing() {
        assert_eq!(apply(EVIDENCE_MAY_REPLACE, (Some("Print"), None), None, "FILE").await, (Some("Print".into()), None));
        assert_eq!(apply(BLANK, (None, None), None, "GUESS").await, (None, None));
    }

    #[tokio::test]
    async fn a_guess_or_a_series_json_value_only_fills_a_blank() {
        assert_eq!(apply(BLANK, (None, None), Some("OneShot"), "GUESS").await, own(("OneShot", "GUESS")));
        assert_eq!(apply(BLANK, (Some("Print"), None), Some("OneShot"), "GUESS").await, (Some("Print".into()), None));
        assert_eq!(apply(BLANK, (Some("Print"), Some("GUESS")), Some("TPB"), "SERIES_JSON").await, own(("Print", "GUESS")));
    }
}
