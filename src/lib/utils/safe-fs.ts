// src/lib/utils/safe-fs.ts
//
// Non-destructive filesystem helpers for relocating library folders. These exist specifically to avoid
// `fs.move(src, dest, { overwrite: true })` on a DIRECTORY — fs-extra implements that by deleting the
// entire destination first, which wipes any files already there (the "Standardize names ate my comics"
// bug). Nothing here ever removes a folder that still contains files.
import fs from 'fs-extra';
import path from 'path';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

/**
 * Remove `startDir`, then walk up removing empty parent folders, stopping at (and never removing) the
 * library root or the first non-empty directory. Only ever deletes CONFIRMED-EMPTY directories: it
 * reads each directory first and bails the moment anything is left, so it can never delete a folder
 * that still holds files.
 */
export async function cleanupEmptyDirs(startDir: string, libraryRoot: string): Promise<void> {
    try {
        if (!startDir || !libraryRoot) return;
        const root = path.normalize(libraryRoot);
        let dir = path.normalize(startDir);
        // Require a separator boundary so "/libraryX" can't be treated as inside "/library".
        while (dir && dir.length > root.length && dir.toLowerCase().startsWith((root + path.sep).toLowerCase())) {
            let entries: string[];
            try { entries = await fs.readdir(dir); } catch { break; }
            if (entries.length > 0) break; // not empty — never delete a folder with contents
            await fs.remove(dir);
            Logger.log(`[safe-fs] Removed empty folder: ${dir}`, 'debug');
            dir = path.dirname(dir);
        }
    } catch (e) {
        Logger.log(`[safe-fs] Empty-folder cleanup skipped for ${startDir}: ${getErrorMessage(e)}`, 'debug');
    }
}

/**
 * Move a single FILE, surviving filesystem boundaries. A plain `fs.rename` throws EXDEV when the
 * source and destination sit on different devices — the NORM in Docker setups where /unmatched and
 * the libraries are separate bind mounts or physical drives (GitHub discussion #169 / issue #170:
 * Smart Matcher failed with "EXDEV: cross-device link not permitted").
 *
 * On EXDEV: copy to a temp name BESIDE the destination, then rename into place (same-filesystem →
 * atomic), then delete the source. A crash mid-copy can therefore never leave a partial file at the
 * real filename — only a stale `.omnitmp` that never matches the comic-extension filters.
 * Never overwrites: callers guard collisions first, and the fallback's final rename refuses an
 * existing target.
 */
export async function moveFileSafe(src: string, dest: string): Promise<void> {
    try {
        await fs.rename(src, dest);
    } catch (e: any) {
        if (e?.code !== 'EXDEV') throw e;
        Logger.log(`[safe-fs] Cross-device move detected (EXDEV); staging a copy instead: ${src} -> ${dest}`, 'debug');
        const tmp = `${dest}.${Date.now()}.${Math.random().toString(36).slice(2)}.omnitmp`;
        try {
            await fs.copy(src, tmp);
            await fs.move(tmp, dest, { overwrite: false }); // same device now → atomic rename
            await fs.remove(src);
        } catch (fallbackErr) {
            await fs.remove(tmp).catch(() => {});
            throw fallbackErr;
        }
    }
}

/**
 * #199: operators on shared storage (NAS shares, mixed-uid setups) need the folders Omnibus creates
 * to be writable by more than the container's own user. `UMASK` is the *arr-family convention: when
 * it's set (octal — 000, 002, 022, ...), library folders this module creates or relocates are
 * chmod'd to 0777 & ~UMASK. Relocated folders are the case a process umask alone can't cover:
 * `fs.move` preserves the SOURCE's mode, so a folder born 0755 stays 0755 through every rename.
 * UMASK unset (or invalid) returns null → no chmod anywhere, today's behavior byte-for-byte.
 */
export function libraryDirMode(): number | null {
    const raw = (process.env.UMASK || '').trim();
    if (!/^[0-7]{1,4}$/.test(raw)) return null;
    return 0o777 & ~parseInt(raw, 8);
}

/**
 * Best-effort mode normalization for a directory that already exists (typically one just moved into
 * place, which kept its source mode). Failures are swallowed: SMB/FAT mounts routinely reject chmod,
 * and the move/write itself is what matters.
 */
export async function applyLibraryDirMode(dir: string): Promise<void> {
    const mode = libraryDirMode();
    if (mode === null) return;
    await fs.chmod(dir, mode).catch(() => {});
}

/** ensureDir + the UMASK-derived chmod above (a plain ensureDir when UMASK is unset). */
export async function ensureLibraryDir(dir: string): Promise<void> {
    await fs.ensureDir(dir);
    await applyLibraryDirMode(dir);
}

/**
 * Relocate the contents of `srcDir` into `destDir` WITHOUT ever overwriting. If `destDir` doesn't exist
 * this is a plain rename; if it exists, entries are merged one-by-one (recursing into subdirectories),
 * and any entry that already exists at the destination is LEFT IN PLACE (counted as a conflict) instead
 * of being clobbered. The emptied source tree is then cleaned up. Drop-in safe replacement for
 * `fs.move(src, dest, { overwrite: true })` on a directory. Returns the number of conflicts skipped.
 */
export async function safeRelocateFolder(srcDir: string, destDir: string, libraryRoot: string): Promise<{ conflicts: number }> {
    let conflicts = 0;
    if (!(await fs.pathExists(srcDir))) return { conflicts };

    // Same location (case-insensitive) — nothing to do.
    if (path.normalize(srcDir).toLowerCase() === path.normalize(destDir).toLowerCase()) return { conflicts };

    // Fast path: nothing at the destination → a plain, non-destructive move. The moved folder kept
    // its source mode, so normalize it (and the parent we may have just created) per UMASK (#199).
    if (!(await fs.pathExists(destDir))) {
        await ensureLibraryDir(path.dirname(destDir));
        await fs.move(srcDir, destDir, { overwrite: false });
        await applyLibraryDirMode(destDir);
        return { conflicts };
    }

    // Destination exists → merge entry-by-entry, recursing into colliding subdirectories.
    const mergeInto = async (from: string, to: string): Promise<void> => {
        await ensureLibraryDir(to);
        for (const entry of await fs.readdir(from)) {
            const src = path.join(from, entry);
            const dst = path.join(to, entry);
            const isDir = (await fs.lstat(src)).isDirectory();
            if (await fs.pathExists(dst)) {
                if (isDir) {
                    await mergeInto(src, dst); // recurse-merge the colliding subdirectory
                } else {
                    conflicts++;
                    Logger.log(`[safe-fs] Conflict: target already exists, leaving source in place: ${dst}`, 'warn');
                }
            } else {
                await fs.move(src, dst, { overwrite: false });
            }
        }
    };

    await mergeInto(srcDir, destDir);
    await cleanupEmptyDirs(srcDir, libraryRoot);
    return { conflicts };
}
