// Follow model (Updates-feed subscription signal, Beta A). Contracts pinned: followSeries is
// idempotent and NEVER throws (a follow insert must never fail the request that triggered it);
// catalog-id follows are silent no-ops for series not in the library; the request-history backfill
// is sentinel-guarded, dedupes, skips never-imported series, and uses the SQLite-safe filter-first
// insert (no skipDuplicates).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { followSeries, followSeriesByCatalogId, backfillFollowsFromRequests, FOLLOW_BACKFILL_SENTINEL } from '@/lib/follows';

const mocks = vi.hoisted(() => ({
    followUpsert: vi.fn(),
    followFindMany: vi.fn(),
    followCreateMany: vi.fn(),
    seriesFindUnique: vi.fn(),
    seriesFindMany: vi.fn(),
    requestFindMany: vi.fn(),
    settingFindUnique: vi.fn(),
    settingCreate: vi.fn(),
    log: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        seriesFollow: { upsert: mocks.followUpsert, findMany: mocks.followFindMany, createMany: mocks.followCreateMany },
        series: { findUnique: mocks.seriesFindUnique, findMany: mocks.seriesFindMany },
        request: { findMany: mocks.requestFindMany },
        systemSetting: { findUnique: mocks.settingFindUnique, create: mocks.settingCreate },
    }
}));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

beforeEach(() => {
    vi.clearAllMocks();
    mocks.followUpsert.mockResolvedValue({});
    mocks.followFindMany.mockResolvedValue([]);
    mocks.followCreateMany.mockResolvedValue({ count: 0 });
    mocks.settingCreate.mockResolvedValue({});
});

describe('followSeries', () => {
    it('upserts on the compound key (idempotent by construction)', async () => {
        await followSeries('u1', 's1');

        expect(mocks.followUpsert).toHaveBeenCalledWith({
            where: { userId_seriesId: { userId: 'u1', seriesId: 's1' } },
            update: {},
            create: { userId: 'u1', seriesId: 's1' },
        });
    });

    it('never throws — a DB failure logs a warning and resolves', async () => {
        mocks.followUpsert.mockRejectedValue(new Error('db down'));

        await expect(followSeries('u1', 's1')).resolves.toBeUndefined();
        expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining('Auto-follow failed'), 'warn');
    });

    it('no-ops on missing ids', async () => {
        await followSeries('', 's1');
        await followSeries('u1', '');
        expect(mocks.followUpsert).not.toHaveBeenCalled();
    });
});

describe('followSeriesByCatalogId', () => {
    it('resolves the series by catalog identity and follows it', async () => {
        mocks.seriesFindUnique.mockResolvedValue({ id: 's9' });

        await followSeriesByCatalogId('u1', 'COMICVINE', '4242');

        expect(mocks.seriesFindUnique).toHaveBeenCalledWith({
            where: { metadataSource_metadataId: { metadataSource: 'COMICVINE', metadataId: '4242' } },
            select: { id: true },
        });
        expect(mocks.followUpsert).toHaveBeenCalledWith(expect.objectContaining({
            create: { userId: 'u1', seriesId: 's9' },
        }));
    });

    it('is a silent no-op when the series is not in the library, or for the 0 placeholder id', async () => {
        mocks.seriesFindUnique.mockResolvedValue(null);
        await followSeriesByCatalogId('u1', 'COMICVINE', '4242');
        await followSeriesByCatalogId('u1', 'COMICVINE', '0');
        await followSeriesByCatalogId('u1', 'COMICVINE', null);

        expect(mocks.followUpsert).not.toHaveBeenCalled();
        expect(mocks.seriesFindUnique).toHaveBeenCalledTimes(1); // '0' and null short-circuit before the lookup
    });

    it('never throws when the lookup fails', async () => {
        mocks.seriesFindUnique.mockRejectedValue(new Error('busy'));
        await expect(followSeriesByCatalogId('u1', 'COMICVINE', '4242')).resolves.toBeUndefined();
        expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining('follow lookup failed'), 'warn');
    });
});

describe('backfillFollowsFromRequests', () => {
    it('is a no-op when the sentinel exists', async () => {
        mocks.settingFindUnique.mockResolvedValue({ key: FOLLOW_BACKFILL_SENTINEL, value: 'done' });

        await backfillFollowsFromRequests();

        expect(mocks.requestFindMany).not.toHaveBeenCalled();
        expect(mocks.settingCreate).not.toHaveBeenCalled();
    });

    it('derives deduped follows from request history, skipping never-imported series and existing rows', async () => {
        mocks.settingFindUnique.mockResolvedValue(null);
        mocks.requestFindMany.mockResolvedValue([
            { userId: 'u1', volumeId: '100', metadataSource: 'COMICVINE' },
            { userId: 'u1', volumeId: '100', metadataSource: 'COMICVINE' }, // dup request → one follow
            { userId: 'u2', volumeId: '100', metadataSource: 'COMICVINE' },
            { userId: 'u1', volumeId: '200', metadataSource: 'METRON' },
            { userId: 'u1', volumeId: '300', metadataSource: 'COMICVINE' }, // series never imported
            { userId: 'u1', volumeId: '0', metadataSource: 'COMICVINE' },   // placeholder id
        ]);
        mocks.seriesFindMany.mockResolvedValue([
            { id: 'sA', metadataSource: 'COMICVINE', metadataId: '100' },
            { id: 'sB', metadataSource: 'METRON', metadataId: '200' },
        ]);
        // u2 already follows sA (e.g. manual follow before the backfill ran) → filtered, not duplicated.
        mocks.followFindMany.mockResolvedValue([{ userId: 'u2', seriesId: 'sA' }]);

        await backfillFollowsFromRequests();

        expect(mocks.followCreateMany).toHaveBeenCalledWith({
            data: [
                { userId: 'u1', seriesId: 'sA' },
                { userId: 'u1', seriesId: 'sB' },
            ]
        });
        expect(mocks.settingCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({ key: FOLLOW_BACKFILL_SENTINEL })
        });
    });

    it('still writes the sentinel when there is nothing to backfill', async () => {
        mocks.settingFindUnique.mockResolvedValue(null);
        mocks.requestFindMany.mockResolvedValue([]);

        await backfillFollowsFromRequests();

        expect(mocks.followCreateMany).not.toHaveBeenCalled();
        expect(mocks.settingCreate).toHaveBeenCalled();
    });
});
