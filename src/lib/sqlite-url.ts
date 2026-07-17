// src/lib/sqlite-url.ts
// SQLite write-lock hygiene (issue #183): Prisma's default SQLite pool opens num_cpus*2+1
// connections that all race for the file's single write lock — alongside the Rust engine's
// scan-time write bursts that maximized SQLITE_BUSY stalls, which surfaced as the whole UI
// hanging during big library scans. One connection makes Node's queries queue in-process
// (microseconds for local SQLite reads) instead of colliding; lib/db.ts pairs this with a
// busy_timeout PRAGMA so the surviving cross-process contention waits politely for the engine.
// Postgres URLs pass through untouched; an explicit connection_limit in DATABASE_URL wins.
export function tunedSqliteUrl(raw?: string): string | undefined {
  const url = (raw ?? process.env.DATABASE_URL ?? '').trim();
  if (!url.startsWith('file:')) return undefined;
  if (/[?&]connection_limit=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'connection_limit=1';
}
