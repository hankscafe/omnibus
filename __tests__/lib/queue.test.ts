import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initWorker } from '@/lib/queue';

// 1. Hoist our mocks
const mocks = vi.hoisted(() => ({
    jobLogCreate: vi.fn(),
    syncSeriesMetadata: vi.fn(),
    runSystemHealthCheck: vi.fn(),
    seriesUpdate: vi.fn(),
    seriesFindMany: vi.fn(),
    issueFindMany: vi.fn(),
    userFindMany: vi.fn(),
    systemSettingUpsert: vi.fn(),
    systemSettingFindMany: vi.fn(),
    axiosGet: vi.fn(),
    writeComicInfo: vi.fn().mockResolvedValue(true),
    writeSeriesJson: vi.fn().mockResolvedValue(true),
    sendWeeklyDigest: vi.fn().mockResolvedValue(true),
    digestHistoryCreate: vi.fn(),
    transaction: vi.fn().mockResolvedValue([]), // <-- FIX: Added transaction mock
    workerCb: { current: null as any }
}));

// 2. Mock Dependencies
vi.mock('@/lib/db', () => ({
    prisma: {
        $transaction: mocks.transaction, // <-- FIX: Added to Prisma mock object
        jobLog: { create: mocks.jobLogCreate },
        systemSetting: { 
            upsert: mocks.systemSettingUpsert, 
            findMany: mocks.systemSettingFindMany,
            deleteMany: vi.fn()
        },
        series: { findMany: mocks.seriesFindMany, update: mocks.seriesUpdate },
        issue: { findMany: mocks.issueFindMany },
        user: { findMany: mocks.userFindMany },
        digestHistory: { 
            deleteMany: vi.fn(), 
            findMany: vi.fn().mockResolvedValue([]), 
            create: mocks.digestHistoryCreate 
        }
    }
}));

// BullMQ uses apiClient inside the queue dynamically
vi.mock('@/lib/api-client', () => ({
    apiClient: { get: mocks.axiosGet }
}));

// Discover Sync uses axios directly
vi.mock('axios', () => ({
    default: { get: mocks.axiosGet }
}));

vi.mock('@/lib/metadata-fetcher', () => ({ syncSeriesMetadata: mocks.syncSeriesMetadata }));
vi.mock('@/lib/health-checker', () => ({ runSystemHealthCheck: mocks.runSystemHealthCheck }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));
vi.mock('@/lib/notifications', () => ({ SystemNotifier: { sendAlert: vi.fn().mockResolvedValue(true) } }));

// Mock the file writers for embedding
vi.mock('@/lib/metadata-writer', () => ({
    writeComicInfo: mocks.writeComicInfo,
    writeSeriesJson: mocks.writeSeriesJson
}));

// Mock the mailer for the digest
vi.mock('@/lib/mailer', () => ({
    Mailer: { sendWeeklyDigest: mocks.sendWeeklyDigest }
}));

// 3. Intercept BullMQ Worker creation
vi.mock('bullmq', () => ({
    Queue: class QueueMock {
        add = vi.fn();
        getRepeatableJobs = vi.fn().mockResolvedValue([]);
        removeRepeatableByKey = vi.fn();
    },
    Worker: class WorkerMock {
        constructor(name: string, cb: any, opts: any) {
            mocks.workerCb.current = cb; 
        }
        on = vi.fn();
    }
}));

describe('Cron: BullMQ Worker Router', () => {
    let originalSetTimeout: typeof setTimeout;

    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).omnibusWorker = null; 

        // Bypass all the API-ban delays in the fetcher/sync loops to prevent 5000ms test timeouts
        originalSetTimeout = global.setTimeout;
        vi.stubGlobal('setTimeout', (cb: Function) => originalSetTimeout(cb, 0));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should correctly route the METADATA_SYNC job payload to the fetcher logic', async () => {
        initWorker();
        
        mocks.seriesFindMany.mockResolvedValueOnce([
            { id: 'series_1', metadataId: 'cv_123', folderPath: '/comics/Batman', metadataSource: 'COMICVINE' }
        ]);

        const mockJob = {
            id: 'job_meta',
            data: { type: 'METADATA_SYNC', seriesIds: ['series_1'] },
            updateProgress: vi.fn()
        };

        await mocks.workerCb.current(mockJob);

        expect(mocks.syncSeriesMetadata).toHaveBeenCalledWith('cv_123', '/comics/Batman', 'COMICVINE');
        expect(mocks.jobLogCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ jobType: 'METADATA_SYNC', status: 'COMPLETED' })
        }));
    });

    it('should catch errors thrown by jobs and log them as FAILED in the database', async () => {
        initWorker();
        mocks.runSystemHealthCheck.mockRejectedValueOnce(new Error("Drive C: disconnected"));

        const mockJob = { id: 'job_health', data: { type: 'SYSTEM_HEALTH_CHECK' }, updateProgress: vi.fn() };

        await expect(mocks.workerCb.current(mockJob)).rejects.toThrow("Drive C: disconnected");

        expect(mocks.jobLogCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ jobType: 'SYSTEM_HEALTH_CHECK', status: 'FAILED', message: 'Drive C: disconnected' })
        }));
    });

    it('should correctly process EMBED_METADATA and generate series.json files', async () => {
        initWorker();
        
        // Return a mock issue that needs its ComicInfo.xml injected
        mocks.issueFindMany.mockResolvedValueOnce([
            { id: 'issue_100', seriesId: 'series_99' }
        ]);

        const mockJob = {
            id: 'job_embed',
            data: { type: 'EMBED_METADATA', seriesId: 'series_99' },
            updateProgress: vi.fn()
        };

        await mocks.workerCb.current(mockJob);

        // Verify the background job called the correct external writers
        expect(mocks.writeComicInfo).toHaveBeenCalledWith('issue_100');
        expect(mocks.writeSeriesJson).toHaveBeenCalledWith('series_99');
        
        expect(mocks.jobLogCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ jobType: 'EMBED_METADATA', status: 'COMPLETED' })
        }));
    });

    it('should compile and send a WEEKLY_DIGEST if new issues are found', async () => {
        initWorker();
        
        // Mock new issues found within the last 7 days
        mocks.issueFindMany.mockResolvedValueOnce([
            { 
                id: 'issue_1', 
                number: '1', 
                seriesId: 'series_1', 
                series: { id: 'series_1', name: 'Batman', isManga: false, publisher: 'DC Comics' } 
            }
        ]);
        
        // Mock the user recipient list
        mocks.userFindMany.mockResolvedValueOnce([
            { email: 'reader@omnibus.com' }
        ]);

        const mockJob = {
            id: 'job_digest',
            data: { type: 'WEEKLY_DIGEST' },
            updateProgress: vi.fn()
        };

        await mocks.workerCb.current(mockJob);

        // Verify the Mailer was dispatched with the correct compiled payload
        expect(mocks.sendWeeklyDigest).toHaveBeenCalledWith(
            ['reader@omnibus.com'], 
            expect.arrayContaining([expect.objectContaining({ name: 'Batman' })]),
            [] // Empty manga array
        );
        
        expect(mocks.jobLogCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ jobType: 'WEEKLY_DIGEST', status: 'COMPLETED' })
        }));
    });

    it('should filter out manga during DISCOVER_SYNC when discover_manga_filter_mode is HIDE_ALL', async () => {
        initWorker();
        
        // Mock DB settings to HIDE_ALL manga, and provide a dummy CV API key
        mocks.systemSettingFindMany.mockResolvedValue([
            { key: 'discover_manga_filter_mode', value: 'HIDE_ALL' },
            { key: 'cv_api_key', value: 'mock_key' },
            { key: 'manga_publishers', value: 'shueisha, kodansha' } // Manga Publisher Dictionary
        ]);

        // Mock ComicVine API to return a Manga and a Western Comic
        mocks.axiosGet.mockResolvedValue({
            data: {
                results: [
                    { id: 1, volume: { id: 10, name: 'Chainsaw Man', publisher: { name: 'Shueisha' } }, issue_number: '1' },
                    { id: 2, volume: { id: 20, name: 'Batman', publisher: { name: 'DC Comics' } }, issue_number: '1' }
                ]
            }
        });

        const mockJob = {
            id: 'job_discover',
            data: { type: 'DISCOVER_SYNC' },
            updateProgress: vi.fn()
        };

        await mocks.workerCb.current(mockJob);

        // Verify the cache was updated WITHOUT the manga (Chainsaw Man)
        expect(mocks.systemSettingUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { key: 'discover_cache_new' },
            create: expect.objectContaining({
                value: expect.not.stringContaining('Chainsaw Man')
            })
        }));

        // Verify the cache WAS updated WITH the western comic (Batman)
        expect(mocks.systemSettingUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { key: 'discover_cache_new' },
            create: expect.objectContaining({
                value: expect.stringContaining('Batman')
            })
        }));
    });
});