import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deleteUsenetSource, isStrictSubPath } from '@/lib/utils/usenet-cleanup';
import fs from 'fs-extra';

// Issue #198: the guard matrix here is the safety story for a feature whose whole job is deleting
// user files — every refusal branch gets pinned.

const mocks = vi.hoisted(() => ({
    findManyLibraries: vi.fn(),
    log: vi.fn(),
}));

vi.mock('fs-extra', () => ({
    default: {
        existsSync: vi.fn().mockReturnValue(true),
        remove: vi.fn().mockResolvedValue(undefined),
    }
}));

vi.mock('@/lib/db', () => ({
    prisma: { library: { findMany: mocks.findManyLibraries } }
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

// Identity mapping — resolution behavior itself is path-resolver's own test surface.
vi.mock('@/lib/utils/path-resolver', () => ({ resolveRemotePath: vi.fn(async (p: string) => p) }));

const baseOpts = {
    clientType: 'nzbget',
    clientRoot: '/nzbget/comics',
    sourcePath: '/nzbget/comics/COMIC 001 (2026)',
    reason: 'imported' as const,
};

describe('Usenet Cleanup: deleteUsenetSource (issue #198)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.remove).mockResolvedValue(undefined as any);
        mocks.findManyLibraries.mockResolvedValue([{ path: '/library/comics' }]);
    });

    it('deletes a job folder strictly inside the client root', async () => {
        const result = await deleteUsenetSource(baseOpts);

        expect(result).toBe(true);
        expect(fs.remove).toHaveBeenCalledWith('/nzbget/comics/COMIC 001 (2026)');
        expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining('Deleted imported usenet download'), 'info');
    });

    it('refuses torrent client types — deleting a torrent payload breaks seeding', async () => {
        for (const clientType of ['qbit', 'deluge', null, undefined]) {
            expect(await deleteUsenetSource({ ...baseOpts, clientType })).toBe(false);
        }
        expect(fs.remove).not.toHaveBeenCalled();
    });

    it('refuses when the source IS the client root (empty job name would nuke the category folder)', async () => {
        const result = await deleteUsenetSource({ ...baseOpts, sourcePath: '/nzbget/comics' });

        expect(result).toBe(false);
        expect(fs.remove).not.toHaveBeenCalled();
        expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining('not strictly inside'), 'warn');
    });

    it('refuses a source that resolved outside the client root', async () => {
        const result = await deleteUsenetSource({ ...baseOpts, sourcePath: '/somewhere/else/job' });

        expect(result).toBe(false);
        expect(fs.remove).not.toHaveBeenCalled();
    });

    it('refuses when the source overlaps a library root in any direction', async () => {
        // Client root misconfigured to contain the library: source == library, inside it, or above it.
        mocks.findManyLibraries.mockResolvedValue([{ path: '/nzbget/comics/COMIC 001 (2026)/nested-lib' }]);
        expect(await deleteUsenetSource(baseOpts)).toBe(false);

        mocks.findManyLibraries.mockResolvedValue([{ path: '/nzbget/comics' }]);
        expect(await deleteUsenetSource(baseOpts)).toBe(false);

        mocks.findManyLibraries.mockResolvedValue([{ path: '/nzbget/comics/COMIC 001 (2026)' }]);
        expect(await deleteUsenetSource(baseOpts)).toBe(false);

        expect(fs.remove).not.toHaveBeenCalled();
    });

    it('refuses when the source overlaps the watched folder', async () => {
        const result = await deleteUsenetSource({
            ...baseOpts,
            clientRoot: '/',
            sourcePath: '/watched',
        });

        expect(result).toBe(false);
        expect(fs.remove).not.toHaveBeenCalled();
    });

    it('quietly no-ops when the source is already gone', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const result = await deleteUsenetSource(baseOpts);

        expect(result).toBe(false);
        expect(fs.remove).not.toHaveBeenCalled();
        // Nothing to warn about — the files being gone is the desired end state.
        expect(mocks.log).not.toHaveBeenCalledWith(expect.stringContaining('Refusing'), 'warn');
    });

    it('never throws when the delete fails (read-only mount) — the import already succeeded', async () => {
        vi.mocked(fs.remove).mockRejectedValue(new Error('EACCES: permission denied'));

        const result = await deleteUsenetSource(baseOpts);

        expect(result).toBe(false);
        expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining('EACCES'), 'warn');
    });
});

describe('Usenet Cleanup: isStrictSubPath', () => {
    it('is strict about equality and traversal', () => {
        expect(isStrictSubPath('/downloads', '/downloads/job')).toBe(true);
        expect(isStrictSubPath('/downloads', '/downloads/a/b/c.cbz')).toBe(true);
        expect(isStrictSubPath('/downloads', '/downloads')).toBe(false);
        expect(isStrictSubPath('/downloads', '/downloads/../etc')).toBe(false);
        expect(isStrictSubPath('/downloads', '/downloads-other/job')).toBe(false);
    });
});
