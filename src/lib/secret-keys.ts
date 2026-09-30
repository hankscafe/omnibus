// SystemSetting keys whose values are credentials encrypted at rest (enc:v2: AES-256-GCM; legacy enc:v1: CBC still read).
// Reads are transparently decrypted by the Prisma extension in db.ts; writes are encrypted by the
// admin config route (which also masks every one of them on the way out); existing plaintext is
// migrated by db-init. The Rust engine has a matching decrypt (omnibus-engine/src/secret_crypto.rs)
// for the keys it reads (cv_api_key, prowlarr_key, metron_api_token, metron_pass). Usernames/URLs
// (metron_user, smtp_user, prowlarr_url, …) are NOT secrets and stay in plaintext.
export const SECRET_SETTING_KEYS = new Set<string>([
  'cv_api_key',
  'prowlarr_key',
  'metron_api_token',
  'metron_pass',
  'smtp_pass',
  'oidc_client_secret',
  'pushover_token',
  'telegram_bot_token',
  'apprise_url',
]);
