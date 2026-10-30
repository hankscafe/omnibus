// #261: the unmatched folder must be one the watched-folder sweep never reads. When unmatched IS the
// watched folder (one host folder mounted at both paths counts) or sits inside it, a file parked
// there is swept again on the next run: 1.4.9 renamed it "(copy 1)" every time, and the cross-mount
// move before that deleted it. Paths can't show two mounts of one folder, so a probe file is written
// to unmatched and looked for the way the engine's sweep walks watched: recursively, hidden entries
// skipped, links not followed. Parity: omnibus-engine watched_sync.rs `probe_reaches`.
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export async function unmatchedReachableFromWatched(watchedDir: string, unmatchedDir: string): Promise<boolean> {
    // Not a dot-name (the walk skips those) and never a comic extension, so nothing else picks it up.
    const name = `omnibus-unmatched-check-${randomUUID()}.tmp`;
    const probe = path.join(unmatchedDir, name);
    try {
        await fs.promises.writeFile(probe, '');
    } catch {
        // Nothing can be parked in a folder nothing can be written to, so there is nothing to stop.
        return false;
    }
    try {
        return await holds(watchedDir, name);
    } finally {
        await fs.promises.rm(probe, { force: true }).catch(() => {});
    }
}

async function holds(dir: string, name: string): Promise<boolean> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
        return false;
    }
    const visible = entries.filter(e => !e.name.startsWith('.'));
    if (visible.some(e => e.name === name)) return true;
    for (const e of visible) {
        if (e.isDirectory() && await holds(path.join(dir, e.name), name)) return true;
    }
    return false;
}
