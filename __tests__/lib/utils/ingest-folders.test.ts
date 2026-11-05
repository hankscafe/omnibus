import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createdOnFirstSweep, unmatchedReachableFromWatched } from '@/lib/utils/ingest-folders';

// #261: a file parked in unmatched must never be swept again from watched. The probe is written to
// unmatched and looked for the way the engine's sweep walks watched (hidden entries skipped), so
// one host folder mounted at both paths is seen too. Parity: watched_sync.rs `probe_reaches`.
describe('unmatchedReachableFromWatched', () => {
    let base: string;

    beforeEach(() => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-ingest-'));
    });

    afterEach(() => {
        fs.rmSync(base, { recursive: true, force: true });
    });

    const names = (dir: string) => fs.readdirSync(dir).sort();

    it('sees unmatched when it is the watched folder', async () => {
        const shared = path.join(base, 'quarantine');
        fs.mkdirSync(shared);

        expect(await unmatchedReachableFromWatched(shared, shared)).toBe(true);
        expect(names(shared)).toEqual([]);
    });

    it('sees unmatched anywhere inside the watched folder', async () => {
        const watched = path.join(base, 'watched');
        const unmatched = path.join(watched, 'deeper', 'unmatched');
        fs.mkdirSync(unmatched, { recursive: true });

        expect(await unmatchedReachableFromWatched(watched, unmatched)).toBe(true);
        expect(names(unmatched)).toEqual([]);
    });

    it('leaves a folder of its own alone', async () => {
        const watched = path.join(base, 'watched');
        const unmatched = path.join(base, 'unmatched');
        fs.mkdirSync(path.join(watched, 'Batman'), { recursive: true });
        fs.writeFileSync(path.join(watched, 'Batman', 'Batman 001.cbz'), 'x');
        fs.mkdirSync(unmatched);

        expect(await unmatchedReachableFromWatched(watched, unmatched)).toBe(false);
        expect(names(unmatched)).toEqual([]);
        expect(names(watched)).toEqual(['Batman']);
    });

    it('ignores unmatched inside a hidden folder, which the sweep never reads', async () => {
        const watched = path.join(base, 'watched');
        const unmatched = path.join(watched, '.unmatched');
        fs.mkdirSync(unmatched, { recursive: true });

        expect(await unmatchedReachableFromWatched(watched, unmatched)).toBe(false);
        expect(names(unmatched)).toEqual([]);
    });

    it('finds nothing when the probe cannot be written (parking there would fail too)', async () => {
        const watched = path.join(base, 'watched');
        fs.mkdirSync(watched);

        expect(await unmatchedReachableFromWatched(watched, path.join(watched, 'missing'))).toBe(false);
        expect(names(watched)).toEqual([]);
    });
});

// #269: a new install's watched and unmatched folders don't exist until the engine's first sweep
// creates them. That's fine on a mounted volume, and worth a warning when they'd land inside the
// container.
describe('createdOnFirstSweep', () => {
    let base: string;

    beforeEach(() => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-ingest-'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(base, { recursive: true, force: true });
    });

    // `/` is on the container's own filesystem (device 1), `mounted` on a volume (device 2).
    const devices = (mounted: string) => vi.spyOn(fs.promises, 'stat').mockImplementation(
        ((p: fs.PathLike) => Promise.resolve({ dev: p === mounted ? 2 : 1 } as fs.Stats)) as unknown as typeof fs.promises.stat,
    );

    it('is true on a mounted volume, where the sweep creates the folder', async () => {
        const stat = devices(base);

        expect(await createdOnFirstSweep(path.join(base, 'watched'))).toBe(true);
        expect(stat).toHaveBeenCalledWith(base);
        expect(stat).toHaveBeenCalledWith('/');
    });

    it('looks past missing folders to the nearest one that exists', async () => {
        const stat = devices(base);

        expect(await createdOnFirstSweep(path.join(base, 'inbox', 'comics', 'watched'))).toBe(true);
        expect(stat).toHaveBeenCalledWith(base);
    });

    it('is false with no volume mounted there: the folder would land inside the container', async () => {
        devices('/somewhere-else');

        expect(await createdOnFirstSweep(path.join(base, 'watched'))).toBe(false);
    });

    it('is false on a volume Omnibus cannot write to', async () => {
        devices(base);
        const access = vi.spyOn(fs.promises, 'access').mockRejectedValue(new Error('EACCES'));

        expect(await createdOnFirstSweep(path.join(base, 'watched'))).toBe(false);
        expect(access).toHaveBeenCalledWith(base, fs.constants.W_OK);
    });
});
