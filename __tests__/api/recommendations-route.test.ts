// __tests__/api/recommendations-route.test.ts
//
// "Because you read X" rotation (2026-07-25 worklist item 3): the seed must rotate daily across
// the user's DISTINCT recently-read series instead of pinning to the single most-recent
// ReadProgress row, and empty Issue.genres must fall back to Series.genres before giving up.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET } from '../../src/app/api/recommendations/route';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    getAccessibleLibraryIds: vi.fn(),
    readProgressFindMany: vi.fn(),
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
        readProgress: { findMany: mocks.readProgressFindMany },
        series: { findMany: mocks.seriesFindMany },
    },
}));
vi.mock('../../src/lib/logger', () => ({ Logger: { log: mocks.log } }));

const read = (seriesId: string, seriesName: string, issueGenres: string | null, seriesGenres: string | null = null) => ({
    userId: 'u1', issueId: `iss-${seriesId}`, updatedAt: new Date('2026-07-25T00:00:00Z'),
    issue: {
        id: `iss-${seriesId}`, seriesId, genres: issueGenres,
        series: { id: seriesId, name: seriesName, genres: seriesGenres },
    },
});

const candidate = (id: string) => ({
    id, name: `Series ${id}`, year: 2026, folderPath: `/lib/${id}`, coverUrl: null,
    _count: { issues: 2 }, issues: [{ coverUrl: `http://covers/${id}.jpg` }],
});

describe('GET /api/recommendations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', role: 'USER' } });
        mocks.getAccessibleLibraryIds.mockResolvedValue('ALL');
        mocks.seriesFindMany.mockResolvedValue([candidate('c1'), candidate('c2')]);
    });
    afterEach(() => { vi.useRealTimers(); });

    it('rotates the seed across distinct recent series on different days', async () => {
        mocks.readProgressFindMany.mockResolvedValue([
            read('sA', 'Alpha', '["Action"]'),
            read('sB', 'Beta', '["Horror"]'),
        ]);

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-24T12:00:00Z'));
        const day1 = await (await GET(new Request('http://x/api/recommendations') as any)).json();

        vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
        const day2 = await (await GET(new Request('http://x/api/recommendations') as any)).json();

        expect([day1.basedOn, day2.basedOn].sort()).toEqual(['Alpha', 'Beta']);
        expect(day1.basedOn).not.toBe(day2.basedOn);
    });

    it('collapses multiple reads of the same series into one seed', async () => {
        mocks.readProgressFindMany.mockResolvedValue([
            read('sA', 'Alpha', '["Action"]'),
            read('sA', 'Alpha', '["Action"]'),
            read('sA', 'Alpha', '["Action"]'),
        ]);
        const data = await (await GET(new Request('http://x') as any)).json();
        expect(data.basedOn).toBe('Alpha');
        expect(data.series.length).toBeGreaterThan(0);
    });

    it('falls back to Series.genres when the issue has none', async () => {
        mocks.readProgressFindMany.mockResolvedValue([
            read('sA', 'Alpha', '[]', '["Isekai"]'),
        ]);
        const data = await (await GET(new Request('http://x') as any)).json();

        expect(data.basedOn).toBe('Alpha');
        expect(mocks.seriesFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                issues: expect.objectContaining({
                    some: expect.objectContaining({
                        OR: [{ genres: { contains: 'Isekai' } }],
                    }),
                }),
            }),
        }));
    });

    it('skips seeds with no genres anywhere and uses the next distinct series', async () => {
        mocks.readProgressFindMany.mockResolvedValue([
            read('sA', 'Alpha', null, null),
            read('sB', 'Beta', '["Sci-Fi"]'),
        ]);
        const data = await (await GET(new Request('http://x') as any)).json();
        expect(data.basedOn).toBe('Beta');
    });

    it('returns an empty shelf when no read history exists', async () => {
        mocks.readProgressFindMany.mockResolvedValue([]);
        const data = await (await GET(new Request('http://x') as any)).json();
        expect(data).toEqual({ series: [], basedOn: null });
    });
});
