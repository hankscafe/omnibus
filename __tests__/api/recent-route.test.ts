// __tests__/api/recent-route.test.ts
//
// "Recently Added" shelf ordering (2026-07-25 worklist item 1): the shelf must surface the
// series with the NEWEST IMPORTED ISSUE first — not series-row creation order. The old query
// ordered by Series.id desc, so new issues landing in existing series never bumped the shelf.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '../../src/app/api/library/recent/route';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    getAccessibleLibraryIds: vi.fn(),
    issueGroupBy: vi.fn(),
    seriesFindMany: vi.fn(),
    log: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('../../src/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn().mockResolvedValue({}) }));
vi.mock('../../src/lib/library-access', () => ({
    getAccessibleLibraryIds: mocks.getAccessibleLibraryIds,
    seriesAccessWhere: (ids: any) => (ids === 'ALL' ? {} : { libraryId: { in: ids } }),
    nestedSeriesAccessWhere: (ids: any) => (ids === 'ALL' ? {} : { series: { libraryId: { in: ids } } }),
}));
vi.mock('../../src/lib/db', () => ({
    prisma: {
        issue: { groupBy: mocks.issueGroupBy },
        series: { findMany: mocks.seriesFindMany },
    },
}));
vi.mock('../../src/lib/logger', () => ({ Logger: { log: mocks.log } }));

const seriesRow = (id: string, name: string) => ({
    id, name, year: 2026, folderPath: `/lib/${name}`, coverUrl: null,
    _count: { issues: 3 }, issues: [{ coverUrl: `http://covers/${name}.jpg` }],
});

describe('GET /api/library/recent', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
        mocks.getAccessibleLibraryIds.mockResolvedValue('ALL');
    });

    it('orders series by newest imported issue, not by series id', async () => {
        // old-series has the NEWER issue import; new-series is a newer row with an older import
        mocks.issueGroupBy.mockResolvedValue([
            { seriesId: 'old-series', _max: { createdAt: new Date('2026-07-25T10:00:00Z') } },
            { seriesId: 'new-series', _max: { createdAt: new Date('2026-07-20T10:00:00Z') } },
        ]);
        // DB hands the hydration query back in its own (id) order — route must re-apply groupBy order
        mocks.seriesFindMany.mockResolvedValue([
            seriesRow('new-series', 'Newer Row'),
            seriesRow('old-series', 'Older Row'),
        ]);

        const res = await GET();
        const data = await res.json();

        expect(mocks.issueGroupBy).toHaveBeenCalledWith(expect.objectContaining({
            by: ['seriesId'],
            where: expect.objectContaining({ filePath: { not: null } }),
            orderBy: { _max: { createdAt: 'desc' } },
            take: 7,
        }));
        expect(data.items.map((i: any) => i.id)).toEqual(['old-series', 'new-series']);
    });

    it('returns an empty shelf when no issues exist', async () => {
        mocks.issueGroupBy.mockResolvedValue([]);
        const res = await GET();
        const data = await res.json();
        expect(data.items).toEqual([]);
        expect(mocks.seriesFindMany).not.toHaveBeenCalled();
    });

    it('scopes the issue rollup to accessible libraries for restricted users', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'u2', role: 'USER' } });
        mocks.getAccessibleLibraryIds.mockResolvedValue(['lib1']);
        mocks.issueGroupBy.mockResolvedValue([]);

        await GET();

        expect(mocks.issueGroupBy).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ series: { libraryId: { in: ['lib1'] } } }),
        }));
    });
});
