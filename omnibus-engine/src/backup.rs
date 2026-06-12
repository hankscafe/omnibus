use anyhow::Result;
use sqlx::PgPool;
use std::fs;
use std::path::PathBuf;
use sha2::Sha256;
use pbkdf2::pbkdf2_hmac;
use rand::Rng;
use aes::Aes256;
use cbc::Encryptor;
use cipher::{KeyIvInit, block_padding::Pkcs7, BlockEncryptMut};

type Aes256CbcEnc = Encryptor<Aes256>;

/// Postgres `row_to_json` serializes `timestamp without time zone` columns with no zone marker
/// (e.g. `"2024-01-15T12:34:56.789"`), whereas Node's `JSON.stringify(new Date())` always emits a
/// trailing `Z`. Without it, JS/Prisma parse the naive string as LOCAL time on restore, zone-shifting
/// every timestamp. Prisma stores these columns in UTC, so appending `Z` to naive timestamps restores
/// the Node round-trip. Offset-bearing values (`…+00:00`) and date-only strings are left untouched.
fn mark_naive_timestamps_utc(v: &mut serde_json::Value, re: &regex::Regex) {
    match v {
        serde_json::Value::String(s) => {
            if re.is_match(s) { s.push('Z'); }
        }
        serde_json::Value::Array(arr) => arr.iter_mut().for_each(|x| mark_naive_timestamps_utc(x, re)),
        serde_json::Value::Object(map) => map.values_mut().for_each(|x| mark_naive_timestamps_utc(x, re)),
        _ => {}
    }
}

pub async fn process_backup(db: PgPool) -> Result<(i32, String)> {
    // 1. Prepare Encryption Keys (Matching the Node admin/backup route exactly).
    // SECURITY: mandatory secret check, no literal fallback (parity with backup/route.ts:19-23).
    let secret = std::env::var("NEXTAUTH_SECRET").unwrap_or_default();
    if secret.is_empty() || secret == "change_this_to_a_random_secure_string_123!" {
        anyhow::bail!("Backup failed: NEXTAUTH_SECRET is not configured.");
    }

    // 16-byte random salt + IV (parity with crypto.randomBytes(16)).
    let mut salt = [0u8; 16];
    rand::thread_rng().fill(&mut salt);
    let mut iv = [0u8; 16];
    rand::thread_rng().fill(&mut iv);

    // STRENGTHEN KDF: PBKDF2-HMAC-SHA256, 100,000 iterations, 32-byte key.
    // Byte-identical to Node's crypto.pbkdf2Sync(secret, salt, 100000, 32, 'sha256').
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(secret.as_bytes(), &salt, 100_000, &mut key);

    // 2. Table mappings (JSON Key -> PostgreSQL Table Name)
    let tables = vec![
        ("users", "User"),
        ("settings", "SystemSetting"),
        ("libraries", "Library"),
        ("downloadClients", "DownloadClient"),
        ("discordWebhooks", "DiscordWebhook"),
        ("indexers", "Indexer"),
        ("customHeaders", "CustomHeader"),
        ("searchAcronyms", "SearchAcronym"),
        ("collections", "Collection"),
        ("readingLists", "ReadingList"),
        ("trophies", "Trophy"),
        ("series", "Series"),
        ("issues", "Issue"),
        ("requests", "Request"),
        ("readProgresses", "ReadProgress"),
        ("collectionItems", "CollectionItem"),
        ("readingListItems", "ReadingListItem"),
        ("userTrophies", "UserTrophy"),
        ("issueReports", "IssueReport"),
        ("digestHistory", "DigestHistory"),
    ];

    let mut inner_data = serde_json::Map::new();

    // Matches a naive ISO-8601 datetime (no trailing `Z` / offset) so we can mark it UTC — see
    // mark_naive_timestamps_utc.
    let naive_ts_re = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?$").unwrap();

    // 3. Ultra-Fast PostgreSQL JSON Extraction
    for (json_key, table_name) in tables {
        log::debug!("[Backup Debug] Exporting table: {}", table_name);

        // This query forces Postgres (C-engine) to serialize the entire table into a single JSON array natively!
        let query = format!(r#"SELECT COALESCE(json_agg(row_to_json(t)), '[]')::text FROM "{}" t"#, table_name);

        let (json_str,): (String,) = sqlx::query_as(&query).fetch_one(&db).await?;
        let mut parsed_arr: serde_json::Value = serde_json::from_str(&json_str)?;
        // Normalize naive timestamps to UTC `…Z` so Node's restore parses them as UTC, not local time.
        mark_naive_timestamps_utc(&mut parsed_arr, &naive_ts_re);

        inner_data.insert(json_key.to_string(), parsed_arr);
    }

    // 4. Assemble the inner payload
    let inner_json = serde_json::json!({
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "data": inner_data
    });
    let inner_string = inner_json.to_string();

    // 5. Encrypt the payload using AES-256-CBC and PKCS7 Padding
    let ct = Aes256CbcEnc::new(&key.into(), &iv.into())
        .encrypt_padded_vec_mut::<Pkcs7>(inner_string.as_bytes());
    
    let encrypted_hex = hex::encode(ct);

    // 6. Build the final outer JSON structure.
    // version "3.0" + "salt" field so the Node restore route picks the PBKDF2 branch (restore/route.ts:46-52).
    let final_json = serde_json::json!({
        "encrypted": true,
        "version": "3.0",
        "salt": hex::encode(salt),
        "iv": hex::encode(iv),
        "data": encrypted_hex
    });

    // 7. Write to Disk
    let backup_dir = std::env::var("OMNIBUS_BACKUPS_DIR").unwrap_or_else(|_| {
        if cfg!(target_os = "windows") {
            "./backups".to_string() // Safe fallback for local Windows testing
        } else {
            "/backups".to_string() // Match Node's default: process.env.OMNIBUS_BACKUPS_DIR || '/backups'
        }
    });
    fs::create_dir_all(&backup_dir)?;

    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis();
    let filename = format!("omnibus_backup_{}.json", now_ms);
    let filepath = PathBuf::from(&backup_dir).join(&filename);

    fs::write(&filepath, final_json.to_string())?;

    // 8. Retention Cleanup: Keep only the latest 5 backups
    if let Ok(entries) = fs::read_dir(&backup_dir) {
        let mut backups: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().unwrap_or_default().to_string_lossy().starts_with("omnibus_backup_"))
            .collect();

        if backups.len() > 5 {
            backups.sort(); // Sorts chronologically because of the timestamp naming
            let to_delete = backups.len() - 5;
            for path in backups.into_iter().take(to_delete) {
                let _ = fs::remove_file(path);
            }
        }
    }

    Ok((0, format!("Backup saved successfully to {}. Retaining last 5 backups.", filepath.to_string_lossy())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn naive_timestamps_get_utc_z_others_untouched() {
        let re = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?$").unwrap();
        let mut v = serde_json::json!([
            {
                "createdAt": "2024-01-15T12:34:56.789",   // naive → +Z
                "updatedAt": "2024-01-15T12:34:56",       // naive, no millis → +Z
                "withOffset": "2024-01-15T12:34:56.789+00:00", // already zoned → untouched
                "alreadyZ": "2024-01-15T12:34:56.789Z",   // already UTC → untouched
                "releaseDate": "2024-01-15",              // date-only string column → untouched
                "name": "Saga 2014 012",                  // ordinary text → untouched
                "count": 12
            }
        ]);
        mark_naive_timestamps_utc(&mut v, &re);
        let row = &v[0];
        assert_eq!(row["createdAt"], "2024-01-15T12:34:56.789Z");
        assert_eq!(row["updatedAt"], "2024-01-15T12:34:56Z");
        assert_eq!(row["withOffset"], "2024-01-15T12:34:56.789+00:00");
        assert_eq!(row["alreadyZ"], "2024-01-15T12:34:56.789Z");
        assert_eq!(row["releaseDate"], "2024-01-15");
        assert_eq!(row["name"], "Saga 2014 012");
        assert_eq!(row["count"], 12);
    }
}