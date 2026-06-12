// src/lib/utils/paths.ts

/**
 * Canonical filesystem locations. Every path is configurable via environment
 * variable in Docker; the fallbacks below are the single source of truth —
 * never inline a path fallback anywhere else in the app.
 */

/** Root config volume; cache, logs, and backups default to subfolders of it. */
export const CONFIG_DIR = process.env.OMNIBUS_CONFIG_DIR || '/config';

/** Base directory for caches and temp work (cover cache, conversion temp dirs). */
export const CACHE_DIR = process.env.OMNIBUS_CACHE_DIR || '/config/cache';

/** Where omnibus.log is written and read from. */
export const LOGS_DIR = process.env.OMNIBUS_LOGS_DIR || '/config/logs';

/** Destination for database/settings backup archives. */
export const BACKUPS_DIR = process.env.OMNIBUS_BACKUPS_DIR || '/config/backups';

/** Drop folder scanned for new downloads to import. */
export const WATCHED_DIR = process.env.OMNIBUS_WATCHED_DIR || '/watched';

/** Holding area for files that could not be matched to a series. */
export const UNMATCHED_DIR = process.env.OMNIBUS_AWAITING_MATCH_DIR || '/unmatched';
