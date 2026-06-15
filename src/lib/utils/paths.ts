// src/lib/utils/paths.ts

import path from 'path';

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

/**
 * True when `filePath` resolves to a location inside one of the given library roots.
 * Normalizes both sides first (collapsing `..`) and requires a path-separator boundary,
 * so neither traversal (`<root>/../../etc/passwd`) nor a sibling-prefix (`<root>-evil`)
 * slips past a naive string `startsWith`. Shared by every endpoint that serves a file
 * from a client-supplied path (reader image/pages, library download).
 */
export function isPathWithinRoots(filePath: string, roots: string[]): boolean {
  const target = path.normalize(filePath).toLowerCase();
  return roots.some((r) => {
    const root = path.normalize(r).replace(/[\\/]+$/, '').toLowerCase();
    return target === root || target.startsWith(root + path.sep);
  });
}
