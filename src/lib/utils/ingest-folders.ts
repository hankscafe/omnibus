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

// #269: on a new install the watched and unmatched folders don't exist until the engine's first
// watched-folder sweep creates them (watched_sync.rs `sweep_folders`). That's only a problem when no
// volume is mounted for them, so they'd land in the container's own filesystem: then the nearest
// folder that does exist is on the same device as `/`. On a mounted volume we can write to, the sweep
// creates them where they belong.
export async function createdOnFirstSweep(dir: string): Promise<boolean> {
    let parent = path.dirname(dir);
    while (!fs.existsSync(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent);
    try {
        const [here, root] = await Promise.all([fs.promises.stat(parent), fs.promises.stat('/')]);
        if (here.dev === root.dev) return false;
        await fs.promises.access(parent, fs.constants.W_OK);
        return true;
    } catch {
        return false;
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
