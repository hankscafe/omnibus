import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Importer } from '@/lib/importer';
import fs from 'fs-extra';
// Import the queue so we can assert against the mock
import { omnibusQueue } from '@/lib/queue';
import { loggerLog } from '../helpers/setup-global';
import { notifierSendAlert } from '../helpers/setup-global';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findUniqueRequest: vi.fn(),
    findManySettings: vi.fn(),
    findManyLibraries: vi.fn(),
    findFirstSeries: vi.fn(),
    findFirstClient: vi.fn(),
    getAllActiveDownloads: vi.fn(),
    updateRequest: vi.fn(),
    updateManyRequest: vi.fn().mockResolvedValue({ count: 2 }),
    recordHandoff: vi.fn().mockResolvedValue(1),
    createIssue: vi.fn(),
    upsertSeries: vi.fn(),
    updateSeries: vi.fn(),
    log: vi.fn(),
    sendAlert: vi.fn(),
    detectManga: vi.fn().mockResolvedValue(false),
    parseComicInfo: vi.fn().mockResolvedValue({}),
    convertCbrToCbz: vi.fn().mockResolvedValue(null),
    syncSeriesMetadata: vi.fn().mockResolvedValue(true),
    // global fetch (engine nested-pack offload)
    fetch: vi.fn(),
    zipGetEntries: vi.fn().mockReturnValue([]),
    // The ZIP index reader (end record + central directory only) - readable by default.
    readZipEntryNames: vi.fn().mockResolvedValue(['01.jpg']),
    requeue: vi.fn().mockResolvedValue('requeued'),
    // The saved-folder check (its own real-fs tests live in stored-folder.test.ts) - fine by default.
    storedFolderProblem: vi.fn().mockReturnValue(null),
}));

// 2. Deeply Mock Dependencies to save RAM and prevent OOM crashes
vi.mock('@/lib/db', () => ({
    prisma: {
        request: { findUnique: mocks.findUniqueRequest, update: mocks.updateRequest, updateMany: mocks.updateManyRequest, findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
        systemSetting: { findMany: mocks.findManySettings, findUnique: vi.fn().mockResolvedValue(null) },
        library: { findMany: mocks.findManyLibraries },
        series: { findFirst: mocks.findFirstSeries, upsert: mocks.upsertSeries, update: mocks.updateSeries },
        issue: { create: mocks.createIssue, findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
        downloadClient: { findFirst: mocks.findFirstClient }
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

// #240 PR B: the importer records the handoff and nothing else — the row-writing itself is unit
// tested in import-handoff.test.ts, and the relative-path key is mocked to its basename here so the
// assertions read as intent rather than as /tmp path arithmetic.
vi.mock('@/lib/import-handoff', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/import-handoff')>()),
    newImportBatchId: () => 'batch_test',
    watchedRelativePath: (_dir: string, filePath: string) => filePath.split(/[\\/]/).pop(),
    recordImportHandoff: mocks.recordHandoff,
}));

vi.mock('@/lib/utils/path-resolver', () => ({ resolveRemotePath: vi.fn((path) => path) }));
vi.mock('@/lib/download-clients', () => ({ DownloadService: { getAllActiveDownloads: mocks.getAllActiveDownloads } }));

// Prevent heavy libraries from loading
vi.mock('@/lib/manga-detector', () => ({ detectManga: mocks.detectManga }));
vi.mock('@/lib/metadata-extractor', () => ({ parseComicInfo: mocks.parseComicInfo }));
vi.mock('@/lib/converter', () => ({ convertCbrToCbz: mocks.convertCbrToCbz }));
vi.mock('@/lib/metadata-fetcher', () => ({ syncSeriesMetadata: mocks.syncSeriesMetadata }));
vi.mock('adm-zip', () => ({ default: class AdmZipMock { getEntries() { return mocks.zipGetEntries(); } } }));
vi.mock('axios');
vi.mock('@/lib/utils/archive-pages', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/utils/archive-pages')>()),
    readZipEntryNames: mocks.readZipEntryNames,
}));
vi.mock('@/lib/requeue', () => ({ requeueWithNextRelease: mocks.requeue }));
vi.mock('@/lib/utils/stored-folder', () => ({ storedFolderProblem: mocks.storedFolderProblem }));

describe('File System: Importer Engine', () => {
    beforeEach(() => {
        
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
        mocks.getAllActiveDownloads.mockResolvedValue([]);
        mocks.findFirstClient.mockResolvedValue(null);
        mocks.storedFolderProblem.mockReset();
        mocks.storedFolderProblem.mockReturnValue(null);
    });

    // beta.018 follow-up: a Root Path saved before Settings checked it (a Windows path under Docker,
    // a leading space, a folder nothing is mounted at) surfaced only as a bare EACCES deep in the
    // copy. The importer now names the library and the fix, and touches nothing.
    it('refuses a library whose saved Root Path the server can\'t use, naming the library and the fix', async () => {
        mocks.findUniqueRequest.mockResolvedValueOnce({
            id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Batman 01.cbz', volumeId: 'cv_123', createdAt: new Date()
        });
        mocks.findFirstSeries.mockResolvedValueOnce({
            id: 'series_1', name: 'Batman', publisher: 'DC Comics', year: 2016, libraryId: 'lib_1', isManga: false
        });
        mocks.findManyLibraries.mockResolvedValue([
            { id: 'lib_1', name: 'Standard Comics', path: 'C:\\Comics', isManga: false, isDefault: true }
        ]);
        mocks.storedFolderProblem.mockImplementation((p: string) =>
            p === 'C:\\Comics' ? '"C:\\Comics" is a Windows path, and Omnibus runs inside a Linux container that can\'t see it.' : null
        );
        vi.mocked(fs.copy).mockClear();
        vi.mocked(fs.ensureDir).mockClear();

        const result = await Importer.importRequest('req_1');

        expect(result).toBe(false);
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('library "Standard Comics"'), 'error');
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('"C:\\Comics" is a Windows path'), 'error');
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('Settings → Library & Files'), 'error');
        expect(fs.copy).not.toHaveBeenCalled();
        expect(vi.mocked(fs.ensureDir).mock.calls.some(([p]) => String(p).includes('C:\\Comics'))).toBe(false);
        expect(mocks.createIssue).not.toHaveBeenCalled();
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
            expect.stringContaining('Batman #001.cbz'),
            expect.any(Object)
        );

        // Assert it created the issue in the database
        expect(mocks.createIssue).toHaveBeenCalled();
        
        // Assert it sent the "Comic Available" notification
        expect(notifierSendAlert).toHaveBeenCalledWith('comic_available', expect.any(Object));

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

    // Issue.fileAddedAt (#206 follow-up): a download is an arrival. The placeholder a monitored
    // download fills keeps its old createdAt, so the arrival time has to be stamped here.
    describe('fileAddedAt', () => {
        const batmanRequest = () => {
            mocks.findUniqueRequest.mockResolvedValueOnce({
                id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Batman 01.cbz', volumeId: 'cv_123', createdAt: new Date()
            });
            mocks.findFirstSeries.mockResolvedValueOnce({
                id: 'series_1', name: 'Batman', publisher: 'DC Comics', year: 2016, libraryId: 'lib_1', isManga: false
            });
        };
        const issueRow = (over: Record<string, unknown>) => ({
            id: 'iss_1', seriesId: 'series_1', number: '1', isAnnual: false, name: null, description: null,
            writers: null, artists: null, characters: null, metadataId: '900001', metadataSource: 'COMICVINE', matchState: 'MATCHED',
            ...over,
        });
        afterEach(async () => {
            const { prisma } = await import('@/lib/db');
            (prisma.issue.findMany as any).mockResolvedValue([]);
        });

        it('stamps a new row it creates', async () => {
            batmanRequest();
            const before = Date.now();
            await Importer.importRequest('req_1');
            const data = mocks.createIssue.mock.calls.at(-1)![0].data;
            expect(data.fileAddedAt).toBeInstanceOf(Date);
            expect(data.fileAddedAt.getTime()).toBeGreaterThanOrEqual(before);
        });

        it('stamps the WANTED placeholder it fills', async () => {
            batmanRequest();
            const { prisma } = await import('@/lib/db');
            (prisma.issue.findMany as any).mockResolvedValue([issueRow({ filePath: null, status: 'WANTED', fileAddedAt: null })]);
            await Importer.importRequest('req_1');
            const data = (prisma.issue.update as any).mock.calls.at(-1)[0].data;
            expect(data.filePath).toContain('Batman #001.cbz');
            expect(data.fileAddedAt).toBeInstanceOf(Date);
        });

        it('leaves the stamp alone when the download replaces a file the row already had', async () => {
            batmanRequest();
            const { prisma } = await import('@/lib/db');
            const OLD = new Date('2026-06-01T08:00:00.000Z');
            (prisma.issue.findMany as any).mockResolvedValue([issueRow({ filePath: '/library/comics/DC Comics/Batman (2016)/Batman #01.cbr', status: 'DOWNLOADED', fileAddedAt: OLD })]);
            await Importer.importRequest('req_1');
            const data = (prisma.issue.update as any).mock.calls.at(-1)[0].data;
            expect(data.filePath).toContain('Batman #001.cbz');
            expect('fileAddedAt' in data).toBe(false);
        });
    });

    // The naming cleanup (#244): a download is named by the same rules as every other path - padded
    // by the issue_number_padding setting (it used to pad a single digit only), and "$&" in a series
    // name stays "$&" (string replacement turned it back into the token it replaced).
    describe('naming (#244)', () => {
        const download = (series: Record<string, unknown> = {}) => {
            mocks.findUniqueRequest.mockResolvedValueOnce({
                id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Batman 01.cbz', volumeId: 'cv_123', createdAt: new Date()
            });
            mocks.findFirstSeries.mockResolvedValueOnce({
                id: 'series_1', name: 'Batman', publisher: 'DC Comics', year: 2016, libraryId: 'lib_1', isManga: false, ...series
            });
        };
        const copiedTo = () => String(vi.mocked(fs.copy).mock.calls.at(-1)?.[1]).replace(/\\/g, '/');

        it.each([
            { padding: 'none', name: 'Batman #1.cbz' },
            { padding: '2', name: 'Batman #01.cbz' },
            { padding: '3', name: 'Batman #001.cbz' },
        ])('pads by the setting ($padding)', async ({ padding, name }) => {
            mocks.findManySettings.mockResolvedValue([
                { key: 'download_path', value: '/downloads' },
                { key: 'issue_number_padding', value: padding },
            ]);
            download();
            expect(await Importer.importRequest('req_1')).toBe(true);
            expect(copiedTo()).toMatch(new RegExp(`/DC Comics/Batman \\(2016\\)/(\\d+_)?${name.replace(/[.#]/g, '\\$&')}$`));
        });

        it('keeps "$&" in a series name literal, in the folder and the file', async () => {
            download({ name: 'Cash $& Carry' });
            expect(await Importer.importRequest('req_1')).toBe(true);
            expect(copiedTo()).toMatch(/\/DC Comics\/Cash \$& Carry \(2016\)\/(\d+_)?Cash \$& Carry #001\.cbz$/);
        });
    });

    // A series row whose folderPath isn't strictly inside a library - a library root itself, or a
    // folder elsewhere (a volume request could store one) - is never "standardized" by moving that
    // folder into the library. The download lands in the pattern's folder instead.
    describe('a series folder outside the library', () => {
        it.each(['/library/comics', '/config', '/library/comics/DC Comics/../..'])('never moves %s', async (stored) => {
            vi.mocked(fs.move).mockClear();
            mocks.findUniqueRequest.mockResolvedValueOnce({
                id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Batman 01.cbz', volumeId: 'cv_123', createdAt: new Date()
            });
            mocks.findFirstSeries.mockResolvedValueOnce({
                id: 'series_1', name: 'Batman', publisher: 'DC Comics', year: 2016, libraryId: 'lib_1', isManga: false, folderPath: stored
            });

            const result = await Importer.importRequest('req_1');

            expect(result).toBe(true);
            expect(vi.mocked(fs.move).mock.calls.filter(c => c[0] === stored)).toEqual([]);
            expect(fs.copy).toHaveBeenLastCalledWith(
                expect.any(String),
                // (existsSync is true for every path here, so the collision prefix applies)
                expect.stringMatching(/[\\/]library[\\/]comics[\\/]DC Comics[\\/]Batman \(2016\)[\\/](\d+_)?Batman #001\.cbz$/),
                expect.any(Object)
            );
        });
    });
    // #243 (anacronismo): a monitored download of X-Men #38 - a series that started in 2024, an
    // issue released in 2026 - was named "X-Men #38 (2024)" although the file pattern asks for
    // {IssueYear}. The importer took the year from ComicInfo's <Volume> (the series' start year)
    // and never looked at the issue's own row. {IssueYear} is now the issue's release date in the
    // library, else the file's own <Year>, else the series year - the same year Standardize uses.
    describe('{IssueYear} (#243)', () => {
        const xmenDownload = () => {
            mocks.findManySettings.mockResolvedValue([
                { key: 'download_path', value: '/downloads' },
                { key: 'folder_naming_pattern', value: '{Publisher}/{Series} ({Year})' },
                { key: 'file_naming_pattern', value: '{Series} #{Issue} ({IssueYear})' },
            ]);
            mocks.findUniqueRequest.mockResolvedValueOnce({
                id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'X-Men #38 (2026).cbz', volumeId: 'cv_1', createdAt: new Date()
            });
            mocks.findFirstSeries.mockResolvedValueOnce({
                id: 'series_x', name: 'X-Men', publisher: 'Marvel', year: 2024, libraryId: 'lib_1', isManga: false
            });
        };
        const libraryRows = async (rows: Array<{ number: string; releaseDate: string | null; isAnnual?: boolean }>) => {
            const { prisma } = await import('@/lib/db');
            (prisma.issue.findMany as any).mockResolvedValue(rows.map((r, i) => ({
                id: `iss_${i}`, seriesId: 'series_x', isAnnual: false, filePath: null, status: 'WANTED',
                name: null, description: null, writers: null, artists: null, characters: null, ...r,
            })));
        };
        const copiedTo = () => (fs.copy as any).mock.calls.at(-1)?.[1] as string;
        afterEach(async () => {
            const { prisma } = await import('@/lib/db');
            (prisma.issue.findMany as any).mockResolvedValue([]);
        });

        it('uses the issue\'s release date in the library, not the series year from <Volume>', async () => {
            xmenDownload();
            mocks.parseComicInfo.mockResolvedValueOnce({ series: 'X-Men', number: '38', year: 2024 });
            await libraryRows([{ number: '37', releaseDate: '2025-12-10' }, { number: '38', releaseDate: '2026-01-14' }]);

            expect(await Importer.importRequest('req_1')).toBe(true);
            expect(copiedTo()).toMatch(/Marvel[\\/]X-Men \(2024\)[\\/](?:\d+_)?X-Men #038 \(2026\)\.cbz$/);
        });

        it('the library\'s release date wins over the file\'s own <Year>, so Standardize never renames it again', async () => {
            xmenDownload();
            mocks.parseComicInfo.mockResolvedValueOnce({ series: 'X-Men', number: '38', year: 2024, issueYear: 2026 });
            await libraryRows([{ number: '38', releaseDate: '2025-11-05' }]);

            await Importer.importRequest('req_1');
            expect(copiedTo()).toMatch(/(?:\d+_)?X-Men #038 \(2025\)\.cbz$/);
        });

        it('without a library row, uses the file\'s own ComicInfo <Year>', async () => {
            xmenDownload();
            mocks.parseComicInfo.mockResolvedValueOnce({ series: 'X-Men', number: '38', year: 2024, issueYear: 2026 });

            await Importer.importRequest('req_1');
            expect(copiedTo()).toMatch(/(?:\d+_)?X-Men #038 \(2026\)\.cbz$/);
        });

        it('with neither, falls back to the series year', async () => {
            xmenDownload();
            mocks.parseComicInfo.mockResolvedValueOnce(null);

            await Importer.importRequest('req_1');
            expect(copiedTo()).toMatch(/(?:\d+_)?X-Men #038 \(2024\)\.cbz$/);
        });

        it('an annual takes its year from the annual\'s row, never the main run\'s same number', async () => {
            xmenDownload();
            mocks.findUniqueRequest.mockReset();
            mocks.findUniqueRequest.mockResolvedValueOnce({
                id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'X-Men Annual #1 (2025).cbz', volumeId: 'cv_1', createdAt: new Date()
            });
            mocks.parseComicInfo.mockResolvedValueOnce({ series: 'X-Men', number: '1', year: 2024, format: 'Annual' });
            await libraryRows([
                { number: '1', releaseDate: '2024-07-10', isAnnual: false },
                { number: '1', releaseDate: '2025-08-20', isAnnual: true },
            ]);

            await Importer.importRequest('req_1');
            expect(copiedTo()).toMatch(/(?:\d+_)?X-Men Annual #001 \(2025\)\.cbz$/);
        });
    });

    it.each([null, '', '   '])('adopts ComicInfo Imprint over stored %j and saves it for later naming', async (imprint) => {
        mocks.findManySettings.mockResolvedValue([
            { key: 'download_path', value: '/downloads' },
            { key: 'folder_naming_pattern', value: '{Imprint}/{Publisher}/{Series} ({Year})' },
            { key: 'file_naming_pattern', value: '{Imprint} {Series} #{Issue}' },
        ]);
        mocks.findUniqueRequest.mockResolvedValueOnce({
            id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Batman 01.cbz', volumeId: 'cv_123', createdAt: new Date()
        });
        mocks.findFirstSeries.mockResolvedValueOnce({
            id: 'series_1', name: 'Batman', publisher: 'DC Comics', year: 2016,
            libraryId: 'lib_1', isManga: false, hasCustomMetadata: false, imprint,
        });
        mocks.parseComicInfo.mockResolvedValueOnce({ imprint: 'Absolute' });

        const result = await Importer.importRequest('req_1');

        expect(result).toBe(true);
        expect(fs.copy).toHaveBeenCalledWith(
            expect.any(String),
            expect.stringMatching(/Absolute[\\/]DC Comics[\\/]Batman \(2016\)[\\/](?:\d+_)?Absolute Batman #001\.cbz$/),
            expect.any(Object),
        );
        expect(mocks.updateSeries).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'series_1' },
            data: expect.objectContaining({ imprint: 'Absolute' }),
        }));
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
        // Batch ROUTED, not closed (#240 PR B): the request waits at IMPORTING, the files are handed
        // over to the sweep under their watched-folder names, and the sync is queued under the batch.
        expect(mocks.updateManyRequest).toHaveBeenCalledWith({
            where: { id: { in: ['req_1'] } },
            data: expect.objectContaining({ status: 'IMPORTING' })
        });
        expect(mocks.recordHandoff).toHaveBeenCalledWith(expect.objectContaining({
            batchId: 'batch_test',
            requestIds: ['req_1'],
            relativePaths: ['a.cbz', 'b.cbz']
        }));
        expect(omnibusQueue.add).toHaveBeenCalledWith('WATCHED_FOLDER_SYNC', expect.any(Object), { jobId: 'batch_test' });
        // Nothing is announced at routing time any more — the bell no longer lies about the import.
        expect(notifierSendAlert).not.toHaveBeenCalled();
    });

    it('falls back to local AdmZip batch extraction when the engine is down', async () => {
        mocks.findUniqueRequest.mockResolvedValueOnce({
            id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Big Pack.cbz'
        });

        // Engine unreachable (default fetch rejection) → the ZIP's index finds the nested comic
        // (#240: without loading the pack into memory), then the local AdmZip extraction runs.
        mocks.readZipEntryNames.mockResolvedValueOnce(['nested/a.cbz', 'readme.txt']);
        mocks.zipGetEntries.mockReturnValue([
            { entryName: 'nested/a.cbz', isDirectory: false, getData: () => Buffer.from('a') },
            { entryName: 'readme.txt', isDirectory: false, getData: () => Buffer.from('junk') },
        ]);

        const result = await Importer.importRequest('req_1');

        expect(result).toBe(true);
        // Only the nested comic was written to the watched folder.
        expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledTimes(1);
        expect(mocks.updateManyRequest).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'IMPORTING' })
        }));
        // The destination keeps a collision prefix when the watched folder already holds that name,
        // and the handoff key follows the file it actually wrote.
        expect(mocks.recordHandoff).toHaveBeenCalledWith(expect.objectContaining({
            relativePaths: [expect.stringMatching(/a\.cbz$/)]
        }));
        expect(notifierSendAlert).not.toHaveBeenCalled();
    });

    // ==== #240 finding 4: a 1.2 GB pack cut short was imported as ONE issue with 0 pages. The engine
    // listing failed, the AdmZip fallback (which loads the whole pack into memory) threw, the error
    // was swallowed, and the file went down the single-issue path. An archive that can't be read is
    // now refused: never imported, the release is blocked, and the request searches again. ====
    describe('unreadable archives (#240)', () => {
        const unreadable = () => mocks.readZipEntryNames.mockRejectedValueOnce(new Error('EOCD signature not found'));

        it('refuses a ZIP whose index can\'t be read: no issue, no move, and the release is blocked for a re-search', async () => {
            mocks.findUniqueRequest.mockResolvedValueOnce({
                id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Big Pack (2024).cbz', downloadLink: 'abc123hash', retryCount: 0, volumeId: 'cv_1'
            });
            unreadable();

            expect(await Importer.importRequest('req_1')).toBe(false);

            expect(mocks.createIssue).not.toHaveBeenCalled();
            expect(fs.copy).not.toHaveBeenCalled();
            expect(fs.move).not.toHaveBeenCalled();
            expect(mocks.requeue).toHaveBeenCalledWith(expect.objectContaining({ id: 'req_1' }), { title: 'Big Pack (2024).cbz' });
            expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining("can't be read"), 'error');
            // A download client's file is left where it is (a torrent may still be seeding it).
            expect(fs.remove).not.toHaveBeenCalled();
        });

        it('deletes our own direct-download temp file when refusing it, so a folder search never picks it up again', async () => {
            mocks.findUniqueRequest.mockResolvedValueOnce({
                id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Big Pack (2024).cbz', downloadLink: 'https://getcomics.org/dls/x', retryCount: 0
            });
            // Only the GetComics copy exists (the engine's DDL target), not one in the download root.
            vi.mocked(fs.existsSync).mockImplementation((p: any) => {
                const s = String(p).replace(/\\/g, '/');
                return !(s.endsWith('/Big Pack (2024).cbz') && !s.includes('/GetComics/'));
            });
            unreadable();

            expect(await Importer.importRequest('req_1')).toBe(false);

            expect(fs.remove).toHaveBeenCalledWith(expect.stringMatching(/GetComics[\\/]Big Pack \(2024\)\.cbz$/));
            expect(mocks.requeue).toHaveBeenCalled();
            expect(mocks.createIssue).not.toHaveBeenCalled();
        });

        it('an admin\'s uploaded file that can\'t be read is reported - not deleted, not re-searched', async () => {
            mocks.findUniqueRequest.mockResolvedValueOnce({ id: 'req_1', status: 'PENDING', activeDownloadName: 'X-Men 038.cbz' });
            unreadable();

            expect(await Importer.importRequest('req_1', { sourcePathOverride: '/downloads/X-Men 038.cbz' })).toBe(false);

            expect(mocks.requeue).not.toHaveBeenCalled();
            expect(fs.remove).not.toHaveBeenCalled();
            expect(mocks.createIssue).not.toHaveBeenCalled();
        });

        it('a readable ZIP is checked from its index alone - the file is never loaded into memory', async () => {
            mocks.findUniqueRequest.mockResolvedValueOnce({
                id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Batman 01.cbz', volumeId: 'cv_123', createdAt: new Date()
            });
            mocks.findFirstSeries.mockResolvedValueOnce({
                id: 'series_1', name: 'Batman', publisher: 'DC Comics', year: 2016, libraryId: 'lib_1', isManga: false
            });

            expect(await Importer.importRequest('req_1')).toBe(true);

            expect(mocks.readZipEntryNames).toHaveBeenCalled();
            expect(mocks.createIssue).toHaveBeenCalled();
            expect(mocks.zipGetEntries).not.toHaveBeenCalled();
            expect(mocks.requeue).not.toHaveBeenCalled();
        });

        it('when the engine lists the archive, its answer is trusted and the index isn\'t read again', async () => {
            mocks.findUniqueRequest.mockResolvedValueOnce({
                id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Batman 01.cbz', volumeId: 'cv_123', createdAt: new Date()
            });
            mocks.findFirstSeries.mockResolvedValueOnce({
                id: 'series_1', name: 'Batman', publisher: 'DC Comics', year: 2016, libraryId: 'lib_1', isManga: false
            });
            mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ count: 0, entries: [] }) });

            expect(await Importer.importRequest('req_1')).toBe(true);

            expect(mocks.readZipEntryNames).not.toHaveBeenCalled();
            expect(mocks.createIssue).toHaveBeenCalled();
        });
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
        expect(mocks.updateManyRequest).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'IMPORTING' })
        }));
        expect(mocks.recordHandoff).toHaveBeenCalledWith(expect.objectContaining({
            relativePaths: ['Batman 89 Echoes 001.cbz']
        }));
        expect(notifierSendAlert).not.toHaveBeenCalled();
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
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('could not be split'), 'error');
        // Nothing was handed over: the request is not marked IMPORTING and no handoff row exists —
        // a request that would wait forever on an import that was never queued (#240 PR B).
        expect(mocks.updateManyRequest).not.toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'IMPORTING' })
        }));
        expect(mocks.recordHandoff).not.toHaveBeenCalled();
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

    // ==== Issue #198: delete the original usenet download once its copy into the library is verified ====

    const usenetRequest = {
        id: 'req_1', status: 'DOWNLOADING', activeDownloadName: 'Batman 01 (2016)',
        downloadLink: 'nzb_42', volumeId: 'cv_123', createdAt: new Date()
    };
    const usenetActiveItem = { id: 'nzb_42', name: 'Batman 01 (2016)', clientName: 'NZBGet', progress: '100.0', status: 'SUCCESS/ALL' };

    function armUsenetImport(clientType: string, toggle?: string) {
        mocks.findManySettings.mockResolvedValue([
            { key: 'download_path', value: '/downloads' },
            { key: 'folder_naming_pattern', value: '{Publisher}/{Series} ({Year})' },
            { key: 'file_naming_pattern', value: '{Series} #{Issue}' },
            ...(toggle ? [{ key: 'usenet_delete_after_import', value: toggle }] : [])
        ]);
        mocks.findUniqueRequest.mockResolvedValueOnce(usenetRequest);
        mocks.getAllActiveDownloads.mockResolvedValue([usenetActiveItem]);
        mocks.findFirstClient.mockResolvedValue({ type: clientType, localPath: '/nzbget/comics', name: 'NZBGet' });
        mocks.findFirstSeries.mockResolvedValueOnce({
            id: 'series_1', name: 'Batman', publisher: 'DC Comics', year: 2016, libraryId: 'lib_1', isManga: false
        });
    }

    it('deletes the verified usenet source after import when the toggle is on (issue #198)', async () => {
        armUsenetImport('nzbget', 'true');

        const result = await Importer.importRequest('req_1');

        expect(result).toBe(true);
        // The copy still happened (usenet imports stay copy-then-delete, never a move mid-flight)…
        expect(fs.copy).toHaveBeenCalled();
        // …and the ORIGINAL job path in the client's folder was removed afterwards.
        expect(fs.remove).toHaveBeenCalledWith(expect.stringContaining('Batman 01 (2016)'));
        expect(vi.mocked(fs.remove).mock.calls[0][0]).toContain('nzbget');
    });

    it('leaves the usenet source alone when the toggle is off (the default)', async () => {
        armUsenetImport('nzbget'); // no usenet_delete_after_import key at all

        const result = await Importer.importRequest('req_1');

        expect(result).toBe(true);
        expect(fs.copy).toHaveBeenCalled();
        expect(fs.remove).not.toHaveBeenCalled();
    });

    it('never deletes a torrent client source, even with the toggle on (seeding)', async () => {
        armUsenetImport('qbit', 'true');

        const result = await Importer.importRequest('req_1');

        expect(result).toBe(true);
        expect(fs.copy).toHaveBeenCalled();
        expect(fs.remove).not.toHaveBeenCalled();
    });
});
