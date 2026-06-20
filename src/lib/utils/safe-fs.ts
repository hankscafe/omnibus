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

    // Fast path: nothing at the destination → a plain, non-destructive move.
    if (!(await fs.pathExists(destDir))) {
        await fs.ensureDir(path.dirname(destDir));
        await fs.move(srcDir, destDir, { overwrite: false });
        return { conflicts };
    }

    // Destination exists → merge entry-by-entry, recursing into colliding subdirectories.
    const mergeInto = async (from: string, to: string): Promise<void> => {
        await fs.ensureDir(to);
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
