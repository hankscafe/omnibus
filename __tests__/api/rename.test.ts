import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/library/rename/route';
import { NextRequest } from 'next/server';
import path from 'path';
import { auditLog } from '../helpers/setup-global';

const mocks = vi.hoisted(() => ({
    seriesFindMany: vi.fn(),
    issueFindMany: vi.fn(),
    libraryFindMany: vi.fn(),
    systemSettingFindMany: vi.fn(),
    seriesUpdate: vi.fn(),
    issueUpdate: vi.fn(),
    fsMove: vi.fn().mockResolvedValue(true),
    fsExistsSync: vi.fn(),
    log: vi.fn(),
    engineFetchLong: vi.fn(),
    auditLog: vi.fn(),
    mockSession: { user: { id: 'admin_1', role: 'ADMIN' } }
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findMany: mocks.seriesFindMany, update: mocks.seriesUpdate },
        issue: { findMany: mocks.issueFindMany, update: mocks.issueUpdate },
        library: { findMany: mocks.libraryFindMany },
        systemSetting: { findMany: mocks.systemSettingFindMany }
    }
}));

vi.mock('fs-extra', () => ({
    move: mocks.fsMove,
    existsSync: mocks.fsExistsSync,
    ensureDir: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue(true),
    copy: vi.fn().mockResolvedValue(true),
    default: { 
        move: mocks.fsMove, 
        existsSync: mocks.fsExistsSync, 
        ensureDir: vi.fn().mockResolvedValue(true),
        remove: vi.fn().mockResolvedValue(true),
        copy: vi.fn().mockResolvedValue(true)
    }
}));

vi.mock('next-auth/next', () => ({ getServerSession: vi.fn().mockResolvedValue(mocks.mockSession) }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn().mockResolvedValue(mocks.mockSession) }));
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn().mockResolvedValue(mocks.mockSession.user) }));
vi.mock('@/lib/auth', () => ({ getAuthSession: vi.fn().mockResolvedValue(mocks.mockSession) }));

vi.mock('@/lib/engine', () => ({
    ENGINE_URL: 'http://engine',
    engineHeaders: (extra?: Record<string, string>) => extra || {},
    engineFetchLong: mocks.engineFetchLong,
}));

describe('API Route: Bulk Library Renamer', () => {
    beforeEach(() => {
        // Default: engine offload unavailable → the route falls back to the local rename loop.
        mocks.engineFetchLong.mockRejectedValue(new Error('engine unavailable'));
        // The route now resolves the manga pattern BEFORE the engine offload, so every path reads
        // settings; individual tests override with their own values.
        mocks.systemSettingFindMany.mockResolvedValue([]);
    });

    it('returns the engine summary without running the local loop when the engine handles the job', async () => {
        mocks.engineFetchLong.mockResolvedValue({
            ok: true,
            json: async () => ({ filesRenamed: 7, foldersRenamed: 2, conflicts: 1, newPath: '/data/comics/DC Comics/Batman (2016)' })
        });

        const req = new NextRequest('http://localhost/api/library/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                seriesIds: ['series_1'],
                folderPattern: '{Publisher}/{Series} ({Year})',
                filePattern: '{Series} #{Issue}'
            })
        });

        const res = await POST(req);
        const data = await res.json();

        expect(data).toMatchObject({ success: true, filesRenamed: 7, foldersRenamed: 2, conflicts: 1, newPath: '/data/comics/DC Comics/Batman (2016)' });
        // The engine got snake_case params and the whole local pipeline was skipped.
        const body = JSON.parse(mocks.engineFetchLong.mock.calls[0][1].body);
        expect(body).toEqual({
            series_ids: ['series_1'],
            folder_pattern: '{Publisher}/{Series} ({Year})',
            file_pattern: '{Series} #{Issue}',
            manga_file_pattern: '{Series} Vol. {Issue}',
            // #203 COLLECTED: resolved alongside the others so the engine and the local fallback
            // name a trade identically. null = the engine's built-in default.
            collected_file_pattern: null
        });
        expect(mocks.seriesFindMany).not.toHaveBeenCalled();
        expect(mocks.fsMove).not.toHaveBeenCalled();
        // The audit entry still records the engine-reported counts.
        expect(auditLog).toHaveBeenCalledWith('BULK_RENAME_FILES', expect.objectContaining({ filesRenamed: 7, conflicts: 1 }), 'admin_1');
    });

    // 2026-07-25 worklist item 8: the manga file pattern existed but the standardize path leaked it
    // three ways — the engine payload never carried it, and the client's filePattern shadowed the
    // config value (`filePattern || config.manga_file_naming_pattern` was always the former).
    it('sends the CONFIG manga pattern to the engine even when the client supplies a comic filePattern', async () => {
        mocks.engineFetchLong.mockResolvedValue({
            ok: true,
            json: async () => ({ filesRenamed: 1, foldersRenamed: 0, conflicts: 0, newPath: '/x' })
        });
        mocks.systemSettingFindMany.mockResolvedValue([
            { key: 'manga_file_naming_pattern', value: '{Series} - Chapter {Issue}' }
        ]);

        const req = new NextRequest('http://localhost/api/library/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                seriesIds: ['series_1'],
                folderPattern: '{Publisher}/{Series} ({Year})',
                filePattern: '{Series} #{Issue}'
            })
        });
        await POST(req);

        const body = JSON.parse(mocks.engineFetchLong.mock.calls[0][1].body);
        expect(body.file_pattern).toBe('{Series} #{Issue}');
        expect(body.manga_file_pattern).toBe('{Series} - Chapter {Issue}');
    });

    it('lets an explicit client mangaFilePattern win over the config value', async () => {
        mocks.engineFetchLong.mockResolvedValue({
            ok: true,
            json: async () => ({ filesRenamed: 1, foldersRenamed: 0, conflicts: 0, newPath: '/x' })
        });
        mocks.systemSettingFindMany.mockResolvedValue([
            { key: 'manga_file_naming_pattern', value: '{Series} - Chapter {Issue}' }
        ]);

        const req = new NextRequest('http://localhost/api/library/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                seriesIds: ['series_1'],
                folderPattern: '{Publisher}/{Series} ({Year})',
                filePattern: '{Series} #{Issue}',
                mangaFilePattern: '{Series} c{Issue}'
            })
        });
        await POST(req);

        const body = JSON.parse(mocks.engineFetchLong.mock.calls[0][1].body);
        expect(body.manga_file_pattern).toBe('{Series} c{Issue}');
    });

    it.each([
        { pattern: '{Series} --- #{Issue}', filename: 'Batman - - #001.cbz' },
        { pattern: '{Series} #{Issue} [{Imprint}]', filename: 'Batman #001.cbz' },
    ])('cleans the Node fallback filename once before adding the extension: $pattern', async ({ pattern, filename }) => {
        mocks.libraryFindMany.mockResolvedValue([{ id: 'lib_1', path: '/data/comics' }]);
        mocks.fsExistsSync.mockImplementation((p: string | Buffer | URL) => !String(p).includes('#001'));
        mocks.seriesFindMany.mockResolvedValue([{
            id: 'series_1', libraryId: 'lib_1', folderPath: '/data/comics/Batman',
            publisher: 'DC Comics', name: 'Batman', year: 2016, isManga: false, imprint: null,
        }]);
        mocks.issueFindMany.mockResolvedValue([{
            id: 'issue_1', seriesId: 'series_1', filePath: '/data/comics/Batman/Batman 1.cbz',
            number: '1', releaseDate: '2016-01-01',
        }]);
        const res = await POST(new NextRequest('http://localhost/api/library/rename', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seriesIds: ['series_1'], folderPattern: '{Series}', filePattern: pattern }),
        }));
        expect(res.status).toBe(200);
        expect(mocks.fsMove).toHaveBeenCalledWith(
            '/data/comics/Batman/Batman 1.cbz', path.join('/data/comics/Batman', filename),
        );
    });

    it('should physically move and rename files based on pattern matching', async () => {
        mocks.libraryFindMany.mockResolvedValue([{ id: 'lib_1', path: '/data/comics' }]);
        mocks.systemSettingFindMany.mockResolvedValue([]); 
        
        // CRITICAL FIX: Make the mock smart. Source folders exist, target files do not.
        mocks.fsExistsSync.mockImplementation((p: string | Buffer | URL) => {
            if (!p) return false;
            // Our test target name will be "Batman #001.cbz". We must tell the route this DOES NOT exist yet.
            if (p.toString().includes('#001')) return false; 
            return true; // The source folders and messy files DO exist
        });

        mocks.seriesFindMany.mockResolvedValue([{
            id: 'series_1',
            libraryId: 'lib_1',
            folderPath: '/data/comics/messy_folder',
            publisher: 'DC Comics',
            name: 'Batman',
            year: 2016,
            isManga: false
        }]);

        mocks.issueFindMany.mockResolvedValue([{
            id: 'issue_1',
            seriesId: 'series_1',
            filePath: '/data/comics/messy_folder/Batman 1.cbz',
            number: '1',
            releaseDate: '2016-01-01'
        }]);

        const req = new NextRequest('http://localhost/api/library/rename', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                seriesIds: ['series_1'],
                folderPattern: '{Publisher}/{Series} ({Year})',
                filePattern: '{Series} #{Issue}'
            })
        });

        const res = await POST(req);
        const data = await res.json();

        expect(data.success).toBe(true);
        expect(data.filesRenamed).toBe(1); // Now this will successfully pass!

        // The fix relocates files INDIVIDUALLY into the standardized folder — never a destructive
        // folder-level move with overwrite (which deleted any files already in the target).
        expect(mocks.fsMove).toHaveBeenCalledWith(
            '/data/comics/messy_folder/Batman 1.cbz',
            expect.stringContaining(path.normalize('Batman #001.cbz'))
        );
        // Regression guard: it must NOT move the whole series directory (the data-loss path).
        expect(mocks.fsMove).not.toHaveBeenCalledWith(
            '/data/comics/messy_folder',
            expect.anything(),
            expect.anything()
        );

        expect(mocks.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                filePath: expect.stringContaining('Batman #001.cbz')
            })
        }));
    });

    // A LOCAL collected edition's files are claimed by NAME alone (no provider id to fall back on),
    // so the local loop must name its books after the edition — "Batman Compendium Vol. 001" — while
    // a provider-backed trade in the same series still takes the series name.
    it('names a LOCAL collected edition\'s books after the edition, and a provider trade after the series', async () => {
        mocks.libraryFindMany.mockResolvedValue([{ id: 'lib_1', path: '/data/comics' }]);
        mocks.fsExistsSync.mockImplementation((p: string | Buffer | URL) => {
            if (!p) return false;
            // Targets do not exist yet; the source folder and its files do.
            if (/Vol\. 00\d|#00\d/.test(p.toString())) return false;
            return true;
        });
        mocks.seriesFindMany.mockResolvedValue([{
            id: 'series_1', libraryId: 'lib_1', folderPath: '/data/comics/DC Comics/Batman (2016)',
            publisher: 'DC Comics', name: 'Batman', year: 2016, isManga: false,
        }]);
        mocks.issueFindMany.mockResolvedValue([
            {
                id: 'local_book', seriesId: 'series_1', number: '1', name: 'Vol. 1', releaseDate: null,
                filePath: '/data/comics/DC Comics/Batman (2016)/Batman Compendium 01.cbz',
                attachedVolume: { kind: 'COLLECTED', metadataSource: 'LOCAL', name: 'Batman Compendium' },
            },
            {
                id: 'cv_book', seriesId: 'series_1', number: '2', name: 'Vol. 2: City of Owls', releaseDate: '2016-06-01',
                filePath: '/data/comics/DC Comics/Batman (2016)/Batman TPB 02.cbz',
                attachedVolume: { kind: 'COLLECTED', metadataSource: 'COMICVINE', name: 'Batman' },
            },
            {
                id: 'issue_3', seriesId: 'series_1', number: '3', name: 'Batman #3', releaseDate: '2016-03-01',
                filePath: '/data/comics/DC Comics/Batman (2016)/Batman 3.cbz', attachedVolume: null,
            },
        ]);

        const req = new NextRequest('http://localhost/api/library/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                seriesIds: ['series_1'],
                folderPattern: '{Publisher}/{Series} ({Year})',
                filePattern: '{Series} #{Issue}',
            }),
        });
        const data = await (await POST(req)).json();
        expect(data).toMatchObject({ success: true, filesRenamed: 3, conflicts: 0 });

        // The route has to ask for what the rule needs: the attachment's source and name.
        expect(mocks.issueFindMany).toHaveBeenCalledWith(expect.objectContaining({
            include: { attachedVolume: { select: expect.objectContaining({ kind: true, metadataSource: true, name: true }) } },
        }));
        const targets = mocks.fsMove.mock.calls.map(c => path.basename(c[1]));
        expect(targets).toContain('Batman Compendium Vol. 001 (2016).cbz');
        expect(targets).toContain('Batman Vol. 002 (2016).cbz');
        expect(targets).toContain('Batman #003.cbz');
        expect(targets).not.toContain('Batman Vol. 001 (2016).cbz');
    });
});
