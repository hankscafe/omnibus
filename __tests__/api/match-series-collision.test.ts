// /api/library/match-series — the folder-collision guard (field report by robotshavehearts2). When
// the folder a match would use already belongs to ANOTHER series, nothing is written and the caller
// is told who owns it and what it could do instead; a resolution sent back either attaches the
// volume to the owner as a collected edition or takes a folder name of its own.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/library/match-series/route';
import fs from 'fs';
import { makePostJson } from '../helpers/request';

const mocks = vi.hoisted(() => ({
    findManyLibraries: vi.fn(), findUniqueSetting: vi.fn(), findUniqueSeries: vi.fn(), findFirstSeries: vi.fn(),
    createSeries: vi.fn(), updateSeries: vi.fn(), deleteSeries: vi.fn(), findManySettings: vi.fn(),
    findManyRequests: vi.fn(), updateManyRequests: vi.fn(), findManyIssues: vi.fn(), updateManyIssues: vi.fn(),
    findFirstIssue: vi.fn(), createIssue: vi.fn(), updateIssue: vi.fn(),
    safeRelocateFolder: vi.fn(), moveFileSafe: vi.fn(),
    folderOwner: vi.fn(), suggestFreeFolderName: vi.fn(), attachAsCollected: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: vi.fn().mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } }) }));
vi.mock('@/lib/db', () => ({
    prisma: {
        library: { findMany: mocks.findManyLibraries },
        systemSetting: { findMany: mocks.findManySettings, findUnique: mocks.findUniqueSetting },
        series: { findUnique: mocks.findUniqueSeries, findFirst: mocks.findFirstSeries, create: mocks.createSeries, update: mocks.updateSeries, delete: mocks.deleteSeries },
        issue: { findMany: mocks.findManyIssues, updateMany: mocks.updateManyIssues, findFirst: mocks.findFirstIssue, create: mocks.createIssue, update: mocks.updateIssue },
        request: { findMany: mocks.findManyRequests, updateMany: mocks.updateManyRequests },
    }
}));
vi.mock('axios');
vi.mock('@/lib/api-client', async () => { const axios = (await import('axios')).default; return { apiClient: { get: axios.get } }; });
vi.mock('fs', () => ({
    default: {
        existsSync: vi.fn().mockReturnValue(true), mkdirSync: vi.fn(),
        promises: { stat: vi.fn().mockResolvedValue({ isFile: () => false }), readdir: vi.fn().mockResolvedValue([]), rename: vi.fn(), mkdir: vi.fn(), rmdir: vi.fn(), writeFile: vi.fn() },
    }
}));
vi.mock('@/lib/manga-detector', () => ({ detectManga: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/metadata/providers/metron', () => ({ MetronProvider: class { getSeriesDetails = vi.fn() } }));
vi.mock('@/lib/queue', () => ({ omnibusQueue: { add: vi.fn().mockResolvedValue({}) } }));
vi.mock('@/lib/discord', () => ({ DiscordNotifier: { sendAlert: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));
vi.mock('@/lib/utils/safe-fs', () => ({
    safeRelocateFolder: mocks.safeRelocateFolder, moveFileSafe: mocks.moveFileSafe, cleanupEmptyDirs: vi.fn(), ensureLibraryDir: vi.fn(),
}));
vi.mock('@/lib/match-collision', () => ({
    folderOwner: mocks.folderOwner, suggestFreeFolderName: mocks.suggestFreeFolderName, attachAsCollected: mocks.attachAsCollected,
}));

const createReq = makePostJson('http://localhost/api/library/match-series');
const OWNER = { id: 's1', name: 'Saga', year: 2012, publisher: 'Image', metadataSource: 'COMICVINE', metadataId: '49976', folderPath: '/comics/Image/Saga (2012)', isManga: false };
// The TPB volume: same name, same year → the same computed folder.
const tpbMatch = (extra: any = {}) => ({ oldFolderPath: '/unmatched/Saga TPB', metadataId: '55555', metadataSource: 'COMICVINE', name: 'Saga', year: '2012', publisher: 'Image', ...extra });

describe('match-series — folder collision guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(fs.existsSync).mockReturnValue(true);
        process.env.OMNIBUS_AWAITING_MATCH_DIR = '/unmatched';
        mocks.findManyLibraries.mockResolvedValue([{ id: 'lib_1', path: '/comics', isDefault: true, isManga: false }]);
        mocks.findUniqueSetting.mockResolvedValue(null); // no CV key → the body's name/year/publisher are used
        mocks.findUniqueSeries.mockResolvedValue(null);  // nothing matched to the TPB volume yet
        mocks.findFirstSeries.mockResolvedValue({ id: 's_unm', folderPath: '/unmatched/Saga TPB', libraryId: null, isManga: false });
        mocks.findManySettings.mockResolvedValue([]);
        mocks.findManyRequests.mockResolvedValue([]);
        mocks.findManyIssues.mockResolvedValue([]);
        mocks.findFirstIssue.mockResolvedValue(null);
        mocks.updateSeries.mockResolvedValue({ id: 's_unm', folderPath: '/comics/Image/Saga (2012) (TPB)', year: 2012 });
        mocks.createSeries.mockResolvedValue({ id: 's_new', folderPath: '/comics/Image/Saga (2012) (TPB)', year: 2012 });
        mocks.safeRelocateFolder.mockResolvedValue({ conflicts: 0 });
        mocks.folderOwner.mockResolvedValue(null);
        mocks.suggestFreeFolderName.mockResolvedValue('Saga (2012) (2)');
        mocks.attachAsCollected.mockResolvedValue({ attachmentId: 'attX', moved: 1, absorbed: 1, claimed: 0, skeletonsReplaced: 1, conflicts: 0 });
    });

    it('refuses to give two series one folder: 409, who owns it, a free name to offer — and nothing written', async () => {
        mocks.folderOwner.mockResolvedValue(OWNER);

        const res = await POST(createReq(tpbMatch()));
        const body = await res.json();

        expect(res.status).toBe(409);
        expect(body.collision).toEqual(expect.objectContaining({
            seriesId: 's1', seriesName: 'Saga', year: 2012, folderPath: '/comics/Image/Saga (2012)',
            suggestedFolderName: 'Saga (2012) (2)', volumeName: 'Saga',
        }));
        expect(body.error).toMatch(/already belongs to/);
        expect(mocks.folderOwner).toHaveBeenCalledWith('/comics/Image/Saga (2012)', ['s_unm']);
        expect(mocks.updateSeries).not.toHaveBeenCalled();
        expect(mocks.createSeries).not.toHaveBeenCalled();
        expect(mocks.safeRelocateFolder).not.toHaveBeenCalled();
    });

    it('takes a folder name of its own when asked, and refuses one that is taken too', async () => {
        mocks.folderOwner.mockImplementation(async (p: string) => p === '/comics/Image/Saga (2012)' ? OWNER : null);

        const res = await POST(createReq(tpbMatch({ collision: { mode: 'rename', folderName: 'Saga (2012) (TPB)' } })));
        expect(res.status).toBe(200);
        expect(mocks.updateSeries).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 's_unm' }, data: expect.objectContaining({ folderPath: '/comics/Image/Saga (2012) (TPB)' }),
        }));
        expect(mocks.safeRelocateFolder).toHaveBeenCalledWith('/unmatched/Saga TPB', '/comics/Image/Saga (2012) (TPB)', expect.any(String));

        vi.clearAllMocks();
        mocks.findManyLibraries.mockResolvedValue([{ id: 'lib_1', path: '/comics', isDefault: true, isManga: false }]);
        mocks.findFirstSeries.mockResolvedValue({ id: 's_unm', folderPath: '/unmatched/Saga TPB' });
        mocks.findManySettings.mockResolvedValue([]);
        mocks.folderOwner.mockResolvedValue(OWNER); // whatever name is tried, someone owns it
        mocks.suggestFreeFolderName.mockResolvedValue('Saga (2012) (2)');
        const taken = await POST(createReq(tpbMatch({ collision: { mode: 'rename', folderName: 'Saga (2012)' } })));
        expect(taken.status).toBe(409);
        expect(mocks.updateSeries).not.toHaveBeenCalled();
    });

    it('rejects a custom folder name it cannot use', async () => {
        mocks.folderOwner.mockResolvedValue(OWNER);
        for (const folderName of ['', '   ', 'Saga/2012', '..']) {
            const res = await POST(createReq(tpbMatch({ collision: { mode: 'rename', folderName } })));
            expect(res.status).toBe(400);
        }
        expect(mocks.updateSeries).not.toHaveBeenCalled();
    });

    it('attaches the volume to the owner as a collected edition when asked, and reports where the files went', async () => {
        mocks.folderOwner.mockResolvedValue(OWNER);

        const res = await POST(createReq(tpbMatch({ collision: { mode: 'attach' } })));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(mocks.attachAsCollected).toHaveBeenCalledWith(expect.objectContaining({
            owner: expect.objectContaining({ id: 's1' }),
            source: '/unmatched/Saga TPB', sourceSeriesId: 's_unm',
            metadataSource: 'COMICVINE', volumeId: '55555', volumeName: 'Saga', volumeYear: 2012,
        }));
        expect(body).toEqual(expect.objectContaining({ success: true, newPath: '/comics/Image/Saga (2012)', attachedTo: expect.objectContaining({ id: 's1', name: 'Saga' }), moved: 1, conflicts: 0 }));
        // The would-be second series is never created or repointed.
        expect(mocks.updateSeries).not.toHaveBeenCalled();
        expect(mocks.createSeries).not.toHaveBeenCalled();
        expect(mocks.safeRelocateFolder).not.toHaveBeenCalled();
    });

    it('surfaces an attach that could not complete as a 502, not a success', async () => {
        mocks.folderOwner.mockResolvedValue(OWNER);
        mocks.attachAsCollected.mockResolvedValue({ error: 'The engine is unreachable.' });

        const res = await POST(createReq(tpbMatch({ collision: { mode: 'attach' } })));
        expect(res.status).toBe(502);
        expect((await res.json()).error).toMatch(/engine is unreachable/);
    });
});

// #285 (Tobechukwu-Njoku): the volume is already in the library as series B, in a folder of its own.
// Matching folder A to it used to repoint B at A's folder with no warning, leaving B's issue rows
// pointing at B's old folder. Now nothing is written until the admin merges A into B (A's files move
// into B's folder, B keeps it) or cancels.
describe('match-series — the volume already belongs to another series', () => {
    const B = { id: 'sB', name: 'Series B', year: 2016, publisher: 'Pub', metadataSource: 'COMICVINE', metadataId: '12345', folderPath: '/comics/Pub/Series B (2016)', isManga: false, libraryId: 'lib_1', imprint: null, hasCustomCover: false };
    const A_FOLDER = '/comics/Pub/Series A (2016)';
    const matchA = (extra: any = {}) => ({ oldFolderPath: A_FOLDER, metadataId: '12345', metadataSource: 'COMICVINE', name: 'Series A', year: '2016', publisher: 'Pub', ...extra });

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.promises.stat).mockResolvedValue({ isFile: () => false } as any);
        process.env.OMNIBUS_AWAITING_MATCH_DIR = '/unmatched';
        mocks.findManyLibraries.mockResolvedValue([{ id: 'lib_1', path: '/comics', isDefault: true, isManga: false }]);
        mocks.findUniqueSetting.mockResolvedValue(null);
        mocks.findUniqueSeries.mockResolvedValue(B);
        mocks.findFirstSeries.mockResolvedValue({ id: 'sA', folderPath: A_FOLDER, libraryId: 'lib_1', isManga: false });
        mocks.findManySettings.mockResolvedValue([]);
        mocks.findManyRequests.mockResolvedValue([]);
        mocks.findManyIssues.mockResolvedValue([]);
        mocks.findFirstIssue.mockResolvedValue(null);
        mocks.updateManyIssues.mockResolvedValue({ count: 0 });
        mocks.deleteSeries.mockResolvedValue({});
        mocks.updateSeries.mockResolvedValue({ ...B });
        mocks.safeRelocateFolder.mockResolvedValue({ conflicts: 0 });
        mocks.moveFileSafe.mockResolvedValue(undefined);
        mocks.folderOwner.mockResolvedValue(null);
    });

    it('refuses with a 409 that names the series and its folder, and writes nothing', async () => {
        const res = await POST(createReq(matchA()));
        const body = await res.json();

        expect(res.status).toBe(409);
        expect(body.collision).toEqual(expect.objectContaining({
            kind: 'volume', seriesId: 'sB', seriesName: 'Series B', year: 2016, folderPath: '/comics/Pub/Series B (2016)',
            metadataSource: 'COMICVINE', metadataId: '12345', volumeName: 'Series A', sourceIsFile: false,
        }));
        expect(body.error).toMatch(/already in your library as Series B \(2016\)/);
        expect(mocks.updateSeries).not.toHaveBeenCalled();
        expect(mocks.deleteSeries).not.toHaveBeenCalled();
        expect(mocks.updateManyIssues).not.toHaveBeenCalled();
        expect(mocks.safeRelocateFolder).not.toHaveBeenCalled();
        expect(mocks.moveFileSafe).not.toHaveBeenCalled();
    });

    it('a folder-collision answer (attach or rename) still does not get past it', async () => {
        for (const collision of [{ mode: 'attach' }, { mode: 'rename', folderName: 'Series A (2016) (2)' }]) {
            const res = await POST(createReq(matchA({ collision })));
            expect(res.status).toBe(409);
            expect((await res.json()).collision.kind).toBe('volume');
        }
        expect(mocks.attachAsCollected).not.toHaveBeenCalled();
        expect(mocks.updateSeries).not.toHaveBeenCalled();
    });

    it('merges the folder into that series when asked: the files move into its folder and it keeps that folder', async () => {
        const res = await POST(createReq(matchA({ collision: { mode: 'merge' } })));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(mocks.safeRelocateFolder).toHaveBeenCalledWith(A_FOLDER, '/comics/Pub/Series B (2016)', expect.any(String));
        expect(mocks.updateManyIssues).toHaveBeenCalledWith({ where: { seriesId: 'sA' }, data: { seriesId: 'sB' } });
        expect(mocks.deleteSeries).toHaveBeenCalledWith({ where: { id: 'sA' } });
        expect(mocks.updateSeries).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'sB' }, data: expect.objectContaining({ folderPath: '/comics/Pub/Series B (2016)' }),
        }));
        expect(body.newPath).toBe('/comics/Pub/Series B (2016)');
    });

    it('a loose file is asked about too, and merged into that series\' folder', async () => {
        vi.mocked(fs.promises.stat).mockResolvedValue({ isFile: () => true } as any);
        mocks.findFirstSeries.mockResolvedValue(null); // a loose file has no row of its own
        // path.join answers with "\" on Windows.
        vi.mocked(fs.existsSync).mockImplementation((p: any) => String(p).replace(/\\/g, '/') !== '/comics/Pub/Series B (2016)/Series A 003.cbz');
        const file = { oldFolderPath: '/unmatched/Series A 003.cbz' };

        const refused = await POST(createReq(matchA(file)));
        expect(refused.status).toBe(409);
        expect((await refused.json()).collision).toEqual(expect.objectContaining({ kind: 'volume', seriesId: 'sB', sourceIsFile: true }));
        expect(mocks.moveFileSafe).not.toHaveBeenCalled();

        const merged = await POST(createReq(matchA({ ...file, collision: { mode: 'merge' } })));
        expect(merged.status).toBe(200);
        expect(mocks.moveFileSafe).toHaveBeenCalledWith('/unmatched/Series A 003.cbz', expect.stringMatching(/^[\\/]comics[\\/]Pub[\\/]Series B \(2016\)[\\/]Series A 003\.cbz$/));
        expect(mocks.updateSeries).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'sB' }, data: expect.objectContaining({ folderPath: '/comics/Pub/Series B (2016)' }),
        }));
    });

    it('does not ask when the folder the match computes IS that series\' folder (the everyday merge)', async () => {
        mocks.findUniqueSeries.mockResolvedValue({ ...B, folderPath: '/comics/Pub/Series A (2016)' });
        mocks.findFirstSeries.mockResolvedValue({ id: 'sU', folderPath: '/unmatched/Series A', libraryId: null, isManga: false });

        const res = await POST(createReq(matchA({ oldFolderPath: '/unmatched/Series A' })));
        expect(res.status).toBe(200);
        expect(mocks.safeRelocateFolder).toHaveBeenCalledWith('/unmatched/Series A', '/comics/Pub/Series A (2016)', expect.any(String));
    });

    it('does not ask when that series\' folder is gone from disk: the series takes the new one', async () => {
        vi.mocked(fs.existsSync).mockImplementation((p: any) => String(p) !== '/comics/Pub/Series B (2016)');

        const res = await POST(createReq(matchA()));
        expect(res.status).toBe(200);
        expect(mocks.updateSeries).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'sB' }, data: expect.objectContaining({ folderPath: A_FOLDER }),
        }));
    });

    it('does not ask when the folder being matched is that series\' own (a Fix Match that renames its folder)', async () => {
        mocks.findFirstSeries.mockResolvedValue({ ...B });

        const res = await POST(createReq(matchA({ oldFolderPath: '/comics/Pub/Series B (2016)' })));
        expect(res.status).toBe(200);
        expect(mocks.safeRelocateFolder).toHaveBeenCalledWith('/comics/Pub/Series B (2016)', A_FOLDER, expect.any(String));
    });

    it('nor when its own folder comes spelled another way, so the row lookup by path finds nothing', async () => {
        mocks.findFirstSeries.mockResolvedValue(null);

        const res = await POST(createReq(matchA({ oldFolderPath: '/comics/Pub/Series B (2016)/' })));
        expect(res.status).toBe(200);
        expect(mocks.updateSeries).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'sB' }, data: expect.objectContaining({ folderPath: A_FOLDER }),
        }));
    });
});
