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
});