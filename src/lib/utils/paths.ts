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

/**
 * True when `folder` resolves to a location strictly INSIDE one of the library roots - never a root
 * itself. The gate for anything that moves or deletes a whole series folder: a series whose
 * folderPath is a library root (or anywhere outside the libraries) must never take that folder with it.
 */
export function isInsideLibraryRoot(folder: string | null | undefined, roots: string[]): boolean {
  if (!folder) return false;
  const target = path.normalize(folder).replace(/[\\/]+$/, '').toLowerCase();
  return roots.some((r) => {
    const root = path.normalize(r).replace(/[\\/]+$/, '').toLowerCase();
    return target.startsWith(root + path.sep);
  });
}

/**
 * Joins an expanded folder pattern onto a library root one segment at a time, dropping blank
 * segments. Null when a segment isn't a plain name ("..", ".", a dots-only run, a drive prefix) or
 * when nothing is left - a series folder is always a folder INSIDE the library. Engine twin:
 * watched_sync.rs library_subfolder.
 */
export function librarySubfolder(root: string, relFolder: string): string | null {
  const segments = relFolder.split(/[/\\]/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some((s) => /^\.+$/.test(s) || /^[a-z]:/i.test(s))) return null;
  return path.join(root, ...segments);
}

/** A year as it may appear in a folder name: the digits of a positive integer, else "". */
export function folderYear(year: unknown): string {
  if (typeof year !== 'string' && typeof year !== 'number') return '';
  const n = parseInt(String(year).trim(), 10);
  return Number.isFinite(n) && n > 0 ? String(n) : '';
}
