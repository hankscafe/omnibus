// Decryption for SystemSetting credential values, byte-compatible with the Node app's
// src/lib/encryption.ts. Two formats are read transparently:
//   v2 (current): `enc:v2:<iv_b64>:<authTag_b64>:<ciphertext_b64>` — authenticated AES-256-GCM, 12-byte IV
//   v1 (legacy):  `enc:v1:<iv_hex>:<ciphertext_hex>`             — unauthenticated AES-256-CBC, 16-byte IV
// The key is SHA-256(secret) where the secret is the `DATABASE_ENCRYPTION_KEY` SystemSetting row (else
// the NEXTAUTH_SECRET env var), exactly mirroring Node's getEncryptionKey(). Node writes v2 now, so the
// engine MUST read v2 or it loses the cv_api_key / prowlarr_key / metron_pass that Node stores at rest.
use aes::Aes256;
use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::Engine as _;
use cbc::Decryptor;
use cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use sha2::{Digest, Sha256};
use sqlx::PgPool;

type Aes256CbcDec = Decryptor<Aes256>;
const PREFIX_V1: &str = "enc:v1:";
const PREFIX_V2: &str = "enc:v2:";

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

/// Decrypt the v1 `<iv_hex>:<ct_hex>` portion (everything after the `enc:v1:` prefix). AES-256-CBC.
fn decrypt_payload_v1(rest: &str, key: &[u8; 32]) -> Option<String> {
    let (iv_hex, ct_hex) = rest.split_once(':')?;
    let iv = hex::decode(iv_hex).ok()?;
    let ct = hex::decode(ct_hex).ok()?;
    let plain = Aes256CbcDec::new_from_slices(key, &iv)
        .ok()?
        .decrypt_padded_vec_mut::<Pkcs7>(&ct)
        .ok()?;
    String::from_utf8(plain).ok()
}

/// Decrypt the v2 `<iv_b64>:<authTag_b64>:<ct_b64>` portion (everything after the `enc:v2:` prefix).
/// Authenticated AES-256-GCM: the aes-gcm crate expects the ciphertext with the 16-byte tag appended,
/// which is how Node splits it out (cipher.getAuthTag()). A wrong key or tampered data fails the tag
/// check and returns None rather than yielding garbage.
fn decrypt_payload_v2(rest: &str, key: &[u8; 32]) -> Option<String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut parts = rest.split(':');
    let iv = b64.decode(parts.next()?).ok()?;
    let tag = b64.decode(parts.next()?).ok()?;
    let ct = b64.decode(parts.next()?).ok()?;
    if iv.len() != 12 {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let mut combined = ct;
    combined.extend_from_slice(&tag); // aes-gcm wants ciphertext || tag
    let plain = cipher.decrypt(Nonce::from_slice(&iv), combined.as_ref()).ok()?;
    String::from_utf8(plain).ok()
}

/// Decrypts a SystemSetting value carrying the `enc:v1:` prefix; returns plaintext values unchanged
/// (legacy / not-yet-encrypted). Returns None for a None input or on decryption failure — callers
/// then treat the credential as missing rather than sending ciphertext to an upstream API.
pub async fn decrypt_setting(db: &PgPool, value: Option<String>) -> Option<String> {
    let v = value?;
    // Dispatch on the version prefix; a plaintext (unprefixed) value passes through unchanged.
    let decoded = if let Some(rest) = v.strip_prefix(PREFIX_V2) {
        encryption_key(db).await.and_then(|key| decrypt_payload_v2(rest, &key))
    } else if let Some(rest) = v.strip_prefix(PREFIX_V1) {
        encryption_key(db).await.and_then(|key| decrypt_payload_v1(rest, &key))
    } else {
        return Some(v);
    };
    match decoded {
        Some(plain) => Some(plain),
        None => {
            log::warn!(
                "[Secret] Failed to decrypt a SystemSetting credential; treating it as missing. \
                 Check DATABASE_ENCRYPTION_KEY / NEXTAUTH_SECRET parity with the Node app."
            );
            None
        }
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

    // v1 vector produced by Node's AES-256-CBC scheme (secret "test_secret_123", plaintext
    // "hello-omnibus-key", fixed IV 0x07*16). Decrypting it here proves cross-language parity.
    const NODE_VECTOR_V1: &str =
        "07070707070707070707070707070707:c1a9e634f892cb898c94cd6c6f2db6f4c5483ce89bc7244c8a200d40877da0a6";

    // v2 vector produced by Node's AES-256-GCM scheme (same secret/plaintext, fixed IV 0x07*12).
    // Format: iv_b64:authTag_b64:ciphertext_b64. Proves the engine reads what Node now writes.
    const NODE_VECTOR_V2: &str =
        "BwcHBwcHBwcHBwcH:HwrImqzSf36ROaN5VPNvSw==:qQmG5rj/zzOy2XQ+/sIHDeQ=";

    #[test]
    fn decrypts_node_generated_vector() {
        let key = derive_key("test_secret_123");
        assert_eq!(decrypt_payload_v1(NODE_VECTOR_V1, &key).as_deref(), Some("hello-omnibus-key"));
        assert_eq!(decrypt_payload_v2(NODE_VECTOR_V2, &key).as_deref(), Some("hello-omnibus-key"));
    }

    #[test]
    fn wrong_key_does_not_yield_plaintext_and_garbage_is_safe() {
        // A wrong key never produces the real plaintext (may be None or garbage — never panics).
        let wrong = derive_key("the_wrong_secret");
        assert_ne!(decrypt_payload_v1(NODE_VECTOR_V1, &wrong).as_deref(), Some("hello-omnibus-key"));
        // GCM authenticates: a wrong key fails the tag check → None (never garbage plaintext).
        assert_eq!(decrypt_payload_v2(NODE_VECTOR_V2, &wrong), None);
        // Malformed payloads return None rather than panicking.
        assert_eq!(decrypt_payload_v1("nocolon", &derive_key("x")), None);
        assert_eq!(decrypt_payload_v1("aa:zz", &derive_key("x")), None);
        assert_eq!(decrypt_payload_v2("nocolon", &derive_key("x")), None);
    }
}
