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
    cv_issue_credits, is_same_issue, json_num_string, merge_credit_json, metron_auth, metron_fetch,
    metron_issue_credits, metron_issue_name, next_match_state, parse_date_ms, prefer_existing,
    resolve_synced_name,
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

    for issue in &issues {
        // ---- ID-anchored: the row this provider issue already owns, wherever the user moved its
        //      number to. Nothing else in the lane is a candidate.
        let existing = sqlx::query(
            r#"SELECT id, number, name, description, "releaseDate", "coverUrl", "matchState",
                      CAST("hasCustomMetadata" AS INTEGER) AS "hasCustomMetadata",
                      CAST("hasCustomCover" AS INTEGER) AS "hasCustomCover",
                      writers, artists, "coverArtists", colorists, letterers, characters, teams, locations,
                      inker, editor, translator
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

        // ---- The claim: a file-backed annual row nobody has bound yet, whose NUMBER matches this
        //      provider issue. Silent by decision (2026-08-26) — the summary is the honesty, and
        //      detach / the editor's exact-id field are the undo.
        let claimed_row = if existing.is_none() && adopted_row.is_none() && claim && kind == "ANNUAL" {
            find_claim_candidate(db, &series_id, &issue.number).await?
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

        let res = if let Some(t) = target {
            let row_id: String = t.get("id");
            // `number` is ABSENT from this UPDATE on purpose: inside an attached lane the number is
            // the user's curation, and the id is the anchor. A claim additionally stamps the link.
            sqlx::query(&format!(
                r#"UPDATE "Issue" SET "attachedVolumeId"=$1, "metadataId"=$2, "metadataSource"=$3, "isAnnual"={annual},
                   name=$4, description=$5, "releaseDate"=$6, "coverUrl"=$7, "matchState"=$8,
                   writers=$9, artists=$10, "coverArtists"=$11, colorists=$12, letterers=$13,
                   characters=$14, teams=$15, locations=$16, inker=$17, editor=$18, translator=$19
                   WHERE id=$20"#,
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
                    inker, editor, translator, "createdAt", "updatedAt")
                   VALUES ($1,$2,$3,$4,$5,$6,{annual},'WANTED',$7,$8,$9,$10,'MATCHED',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,{now},{now})"#,
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
                  inker, editor, translator
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
                  inker, editor, translator
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
        .query(&[("api_key", api_key.as_str()), ("format", "json"), ("field_list", "name,start_year,count_of_issues")])
        .header("User-Agent", "Omnibus/1.0")
        .timeout(Duration::from_secs(15))
        .build()?;
    let vol_full_url = vol_req.url().to_string();
    let vol_json: serde_json::Value = match crate::metadata_cache::get(db, "comicvine", &vol_full_url).await {
        Some(hit) => hit,
        None => {
            let resp = client.execute(vol_req).await?;
            crate::api_usage::log(&db.pool, "comicvine", &vol_url).await;
            if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                anyhow::bail!("ComicVine rate limited (429) on the attached volume fetch");
            }
            let j: serde_json::Value = resp.json().await?;
            crate::metadata_cache::put(db, "comicvine", &vol_full_url, &j).await;
            j
        }
    };
    volume.name = vol_json["results"]["name"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string());
    volume.start_year = vol_json["results"]["start_year"].as_str().and_then(|s| s.trim().parse::<i32>().ok())
        .or_else(|| vol_json["results"]["start_year"].as_i64().map(|v| v as i32));

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
                if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                    anyhow::bail!("ComicVine rate limited (429) on the attached issues fetch");
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
