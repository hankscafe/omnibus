# Upgrading Omnibus

## Choosing your database (SQLite or PostgreSQL)

Omnibus runs on **either** database from the **same images** — you choose with `DATABASE_URL`, and
you are not locked in (you can move between them later via Backup → Restore, below).

- **SQLite — the default, recommended for most.** Zero configuration: the database is a single file
  at `<config>/omnibus.db`. No database server to run. Start with the standard compose file:

  ```bash
  docker compose up -d
  ```

- **PostgreSQL — optional, for very large libraries.** Adds a Postgres service. Start with the scale
  compose file:

  ```bash
  docker compose -f docker-compose.postgres.yml up -d
  ```

Both the web app and the Rust engine read the **same `DATABASE_URL`**. On the SQLite profile they
open the **same database file**, so they must share the `/config` volume — the compose files already
do this. **Keep `/config` on a local disk or bind mount, never an SMB/NFS network share:** SQLite's
file locking is unreliable over network filesystems and can corrupt the database under concurrent
access. (Your comic library on `/data` can live on a network share as usual — this applies only to
`/config`, where the SQLite file lives.)

> **How the provider is selected:** the image ships ready for SQLite (the default). When
> `DATABASE_URL` is a `postgres://` URL, the container's entrypoint rewrites the Prisma datasource
> and regenerates the client automatically before first boot — no manual step.

---

## In-place image upgrades on NAS / command-freezing platforms (QNAP, etc.)

Most setups upgrade cleanly by pulling the new image and recreating the container. But some
platforms — notably **QNAP Container Station**, and other UIs that capture a container's run
configuration at *creation* — keep the **original container's command** when you only update the
image, instead of adopting the new image's startup. Because this build runs its datasource setup at
startup, a container carried over from an older image can keep a stale command and fail to boot with:

```
Error validating datasource `db`: the URL must start with the protocol `file:`.  (P1012)
```

That means the container is running the old startup (a bare `prisma db push`) against the new
image's SQLite-default schema while `DATABASE_URL` points at PostgreSQL. (This is harmless — the
error is a schema-validation failure *before* Prisma connects, so **your database is untouched**.
The Rust engine is unaffected either way; it reads `DATABASE_URL` directly and never uses Prisma.)

**Fix — do either one:**

1. **Recreate the container** (recommended) so it adopts the new image's entrypoint. Keep the same
   environment (`DATABASE_URL`, `NEXTAUTH_SECRET`, the `OMNIBUS_*` paths) and the same `/config` +
   `/data` volumes, and leave the command/entrypoint fields **blank** so the image's defaults apply.
2. **Or set the command override** to run the provider-select step before starting:

   ```
   sh -c 'node ./scripts/prepare-datasource.mjs && node ./node_modules/prisma/build/index.js db push --schema=/app/prisma/schema.prisma --skip-generate --accept-data-loss && node server.js'
   ```

Either way, a healthy boot logs `provider "sqlite" -> "postgresql"; regenerating Prisma client...`
followed by `Your database is now in sync with your Prisma schema.` before the server starts. Once
set, the platform keeps the correct startup across future updates.

---

## Switching an existing instance between SQLite and PostgreSQL

The two databases use different on-disk formats, so there is **no in-place file conversion** — a raw
SQLite→PostgreSQL dump would mis-type the booleans and dates that the Rust engine reads natively.
Instead, move your data with Omnibus's own **encrypted Backup → Restore**, which round-trips every
row through Prisma (so SQLite `0/1` booleans become real PostgreSQL booleans, dates normalize, etc.).
The same procedure works in **either** direction (SQLite → Postgres for scale, or Postgres → SQLite
to simplify).

### Before you start

- **Note your `NEXTAUTH_SECRET`.** The backup is AES-256 encrypted with it, so the **new** stack must
  use the **exact same `NEXTAUTH_SECRET`** — otherwise the backup cannot be decrypted (and your 2FA
  secrets and saved download/hoster credentials won't decrypt either).
- Keep a copy of your existing `<config>` volume as a safety net.

### Steps

1. **On the OLD instance:** log in as an admin → **Admin → Settings → Backup** → download the
   database backup (`omnibus_backup_<date>.json`).
2. **Stand up the NEW stack** with the **same `NEXTAUTH_SECRET`** set in your `.env` — use
   `docker compose up -d` for the SQLite target, or `docker compose -f docker-compose.postgres.yml up -d`
   for the PostgreSQL target. The web container creates the schema automatically on first boot
   (`prisma db push`); on the Postgres target the datasource is switched to PostgreSQL automatically.
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
