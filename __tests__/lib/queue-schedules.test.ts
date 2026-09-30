import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncSchedules } from '@/lib/queue';
import { scheduleOffsetMs } from '@/lib/schedule-jitter';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const mocks = vi.hoisted(() => ({
    settingFindMany: vi.fn(),
    settingUpsert: vi.fn(),
    queueAdd: vi.fn(),
    getRepeatableJobs: vi.fn(),
    removeRepeatableByKey: vi.fn(),
    upsertJobScheduler: vi.fn(),
    getJobSchedulers: vi.fn(),
    removeJobScheduler: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findMany: mocks.settingFindMany, upsert: mocks.settingUpsert, findUnique: vi.fn() },
    },
}));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: vi.fn() } }));
vi.mock('@/lib/health-checker', () => ({ runSystemHealthCheck: vi.fn() }));
vi.mock('@/lib/download-clients', () => ({ DownloadService: {} }));
vi.mock('@/lib/automation', () => ({ searchAndDownload: vi.fn() }));
vi.mock('@/lib/mailer', () => ({ Mailer: {} }));
vi.mock('ioredis', () => ({
    default: class IORedisMock {
        on() { return this; }
        once() { return this; }
        quit() { return Promise.resolve(); }
        disconnect() { }
        duplicate() { return this; }
    },
}));
vi.mock('bullmq', () => ({
    Queue: class QueueMock {
        add = mocks.queueAdd;
        getRepeatableJobs = mocks.getRepeatableJobs;
        removeRepeatableByKey = mocks.removeRepeatableByKey;
        upsertJobScheduler = mocks.upsertJobScheduler;
        getJobSchedulers = mocks.getJobSchedulers;
        removeJobScheduler = mocks.removeJobScheduler;
    },
    Worker: class WorkerMock { on = vi.fn(); },
}));

const SEED = '0123456789abcdef0123456789abcdef';

function withSettings(values: Record<string, string>) {
    mocks.settingFindMany.mockResolvedValue(Object.entries(values).map(([key, value]) => ({ key, value })));
}

function schedulerCall(id: string) {
    return mocks.upsertJobScheduler.mock.calls.find(call => call[0] === id);
}

// #216: the Metron maintainer saw every Omnibus install query Metron at ~8:03 PM EST nightly.
// BullMQ's legacy `repeat: { every }` lands on multiples of the interval since the Unix epoch, so
// every install's 24h jobs fired at 00:00 UTC together. Schedules now go through job schedulers with
// a stable per-install offset.
describe('syncSchedules: per-install staggered schedules (#216)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.settingUpsert.mockResolvedValue({ key: 'schedule_seed', value: SEED });
        mocks.getRepeatableJobs.mockResolvedValue([]);
        mocks.getJobSchedulers.mockResolvedValue([]);
    });

    it('schedules interval jobs through job schedulers with this install\'s offset, never an epoch-aligned repeat', async () => {
        withSettings({ metadata_sync_schedule: '24', monitor_sync_schedule: '24', library_sync_schedule: '12', popular_sync_schedule: '24' });

        await syncSchedules();

        for (const [jobType, every] of [['METADATA_SYNC', DAY], ['SERIES_MONITOR', DAY], ['LIBRARY_SCAN', 12 * HOUR], ['DISCOVER_SYNC', DAY], ['FOR_YOU_SYNC', DAY]] as const) {
            const call = schedulerCall(`repeat_${jobType.toLowerCase()}`);
            expect(call, jobType).toBeDefined();
            expect(call![1]).toEqual({ every, offset: scheduleOffsetMs(SEED, jobType, every) });
            expect(call![2]).toMatchObject({ name: jobType, data: { type: jobType } });
        }
        // Nothing goes through the old epoch-aligned repeat path any more.
        expect(mocks.queueAdd.mock.calls.filter(call => call[2]?.repeat)).toEqual([]);
    });

    it('staggers the built-in cadences too (watched folder, health check, unmatched sweep, update check)', async () => {
        withSettings({});

        await syncSchedules();

        for (const [jobType, every] of [['WATCHED_FOLDER_SYNC', 0.25 * HOUR], ['SYSTEM_HEALTH_CHECK', 0.25 * HOUR], ['UNMATCHED_SWEEP', HOUR], ['UPDATE_CHECK', DAY]] as const) {
            const call = schedulerCall(`repeat_${jobType.toLowerCase()}`);
            expect(call, jobType).toBeDefined();
            expect(call![1]).toEqual({ every, offset: scheduleOffsetMs(SEED, jobType, every) });
        }
    });

    // #216 follow-up: a failed scheduled run that calls Metron, ComicVine or GitHub was retried twice
    // more within seconds (the queue default, 3 attempts) - the next scheduled run is its retry.
    it('never retries a scheduled run that calls an outside service; local jobs keep the default retries', async () => {
        withSettings({ metadata_sync_schedule: '24', monitor_sync_schedule: '24', popular_sync_schedule: '24', library_sync_schedule: '12', backup_sync_schedule: '24' });

        await syncSchedules();

        for (const jobType of ['METADATA_SYNC', 'SERIES_MONITOR', 'DISCOVER_SYNC', 'FOR_YOU_SYNC', 'UNMATCHED_SWEEP', 'UPDATE_CHECK']) {
            expect(schedulerCall(`repeat_${jobType.toLowerCase()}`)![2], jobType).toEqual({ name: jobType, data: { type: jobType }, opts: { attempts: 1 } });
        }
        for (const jobType of ['LIBRARY_SCAN', 'DATABASE_BACKUP', 'WATCHED_FOLDER_SYNC', 'SYSTEM_HEALTH_CHECK']) {
            expect(schedulerCall(`repeat_${jobType.toLowerCase()}`)![2], jobType).toEqual({ name: jobType, data: { type: jobType } });
        }
    });

    it('creates the install seed once and never overwrites it', async () => {
        withSettings({ metadata_sync_schedule: '24' });

        await syncSchedules();

        expect(mocks.settingUpsert).toHaveBeenCalledWith({
            where: { key: 'schedule_seed' },
            update: {},
            create: { key: 'schedule_seed', value: expect.stringMatching(/^[0-9a-f]{32}$/) },
        });
    });

    it('gives the same offsets on every boot, so a restart keeps each job in its slot', async () => {
        withSettings({ metadata_sync_schedule: '24' });

        await syncSchedules();
        const first = schedulerCall('repeat_metadata_sync')![1];
        mocks.upsertJobScheduler.mockClear();
        await syncSchedules();

        expect(schedulerCall('repeat_metadata_sync')![1]).toEqual(first);
    });

    it('keeps the weekly backup and digest on their day-of-week patterns', async () => {
        withSettings({ backup_sync_schedule: '168', backup_sync_day: '0', weekly_digest_schedule: '168', weekly_digest_day: '5' });

        await syncSchedules();

        expect(schedulerCall('repeat_database_backup')![1]).toEqual({ pattern: '0 3 * * 0' });
        expect(schedulerCall('repeat_weekly_digest')![1]).toEqual({ pattern: '0 8 * * 5' });
    });

    it('removes the legacy epoch-aligned repeatables older versions left in Redis, but not its own schedulers', async () => {
        withSettings({ metadata_sync_schedule: '24' });
        mocks.getRepeatableJobs.mockResolvedValue([
            { key: '3f2b9c0d8e7a6b5c4d3e2f1a0b9c8d7e' },          // v5 legacy key (md5)
            { key: 'METADATA_SYNC:repeat_metadata_sync:::86400000' }, // older legacy format
            { key: 'repeat_metadata_sync' },                      // a job scheduler (same Redis set)
        ]);

        await syncSchedules();

        expect(mocks.removeRepeatableByKey.mock.calls.map(call => call[0])).toEqual([
            '3f2b9c0d8e7a6b5c4d3e2f1a0b9c8d7e',
            'METADATA_SYNC:repeat_metadata_sync:::86400000',
        ]);
    });

    it('drops the scheduler of a job the admin turned off, and leaves the rest', async () => {
        withSettings({ metadata_sync_schedule: '0', monitor_sync_schedule: '24' });
        mocks.getJobSchedulers.mockResolvedValue([
            { key: 'repeat_metadata_sync', name: 'METADATA_SYNC' },
            { key: 'repeat_series_monitor', name: 'SERIES_MONITOR' },
        ]);

        await syncSchedules();

        expect(schedulerCall('repeat_metadata_sync')).toBeUndefined();
        expect(mocks.removeJobScheduler).toHaveBeenCalledWith('repeat_metadata_sync');
        expect(mocks.removeJobScheduler).not.toHaveBeenCalledWith('repeat_series_monitor');
    });
});
