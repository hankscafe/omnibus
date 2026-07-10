import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Importer } from '@/lib/importer';
import fs from 'fs-extra';
// Import the queue so we can assert against the mock
import { omnibusQueue } from '@/lib/queue';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findUniqueRequest: vi.fn(),
    findManySettings: vi.fn(),
    findManyLibraries: vi.fn(),
    findFirstSeries: vi.fn(),
    updateRequest: vi.fn(),
    createIssue: vi.fn(),
    upsertSeries: vi.fn(),
    log: vi.fn(),
    sendAlert: vi.fn(),
    detectManga: vi.fn().mockResolvedValue(false),
    parseComicInfo: vi.fn().mockResolvedValue({}),
    convertCbrToCbz: vi.fn().mockResolvedValue(null),
    syncSeriesMetadata: vi.fn().mockResolvedValue(true),
    // global fetch (engine nested-pack offload)
    fetch: vi.fn(),
    zipGetEntries: vi.fn().mockReturnValue([])
}));

// 2. Deeply Mock Dependencies to save RAM and prevent OOM crashes
vi.mock('@/lib/db', () => ({
    prisma: {
        request: { findUnique: mocks.findUniqueRequest, update: mocks.updateRequest, count: vi.fn().mockResolvedValue(0) },
        systemSetting: { findMany: mocks.findManySettings, findUnique: vi.fn().mockResolvedValue(null) },
        library: { findMany: mocks.findManyLibraries },
        series: { findFirst: mocks.findFirstSeries, upsert: mocks.upsertSeries, update: vi.fn() },
        issue: { create: mocks.createIssue, findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn().mockResolvedValue([]) }
    }
}));

vi.mock('fs-extra', () => ({
    default: {
        existsSync: vi.fn(), // We will mock this per-test
        statSync: vi.fn().mockReturnValue({ isDirectory: () => false, size: 1000000 }),
        promises: { readdir: vi.fn().mockResolvedValue([]), stat: vi.fn().mockResolvedValue({ isFile: () => true }) },
        ensureDir: vi.fn().mockResolvedValue(true),
        move: vi.fn().mockResolvedValue(true),
        copy: vi.fn().mockResolvedValue(true),
        writeFile: vi.fn().mockResolvedValue(true),
        writeFileSync: vi.fn(),
        remove: vi.fn().mockResolvedValue(true)
    }
}));

// Mock the queue so the dynamic import intercepts this instead of the real Redis connection
vi.mock('@/lib/queue', () => ({
    omnibusQueue: {
        add: vi.fn().mockResolvedValue(true)
    }
}));

vi.mock('@/lib/notifications', () => ({ SystemNotifier: { sendAlert: mocks.sendAlert } }));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('@/lib/utils/path-resolver', () => ({ resolveRemotePath: vi.fn((path) => path) }));
vi.mock('@/lib/download-clients', () => ({ DownloadService: { getAllActiveDownloads: vi.fn().mockResolvedValue([]) } }));

// Prevent heavy libraries from loading
vi.mock('@/lib/manga-detector', () => ({ detectManga: mocks.detectManga }));
vi.mock('@/lib/metadata-extractor', () => ({ parseComicInfo: mocks.parseComicInfo }));
vi.mock('@/lib/converter', () => ({ convertCbrToCbz: mocks.convertCbrToCbz }));
vi.mock('@/lib/metadata-fetcher', () => ({ syncSeriesMetadata: mocks.syncSeriesMetadata }));
vi.mock('adm-zip', () => ({ default: class AdmZipMock { getEntries() { return mocks.zipGetEntries(); } } }));
vi.mock('axios');

describe('File System: Importer Engine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        
        mocks.findManySettings.mockResolvedValue([
            { key: 'download_path', value: '/downloads' },
            { key: 'folder_naming_pattern', value: '{Publisher}/{Series} ({Year})' },
            { key: 'file_naming_pattern', value: '{Series} #{Issue}' }
        ]);
        mocks.findManyLibraries.mockResolvedValue([
            { id: 'lib_1', path: '/library/comics', isManga: false, isDefault: true }
        ]);
        
        // CRITICAL FIX: Reset fs.existsSync to TRUE by default so files are "found"
        vi.mocked(fs.existsSync).mockReset();
        vi.mocked(fs.existsSync).mockReturnValue(true);

        // Default: engine offload unavailable → the importer falls back to local AdmZip paths.
        vi.stubGlobal('fetch', mocks.fetch);
        mocks.fetch.mockRejectedValue(new Error('engine unavailable'));
        mocks.zipGetEntries.mockReturnValue([]);
    });

    it('should stall the request if the downloaded file is missing from the hard drive', async () => {
        mocks.findUniqueRequest.mockResolvedValueOnce({
            id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Batman_01.cbz', retryCount: 25
        });
        
        // Simulate: The file itself doesn't exist, BUT the base download directory DOES exist
        vi.mocked(fs.existsSync).mockImplementation((path: any) => {
            if (typeof path === 'string' && path.includes('Batman_01')) return false; // File is missing
            return true; // Parent directory (/downloads) is online
        });

        const result = await Importer.importRequest('req_1');
        
        expect(result).toBe(false);
        // Assert it marked the request as stalled after 20+ missing attempts
        expect(mocks.updateRequest).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'STALLED' })
        }));
    });

    it('should successfully rename and copy a comic to the library', async () => {
        mocks.findUniqueRequest.mockResolvedValueOnce({
            id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Batman 01.cbz', volumeId: 'cv_123', createdAt: new Date()
        });
        
        // Mock the series metadata
        mocks.findFirstSeries.mockResolvedValueOnce({
            id: 'series_1', name: 'Batman', publisher: 'DC Comics', year: 2016, libraryId: 'lib_1', isManga: false
        });

        const result = await Importer.importRequest('req_1');
        
        expect(result).toBe(true);

        // FIX: Omnibus COPIES torrent files to preserve seeding!
        expect(fs.copy).toHaveBeenCalledWith(
            expect.any(String),
            expect.stringContaining('Batman #01.cbz'),
            expect.any(Object)
        );

        // Assert it created the issue in the database
        expect(mocks.createIssue).toHaveBeenCalled();
        
        // Assert it sent the "Comic Available" notification
        expect(mocks.sendAlert).toHaveBeenCalledWith('comic_available', expect.any(Object));

        // Assert the dynamic BullMQ deduplication logic was triggered correctly
        expect(omnibusQueue.add).toHaveBeenCalledWith(
            'METADATA_SYNC',
            expect.objectContaining({ seriesIds: expect.any(Array) }),
            expect.objectContaining({
                jobId: expect.stringContaining('METADATA_SYNC_MATCH_series_1_'),
                delay: 600000
            })
        );
    });

    it('routes a nested batch archive to WATCHED via the engine without touching AdmZip', async () => {
        mocks.findUniqueRequest.mockResolvedValueOnce({
            id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Big Pack.cbz'
        });

        // Engine answers both calls: detection (list) then extraction (files written by the engine).
        mocks.fetch
            .mockResolvedValueOnce({ ok: true, json: async () => ({ count: 2, entries: ['a.cbz', 'b.cbr'] }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ count: 2, files: ['/watched/a.cbz', '/watched/b.cbz'] }) });

        const result = await Importer.importRequest('req_1');

        expect(result).toBe(true);
        // Detection + extraction both went to the engine; the local AdmZip path never ran.
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        const extractBody = JSON.parse(mocks.fetch.mock.calls[1][1].body);
        expect(extractBody.path).toContain('Big Pack.cbz');
        expect(extractBody.dest_dir).toBeTruthy();
        expect(mocks.zipGetEntries).not.toHaveBeenCalled();
        // Batch routing completed: request closed out and the watched-folder sync queued.
        expect(mocks.updateRequest).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'COMPLETED' })
        }));
        expect(omnibusQueue.add).toHaveBeenCalledWith('WATCHED_FOLDER_SYNC', expect.any(Object), expect.any(Object));
        expect(mocks.sendAlert).toHaveBeenCalledWith('comic_available', expect.objectContaining({
            title: expect.stringContaining('2 Files')
        }));
    });

    it('falls back to local AdmZip batch extraction when the engine is down', async () => {
        mocks.findUniqueRequest.mockResolvedValueOnce({
            id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Big Pack.cbz'
        });

        // Engine unreachable (default fetch rejection) → local AdmZip detection + extraction.
        mocks.zipGetEntries.mockReturnValue([
            { entryName: 'nested/a.cbz', isDirectory: false, getData: () => Buffer.from('a') },
            { entryName: 'readme.txt', isDirectory: false, getData: () => Buffer.from('junk') },
        ]);

        const result = await Importer.importRequest('req_1');

        expect(result).toBe(true);
        // Only the nested comic was written to the watched folder.
        expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledTimes(1);
        expect(mocks.updateRequest).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'COMPLETED' })
        }));
        expect(mocks.sendAlert).toHaveBeenCalledWith('comic_available', expect.objectContaining({
            title: expect.stringContaining('1 Files')
        }));
    });

    // ==== Issue #174: RAR packs (the dominant Usenet/scene container) must be batch-split too. ====

    it('routes a nested RAR batch pack to WATCHED via the engine (issue #174)', async () => {
        mocks.findUniqueRequest.mockResolvedValueOnce({
            id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Batman 89 Echoes Pack.cbr'
        });

        // Engine answers detection (list) then extraction — the same pipeline zips already use.
        mocks.fetch
            .mockResolvedValueOnce({ ok: true, json: async () => ({ count: 6, entries: ['Batman 89 Echoes 001.cbz'] }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ count: 6, files: ['/watched/Batman 89 Echoes 001.cbz'] }) });

        const result = await Importer.importRequest('req_1');

        expect(result).toBe(true);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        // AdmZip can't read RAR — it must never be consulted for a .cbr pack.
        expect(mocks.zipGetEntries).not.toHaveBeenCalled();
        expect(mocks.updateRequest).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'COMPLETED' })
        }));
        expect(omnibusQueue.add).toHaveBeenCalledWith('WATCHED_FOLDER_SYNC', expect.any(Object), expect.any(Object));
    });

    it('treats a RAR file as a single issue when the engine is down (no AdmZip fallback for RAR)', async () => {
        mocks.findUniqueRequest.mockResolvedValueOnce({
            id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Wolverine 003.cbr', createdAt: new Date()
        });

        // Engine unreachable (default fetch rejection) → RAR can't be inspected locally; the file
        // must fall through to the normal single-issue import, NOT crash into AdmZip.
        const result = await Importer.importRequest('req_1');

        expect(result).toBe(true);
        // The engine list WAS attempted for the .cbr…
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        // …but AdmZip never touched the RAR.
        expect(mocks.zipGetEntries).not.toHaveBeenCalled();
    });

    it('fails with an accurate "could not be split" log when RAR pack extraction fails (issue #174)', async () => {
        mocks.findUniqueRequest.mockResolvedValueOnce({
            id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Batman 89 Echoes Pack.cbr'
        });

        // Detection sees a batch, but the extraction call fails (engine died mid-flight).
        mocks.fetch
            .mockResolvedValueOnce({ ok: true, json: async () => ({ count: 6, entries: ['a.cbz'] }) })
            .mockRejectedValueOnce(new Error('engine crashed'));

        const result = await Importer.importRequest('req_1');

        expect(result).toBe(false);
        // The reason must be the REAL one — not a path-mapping/permissions red herring.
        expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining('could not be split'), 'error');
        expect(mocks.updateRequest).not.toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'COMPLETED' })
        }));
    });

    it('splits a pack that arrives inside a download-client job folder (SAB case, issue #174)', async () => {
        mocks.findUniqueRequest.mockResolvedValueOnce({
            id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Batman 89 Echoes Job'
        });

        // SABnzbd delivers a job FOLDER containing the pack archive — the folder resolves to a
        // single archive, and that archive must still get nested-pack inspection.
        vi.mocked(fs.statSync).mockImplementation((p: any) => ({
            isDirectory: () => typeof p === 'string' && !/\.cb[zr7t]$|\.zip$|\.rar$/i.test(p),
            size: 1000000
        }) as any);
        vi.mocked(fs.promises.readdir).mockResolvedValue([
            { name: 'Batman 89 Echoes Pack.cbz', isDirectory: () => false }
        ] as any);

        mocks.fetch
            .mockResolvedValueOnce({ ok: true, json: async () => ({ count: 6, entries: ['a.cbz'] }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ count: 6, files: ['/watched/a.cbz'] }) });

        const result = await Importer.importRequest('req_1');

        expect(result).toBe(true);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        // The nested inspection ran against the archive INSIDE the folder.
        const listBody = JSON.parse(mocks.fetch.mock.calls[0][1].body);
        expect(listBody.path).toContain('Batman 89 Echoes Pack.cbz');
        expect(omnibusQueue.add).toHaveBeenCalledWith('WATCHED_FOLDER_SYNC', expect.any(Object), expect.any(Object));

        // Restore the shared statSync/readdir defaults for any tests added after this one
        // (vi.clearAllMocks does not reset implementations).
        vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false, size: 1000000 } as any);
        vi.mocked(fs.promises.readdir).mockResolvedValue([] as any);
    });
});