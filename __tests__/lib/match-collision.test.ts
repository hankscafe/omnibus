// Folder collisions at match time (field report by robotshavehearts2: "Image does it a lot" — an
// issues volume and its TPB volume share a name and a year, so they compute the SAME folder). Two
// series can never own one folder. These pin the pieces: who owns a folder, a free name to offer,
// and the attach-as-collected resolution that puts the trade under the series it collects.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

const mocks = vi.hoisted(() => ({
    seriesFindMany: vi.fn(), seriesDelete: vi.fn(),
    avUpsert: vi.fn(),
    issueFindMany: vi.fn(), issueUpdate: vi.fn(), issueDelete: vi.fn(), issueCreate: vi.fn(), issueCount: vi.fn(),
    engineFetchLong: vi.fn(),
    moveFileSafe: vi.fn(), cleanupEmptyDirs: vi.fn(), ensureLibraryDir: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findMany: mocks.seriesFindMany, delete: mocks.seriesDelete },
        attachedVolume: { upsert: mocks.avUpsert },
        issue: { findMany: mocks.issueFindMany, update: mocks.issueUpdate, delete: mocks.issueDelete, create: mocks.issueCreate, count: mocks.issueCount },
    },
}));
vi.mock('@/lib/engine', () => ({ ENGINE_URL: 'http://engine', engineHeaders: (e: any) => ({ ...e }), engineFetchLong: mocks.engineFetchLong }));
vi.mock('@/lib/utils/safe-fs', () => ({ moveFileSafe: mocks.moveFileSafe, cleanupEmptyDirs: mocks.cleanupEmptyDirs, ensureLibraryDir: mocks.ensureLibraryDir }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));
vi.mock('fs', () => ({
    default: { existsSync: vi.fn(() => false), promises: { stat: vi.fn(), readdir: vi.fn(async () => []) } },
}));

import { sameFolder, folderOwner, suggestFreeFolderName, attachAsCollected } from '@/lib/match-collision';

const OWNER = { id: 's1', name: 'Saga', year: 2012, publisher: 'Image', metadataSource: 'COMICVINE', metadataId: '49976', folderPath: '/comics/Image/Saga (2012)', isManga: false };

describe('sameFolder / folderOwner', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('compares folders the way the disk does: slashes, case, and a trailing separator do not matter', () => {
        expect(sameFolder('/comics/Image/Saga (2012)', '\\comics\\image\\SAGA (2012)\\')).toBe(true);
        expect(sameFolder('/comics/Image/Saga (2012)', '/comics/Image/Saga (2012) (2)')).toBe(false);
        expect(sameFolder('/comics/Image/Saga', '/comics/Image/Saga (2012)')).toBe(false);
    });

    it('finds the series that owns a folder, and never the rows this match is allowed to repoint', async () => {
        mocks.seriesFindMany.mockResolvedValue([
            { ...OWNER },
            { id: 's_other', name: 'Saga: Compendium', folderPath: '/comics/Image/Saga Compendium (2019)' },
        ]);
        expect(await folderOwner('/comics/image/saga (2012)/', [])).toEqual(expect.objectContaining({ id: 's1', name: 'Saga' }));
        expect(await folderOwner('/comics/Image/Saga (2012)', ['s1'])).toBeNull();
        expect(await folderOwner('/comics/Image/Nowhere (2012)', [])).toBeNull();
    });
});

describe('suggestFreeFolderName', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('offers the first numbered name no series owns and no folder occupies', async () => {
        mocks.seriesFindMany.mockResolvedValue([{ ...OWNER }, { id: 's2', name: 'Saga', folderPath: '/comics/Image/Saga (2012) (2)' }]);
        vi.mocked(fs.existsSync).mockImplementation((p: any) => String(p).replace(/\\/g, '/') === '/comics/Image/Saga (2012) (3)');
        expect(await suggestFreeFolderName('/comics/Image/Saga (2012)', [])).toBe('Saga (2012) (4)');
    });
});

describe('attachAsCollected', () => {
    const input = {
        owner: OWNER,
        source: '/unmatched/Saga TPB',
        sourceSeriesId: 's_unm',
        metadataSource: 'COMICVINE', volumeId: '55555', volumeName: 'Saga', volumeYear: 2012,
        config: {},
        libraryRoots: ['/comics', '/unmatched'],
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(fs.existsSync).mockReturnValue(false);
        vi.mocked(fs.promises.stat as any).mockResolvedValue({ isFile: () => false });
        // The folder as the disk lists it — the row for it (below) is matched by path.
        vi.mocked(fs.promises.readdir as any).mockResolvedValue(['Saga v01.cbz', 'cover.jpg']);
        mocks.avUpsert.mockResolvedValue({ id: 'attX' });
        mocks.engineFetchLong.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, results: [{ total: 1, created: 1 }] }) });
        mocks.issueUpdate.mockResolvedValue({});
        mocks.issueDelete.mockResolvedValue({});
        mocks.issueCreate.mockResolvedValue({ id: 'new1' });
        mocks.issueCount.mockResolvedValue(0);
        mocks.seriesDelete.mockResolvedValue({});
        mocks.issueFindMany.mockImplementation(async ({ where }: any) => {
            // The lane after the engine's sync: one provider skeleton, "Vol. 1".
            if (where.attachedVolumeId === 'attX') return [{ id: 'sk1', number: '1', filePath: null, metadataId: '900001', metadataSource: 'COMICVINE', name: 'Vol. 1: Chapter One', coverUrl: 'c.jpg', releaseDate: '2012-10-01', description: null, coversIssues: '1-6', isAnnual: false }];
            // The unmatched folder's own rows.
            if (where.seriesId === 's_unm') return [{ id: 'u1', number: '1', filePath: '/unmatched/Saga TPB/Saga v01.cbz', metadataId: 'unmatched_x', isAnnual: false }];
            return [];
        });
    });

    it('attaches the volume to the owner, absorbs the folder row into the lane as the skeleton it replaces, and moves the file under the collected name', async () => {
        const result = await attachAsCollected(input);

        expect(mocks.avUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { seriesId_metadataSource_volumeId: { seriesId: 's1', metadataSource: 'COMICVINE', volumeId: '55555' } },
            create: expect.objectContaining({ seriesId: 's1', kind: 'COLLECTED', name: 'Saga', startYear: 2012 }),
        }));
        expect(mocks.engineFetchLong).toHaveBeenCalledWith('http://engine/api/metadata/attach-sync', expect.objectContaining({ body: JSON.stringify({ attachment_id: 'attX', claim: true }) }));
        // The file lands in the owner's folder under the collected pattern.
        expect(mocks.moveFileSafe).toHaveBeenCalledWith('/unmatched/Saga TPB/Saga v01.cbz', '/comics/Image/Saga (2012)/Saga Vol. 01 (2012).cbz');
        // The owning row survives and BECOMES the provider book; the skeleton goes.
        expect(mocks.issueDelete).toHaveBeenCalledWith({ where: { id: 'sk1' } });
        expect(mocks.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'u1' },
            data: expect.objectContaining({
                seriesId: 's1', attachedVolumeId: 'attX', metadataId: '900001', metadataSource: 'COMICVINE', matchState: 'MATCHED',
                filePath: '/comics/Image/Saga (2012)/Saga Vol. 01 (2012).cbz', status: 'DOWNLOADED', name: 'Vol. 1: Chapter One',
                coversIssues: '1-6', // the sync's provider prefill travels with the identity
            }),
        }));
        // Nothing left in the unmatched series → it goes; its folder is tidied.
        expect(mocks.seriesDelete).toHaveBeenCalledWith({ where: { id: 's_unm' } });
        expect(mocks.cleanupEmptyDirs).toHaveBeenCalledWith('/unmatched/Saga TPB', '/unmatched');
        expect(result).toEqual(expect.objectContaining({ attachmentId: 'attX', moved: 1, absorbed: 1, skeletonsReplaced: 1, conflicts: 0 }));
    });

    it('leaves a file whose collected name is already taken exactly where it is — row, folder and series untouched', async () => {
        vi.mocked(fs.existsSync).mockImplementation((p: any) => String(p).replace(/\\/g, '/') === '/comics/Image/Saga (2012)/Saga Vol. 01 (2012).cbz');
        mocks.issueCount.mockResolvedValue(1);

        const result = await attachAsCollected(input);

        expect(mocks.moveFileSafe).not.toHaveBeenCalled();
        expect(mocks.issueUpdate).not.toHaveBeenCalled();
        expect(mocks.issueDelete).not.toHaveBeenCalled();
        expect(mocks.seriesDelete).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({ moved: 0, absorbed: 0, conflicts: 1 }));
    });

    it('moves a folder that has no rows yet — just dropped into /unmatched — claiming the skeleton per file', async () => {
        const result = await attachAsCollected({ ...input, sourceSeriesId: null });

        expect(mocks.moveFileSafe).toHaveBeenCalledWith('/unmatched/Saga TPB/Saga v01.cbz', '/comics/Image/Saga (2012)/Saga Vol. 01 (2012).cbz');
        expect(mocks.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'sk1' }, data: expect.objectContaining({ filePath: '/comics/Image/Saga (2012)/Saga Vol. 01 (2012).cbz' }) }));
        expect(mocks.seriesDelete).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({ moved: 1, claimed: 1, absorbed: 0, conflicts: 0 }));
    });

    it('claims the skeleton for a loose file, which has no row of its own', async () => {
        vi.mocked(fs.promises.stat as any).mockResolvedValue({ isFile: () => true });

        const result = await attachAsCollected({ ...input, source: '/unmatched/Saga v01.cbz', sourceSeriesId: null });

        expect(mocks.moveFileSafe).toHaveBeenCalledWith('/unmatched/Saga v01.cbz', '/comics/Image/Saga (2012)/Saga Vol. 01 (2012).cbz');
        expect(mocks.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'sk1' },
            data: expect.objectContaining({ filePath: '/comics/Image/Saga (2012)/Saga Vol. 01 (2012).cbz', status: 'DOWNLOADED' }),
        }));
        expect(mocks.issueDelete).not.toHaveBeenCalled();
        expect(mocks.seriesDelete).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({ moved: 1, claimed: 1, conflicts: 0 }));
    });

    // Issue.fileAddedAt (#206 follow-up): a file that brings its own row keeps that row's arrival
    // time (it was announced when the scan found it); a file with no row is new to the library.
    it('keeps the arrival time on a row that brings its file along, and stamps a file that had no row', async () => {
        await attachAsCollected(input);
        const absorbed = mocks.issueUpdate.mock.calls.map(c => c[0]).find(c => c.where.id === 'u1');
        expect('fileAddedAt' in absorbed.data).toBe(false);

        vi.clearAllMocks();
        vi.mocked(fs.promises.stat as any).mockResolvedValue({ isFile: () => true });
        mocks.avUpsert.mockResolvedValue({ id: 'attX' });
        mocks.engineFetchLong.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, results: [{ total: 1, created: 1 }] }) });
        const before = Date.now();
        await attachAsCollected({ ...input, source: '/unmatched/Saga v01.cbz', sourceSeriesId: null });
        const claimed = mocks.issueUpdate.mock.calls.map(c => c[0]).find(c => c.where.id === 'sk1');
        expect(claimed.data.fileAddedAt).toBeInstanceOf(Date);
        expect(claimed.data.fileAddedAt.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('stops before touching a file when the engine cannot import the volume', async () => {
        mocks.engineFetchLong.mockResolvedValue({ ok: false, status: 502, json: async () => ({ error: 'ComicVine down' }) });

        const result = await attachAsCollected(input);

        expect(result.error).toMatch(/ComicVine down/);
        expect(mocks.moveFileSafe).not.toHaveBeenCalled();
        expect(mocks.issueUpdate).not.toHaveBeenCalled();
    });

    // A LOCAL collected edition — one ComicVine has no volume for: no provider lane, no skeletons, no
    // engine. The files keep their own names (the name rule is the only thing that can ever claim
    // them back after a wipe) and their rows become the lane's books outright.
    describe('LOCAL (no provider volume)', () => {
        const local = { ...input, metadataSource: 'LOCAL', volumeId: 'local_abc', volumeName: 'Saga Compendium' };

        it('moves the folder under the owner without renaming, and makes its rows the lane books — no engine, no twins', async () => {
            const result = await attachAsCollected(local);

            expect(mocks.avUpsert).toHaveBeenCalledWith(expect.objectContaining({
                create: expect.objectContaining({ seriesId: 's1', metadataSource: 'LOCAL', volumeId: 'local_abc', kind: 'COLLECTED', name: 'Saga Compendium' }),
            }));
            expect(mocks.engineFetchLong).not.toHaveBeenCalled();
            expect(mocks.moveFileSafe).toHaveBeenCalledWith('/unmatched/Saga TPB/Saga v01.cbz', '/comics/Image/Saga (2012)/Saga v01.cbz');
            expect(mocks.issueDelete).not.toHaveBeenCalled();
            expect(mocks.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
                where: { id: 'u1' },
                data: expect.objectContaining({
                    seriesId: 's1', attachedVolumeId: 'attX', metadataId: 'local_attX_1', metadataSource: 'LOCAL', matchState: 'MATCHED',
                    name: 'Vol. 1', filePath: '/comics/Image/Saga (2012)/Saga v01.cbz', status: 'DOWNLOADED', isAnnual: false,
                }),
            }));
            expect(mocks.seriesDelete).toHaveBeenCalledWith({ where: { id: 's_unm' } });
            expect(result).toEqual(expect.objectContaining({ attachmentId: 'attX', moved: 1, absorbed: 1, claimed: 0, skeletonsReplaced: 0, conflicts: 0 }));
        });

        it('creates the lane book for a loose file', async () => {
            vi.mocked(fs.promises.stat as any).mockResolvedValue({ isFile: () => true });

            const result = await attachAsCollected({ ...local, source: '/unmatched/Saga Compendium 01.cbz', sourceSeriesId: null });

            expect(mocks.moveFileSafe).toHaveBeenCalledWith('/unmatched/Saga Compendium 01.cbz', '/comics/Image/Saga (2012)/Saga Compendium 01.cbz');
            expect(mocks.issueCreate).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({
                    seriesId: 's1', attachedVolumeId: 'attX', number: '1', metadataId: 'local_attX_1', metadataSource: 'LOCAL', matchState: 'MATCHED',
                    name: 'Vol. 1', filePath: '/comics/Image/Saga (2012)/Saga Compendium 01.cbz', status: 'DOWNLOADED',
                }),
            }));
            expect(mocks.issueUpdate).not.toHaveBeenCalled();
            expect(result).toEqual(expect.objectContaining({ moved: 1, claimed: 1, absorbed: 0 }));
            // A loose file with no row of its own is new to the library.
            expect(mocks.issueCreate.mock.calls[0][0].data.fileAddedAt).toBeInstanceOf(Date);
        });
    });
});
