import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// Logger writes to disk/console; stub it. Everything else uses the REAL filesystem in a temp dir so
// the test actually proves the non-destructive behavior (the whole point of the data-loss fix).
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));

import { safeRelocateFolder, cleanupEmptyDirs } from '@/lib/utils/safe-fs';

let root: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-safefs-'));
});
afterEach(async () => {
    await fs.remove(root).catch(() => {});
});

describe('safeRelocateFolder', () => {
    it('merges into an existing target WITHOUT overwriting or deleting its files', async () => {
        const src = path.join(root, 'src');
        const dest = path.join(root, 'dest');
        await fs.ensureDir(src);
        await fs.ensureDir(dest);
        await fs.writeFile(path.join(src, 'A.cbz'), 'srcA');   // unique → should move
        await fs.writeFile(path.join(src, 'B.cbz'), 'srcB');   // conflicts with dest/B.cbz
        await fs.writeFile(path.join(dest, 'B.cbz'), 'destB'); // MUST survive untouched
        await fs.writeFile(path.join(dest, 'C.cbz'), 'destC'); // pre-existing, MUST survive

        const { conflicts } = await safeRelocateFolder(src, dest, root);

        expect(conflicts).toBe(1);
        // Destination keeps its originals AND gains the non-conflicting source file.
        expect(await fs.readFile(path.join(dest, 'A.cbz'), 'utf8')).toBe('srcA');
        expect(await fs.readFile(path.join(dest, 'B.cbz'), 'utf8')).toBe('destB'); // not clobbered
        expect(await fs.readFile(path.join(dest, 'C.cbz'), 'utf8')).toBe('destC');
        // The conflicting file is left behind in the source; the moved one is gone from source.
        expect(await fs.pathExists(path.join(src, 'A.cbz'))).toBe(false);
        expect(await fs.pathExists(path.join(src, 'B.cbz'))).toBe(true);
    });

    it('plain-moves when the target does not exist, then leaves no source folder', async () => {
        const src = path.join(root, 'src2');
        const dest = path.join(root, 'group', 'dest2');
        await fs.ensureDir(src);
        await fs.writeFile(path.join(src, 'A.cbz'), 'a');

        const { conflicts } = await safeRelocateFolder(src, dest, root);

        expect(conflicts).toBe(0);
        expect(await fs.readFile(path.join(dest, 'A.cbz'), 'utf8')).toBe('a');
        expect(await fs.pathExists(src)).toBe(false);
    });
});

describe('cleanupEmptyDirs', () => {
    it('removes empty dirs up the tree but never one that still holds files', async () => {
        const keep = path.join(root, 'pub', 'keep');
        const empty = path.join(root, 'pub', 'group', 'empty');
        await fs.ensureDir(keep);
        await fs.ensureDir(empty);
        await fs.writeFile(path.join(keep, 'x.cbz'), 'x');

        await cleanupEmptyDirs(empty, root);

        // The empty leaf + its now-empty parent are removed...
        expect(await fs.pathExists(empty)).toBe(false);
        expect(await fs.pathExists(path.join(root, 'pub', 'group'))).toBe(false);
        // ...but 'pub' survives (it still contains 'keep'), and 'keep' + its file are untouched.
        expect(await fs.pathExists(keep)).toBe(true);
        expect(await fs.readFile(path.join(keep, 'x.cbz'), 'utf8')).toBe('x');
    });
});
