# Upgrading Omnibus

## Migrating from the SQLite release (v1.0.x) to the Rust + PostgreSQL release

Older Omnibus releases bundled the database as a single **SQLite** file (`<config>/omnibus.db`)
via Prisma. The current release runs a **PostgreSQL** database alongside the Rust engine and Redis,
so there is **no in-place file conversion** — the two databases use different on-disk formats, and a
raw SQLite→PostgreSQL dump would mis-type the booleans and dates that the Rust engine reads natively.

Instead, migrate with Omnibus's own **encrypted Backup → Restore**, which round-trips every row
through Prisma (so SQLite `0/1` booleans become real PostgreSQL booleans, dates normalize, etc.).

### Before you start

- **Note your `NEXTAUTH_SECRET`.** The backup is AES-256 encrypted with it, so the **new** stack must
  use the **exact same `NEXTAUTH_SECRET`** — otherwise the backup cannot be decrypted (and your 2FA
  secrets and saved download/hoster credentials won't decrypt either).
- Keep a copy of your existing `<config>` volume as a safety net.

### Steps

1. **On the OLD (SQLite) instance:** log in as an admin → **Admin → Settings → Backup** → download the
   database backup (`omnibus_backup_<date>.json`).
2. **Stand up the NEW stack** (`docker-compose.yml`) with the **same `NEXTAUTH_SECRET`** set in your
   `.env`. PostgreSQL, Redis, and the engine start, and the web container creates the schema
   automatically on first boot (`prisma db push`).
3. **Restore before finishing setup:** on the new instance's first-run setup screen (or later via
   **Admin → Settings → Restore**), upload the backup JSON. Restore is intentionally permitted before
   setup completes so you can seed a brand-new instance. Legacy-shaped fields are upgraded
   automatically on boot.
4. Log in with your existing credentials and verify your libraries, reading progress, requests, and
   settings.

### What is migrated

Users, settings, libraries, series, issues, requests, collections, reading lists (and their items),
trophies, read progress, issue reports, **reviews, favorites, bookmarks, daily reading stats,
KOReader sync state, API & OPDS keys**, download-client and hoster-account config, Discord webhooks,
indexers, custom headers, search acronyms, the audit log, and digest history.

### What is NOT migrated (by design)

- **Job logs** and **job locks** — ephemeral background-job diagnostics and runtime locks; they
  regenerate on the new instance.
- **Library files on disk** are not part of the database backup. Point the new stack at the same
  library mount (or copy your comics over) as you normally would.

### Troubleshooting

- **"Decryption failed. Check NEXTAUTH_SECRET."** — the new stack's `NEXTAUTH_SECRET` does not match
  the one used to create the backup. Make them identical and retry.
- **Very large libraries** — the restore runs inside a single transaction with a 10-minute limit. A
  library with hundreds of thousands of issues may need that limit raised in
  `src/app/api/admin/restore/route.ts`.
- After migrating, saved credentials and 2FA secrets are (re)encrypted at rest on first boot. If you
  later change `NEXTAUTH_SECRET`, those values become unreadable — keep the secret stable.

> Note: the old `prisma/migrations/` history was SQLite-only and is not used at runtime (the app
> applies the schema with `prisma db push`). It has been removed; do not run `prisma migrate deploy`.
