// AES-256-CBC decryption for SystemSetting credential values, byte-compatible with the Node app's
// src/lib/encryption.ts. Format: `enc:v1:<iv_hex>:<ciphertext_hex>`; the key is SHA-256(secret) where
// the secret is the `DATABASE_ENCRYPTION_KEY` SystemSetting row (else the NEXTAUTH_SECRET env var),
// exactly mirroring Node's getEncryptionKey(). This lets the engine read the cv_api_key /
// prowlarr_key / metron_pass that Node now stores encrypted at rest.
use aes::Aes256;
use cbc::Decryptor;
use cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use sha2::{Digest, Sha256};
use sqlx::PgPool;

type Aes256CbcDec = Decryptor<Aes256>;
const PREFIX: &str = "enc:v1:";

fn derive_key(secret: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    hasher.finalize().into()
}

/// Resolve the encryption key the same way Node does: the persistent DATABASE_ENCRYPTION_KEY row
/// takes precedence; the NEXTAUTH_SECRET env var is the fallback.
async fn encryption_key(db: &PgPool) -> Option<[u8; 32]> {
    let db_key: Option<String> =
        sqlx::query_scalar(r#"SELECT value FROM "SystemSetting" WHERE key = 'DATABASE_ENCRYPTION_KEY'"#)
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    let secret = db_key
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("NEXTAUTH_SECRET").ok())
        .filter(|s| !s.is_empty())?;
    Some(derive_key(&secret))
}

/// Decrypt the `<iv_hex>:<ct_hex>` portion (everything after the `enc:v1:` prefix).
fn decrypt_payload(rest: &str, key: &[u8; 32]) -> Option<String> {
    let (iv_hex, ct_hex) = rest.split_once(':')?;
    let iv = hex::decode(iv_hex).ok()?;
    let ct = hex::decode(ct_hex).ok()?;
    let plain = Aes256CbcDec::new_from_slices(key, &iv)
        .ok()?
        .decrypt_padded_vec_mut::<Pkcs7>(&ct)
        .ok()?;
    String::from_utf8(plain).ok()
}

/// Decrypts a SystemSetting value carrying the `enc:v1:` prefix; returns plaintext values unchanged
/// (legacy / not-yet-encrypted). Returns None for a None input or on decryption failure — callers
/// then treat the credential as missing rather than sending ciphertext to an upstream API.
pub async fn decrypt_setting(db: &PgPool, value: Option<String>) -> Option<String> {
    let v = value?;
    match v.strip_prefix(PREFIX) {
        Some(rest) => match encryption_key(db).await.and_then(|key| decrypt_payload(rest, &key)) {
            Some(plain) => Some(plain),
            None => {
                log::warn!(
                    "[Secret] Failed to decrypt a SystemSetting credential; treating it as missing. \
                     Check DATABASE_ENCRYPTION_KEY / NEXTAUTH_SECRET parity with the Node app."
                );
                None
            }
        },
        None => Some(v),
    }
}

/// Convenience wrapper for values pulled from a settings map (returns "" when absent/undecryptable).
pub async fn decrypt_str(db: &PgPool, value: &str) -> String {
    decrypt_setting(db, Some(value.to_string()))
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vector produced by Node's src/lib/encryption.ts scheme (secret "test_secret_123", plaintext
    // "hello-omnibus-key", fixed IV 0x07*16). Decrypting it here proves cross-language parity.
    const NODE_VECTOR: &str =
        "07070707070707070707070707070707:c1a9e634f892cb898c94cd6c6f2db6f4c5483ce89bc7244c8a200d40877da0a6";

    #[test]
    fn decrypts_node_generated_vector() {
        let key = derive_key("test_secret_123");
        assert_eq!(decrypt_payload(NODE_VECTOR, &key).as_deref(), Some("hello-omnibus-key"));
    }

    #[test]
    fn wrong_key_does_not_yield_plaintext_and_garbage_is_safe() {
        // A wrong key never produces the real plaintext (may be None or garbage — never panics).
        let wrong = derive_key("the_wrong_secret");
        assert_ne!(decrypt_payload(NODE_VECTOR, &wrong).as_deref(), Some("hello-omnibus-key"));
        // Malformed payloads return None rather than panicking.
        assert_eq!(decrypt_payload("nocolon", &derive_key("x")), None);
        assert_eq!(decrypt_payload("aa:zz", &derive_key("x")), None);
    }
}
