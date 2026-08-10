import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initCronJobs } from '@/lib/cron';
import { loggerLog } from '../helpers/setup-global';

// 1. Hoist our mocks
const mocks = vi.hoisted(() => ({
    requestFindMany: vi.fn(),
    requestUpdate: vi.fn(),
    requestUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
    systemSettingFindUnique: vi.fn(),
    systemSettingFindMany: vi.fn(),
    jobLockFindUnique: vi.fn(),
    jobLockCreate: vi.fn(),
    jobLockUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
    jobLogCreate: vi.fn(),
    getAllActiveDownloads: vi.fn(),
    downloadDirectFile: vi.fn().mockResolvedValue(true),
    importRequest: vi.fn().mockResolvedValue(true),
    seriesFindMany: vi.fn(),
    log: vi.fn(),
    cronCb: { current: null as any }
}));

// 2. Mock dependencies safely
vi.mock('@/lib/db', () => ({
    prisma: {
        request: { findMany: mocks.requestFindMany, update: mocks.requestUpdate, updateMany: mocks.requestUpdateMany },
        systemSetting: { findUnique: mocks.systemSettingFindUnique, findMany: mocks.systemSettingFindMany },
        jobLock: { findUnique: mocks.jobLockFindUnique, create: mocks.jobLockCreate, updateMany: mocks.jobLockUpdateMany },
        jobLog: { create: mocks.jobLogCreate },
        series: { findMany: mocks.seriesFindMany }
    }
}));


// The 60s tick now runs the stuck-job heal first (issue #183); stub it so these download-checker
// suites stay deterministic (job-heal has its own unit suite).
vi.mock('@/lib/job-heal', () => ({ healStuckJobs: vi.fn().mockResolvedValue(0) }));

vi.mock('@/lib/download-clients', () => ({
    DownloadService: {
        getAllActiveDownloads: mocks.getAllActiveDownloads,
        downloadDirectFile: mocks.downloadDirectFile
    }
}));

vi.mock('@/lib/importer', () => ({
    Importer: { importRequest: mocks.importRequest }
}));

vi.mock('@/lib/queue', () => ({
    syncSchedules: vi.fn().mockResolvedValue(true)
}));


describe('Cron Logic: Automated Download Checker', () => {
    beforeEach(() => {
        (globalThis as any)._cronInitialized = false;
        
        // Intercept setInterval to manually trigger the async callback loop during tests
        vi.stubGlobal('setInterval', (cb: any) => {
            mocks.cronCb.current = cb;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should retry stalled downloads if the retry delay has passed', async () => {
        const pastDate = new Date(Date.now() - 10 * 60 * 1000);
        
        // Use implementation to safely handle multiple dynamic calls
        mocks.requestFindMany.mockImplementation(async (args) => {
            if (args.where.status === 'STALLED') return [{
                id: 'req_stalled_1',
                status: 'STALLED',
                retryCount: 0,
                updatedAt: pastDate,
                downloadLink: 'http://getcomics/file.cbz',
                activeDownloadName: 'Batman 01'
            }];
            return [];
        });
        
        mocks.systemSettingFindUnique.mockImplementation(async (args) => {
            if (args.where.key === 'download_retry_delay') return { value: '5' };
            return null;
        });
        
        mocks.systemSettingFindMany.mockResolvedValue([{ key: 'download_path', value: '/downloads' }]); 
        mocks.getAllActiveDownloads.mockResolvedValue([]); 

        initCronJobs();
        await mocks.cronCb.current(); // Manually trigger the loop

        // Assert it updated the DB to reflect the retry attempt
        expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'req_stalled_1' },
            data: expect.objectContaining({ retryCount: 1, status: 'DOWNLOADING' })
        }));
        
        // Assert it triggered the Download Client to try again
        expect(mocks.downloadDirectFile).toHaveBeenCalledWith(
            'http://getcomics/file.cbz',
            'Batman 01',
            '/downloads',
            'req_stalled_1'
        );
    });

    it('should fuzzy match messy torrent names to clean database requests and import when complete', async () => {
        mocks.requestFindMany.mockImplementation(async (args) => {
            if (args.where.status === 'STALLED') return [];
            if (args.where.status === 'DOWNLOADING') return [{
                id: 'req_fuzzy',
                status: 'DOWNLOADING',
                activeDownloadName: 'Batman #1',
                volumeId: 'vol_1'
            }];
            return [];
        });
        
        // Simulate a torrent client reporting a messy active download at 100% completion
        mocks.getAllActiveDownloads.mockResolvedValue([{
            id: 'torrent_hash_123',
            name: 'Batman Issue #01 (Webrip)',
            progress: '100'
        }]);

        mocks.seriesFindMany.mockResolvedValue([{
            metadataId: 'vol_1',
            year: 2016
        }]);

        initCronJobs();
        await mocks.cronCb.current();

        expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'req_fuzzy' },
            data: expect.objectContaining({ 
                activeDownloadName: 'Batman Issue #01 (Webrip)', 
                downloadLink: 'torrent_hash_123' 
            })
        }));
        expect(mocks.importRequest).toHaveBeenCalledWith('req_fuzzy');

        // NEW: Assert our new debug log traced the successful match ratio calculation
        expect(loggerLog).toHaveBeenCalledWith(
            expect.stringContaining('[Cron Debug] Match SUCCESS! Ratio:'),
            'debug'
        );
    });

    // ==== #202: the fallback matcher's year gate captured group 1 of /(19|20)\d{2}/ — the literal
    // "20" — so every DATED torrent failed the year comparison ("Req: 2011 vs Tor: 20") and could
    // only ever pair via the exact-name/link tiers. These pin the fixed capture both ways.
    it('pairs a dated torrent with its request when the release year matches the series year (#202)', async () => {
        mocks.requestFindMany.mockImplementation(async (args) => {
            if (args.where.status === 'DOWNLOADING') return [{
                id: 'req_dated_ok',
                status: 'DOWNLOADING',
                activeDownloadName: 'Batman #1',
                volumeId: 'vol_1'
            }];
            return [];
        });
        mocks.getAllActiveDownloads.mockResolvedValue([{
            id: 'torrent_hash_dated',
            name: 'Batman 001 (2016) (Digital)',
            progress: '100'
        }]);
        mocks.seriesFindMany.mockResolvedValue([{ metadataId: 'vol_1', year: 2016 }]);

        initCronJobs();
        await mocks.cronCb.current();

        expect(mocks.importRequest).toHaveBeenCalledWith('req_dated_ok');
    });

    it('still refuses to pair a dated torrent whose year disagrees (#202 keeps the gate strict)', async () => {
        mocks.requestFindMany.mockImplementation(async (args) => {
            if (args.where.status === 'DOWNLOADING') return [{
                id: 'req_dated_wrong',
                status: 'DOWNLOADING',
                activeDownloadName: 'Batman #1',
                volumeId: 'vol_1'
            }];
            return [];
        });
        mocks.getAllActiveDownloads.mockResolvedValue([{
            id: 'torrent_hash_wrongyear',
            name: 'Batman 001 (2014) (Digital)',
            progress: '100'
        }]);
        mocks.seriesFindMany.mockResolvedValue([{ metadataId: 'vol_1', year: 2016 }]);

        initCronJobs();
        await mocks.cronCb.current();

        expect(mocks.importRequest).not.toHaveBeenCalledWith('req_dated_wrong');
        expect(loggerLog).toHaveBeenCalledWith(
            expect.stringContaining('Year mismatch (Req: 2016 vs Tor: 2014)'),
            'debug'
        );
    });

    it('releases parked batch siblings stranded by a permanently-failed (terminal) lead', async () => {
        const deadLink = 'http://getcomics/batch-pack.cbz';

        mocks.requestFindMany.mockImplementation(async (args) => {
            // The terminal-dead-lead query (STALLED, retryCount >= 3) — return one dead lead.
            if (args.where.status === 'STALLED' && args.where.retryCount?.gte === 3) {
                return [{ downloadLink: deadLink }];
            }
            // The retryable-stalled query (retryCount < 3) and any DOWNLOADING query — nothing here.
            return [];
        });
        mocks.requestUpdateMany.mockResolvedValue({ count: 2 });
        mocks.systemSettingFindMany.mockResolvedValue([{ key: 'download_path', value: '/downloads' }]);
        mocks.getAllActiveDownloads.mockResolvedValue([]);

        initCronJobs();
        await mocks.cronCb.current();

        // Parked DOWNLOADING siblings sharing the dead lead's link are demoted to terminal STALLED.
        expect(mocks.requestUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                status: 'DOWNLOADING',
                downloadLink: { in: [deadLink] }
            }),
            data: expect.objectContaining({ status: 'STALLED', retryCount: 3 })
        }));

        // With no retryable stalls present, nothing should be re-downloaded.
        expect(mocks.downloadDirectFile).not.toHaveBeenCalled();
    });

});