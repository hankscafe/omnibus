//! #203 Phase 1 — attached provider volumes (concept by anacronismo).
//!
//! A series' annuals live in DIFFERENT provider volumes than the series itself, and ComicVine
//! publishes no machine link between them (which is why Mylar makes the attachment manual too).
//! An `AttachedVolume` row is that link; this module is the sync lane that keeps its issues fresh.
//!
//! THE RULE THAT MAKES MANUAL NUMBERING SAFE: pairing inside an attached lane is **ID-anchored**,
//! never number-anchored. The parent-volume sync anchors on `number` (issue #194) because within one
//! volume the number IS the identity — but an attached lane's numbers are pure user curation.
//! Renumbering a 1996 one-off annual to "29" so it slots chronologically must not break its provider
//! link, so the lane finds its rows by `metadataId` inside `WHERE "attachedVolumeId" = <link>` and
//! NEVER rewrites `number` after the insert. The parent lane's exclusion of `isAnnual` rows (Phase 0)
//! is what keeps the two lanes from ever reaching for the same row.

use crate::db::Db;
use crate::metadata::{
    cv_issue_credits, is_cv_rate_limited, is_same_issue, json_num_string, merge_credit_json,
    metron_auth, metron_fetch, metron_issue_credits, metron_issue_name, next_match_state,
    parse_date_ms, prefer_existing, resolve_synced_name,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::time::Duration;

/// What a sync pass did — surfaced verbatim in the attach dialog's result line
/// ("Claimed N owned files · created M missing entries · K left unclaimed").
#[derive(Debug, Default, Serialize)]
pub struct AttachSummary {
    pub attachment_id: String,
    pub name: Option<String>,
    pub start_year: Option<i32>,
    /// Provider issues seen in this pass.
    pub total: i64,
    /// Local file-backed annual rows bound to this volume by the claim pass.
    pub claimed: i64,
    /// Skeleton rows created for provider issues nobody owns yet.
    pub created: i64,
    /// Rows already in the lane that this pass refreshed.
    pub updated: i64,
    /// File-backed annual rows on the series still bound to no attachment.
    pub unclaimed: i64,
}

#[derive(Debug, Deserialize)]
pub struct AttachSyncRequest {
    /// Sync one attachment (the attach-time import).
    pub attachment_id: Option<String>,
    /// Sync every attachment on a series (rides along with the series refresh).
    pub series_id: Option<String>,
    /// Bind unclaimed file-backed annual rows by number. Default true — the claim is what turns a
    /// scan-born "Batman Annual 001.cbz" into a provider-linked issue.
    pub claim: Option<bool>,
}

/// One provider issue, normalized across ComicVine and Metron.
struct LaneIssue {
    source_id: String,
    number: String,
    name: Option<String>,
    description: Option<String>,
    cover_url: Option<String>,
    release_date: Option<String>,
    credits: crate::metadata::CvIssueCredits,
}

/// Volume-level facts worth caching on the attachment row for the UI.
#[derive(Default)]
struct LaneVolume {
    name: Option<String>,
    start_year: Option<i32>,
    /// The provider's own text — for a one-book collected volume it may state "Collects #1-6"
    /// (coverage prefill, #203 COLLECTED).
    description: Option<String>,
}

pub async fn sync_request(db: &Db, payload: AttachSyncRequest) -> anyhow::Result<Vec<AttachSummary>> {
    let claim = payload.claim.unwrap_or(true);
    let client = Client::new();

    let ids: Vec<String> = if let Some(id) = payload.attachment_id {
        vec![id]
    } else if let Some(series_id) = payload.series_id {
        sqlx::query_scalar::<_, String>(r#"SELECT id FROM "AttachedVolume" WHERE "seriesId" = $1 ORDER BY "createdAt" ASC"#)
            .bind(&series_id)
            .fetch_all(&db.pool)
            .await?
    } else {
        anyhow::bail!("attach sync needs an attachment_id or a series_id");
    };

    let mut out = Vec::new();
    for id in ids {
        match sync_attachment(db, &client, &id, claim).await {
            Ok(summary) => out.push(summary),
            Err(e) => {
                log::error!("[Attached] Sync failed for attachment {}: {:?}", id, e);
                return Err(e);
            }
        }
    }
    Ok(out)
}

/// Every attachment on a series, synced without the claim pass — the refresh case, where new local
/// files have already been claimed by their own attach and the point is provider freshness. Errors
/// are logged, never fatal: an attachment's provider being down must not fail the series' own sync.
pub async fn sync_series_attachments(db: &Db, client: &Client, series_id: &str) {
    let ids: Vec<String> = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "AttachedVolume" WHERE "seriesId" = $1 ORDER BY "createdAt" ASC"#,
    )
    .bind(series_id)
    .fetch_all(&db.pool)
    .await
    .unwrap_or_default();

    for id in ids {
        // claim = true: an annual file that landed in the folder since the attach binds itself on
        // the next refresh instead of waiting for a re-attach.
        if let Err(e) = sync_attachment(db, client, &id, true).await {
            log::warn!("[Attached] Refresh failed for attachment {} on series {}: {:?}", id, series_id, e);
        }
    }
}

async fn sync_attachment(db: &Db, client: &Client, attachment_id: &str, claim: bool) -> anyhow::Result<AttachSummary> {
    let row = match sqlx::query(
        r#"SELECT id, "seriesId", "metadataSource", "volumeId", kind FROM "AttachedVolume" WHERE id = $1"#,
    )
    .bind(attachment_id)
    .fetch_optional(&db.pool)
    .await?
    {
        Some(r) => r,
        None => anyhow::bail!("attachment {} not found", attachment_id),
    };

    let series_id: String = row.get("seriesId");
    let source: String = row.try_get("metadataSource").unwrap_or_else(|_| "COMICVINE".to_string());
    let volume_id: String = row.get("volumeId");
    let kind: String = row.try_get("kind").unwrap_or_else(|_| "ANNUAL".to_string());
    // #203 LOCAL: no provider volume to fetch — the pass is the name claim plus series.json coverage.
    if source == "LOCAL" {
        return sync_local_attachment(db, attachment_id, &series_id, &kind).await;
    }
    // #203 COLLECTED: the lane serves both kinds now, so isAnnual follows the ATTACHMENT's kind —
    // a trade is not an annual, and flagging it as one would put it in the annual numbering domain,
    // label it "Annual #N" in every view, and sort it among comics it merely reprints. Written as a
    // SQL literal, not a bind: the Any driver has no portable boolean bind (the 5H lesson).
    let annual_lit = if kind == "ANNUAL" { "true" } else { "false" };

    // file_metadata_priority (discussion #177) applies to an attached lane exactly as it does to the
    // parent volume: a provider sync only fills blanks that the files didn't already answer.
    let file_priority: bool = sqlx::query_scalar::<_, String>(
        r#"SELECT value FROM "SystemSetting" WHERE key = 'file_metadata_priority'"#,
    )
    .fetch_optional(&db.pool)
    .await
    .ok()
    .flatten()
    .as_deref()
        == Some("true");

    let (volume, issues) = match source.as_str() {
        "METRON" => fetch_metron_lane(db, client, &volume_id).await?,
        _ => fetch_comicvine_lane(db, client, &volume_id).await?,
    };

    let mut summary = AttachSummary {
        attachment_id: attachment_id.to_string(),
        name: volume.name.clone(),
        start_year: volume.start_year,
        total: issues.len() as i64,
        ..Default::default()
    };

    // The name-anchoring rule needs the parent's name and every attachment's name on this series.
    // THIS attachment takes the provider's fresh name (its DB name is still empty on the very first
    // sync); the others keep what earlier syncs stored.
    let (series_name, series_folder): (String, String) = sqlx::query(r#"SELECT name, "folderPath" FROM "Series" WHERE id = $1"#)
        .bind(&series_id)
        .fetch_optional(&db.pool)
        .await?
        .map(|r| (r.try_get("name").unwrap_or_default(), r.try_get("folderPath").unwrap_or_default()))
        .unwrap_or_default();

    // #203 COLLECTED coverage: what series.json remembered per book of THIS volume (a restore
    // after a wipe recreates the book rows here, and their coverage must come back with no calls).
    let series_json_books: std::collections::HashMap<String, String> = if kind == "COLLECTED" && !series_folder.is_empty() {
        let folder = series_folder.clone();
        let (src, vid) = (source.clone(), volume_id.clone());
        tokio::task::spawn_blocking(move || crate::scanner::read_series_json(std::path::Path::new(&folder)))
            .await
            .ok()
            .flatten()
            .map(|sj| sj.attached_volumes.into_iter()
                .filter(|a| a.source == src && a.volume_id == vid)
                .flat_map(|a| a.books)
                .collect())
            .unwrap_or_default()
    } else {
        std::collections::HashMap::new()
    };
    let single_book_volume = issues.len() == 1;
    let name_refs: Vec<AttachmentNameRef> = sqlx::query(r#"SELECT id, name, kind FROM "AttachedVolume" WHERE "seriesId" = $1"#)
        .bind(&series_id)
        .fetch_all(&db.pool)
        .await?
        .iter()
        .map(|r| {
            let id: String = r.get("id");
            let stored: String = r.try_get::<Option<String>, _>("name").unwrap_or(None).unwrap_or_default();
            let name = if id == attachment_id { volume.name.clone().unwrap_or(stored) } else { stored };
            AttachmentNameRef { id, name, kind: r.try_get("kind").unwrap_or_else(|_| "ANNUAL".to_string()) }
        })
        .collect();

    for issue in &issues {
        // ---- ID-anchored: the row this provider issue already owns, wherever the user moved its
        //      number to. Nothing else in the lane is a candidate.
        let existing = sqlx::query(
            r#"SELECT id, number, name, description, "releaseDate", "coverUrl", "matchState",
                      CAST("hasCustomMetadata" AS INTEGER) AS "hasCustomMetadata",
                      CAST("hasCustomCover" AS INTEGER) AS "hasCustomCover",
                      writers, artists, "coverArtists", colorists, letterers, characters, teams, locations,
                      inker, editor, translator, "coversIssues"
               FROM "Issue" WHERE "attachedVolumeId" = $1 AND "metadataId" = $2"#,
        )
        .bind(attachment_id)
        .bind(&issue.source_id)
        .fetch_optional(&db.pool)
        .await?;

        // ---- Still ID-anchored, one step wider: an unbound annual row that already carries THIS
        //      provider issue's id — the shape a wipe→rescan leaves behind when the file's own
        //      ComicInfo named its issue but the link hadn't been rebuilt yet. Adopting by id keeps
        //      a renumbered one-off correct where a number match would not.
        // Claiming and id-adoption look for LOCAL annual rows; a collected lane has no equivalent
        // (nothing on disk is flagged "collected" until it belongs to an attachment), so those
        // passes only run for annual attachments.
        let adopted_row = if existing.is_none() && kind == "ANNUAL" {
            find_unbound_by_id(db, &series_id, &issue.source_id, &source).await?
        } else {
            None
        };

        // ---- The claim, most specific signal first. By NAME (either kind): a file-backed row
        //      nobody has bound yet whose filename names THIS volume and parses to this number —
        //      "The Amazing Spider-Man '96 #001" sitting as main-run #1. Then, annual lanes only,
        //      by NUMBER: an unbound annual row whose number matches. Silent by decision
        //      (2026-08-26) — the summary is the honesty, and detach / the editor's exact-id field
        //      are the undo.
        let claimed_row = if existing.is_none() && adopted_row.is_none() && claim {
            match find_claim_candidate_by_name(db, &series_id, &series_name, attachment_id, &name_refs, &issue.number).await? {
                Some(r) => {
                    log::info!("[Attached] Claimed a file by NAME for volume {} #{} on series {}.", volume_id, issue.number, series_id);
                    Some(r)
                }
                None if kind == "ANNUAL" => find_claim_candidate(db, &series_id, &issue.number).await?,
                None => None,
            }
        } else {
            None
        };

        let target = existing.as_ref().or(adopted_row.as_ref()).or(claimed_row.as_ref());
        // An id-adoption counts as a claim in the summary: from the user's side both are "a file I
        // already owned joined this volume".
        let was_claim = existing.is_none() && (adopted_row.is_some() || claimed_row.is_some());

        let locked = target
            .map(|r| r.try_get::<i64, _>("hasCustomMetadata").map(|v| v != 0).unwrap_or(false))
            .unwrap_or(false);
        let has_custom_cover = target
            .map(|r| r.try_get::<i64, _>("hasCustomCover").map(|v| v != 0).unwrap_or(false))
            .unwrap_or(false);
        let col = |name: &str| -> Option<String> {
            target.and_then(|r| r.try_get::<Option<String>, _>(name).unwrap_or(None))
        };

        let name_val = resolve_synced_name(col("name"), issue.name.clone(), &issue.number, locked, file_priority);
        let desc_val = prefer_existing(col("description"), issue.description.clone(), locked, file_priority);
        let release_val = if locked { col("releaseDate") } else { issue.release_date.clone() };
        let cover_val = if has_custom_cover { col("coverUrl") } else { issue.cover_url.clone() };
        let match_state_val = next_match_state(col("matchState"));
        let c = &issue.credits;
        let writers_val = merge_credit_json(col("writers"), &c.writers, locked, file_priority);
        let artists_val = merge_credit_json(col("artists"), &c.artists, locked, file_priority);
        let cover_artists_val = merge_credit_json(col("coverArtists"), &c.cover_artists, locked, file_priority);
        let colorists_val = merge_credit_json(col("colorists"), &c.colorists, locked, file_priority);
        let letterers_val = merge_credit_json(col("letterers"), &c.letterers, locked, file_priority);
        let characters_val = merge_credit_json(col("characters"), &c.characters, locked, file_priority);
        let teams_val = merge_credit_json(col("teams"), &c.teams, locked, file_priority);
        let locations_val = merge_credit_json(col("locations"), &c.locations, locked, file_priority);
        let inker_val = merge_credit_json(col("inker"), &c.inkers, locked, file_priority);
        let editor_val = merge_credit_json(col("editor"), &c.editors, locked, file_priority);
        let translator_val = merge_credit_json(col("translator"), &c.translators, locked, file_priority);

        // #203 COLLECTED coverage prefill — fill-blank ONLY, from series.json (a restore), else the
        // book's own "Collects #1-6", else a one-book volume's text. A value already there is the
        // user's and is never touched; annual lanes never carry coverage.
        let covers_fill: Option<String> = crate::coverage::coverage_fill_for(
            &kind,
            target.and_then(|r| r.try_get::<Option<String>, _>("coversIssues").unwrap_or(None)).as_deref(),
            series_json_books.get(&issue.source_id).map(|s| s.as_str()),
            issue.description.as_deref(),
            volume.description.as_deref(),
            single_book_volume,
        );

        let res = if let Some(t) = target {
            let row_id: String = t.get("id");
            // `number` is ABSENT from this UPDATE on purpose: inside an attached lane the number is
            // the user's curation, and the id is the anchor. A claim additionally stamps the link.
            // coversIssues is fill-blank: COALESCE over the existing value (blank = empty).
            sqlx::query(&format!(
                r#"UPDATE "Issue" SET "attachedVolumeId"=$1, "metadataId"=$2, "metadataSource"=$3, "isAnnual"={annual},
                   name=$4, description=$5, "releaseDate"=$6, "coverUrl"=$7, "matchState"=$8,
                   writers=$9, artists=$10, "coverArtists"=$11, colorists=$12, letterers=$13,
                   characters=$14, teams=$15, locations=$16, inker=$17, editor=$18, translator=$19,
                   "coversIssues"=COALESCE(NULLIF("coversIssues", ''), $20)
                   WHERE id=$21"#,
                annual = annual_lit
            ))
            .bind(attachment_id)
            .bind(&issue.source_id)
            .bind(&source)
            .bind(&name_val)
            .bind(&desc_val)
            .bind(&release_val)
            .bind(&cover_val)
            .bind(match_state_val)
            .bind(&writers_val)
            .bind(&artists_val)
            .bind(&cover_artists_val)
            .bind(&colorists_val)
            .bind(&letterers_val)
            .bind(&characters_val)
            .bind(&teams_val)
            .bind(&locations_val)
            .bind(&inker_val)
            .bind(&editor_val)
            .bind(&translator_val)
            .bind(&covers_fill)
            .bind(&row_id)
            .execute(&db.pool)
            .await
        } else {
            // A skeleton for an annual nobody owns: WANTED + a real provider id, which is all the
            // existing missing-issue Request button needs (and P0's composite already asks the
            // downloader for "<Series> Annual #N", flipping its annual guard the right way).
            let new_id = uuid::Uuid::new_v4().to_string();
            sqlx::query(&format!(
                r#"INSERT INTO "Issue"
                   (id, "seriesId", "attachedVolumeId", "metadataId", "metadataSource", number, "isAnnual", status,
                    name, description, "releaseDate", "coverUrl", "matchState",
                    writers, artists, "coverArtists", colorists, letterers, characters, teams, locations,
                    inker, editor, translator, "coversIssues", "createdAt", "updatedAt")
                   VALUES ($1,$2,$3,$4,$5,$6,{annual},'WANTED',$7,$8,$9,$10,'MATCHED',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,{now},{now})"#,
                annual = annual_lit,
                now = db.now_expr()
            ))
            .bind(&new_id)
            .bind(&series_id)
            .bind(attachment_id)
            .bind(&issue.source_id)
            .bind(&source)
            .bind(&issue.number)
            .bind(&name_val)
            .bind(&desc_val)
            .bind(&release_val)
            .bind(&cover_val)
            .bind(&writers_val)
            .bind(&artists_val)
            .bind(&cover_artists_val)
            .bind(&colorists_val)
            .bind(&letterers_val)
            .bind(&characters_val)
            .bind(&teams_val)
            .bind(&locations_val)
            .bind(&inker_val)
            .bind(&editor_val)
            .bind(&translator_val)
            .bind(&covers_fill)
            .execute(&db.pool)
            .await
        };

        match res {
            Ok(_) => {
                if was_claim {
                    summary.claimed += 1;
                } else if target.is_some() {
                    summary.updated += 1;
                } else {
                    summary.created += 1;
                }
            }
            Err(e) => log::error!(
                "[Attached] Failed to upsert annual #{} ({}) on attachment {}: {:?}",
                issue.number, issue.source_id, attachment_id, e
            ),
        }
    }

    // Everything the pass could not account for: annual FILES on this series still bound to no
    // attachment. The number is the honest report, not an error — one-offs from a volume the user
    // hasn't attached yet live here, and so does anything they renumbered past recognition.
    summary.unclaimed = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM "Issue" WHERE "seriesId" = $1 AND "isAnnual" = true AND "attachedVolumeId" IS NULL AND "filePath" IS NOT NULL"#,
    )
    .bind(&series_id)
    .fetch_one(&db.pool)
    .await
    .unwrap_or(0);

    let lane_count = sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM "Issue" WHERE "attachedVolumeId" = $1"#)
        .bind(attachment_id)
        .fetch_one(&db.pool)
        .await
        .unwrap_or(0);

    let _ = sqlx::query(&format!(
        r#"UPDATE "AttachedVolume" SET name=COALESCE($1, name), "startYear"=COALESCE($2, "startYear"),
           "issueCount"=$3, "lastSyncedAt"={now_utc}, "updatedAt"={now} WHERE id=$4"#,
        now_utc = db.now_utc_ts_expr(),
        now = db.now_expr()
    ))
    .bind(&volume.name)
    .bind(volume.start_year)
    .bind(lane_count)
    .bind(attachment_id)
    .execute(&db.pool)
    .await;

    log::info!(
        "[Attached] {} volume {} on series {}: claimed {}, created {}, refreshed {}, {} local annual file(s) still unattached.",
        source, volume_id, series_id, summary.claimed, summary.created, summary.updated, summary.unclaimed
    );

    Ok(summary)
}

/// An annual row bound to no attachment that already carries this provider issue's id — the file
/// told us (its ComicInfo carries the issue id), so the link can be rebuilt with zero guessing.
async fn find_unbound_by_id(
    db: &Db,
    series_id: &str,
    source_id: &str,
    source: &str,
) -> anyhow::Result<Option<sqlx::any::AnyRow>> {
    Ok(sqlx::query(
        r#"SELECT id, number, name, description, "releaseDate", "coverUrl", "matchState",
                  CAST("hasCustomMetadata" AS INTEGER) AS "hasCustomMetadata",
                  CAST("hasCustomCover" AS INTEGER) AS "hasCustomCover",
                  writers, artists, "coverArtists", colorists, letterers, characters, teams, locations,
                  inker, editor, translator, "coversIssues"
           FROM "Issue"
           WHERE "seriesId" = $1 AND "isAnnual" = true AND "attachedVolumeId" IS NULL
             AND "metadataId" = $2 AND "metadataSource" = $3"#,
    )
    .bind(series_id)
    .bind(source_id)
    .bind(source)
    .fetch_optional(&db.pool)
    .await?)
}

/// A local annual row that owns a FILE, belongs to no attachment yet, and whose number matches.
/// Never re-claims (the `attachedVolumeId IS NULL` filter is the whole guard) and never touches a
/// main-run row (`isAnnual = true`).
async fn find_claim_candidate(db: &Db, series_id: &str, number: &str) -> anyhow::Result<Option<sqlx::any::AnyRow>> {
    let rows = sqlx::query(
        r#"SELECT id, number, name, description, "releaseDate", "coverUrl", "matchState",
                  CAST("hasCustomMetadata" AS INTEGER) AS "hasCustomMetadata",
                  CAST("hasCustomCover" AS INTEGER) AS "hasCustomCover",
                  writers, artists, "coverArtists", colorists, letterers, characters, teams, locations,
                  inker, editor, translator, "coversIssues"
           FROM "Issue"
           WHERE "seriesId" = $1 AND "isAnnual" = true AND "attachedVolumeId" IS NULL AND "filePath" IS NOT NULL"#,
    )
    .bind(series_id)
    .fetch_all(&db.pool)
    .await?;

    Ok(rows.into_iter().find(|r| {
        let n: String = r.try_get("number").unwrap_or_default();
        is_same_issue(&n, number)
    }))
}

/// #203 LOCAL (field report by robotshavehearts2): a collected edition — or an annual run — the
/// provider has no volume for. There is nothing to fetch: its books are this series' file-backed
/// rows whose FILENAMES carry the attachment's name (the beta.018 rule), bound here — the Node
/// reconciler binds brand-new files the same way — and their coverage comes back from series.json
/// by number after a wipe (the writer records a local edition's books as "local:<number>").
async fn sync_local_attachment(db: &Db, attachment_id: &str, series_id: &str, kind: &str) -> anyhow::Result<AttachSummary> {
    let (series_name, series_folder, att_name, att_volume_id): (String, String, Option<String>, String) = sqlx::query(
        r#"SELECT s.name AS sname, s."folderPath" AS sfolder, a.name AS aname, a."volumeId" AS avol
           FROM "AttachedVolume" a JOIN "Series" s ON s.id = a."seriesId" WHERE a.id = $1"#,
    )
    .bind(attachment_id)
    .fetch_optional(&db.pool)
    .await?
    .map(|r| (
        r.try_get::<String, _>("sname").unwrap_or_default(),
        r.try_get::<Option<String>, _>("sfolder").unwrap_or(None).unwrap_or_default(),
        r.try_get::<Option<String>, _>("aname").unwrap_or(None),
        r.try_get::<String, _>("avol").unwrap_or_default(),
    ))
    .unwrap_or_default();
    let annual_lit = if kind == "ANNUAL" { "true" } else { "false" };

    let name_refs: Vec<AttachmentNameRef> = sqlx::query(r#"SELECT id, name, kind FROM "AttachedVolume" WHERE "seriesId" = $1"#)
        .bind(series_id)
        .fetch_all(&db.pool)
        .await?
        .into_iter()
        .map(|r| AttachmentNameRef {
            id: r.get("id"),
            name: r.try_get::<Option<String>, _>("name").unwrap_or(None).unwrap_or_default(),
            kind: r.try_get("kind").unwrap_or_else(|_| "ANNUAL".to_string()),
        })
        .collect();

    // series.json's memory of this edition's books, by number ("local:<n>" → covers).
    let sj_books: std::collections::HashMap<String, String> = if kind == "COLLECTED" && !series_folder.is_empty() {
        let folder = series_folder.clone();
        let vol = att_volume_id.clone();
        tokio::task::spawn_blocking(move || crate::scanner::read_series_json(std::path::Path::new(&folder)))
            .await
            .ok()
            .flatten()
            .map(|sj| sj.attached_volumes.into_iter()
                .filter(|a| a.source == "LOCAL" && a.volume_id == vol)
                .flat_map(|a| a.books)
                .collect())
            .unwrap_or_default()
    } else {
        std::collections::HashMap::new()
    };
    let sj_covers = |number: &str| sj_books.get(&format!("local:{}", number)).map(|s| s.as_str());

    let mut summary = AttachSummary { attachment_id: attachment_id.to_string(), name: att_name.clone(), ..Default::default() };

    // 1. The claim: unbound file-backed rows whose filename names this edition. The row keeps its
    //    number as parsed under the edition's name, takes a lane-and-number identity that survives
    //    a wipe, a "Vol. N" title unless it already has a real one, and any remembered coverage.
    let candidates = sqlx::query(
        r#"SELECT id, "filePath", "coversIssues" FROM "Issue"
           WHERE "seriesId" = $1 AND "attachedVolumeId" IS NULL AND "filePath" IS NOT NULL AND "filePath" <> ''"#,
    )
    .bind(series_id)
    .fetch_all(&db.pool)
    .await?;
    for r in &candidates {
        let file: String = r.get("filePath");
        let base = std::path::Path::new(&file).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let Some(m) = attachment_for_filename(&base, &series_name, &name_refs) else { continue };
        if m.id != attachment_id { continue; }
        let row_id: String = r.get("id");
        let existing_covers: Option<String> = r.try_get("coversIssues").unwrap_or(None);
        let covers_fill = crate::coverage::coverage_fill_for(kind, existing_covers.as_deref(), sj_covers(&m.number), None, None, false);
        let local_id = format!("local_{}_{}", attachment_id, m.number);
        let vol_name = format!("Vol. {}", m.number);
        sqlx::query(&format!(
            r#"UPDATE "Issue" SET "attachedVolumeId"=$1, "isAnnual"={annual}, "matchState"='MATCHED', "metadataId"=$2, "metadataSource"='LOCAL',
               number=$3, name=CASE WHEN name IS NULL OR name = '' OR name LIKE 'Issue %' THEN $4 ELSE name END,
               "coversIssues"=COALESCE(NULLIF("coversIssues", ''), $5) WHERE id=$6"#,
            annual = annual_lit
        ))
        .bind(attachment_id)
        .bind(&local_id)
        .bind(&m.number)
        .bind(&vol_name)
        .bind(&covers_fill)
        .bind(&row_id)
        .execute(&db.pool)
        .await?;
        summary.claimed += 1;
    }

    // 2. Books already in the lane: coverage restored fill-blank from series.json.
    let bound = sqlx::query(r#"SELECT id, number, "coversIssues" FROM "Issue" WHERE "attachedVolumeId" = $1"#)
        .bind(attachment_id)
        .fetch_all(&db.pool)
        .await?;
    for r in &bound {
        let number: String = r.get("number");
        let existing: Option<String> = r.try_get("coversIssues").unwrap_or(None);
        if let Some(fill) = crate::coverage::coverage_fill_for(kind, existing.as_deref(), sj_covers(&number), None, None, false) {
            let id: String = r.get("id");
            sqlx::query(r#"UPDATE "Issue" SET "coversIssues"=$1 WHERE id=$2"#).bind(&fill).bind(&id).execute(&db.pool).await?;
            summary.updated += 1;
        }
    }
    summary.total = bound.len() as i64;

    let _ = sqlx::query(&format!(
        r#"UPDATE "AttachedVolume" SET "issueCount"=$1, "lastSyncedAt"={now_utc}, "updatedAt"={now} WHERE id=$2"#,
        now_utc = db.now_utc_ts_expr(),
        now = db.now_expr()
    ))
    .bind(summary.total)
    .bind(attachment_id)
    .execute(&db.pool)
    .await;

    log::info!(
        "[Attached] LOCAL \"{}\" on series {}: claimed {} file(s) by name, {} coverage value(s) restored, {} book(s) in the lane.",
        att_name.clone().unwrap_or_else(|| attachment_id.to_string()), series_id, summary.claimed, summary.updated, summary.total
    );
    Ok(summary)
}

/// One attached volume as the name-anchoring rule sees it.
#[derive(Debug, Clone)]
pub(crate) struct AttachmentNameRef {
    pub id: String,
    pub name: String,
    pub kind: String,
}

/// Which attachment a filename belongs to by NAME, and the number it parses to under that name.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AttachmentFileMatch {
    pub id: String,
    pub kind: String,
    pub number: String,
}

/// #203 name-anchored attachment (anacronismo, 2026-09-09): "The Amazing Spider-Man '96 #001
/// (1996).cbz" carries no "Annual" token, so it parses as main-run #1 and collides with the 1963 #1
/// while the attached one-off it belongs to shows "0 of 1 owned". The filename is the only signal,
/// and a good one: a file whose name STARTS WITH an attached volume's own name belongs to it.
///   - token-prefix match with the scanner's series-prefix rules (case, separators, glue guard);
///   - an attachment whose name is itself a token-prefix of the SERIES name (equal included) can
///     never match, or every main-run file would;
///   - among several matches the most specific name wins (most tokens, then longest);
///   - the number is parsed with the attachment's name as the series hint.
///
/// Exact twin of attachmentForFilename (src/lib/utils/attachment-name.ts) — keep them identical.
pub(crate) fn attachment_for_filename(file_name: &str, series_name: &str, attachments: &[AttachmentNameRef]) -> Option<AttachmentFileMatch> {
    let token_count = |s: &str| s.split(|c: char| !c.is_ascii_alphanumeric()).filter(|t| !t.is_empty()).count();
    let mut best: Option<(&AttachmentNameRef, usize, usize)> = None;
    for a in attachments {
        let name = a.name.trim();
        if name.is_empty() {
            continue;
        }
        // The parent's own name — or a shorter prefix of it — names the parent's files, not a lane's.
        if crate::scanner::strip_series_prefix(series_name, name).is_some() {
            continue;
        }
        if crate::scanner::strip_series_prefix(file_name, name).is_none() {
            continue;
        }
        let (tokens, len) = (token_count(name), name.len());
        if best.is_none_or(|(_, t, l)| tokens > t || (tokens == t && len > l)) {
            best = Some((a, tokens, len));
        }
    }
    let (a, _, _) = best?;
    let (number, _) = crate::scanner::issue_descriptor_from_filename(file_name, Some(a.name.trim()));
    Some(AttachmentFileMatch { id: a.id.clone(), kind: a.kind.clone(), number })
}

/// The name-anchored claim: a file-backed row bound to no attachment — main run OR annual — whose
/// FILENAME names this attached volume and parses to `number` under it. Runs before the
/// number-anchored annual claim, because a name is the more specific signal.
async fn find_claim_candidate_by_name(
    db: &Db,
    series_id: &str,
    series_name: &str,
    attachment_id: &str,
    attachments: &[AttachmentNameRef],
    number: &str,
) -> anyhow::Result<Option<sqlx::any::AnyRow>> {
    let rows = sqlx::query(
        r#"SELECT id, number, name, description, "releaseDate", "coverUrl", "matchState",
                  CAST("hasCustomMetadata" AS INTEGER) AS "hasCustomMetadata",
                  CAST("hasCustomCover" AS INTEGER) AS "hasCustomCover",
                  writers, artists, "coverArtists", colorists, letterers, characters, teams, locations,
                  inker, editor, translator, "filePath", "coversIssues"
           FROM "Issue"
           WHERE "seriesId" = $1 AND "attachedVolumeId" IS NULL AND "filePath" IS NOT NULL AND "filePath" <> ''"#,
    )
    .bind(series_id)
    .fetch_all(&db.pool)
    .await?;

    Ok(rows.into_iter().find(|r| {
        let file: String = r.try_get("filePath").unwrap_or_default();
        let base = std::path::Path::new(&file)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        matches!(
            attachment_for_filename(&base, series_name, attachments),
            Some(m) if m.id == attachment_id && is_same_issue(&m.number, number)
        )
    }))
}

/// ComicVine: the volume's own facts plus every issue in it (the same paginated list the parent
/// lane walks — credits ride along in the list call at no extra API cost, issue #179).
async fn fetch_comicvine_lane(db: &Db, client: &Client, volume_id: &str) -> anyhow::Result<(LaneVolume, Vec<LaneIssue>)> {
    let api_key: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'cv_api_key'"#)
        .fetch_optional(&db.pool)
        .await?;
    let api_key = crate::secret_crypto::decrypt_setting(&db.pool, api_key).await;
    let api_key = match api_key.filter(|k| !k.is_empty()) {
        Some(k) => k,
        None => anyhow::bail!("ComicVine API key is not configured"),
    };

    let mut volume = LaneVolume::default();
    let vol_url = format!("https://comicvine.gamespot.com/api/volume/4050-{}/", volume_id);
    let vol_req = client
        .get(&vol_url)
        .query(&[("api_key", api_key.as_str()), ("format", "json"), ("field_list", "name,start_year,count_of_issues,description,deck")])
        .header("User-Agent", "Omnibus/1.0")
        .timeout(Duration::from_secs(15))
        .build()?;
    let vol_full_url = vol_req.url().to_string();
    let vol_json: serde_json::Value = match crate::metadata_cache::get(db, "comicvine", &vol_full_url).await {
        Some(hit) => hit,
        None => {
            let resp = client.execute(vol_req).await?;
            crate::api_usage::log(&db.pool, "comicvine", &vol_url).await;
            if is_cv_rate_limited(resp.status()) {
                anyhow::bail!("ComicVine rate limited (429/420) on the attached volume fetch");
            }
            let j: serde_json::Value = resp.json().await?;
            crate::metadata_cache::put(db, "comicvine", &vol_full_url, &j).await;
            j
        }
    };
    volume.name = vol_json["results"]["name"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string());
    volume.start_year = vol_json["results"]["start_year"].as_str().and_then(|s| s.trim().parse::<i32>().ok())
        .or_else(|| vol_json["results"]["start_year"].as_i64().map(|v| v as i32));
    volume.description = vol_json["results"]["description"].as_str()
        .or_else(|| vol_json["results"]["deck"].as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let mut issues = Vec::new();
    let mut offset = 0i32;
    let mut total = 1i32;
    let mut loops = 0;
    // Same 2000-issue ceiling as the parent lane — an annual volume never approaches it, but a
    // mis-typed volume id shouldn't be able to page forever either.
    while offset < total && loops < 20 {
        let offset_str = offset.to_string();
        let req = client
            .get("https://comicvine.gamespot.com/api/issues/")
            .query(&[
                ("api_key", api_key.as_str()),
                ("format", "json"),
                ("filter", &format!("volume:{}", volume_id)),
                ("sort", "issue_number:asc"),
                ("limit", "100"),
                ("offset", offset_str.as_str()),
                ("field_list", "id,name,issue_number,store_date,cover_date,image,deck,description,person_credits,character_credits,team_credits,location_credits"),
            ])
            .header("User-Agent", "Omnibus/1.0")
            .timeout(Duration::from_secs(15))
            .build()?;
        let full_url = req.url().to_string();
        let json: serde_json::Value = match crate::metadata_cache::get(db, "comicvine", &full_url).await {
            Some(hit) => hit,
            None => {
                let resp = client.execute(req).await?;
                crate::api_usage::log(&db.pool, "comicvine", "https://comicvine.gamespot.com/api/issues/").await;
                if is_cv_rate_limited(resp.status()) {
                    anyhow::bail!("ComicVine rate limited (429/420) on the attached issues fetch");
                }
                let j: serde_json::Value = resp.json().await?;
                crate::metadata_cache::put(db, "comicvine", &full_url, &j).await;
                j
            }
        };
        if offset == 0 {
            total = json["number_of_total_results"].as_i64().unwrap_or(0) as i32;
        }
        for item in json["results"].as_array().cloned().unwrap_or_default() {
            let source_id = match item["id"].as_i64() {
                Some(id) => id.to_string(),
                None => continue,
            };
            issues.push(LaneIssue {
                source_id,
                number: json_num_string(&item["issue_number"]).unwrap_or_else(|| "0".to_string()),
                name: item["name"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string()),
                description: item["description"].as_str().or_else(|| item["deck"].as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string()),
                cover_url: item["image"]["medium_url"].as_str().or_else(|| item["image"]["small_url"].as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string()),
                release_date: item["store_date"].as_str().filter(|s| !s.is_empty())
                    .or_else(|| item["cover_date"].as_str().filter(|s| !s.is_empty()))
                    .filter(|s| parse_date_ms(s).is_some())
                    .map(|s| s.to_string()),
                credits: cv_issue_credits(&item),
            });
        }
        offset += 100;
        loops += 1;
        tokio::time::sleep(Duration::from_secs(3)).await;
    }

    Ok((volume, issues))
}

/// Metron: the attached series' detail + its full issue_list walk. Metron DOES model associated
/// series, but Phase 1 stays manual on both providers — one attach flow, one mental model.
async fn fetch_metron_lane(db: &Db, client: &Client, volume_id: &str) -> anyhow::Result<(LaneVolume, Vec<LaneIssue>)> {
    let auth = match metron_auth(&db.pool).await {
        Some(a) => a,
        None => anyhow::bail!("Metron credentials are not configured"),
    };

    let detail_url = format!("https://metron.cloud/api/series/{}/", volume_id);
    let (status, data) = metron_fetch(db, client, &auth, &detail_url, 10, 3, None).await?;
    if status == 404 {
        anyhow::bail!("Metron series {} not found", volume_id);
    }
    let volume = LaneVolume {
        name: data["series"].as_str().or_else(|| data["name"].as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string()),
        start_year: data["year_began"].as_i64().map(|y| y as i32).filter(|y| *y != 0),
        description: data["desc"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string()),
    };

    let mut raw: Vec<serde_json::Value> = Vec::new();
    let mut next_url = Some(format!("https://metron.cloud/api/series/{}/issue_list/", volume_id));
    while let Some(url) = next_url {
        let (_, page) = metron_fetch(db, client, &auth, &url, 15, 3, None).await?;
        if let Some(arr) = page["results"].as_array() {
            raw.extend(arr.clone());
        }
        next_url = page["next"].as_str().map(|s| s.to_string());
    }

    let issues = raw
        .into_iter()
        .filter_map(|item| {
            let source_id = item["id"].as_i64()?.to_string();
            let number = json_num_string(&item["number"]).unwrap_or_else(|| "0".to_string());
            Some(LaneIssue {
                name: Some(metron_issue_name(&item, &number)).filter(|s| !s.is_empty()),
                description: item["desc"].as_str().or_else(|| item["description"].as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string()),
                cover_url: item["image"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string()),
                release_date: item["store_date"].as_str().filter(|s| !s.is_empty())
                    .or_else(|| item["cover_date"].as_str().filter(|s| !s.is_empty()))
                    .filter(|s| parse_date_ms(s).is_some())
                    .map(|s| s.to_string()),
                credits: metron_issue_credits(&item),
                source_id,
                number,
            })
        })
        .collect();

    Ok((volume, issues))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file-backed fixture DB with the two tables the lane touches. (SQLite in a temp file: the
    /// Any driver's shared in-memory handling differs per connection, so every fixture here uses a
    /// real file — the same shape the scanner/writer tests use.)
    async fn fixture(tag: &str) -> Db {
        let base = std::env::temp_dir().join(format!("omnibus_av_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("create fixture dir");
        let db_file = base.join("av.db");
        std::fs::File::create(&db_file).expect("pre-create sqlite file");
        let db_url = format!("file:{}", db_file.to_string_lossy().replace('\\', "/"));
        let db = Db::connect(&db_url, 2).await.expect("connect file-backed sqlite");
        for ddl in [
            r#"CREATE TABLE "Issue" (id TEXT PRIMARY KEY, "seriesId" TEXT, number TEXT, "isAnnual" INTEGER DEFAULT 0,
                "attachedVolumeId" TEXT, "metadataId" TEXT, "metadataSource" TEXT, "filePath" TEXT, status TEXT,
                name TEXT, description TEXT, "releaseDate" TEXT, "coverUrl" TEXT, "matchState" TEXT,
                "hasCustomMetadata" INTEGER DEFAULT 0, "hasCustomCover" INTEGER DEFAULT 0,
                writers TEXT, artists TEXT, "coverArtists" TEXT, colorists TEXT, letterers TEXT,
                characters TEXT, teams TEXT, locations TEXT, inker TEXT, editor TEXT, translator TEXT)"#,
            r#"CREATE TABLE "AttachedVolume" (id TEXT PRIMARY KEY, "seriesId" TEXT, "metadataSource" TEXT,
                "volumeId" TEXT, kind TEXT, name TEXT, "startYear" INTEGER, "issueCount" INTEGER DEFAULT 0,
                "lastSyncedAt" TEXT, "createdAt" TEXT, "updatedAt" TEXT)"#,
        ] {
            sqlx::query(ddl).execute(&db.pool).await.expect("create schema");
        }
        db
    }

    // ==== #203 name-anchored attachment. The rule's cases are the EXACT twin of
    // __tests__/lib/utils/attachment-name.test.ts — keep both in step. ====

    fn aref(id: &str, name: &str, kind: &str) -> AttachmentNameRef {
        AttachmentNameRef { id: id.into(), name: name.into(), kind: kind.into() }
    }
    const ASM: &str = "The Amazing Spider-Man";

    #[test]
    fn name_rule_claims_the_96_one_off_and_parses_its_number_under_that_name() {
        let refs = [aref("attAnn", "The Amazing Spider-Man Annual", "ANNUAL"), aref("att96", "The Amazing Spider-Man '96", "ANNUAL")];
        assert_eq!(
            attachment_for_filename("The Amazing Spider-Man '96 #001 (1996).cbz", ASM, &refs),
            Some(AttachmentFileMatch { id: "att96".into(), kind: "ANNUAL".into(), number: "1".into() })
        );
        // The filename that IS just the volume name is that volume's one-shot.
        assert_eq!(attachment_for_filename("The Amazing Spider-Man '96 (1996).cbz", ASM, &refs[1..]).map(|m| m.number), Some("1".into()));
        // Case and separators are the scanner's rules, not the user's typing.
        assert_eq!(attachment_for_filename("the amazing spider-man '96 - 001.cbz", ASM, &refs[1..]).map(|m| m.number), Some("1".into()));
    }

    #[test]
    fn name_rule_never_hands_the_parents_own_files_to_a_lane() {
        let refs = [aref("att96", "The Amazing Spider-Man '96", "ANNUAL"), aref("attAnn", "The Amazing Spider-Man Annual", "ANNUAL"), aref("attTpb", "The Amazing Spider-Man: Coming Home", "COLLECTED")];
        assert!(attachment_for_filename("The Amazing Spider-Man #001 (1963).cbz", ASM, &refs).is_none());
        // An attachment named exactly like the series (or a prefix of it) can never match.
        assert!(attachment_for_filename("The Amazing Spider-Man #001 (1963).cbz", ASM, &[aref("same", "The Amazing Spider-Man", "COLLECTED")]).is_none());
        assert!(attachment_for_filename("Amazing Spider-Man #001 (1963).cbz", "Amazing Spider-Man Annual", &[aref("short", "Amazing Spider-Man", "COLLECTED")]).is_none());
    }

    #[test]
    fn name_rule_respects_the_glue_guard_and_token_boundaries() {
        // "'96" is a token; "1996" is a different token → not the '96 volume.
        assert!(attachment_for_filename("The Amazing Spider-Man 1996 #001 (1996).cbz", ASM, &[aref("att96", "The Amazing Spider-Man '96", "ANNUAL")]).is_none());
        // "Annuals" is not "Annual" (glue guard).
        assert!(attachment_for_filename("The Amazing Spider-Man Annuals #001.cbz", ASM, &[aref("attAnn", "The Amazing Spider-Man Annual", "ANNUAL")]).is_none());
    }

    #[test]
    fn name_rule_prefers_the_most_specific_name_and_carries_the_kind() {
        let annual = aref("a", "X-Men Annual", "ANNUAL");
        let annual95 = aref("a95", "X-Men Annual '95", "ANNUAL");
        assert_eq!(attachment_for_filename("X-Men Annual '95 #001 (1995).cbz", "X-Men", &[annual.clone(), annual95.clone()]).map(|m| m.id), Some("a95".into()));
        assert_eq!(attachment_for_filename("X-Men Annual #003 (1979).cbz", "X-Men", &[annual95, annual]).map(|m| m.id), Some("a".into()));
        assert_eq!(
            attachment_for_filename("The Amazing Spider-Man: Coming Home Vol. 1.cbz", ASM, &[aref("attTpb", "The Amazing Spider-Man: Coming Home", "COLLECTED")]),
            Some(AttachmentFileMatch { id: "attTpb".into(), kind: "COLLECTED".into(), number: "1".into() })
        );
        // Nameless attachments are skipped.
        assert_eq!(attachment_for_filename("The Amazing Spider-Man '96 #001.cbz", ASM, &[aref("x", "", "ANNUAL"), aref("z", "The Amazing Spider-Man '96", "ANNUAL")]).map(|m| m.id), Some("z".into()));
    }

    #[tokio::test]
    async fn name_claim_finds_the_unbound_row_whose_file_names_this_volume_and_number() {
        let db = fixture("nameclaim").await;
        // The field shape: the '96 file scanned as MAIN-RUN #1 next to the real 1963 #1.
        insert_issue(&db, "row96", "1", false, Some("/c/ASM/The Amazing Spider-Man '96 #001 (1996).cbz"), None, Some("unmatched_a")).await;
        insert_issue(&db, "row63", "1", false, Some("/c/ASM/The Amazing Spider-Man #001 (1963).cbz"), None, Some("300001")).await;
        // Already bound rows are never candidates, whatever they are named.
        insert_issue(&db, "bound", "1", true, Some("/c/ASM/The Amazing Spider-Man '96 #001 (1996).cbz"), Some("other"), Some("400001")).await;
        let refs = [aref("att96", "The Amazing Spider-Man '96", "ANNUAL"), aref("attAnn", "The Amazing Spider-Man Annual", "ANNUAL")];

        let hit = find_claim_candidate_by_name(&db, "s1", ASM, "att96", &refs, "1").await.unwrap();
        assert_eq!(hit.map(|r| r.get::<String, _>("id")), Some("row96".to_string()));
        // The same file is nobody else's: the Annual lane sees nothing for #1, and '96 has no #2.
        assert!(find_claim_candidate_by_name(&db, "s1", ASM, "attAnn", &refs, "1").await.unwrap().is_none());
        assert!(find_claim_candidate_by_name(&db, "s1", ASM, "att96", &refs, "2").await.unwrap().is_none());
    }

    async fn insert_issue(db: &Db, id: &str, number: &str, annual: bool, file: Option<&str>, attached: Option<&str>, meta_id: Option<&str>) {
        sqlx::query(&format!(
            r#"INSERT INTO "Issue" (id, "seriesId", number, "isAnnual", "filePath", "attachedVolumeId", "metadataId", "metadataSource", status)
               VALUES ($1, 's1', $2, {annual}, $3, $4, $5, 'COMICVINE', 'DOWNLOADED')"#,
            annual = if annual { "true" } else { "false" }
        ))
        .bind(id).bind(number).bind(file).bind(attached).bind(meta_id)
        .execute(&db.pool).await.expect("insert issue");
    }

    #[tokio::test]
    async fn claim_takes_only_unbound_file_backed_annual_rows() {
        let db = fixture("claim").await;
        // The main run's #1 — the row the claim must never touch (Phase 0's whole point).
        insert_issue(&db, "main_1", "1", false, Some("/c/Batman 001.cbz"), None, None).await;
        // A file-less annual skeleton: nothing to claim, it IS the provider's own row.
        insert_issue(&db, "skeleton_1", "1", true, None, None, None).await;
        // An annual already bound to another attachment — never re-claimed.
        insert_issue(&db, "bound_2", "2", true, Some("/c/Batman Annual 002.cbz"), Some("att_other"), None).await;
        // The real candidate.
        insert_issue(&db, "annual_3", "3", true, Some("/c/Batman Annual 003.cbz"), None, None).await;

        let hit = find_claim_candidate(&db, "s1", "3").await.expect("query ok").expect("claims the annual file");
        assert_eq!(hit.get::<String, _>("id"), "annual_3");

        // #1 exists twice on this series (main run + skeleton) and neither is claimable.
        assert!(find_claim_candidate(&db, "s1", "1").await.expect("query ok").is_none());
        // #2's file is already bound.
        assert!(find_claim_candidate(&db, "s1", "2").await.expect("query ok").is_none());
        // Zero-padding is the same number (is_same_issue), so an "003" row still answers to "3".
        assert!(find_claim_candidate(&db, "s1", "003").await.expect("query ok").is_some());
    }

    /// The LOCAL sync reads the series (name, folder) too, and restores coverage from a real
    /// series.json in that folder — so this fixture carries a Series table and a temp folder.
    async fn fixture_local(tag: &str) -> (Db, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!("omnibus_avl_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("create fixture dir");
        let db_file = base.join("avl.db");
        std::fs::File::create(&db_file).expect("pre-create sqlite file");
        let db_url = format!("file:{}", db_file.to_string_lossy().replace('\\', "/"));
        let db = Db::connect(&db_url, 2).await.expect("connect file-backed sqlite");
        for ddl in [
            r#"CREATE TABLE "Series" (id TEXT PRIMARY KEY, name TEXT, "folderPath" TEXT)"#,
            r#"CREATE TABLE "Issue" (id TEXT PRIMARY KEY, "seriesId" TEXT, number TEXT, "isAnnual" INTEGER DEFAULT 0,
                "attachedVolumeId" TEXT, "metadataId" TEXT, "metadataSource" TEXT, "filePath" TEXT, status TEXT,
                name TEXT, "matchState" TEXT, "coversIssues" TEXT)"#,
            r#"CREATE TABLE "AttachedVolume" (id TEXT PRIMARY KEY, "seriesId" TEXT, "metadataSource" TEXT,
                "volumeId" TEXT, kind TEXT, name TEXT, "startYear" INTEGER, "issueCount" INTEGER DEFAULT 0,
                "lastSyncedAt" TEXT, "createdAt" TEXT, "updatedAt" TEXT)"#,
        ] {
            sqlx::query(ddl).execute(&db.pool).await.expect("create schema");
        }
        (db, base)
    }

    // #203 LOCAL: a collected edition the provider has no volume for.
    #[tokio::test]
    async fn local_sync_claims_files_by_name_and_restores_coverage_from_series_json() {
        let (db, folder) = fixture_local("local").await;
        std::fs::write(
            folder.join("series.json"),
            r#"{"version":"1.0.2","metadata":{"type":"comicSeries","name":"Saga"},"omnibus":{"attached_volumes":[
                {"source":"LOCAL","volume_id":"local_abc","kind":"COLLECTED","name":"Saga Compendium",
                 "books":[{"issue_id":"local:1","number":"1","covers":"1-54"}]}]}}"#,
        ).unwrap();
        let folder_str = folder.to_string_lossy().replace('\\', "/");
        sqlx::query(r#"INSERT INTO "Series" (id, name, "folderPath") VALUES ('s1', 'Saga', $1)"#).bind(&folder_str).execute(&db.pool).await.unwrap();
        sqlx::query(r#"INSERT INTO "AttachedVolume" (id, "seriesId", "metadataSource", "volumeId", kind, name) VALUES ('att_local', 's1', 'LOCAL', 'local_abc', 'COLLECTED', 'Saga Compendium')"#).execute(&db.pool).await.unwrap();
        // The scan's view after a wipe: the compendium file indexed as an unmatched main-run #1, beside the real #1.
        insert_issue(&db, "book", "1", false, Some("/c/Saga/Saga Compendium 01.cbz"), None, Some("unmatched_x")).await;
        insert_issue(&db, "main1", "1", false, Some("/c/Saga/Saga 001.cbz"), None, Some("300001")).await;

        let summary = sync_local_attachment(&db, "att_local", "s1", "COLLECTED").await.unwrap();
        assert_eq!((summary.claimed, summary.updated, summary.total), (1, 0, 1));

        let row = sqlx::query(r#"SELECT "attachedVolumeId", "metadataId", "matchState", "coversIssues", name, number FROM "Issue" WHERE id = 'book'"#).fetch_one(&db.pool).await.unwrap();
        assert_eq!(row.get::<Option<String>, _>("attachedVolumeId"), Some("att_local".to_string()));
        assert_eq!(row.get::<String, _>("metadataId"), "local_att_local_1");
        assert_eq!(row.get::<String, _>("matchState"), "MATCHED");
        assert_eq!(row.get::<Option<String>, _>("coversIssues"), Some("1-54".to_string()), "coverage comes back from series.json by number");
        assert_eq!(row.get::<Option<String>, _>("name"), Some("Vol. 1".to_string()));
        // The run's own #1 is nobody's book.
        let main = sqlx::query(r#"SELECT "attachedVolumeId" FROM "Issue" WHERE id = 'main1'"#).fetch_one(&db.pool).await.unwrap();
        assert!(main.get::<Option<String>, _>("attachedVolumeId").is_none());
        // Idempotent: a second pass claims nothing new and restores nothing twice.
        let again = sync_local_attachment(&db, "att_local", "s1", "COLLECTED").await.unwrap();
        assert_eq!((again.claimed, again.updated, again.total), (0, 0, 1));
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[tokio::test]
    async fn unbound_rows_are_adopted_by_id_even_after_renumbering() {
        // anacronismo's case: the 1996 one-off was renumbered to 29 to slot chronologically. After a
        // DB wipe its file's ComicInfo still carries the issue id, so the lane re-adopts it by ID —
        // a number-anchored restore would have looked for "1" and mis-bound (or missed) it.
        let db = fixture("adopt").await;
        insert_issue(&db, "one_off", "29", true, Some("/c/Batman Annual 029.cbz"), None, Some("60436")).await;
        // A same-id row that is already bound is out of scope — the lane finds it by its link.
        insert_issue(&db, "already", "30", true, Some("/c/x.cbz"), Some("att_1"), Some("60437")).await;

        let hit = find_unbound_by_id(&db, "s1", "60436", "COMICVINE").await.expect("query ok").expect("adopts by id");
        assert_eq!(hit.get::<String, _>("id"), "one_off");
        // Still numbered 29 — the adoption reads the number, it never rewrites it.
        assert_eq!(hit.get::<String, _>("number"), "29");

        assert!(find_unbound_by_id(&db, "s1", "60437", "COMICVINE").await.expect("query ok").is_none());
        // The source has to agree: a Metron id of the same digits is a different provider's issue.
        assert!(find_unbound_by_id(&db, "s1", "60436", "METRON").await.expect("query ok").is_none());
    }
}
