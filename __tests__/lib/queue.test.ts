import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initWorker } from '@/lib/queue';
import { ENGINE_URL } from '@/lib/engine';

// 1. Hoist our mocks
const mocks = vi.hoisted(() => ({
    jobLogCreate: vi.fn(),
    runSystemHealthCheck: vi.fn(),
    seriesUpdate: vi.fn(),
    seriesFindMany: vi.fn(),
    issueFindMany: vi.fn(),
    userFindMany: vi.fn(),
    systemSettingUpsert: vi.fn(),
    systemSettingFindMany: vi.fn(),
    systemSettingFindUnique: vi.fn(),
    queueAdd: vi.fn(),
    axiosGet: vi.fn(),
    requestFindUnique: vi.fn(),
    requestFindFirst: vi.fn(),
    requestFindMany: vi.fn(),
    requestCreate: vi.fn(),
    requestUpdate: vi.fn(),
    userFindFirst: vi.fn(),
    seriesFindFirst: vi.fn(),
    issueCount: vi.fn(),
    downloadClientFindMany: vi.fn(),
    addDownload: vi.fn(),
    downloadDirectFile: vi.fn(),
    searchAndDownload: vi.fn().mockResolvedValue(undefined),
    sendWeeklyDigest: vi.fn().mockResolvedValue(true),
    digestHistoryCreate: vi.fn(),
    transaction: vi.fn().mockResolvedValue([]),
    engineFetch: vi.fn(),
    workerCb: { current: null as any }
}));

// 2. Mock Dependencies
vi.mock('@/lib/db', () => ({
    prisma: {
        $transaction: mocks.transaction,
        jobLog: { create: mocks.jobLogCreate },
        systemSetting: {
            upsert: mocks.systemSettingUpsert,
            findMany: mocks.systemSettingFindMany,
            findUnique: mocks.systemSettingFindUnique,
            deleteMany: vi.fn()
        },
        series: { findMany: mocks.seriesFindMany, findFirst: mocks.seriesFindFirst, update: mocks.seriesUpdate },
        issue: { findMany: mocks.issueFindMany, count: mocks.issueCount },
        user: { findMany: mocks.userFindMany, findFirst: mocks.userFindFirst },
        request: { findUnique: mocks.requestFindUnique, findFirst: mocks.requestFindFirst, findMany: mocks.requestFindMany, create: mocks.requestCreate, update: mocks.requestUpdate },
        downloadClient: { findMany: mocks.downloadClientFindMany },
        digestHistory: {
            deleteMany: vi.fn(),
            findMany: vi.fn().mockResolvedValue([]),
            create: mocks.digestHistoryCreate,
            createMany: mocks.digestHistoryCreate
        }
    }
}));

// BullMQ uses apiClient inside the queue dynamically
vi.mock('@/lib/api-client', () => ({
    apiClient: { get: mocks.axiosGet }
}));

vi.mock('@/lib/health-checker', () => ({ runSystemHealthCheck: mocks.runSystemHealthCheck }));
vi.mock('@/lib/download-clients', () => ({ DownloadService: { addDownload: mocks.addDownload, downloadDirectFile: mocks.downloadDirectFile } }));
vi.mock('@/lib/automation', () => ({ searchAndDownload: mocks.searchAndDownload }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));
vi.mock('@/lib/notifications', () => ({ SystemNotifier: { sendAlert: vi.fn().mockResolvedValue(true) } }));

// Mock the mailer for the digest
vi.mock('@/lib/mailer', () => ({
    Mailer: { sendWeeklyDigest: mocks.sendWeeklyDigest }
}));

// queue.ts opens a real Redis connection at import time; BullMQ itself is mocked below,
// so a no-op stand-in prevents the unhandled ECONNREFUSED noise in test output.
vi.mock('ioredis', () => ({
    default: class IORedisMock {
        on() { return this; }
        once() { return this; }
        quit() { return Promise.resolve(); }
        disconnect() { }
        duplicate() { return this; }
    }
}));

// 3. Intercept BullMQ Worker creation
vi.mock('bullmq', () => ({
    Queue: class QueueMock {
        add = mocks.queueAdd;
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
        process.env.NEXTAUTH_SECRET = 'test-secret';

        // Heavy jobs are forwarded to the Rust engine over HTTP; default to "engine accepted".
        mocks.engineFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        vi.stubGlobal('fetch', mocks.engineFetch);

        // Bypass all the API-ban delays in the fetcher/sync loops to prevent 5000ms test timeouts
        originalSetTimeout = global.setTimeout;
        vi.stubGlobal('setTimeout', (cb: (...args: unknown[]) => void) => originalSetTimeout(cb, 0));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should forward a targeted METADATA_SYNC to the engine without bumping the schedule timer', async () => {
        initWorker();

        const mockJob = {
            id: 'job_meta',
            data: { type: 'METADATA_SYNC', seriesIds: ['series_1'] },
            updateProgress: vi.fn()
        };

        await mocks.workerCb.current(mockJob);

        expect(mocks.engineFetch).toHaveBeenCalledWith(
            `${ENGINE_URL}/api/metadata/sync`,
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Content-Type': 'application/json',
                    'X-Internal-Secret': 'test-secret'
                }),
                body: JSON.stringify({ series_ids: ['series_1'] })
            })
        );

        // Targeted syncs must not bump the scheduled-run timer
        expect(mocks.systemSettingUpsert).not.toHaveBeenCalledWith(
            expect.objectContaining({ where: { key: 'last_metadata_sync' } })
        );

        // The engine owns the COMPLETED JobLog + notification for this job now
        expect(mocks.jobLogCreate).not.toHaveBeenCalled();
    });

    it('should forward a scheduled METADATA_SYNC with series_ids null and bump the schedule timer', async () => {
        initWorker();

        const mockJob = {
            id: 'job_meta_sched',
            data: { type: 'METADATA_SYNC' },
            updateProgress: vi.fn()
        };

        await mocks.workerCb.current(mockJob);

        expect(mocks.systemSettingUpsert).toHaveBeenCalledWith(
            expect.objectContaining({ where: { key: 'last_metadata_sync' } })
        );
        expect(mocks.engineFetch).toHaveBeenCalledWith(
            `${ENGINE_URL}/api/metadata/sync`,
            expect.objectContaining({ body: JSON.stringify({ series_ids: null }) })
        );
    });

    it('should fail the METADATA_SYNC job with a FAILED JobLog when the engine rejects it', async () => {
        initWorker();
        mocks.engineFetch.mockResolvedValueOnce({ ok: false, status: 503 });

        const mockJob = {
            id: 'job_meta_down',
            data: { type: 'METADATA_SYNC', seriesIds: ['series_1'] },
            updateProgress: vi.fn()
        };

        await expect(mocks.workerCb.current(mockJob)).rejects.toThrow('Rust returned error status 503');

        expect(mocks.jobLogCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ jobType: 'METADATA_SYNC', status: 'FAILED' })
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

    it('should forward a targeted EMBED_METADATA to the engine without bumping the embed timer', async () => {
        initWorker();

        const mockJob = {
            id: 'job_embed',
            data: { type: 'EMBED_METADATA', seriesId: 'series_99' },
            updateProgress: vi.fn()
        };

        await mocks.workerCb.current(mockJob);

        expect(mocks.engineFetch).toHaveBeenCalledWith(
            `${ENGINE_URL}/api/metadata/embed`,
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ 'X-Internal-Secret': 'test-secret' }),
                body: JSON.stringify({ series_id: 'series_99', issue_ids: null })
            })
        );

        // Targeted embeds must not bump the scheduled-run timer
        expect(mocks.systemSettingUpsert).not.toHaveBeenCalledWith(
            expect.objectContaining({ where: { key: 'last_embed_sync' } })
        );
        expect(mocks.jobLogCreate).not.toHaveBeenCalled();
    });

    it('should bump the embed timer for a scheduled bulk EMBED_METADATA run', async () => {
        initWorker();

        const mockJob = {
            id: 'job_embed_sched',
            data: { type: 'EMBED_METADATA' },
            updateProgress: vi.fn()
        };

        await mocks.workerCb.current(mockJob);

        expect(mocks.systemSettingUpsert).toHaveBeenCalledWith(
            expect.objectContaining({ where: { key: 'last_embed_sync' } })
        );
        expect(mocks.engineFetch).toHaveBeenCalledWith(
            `${ENGINE_URL}/api/metadata/embed`,
            expect.objectContaining({ body: JSON.stringify({ series_id: null, issue_ids: null }) })
        );
    });

    it('should forward EXPORT_SERIES_JSON to the engine when the export is enabled', async () => {
        initWorker();

        mocks.systemSettingFindUnique.mockResolvedValueOnce({ value: 'true' });
        mocks.engineFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ exported: 1, total: 1 }) });

        const mockJob = {
            id: 'job_export',
            data: { type: 'EXPORT_SERIES_JSON', seriesIds: ['series_99'] },
            updateProgress: vi.fn()
        };

        await mocks.workerCb.current(mockJob);

        // The Mylar-spec writer lives in the engine; the job is a thin forwarder.
        expect(mocks.engineFetch).toHaveBeenCalledWith(
            `${ENGINE_URL}/api/metadata/export-series-json`,
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ 'X-Internal-Secret': 'test-secret' }),
                body: JSON.stringify({ series_ids: ['series_99'] })
            })
        );
        expect(mocks.jobLogCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                jobType: 'EXPORT_SERIES_JSON',
                status: 'COMPLETED',
                message: expect.stringContaining('Wrote 1 of 1')
            })
        }));
    });

    it('should skip EXPORT_SERIES_JSON with a warning log when the export feature is disabled', async () => {
        initWorker();

        mocks.systemSettingFindUnique.mockResolvedValueOnce({ value: 'false' });

        const mockJob = {
            id: 'job_export_disabled',
            data: { type: 'EXPORT_SERIES_JSON' },
            updateProgress: vi.fn()
        };

        await mocks.workerCb.current(mockJob);

        expect(mocks.engineFetch).not.toHaveBeenCalled();
        expect(mocks.jobLogCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                jobType: 'EXPORT_SERIES_JSON',
                status: 'COMPLETED_WITH_ERRORS',
                message: expect.stringContaining('Skipped')
            })
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

    it('should forward DISCOVER_SYNC to the engine and bump the popular-sync timer', async () => {
        initWorker();

        const mockJob = {
            id: 'job_discover',
            data: { type: 'DISCOVER_SYNC' },
            updateProgress: vi.fn()
        };

        await mocks.workerCb.current(mockJob);

        // Node still owns the schedule timer; the engine owns the fetch/filter/cache work
        expect(mocks.systemSettingUpsert).toHaveBeenCalledWith(
            expect.objectContaining({ where: { key: 'last_popular_sync' } })
        );
        expect(mocks.engineFetch).toHaveBeenCalledWith(
            `${ENGINE_URL}/api/discover/sync`,
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ 'X-Internal-Secret': 'test-secret' })
            })
        );
        // The engine writes the DISCOVER_SYNC JobLog itself
        expect(mocks.jobLogCreate).not.toHaveBeenCalled();
    });

    // ==== Issue #174: the same pack NZB must not be added to the download client once per issue
    // request. The DDL path already dedups against the primary link (queue.ts duplicateDownload);
    // the external-client (Prowlarr → SAB/qBit) path must do the same on the tracking hash.

    const runExternalClientSearch = async (sibling: { id: string } | null) => {
        initWorker();

        // freshReq: volumeId "0" skips the series/issue-year block — this test targets routing only.
        mocks.requestFindUnique.mockResolvedValue({ id: 'req_2', volumeId: '0', failedLinks: '[]' });
        mocks.systemSettingFindMany.mockResolvedValue([]);
        mocks.downloadClientFindMany.mockResolvedValue([{ id: 'dc1', name: 'SAB', protocol: 'usenet' }]);
        mocks.requestFindFirst.mockResolvedValue(sibling);

        // Engine matched the same whole-run pack this request's sibling already grabbed.
        mocks.engineFetch.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                success: true,
                best_match: {
                    title: "Batman '89 - Echoes 1-6 Pack",
                    protocol: 'usenet',
                    downloadUrl: 'http://nzbgeek/get/abc',
                    guid: 'nzbgeek-abc',
                    infoHash: null,
                    indexer: 'NZBGeek'
                },
                ddl_candidates: []
            })
        });

        await mocks.workerCb.current({
            id: 'job_search',
            data: { type: 'SEARCH_AND_DOWNLOAD', requestId: 'req_2', name: "Batman '89: Echoes #2", year: '2024', isManga: false, publisher: 'DC', skipIndexers: false },
            updateProgress: vi.fn()
        });
    };

    it('parks a duplicate external-client pack instead of re-adding it to the client (issue #174)', async () => {
        await runExternalClientSearch({ id: 'req_1' }); // sibling already holds this tracking hash

        // The pack must NOT be sent to SABnzbd a second time…
        expect(mocks.addDownload).not.toHaveBeenCalled();
        // …the request is parked against the sibling's link so the shared-link completion sweep
        // (importer updateMany on downloadLink) closes it out when the one download imports.
        expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'req_2' },
            data: expect.objectContaining({ status: 'DOWNLOADING', downloadLink: 'nzbgeek-abc' })
        }));
    });

    it('adds the download normally when no sibling holds the same tracking hash', async () => {
        await runExternalClientSearch(null);

        expect(mocks.addDownload).toHaveBeenCalledTimes(1);
        expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'req_2' },
            data: expect.objectContaining({ status: 'DOWNLOADING', downloadLink: 'nzbgeek-abc' })
        }));
    });

    it('forwards UNMATCHED_SWEEP to the engine matcher and bumps its schedule timer', async () => {
        initWorker();

        const mockJob = {
            id: 'job_unmatched',
            data: { type: 'UNMATCHED_SWEEP' },
            updateProgress: vi.fn()
        };

        await mocks.workerCb.current(mockJob);

        expect(mocks.systemSettingUpsert).toHaveBeenCalledWith(
            expect.objectContaining({ where: { key: 'last_unmatched_sweep' } })
        );
        expect(mocks.engineFetch).toHaveBeenCalledWith(
            `${ENGINE_URL}/api/matcher/sweep`,
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ 'X-Internal-Secret': 'test-secret' })
            })
        );
        // The engine owns the UNMATCHED_SWEEP JobLog (detached run), like the watched-folder sweep.
        expect(mocks.jobLogCreate).not.toHaveBeenCalled();
    });

    it('should fail DISCOVER_SYNC when the engine is unreachable', async () => {
        initWorker();
        mocks.engineFetch.mockRejectedValueOnce(new Error('fetch failed'));

        const mockJob = {
            id: 'job_discover_down',
            data: { type: 'DISCOVER_SYNC' },
            updateProgress: vi.fn()
        };

        await expect(mocks.workerCb.current(mockJob)).rejects.toThrow('fetch failed');

        expect(mocks.jobLogCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ jobType: 'DISCOVER_SYNC', status: 'FAILED' })
        }));
    });

    // ==== Self-healing request lifecycle: no more dead-end states that require deleting the
    // request before the monitor will look at the issue again. ====

    const runMonitor = async (candidates: any[]) => {
        initWorker();
        mocks.userFindFirst.mockResolvedValue({ id: 'admin1', role: 'ADMIN' });
        mocks.requestCreate.mockImplementation(async ({ data }: any) => ({ id: 'new_req', ...data }));
        mocks.seriesFindMany.mockResolvedValue([]);
        // Monitor engine phase response.
        mocks.engineFetch.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ skeletons_created: 0, metron_fetched: 0, notes: [], candidates })
        });
        await mocks.workerCb.current({ id: 'job_monitor', data: { type: 'SERIES_MONITOR' }, updateProgress: vi.fn() });
    };

    it('parks a date-less "released" monitor candidate as AWAITING_RELEASE instead of searching prematurely', async () => {
        // is_released defaults true when the provider has no date at all — has_date:false is the
        // engine's signal that this is a just-solicited issue with nothing to search for yet.
        // Fresh array per call: the candidate loop pushes created requests into the dedup result
        // it got back, and a shared mockResolvedValue array would leak that into the later sweeps.
        mocks.requestFindMany.mockImplementation(async () => []);
        await runMonitor([{
            volume_id: 'v1', metadata_source: 'COMICVINE', search_name: 'Spawn #360', issue_number: '360',
            issue_year: '2026', is_released: true, has_date: false, publisher: 'Image', is_manga: false, image_url: null
        }]);

        expect(mocks.requestCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'AWAITING_RELEASE' })
        }));
        expect(mocks.searchAndDownload).not.toHaveBeenCalled();
    });

    it('still searches immediately for a dated, released candidate (has_date guard regression)', async () => {
        mocks.requestFindMany.mockImplementation(async () => []);
        await runMonitor([{
            volume_id: 'v1', metadata_source: 'COMICVINE', search_name: 'Spawn #359', issue_number: '359',
            issue_year: '2026', is_released: true, has_date: true, publisher: 'Image', is_manga: false, image_url: null
        }]);

        expect(mocks.requestCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'PENDING' })
        }));
        expect(mocks.searchAndDownload).toHaveBeenCalledTimes(1);
    });

    it('re-searches parked MANUAL_DDL and dead STALLED requests on the awaiting cadence, leaving live retries to the cron', async () => {
        // No candidates → the first request.findMany call is the UNRELEASED sweep, the second is
        // the parked/dead sweep (this is the one under test).
        mocks.requestFindMany
            .mockResolvedValueOnce([]) // Phase 3: UNRELEASED
            .mockResolvedValueOnce([   // Phase 3b: parked (already cadence+snooze filtered by the query)
                { id: 'r_manual', volumeId: null, activeDownloadName: 'X-Men #5', status: 'MANUAL_DDL', retryCount: 0, downloadLink: 'https://getcomics.org/dls/x' },
                { id: 'r_terminal', volumeId: null, activeDownloadName: 'X-Men #6', status: 'STALLED', retryCount: 3, downloadLink: 'https://host/file' },
                { id: 'r_nolink', volumeId: null, activeDownloadName: 'X-Men #7', status: 'STALLED', retryCount: 0, downloadLink: null },
                { id: 'r_live', volumeId: null, activeDownloadName: 'X-Men #8', status: 'STALLED', retryCount: 1, downloadLink: 'https://host/live' }
            ]);
        await runMonitor([]);

        // The three dead ones go back to PENDING with a fresh retry budget and a new search…
        for (const id of ['r_manual', 'r_terminal', 'r_nolink']) {
            expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({
                where: { id },
                data: expect.objectContaining({ status: 'PENDING', retryCount: 0 })
            }));
        }
        expect(mocks.searchAndDownload).toHaveBeenCalledTimes(3);
        // …but a STALLED with retries left AND an http link belongs to the 60s cron, not this sweep.
        expect(mocks.requestUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r_live' } }));
    });

    // ==== Pack guard: packs bypass the single-issue number check and the off-series reverse
    // guard, so they must not be considered for an issue too fresh for any pack to contain. ====

    const runSearchWithReleaseDate = async (releaseDate: string) => {
        initWorker();
        mocks.requestFindUnique.mockResolvedValue({ id: 'req_p', volumeId: '101', metadataSource: 'COMICVINE', activeDownloadName: 'Spawn #360', failedLinks: '[]' });
        mocks.seriesFindFirst.mockResolvedValue({ id: 's1', metadataId: '101', metadataSource: 'COMICVINE' });
        mocks.issueCount.mockResolvedValue(0); // zero files owned → packs would normally be allowed
        mocks.issueFindMany.mockResolvedValue([{ number: '360', releaseDate }]);
        mocks.engineFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: false }) });

        await mocks.workerCb.current({
            id: 'job_search_pack',
            data: { type: 'SEARCH_AND_DOWNLOAD', requestId: 'req_p', name: 'Spawn #360', year: '2026', isManga: false, publisher: 'Image', skipIndexers: false },
            updateProgress: vi.fn()
        });

        const searchCall = mocks.engineFetch.mock.calls.find((c: any[]) => String(c[0]).includes('/api/automation/search'));
        return JSON.parse(searchCall![1].body);
    };

    it('disables packs when the requested issue is brand-new (released < 30 days ago)', async () => {
        const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const body = await runSearchWithReleaseDate(tenDaysAgo);
        expect(body.allow_packs).toBe(false);
    });

    it('keeps packs allowed for a zero-file series when the issue is old enough', async () => {
        const body = await runSearchWithReleaseDate('2019-05-01');
        expect(body.allow_packs).toBe(true);
    });

    it('parks the request as STALLED when every DDL hoster candidate fails (no more orphaned DOWNLOADING)', async () => {
        initWorker();
        mocks.requestFindUnique.mockResolvedValue({ id: 'req_ddl', volumeId: '0', failedLinks: '[]' });
        mocks.systemSettingFindMany.mockResolvedValue([]);
        mocks.requestFindFirst.mockResolvedValue(null); // no duplicate download
        mocks.downloadDirectFile.mockResolvedValue(false); // every hoster fails
        mocks.engineFetch.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                success: true,
                best_match: { title: 'Spawn 360', protocol: 'ddl', downloadUrl: 'https://mediafire.com/x', indexer: 'mediafire' },
                ddl_candidates: [{ url: 'https://mediafire.com/x', hoster: 'mediafire' }]
            })
        });

        await mocks.workerCb.current({
            id: 'job_search_ddl',
            data: { type: 'SEARCH_AND_DOWNLOAD', requestId: 'req_ddl', name: 'Spawn #360', year: '2026', isManga: false, publisher: 'Image', skipIndexers: false },
            updateProgress: vi.fn()
        });

        // The hoster loop is detached — wait for it to park the request. The mediafire URL matches
        // neither manual-hold pattern, so the request must land STALLED (not stay DOWNLOADING).
        await vi.waitFor(() => {
            expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({
                where: { id: 'req_ddl' },
                data: expect.objectContaining({ status: 'STALLED', progress: 0 })
            }));
        });
    });
});
