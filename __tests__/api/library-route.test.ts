// __tests__/api/library-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/library/route';

// 1. Hoist our mocks
const mocks = vi.hoisted(() => ({
    findManySeries: vi.fn(),
    countSeries: vi.fn(),
    // Hoisted (not factory-inline) so the aggregate-counts test can override per test.
    groupByIssue: vi.fn(),
    getServerSession: vi.fn()
}));

// 2. Mock NextAuth
vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));

// 3. Mock Prisma
vi.mock('@/lib/db', () => ({
    prisma: {
        series: {
            findMany: mocks.findManySeries,
            count: mocks.countSeries
        },
        issue: {
            groupBy: mocks.groupByIssue,
            findMany: vi.fn().mockResolvedValue([])
        },
        library: {
            findMany: vi.fn().mockResolvedValue([{ id: 'lib_1', path: '/library', isManga: false }])
        }
    }
}));


const createReq = (queryParam: string, extraParams: string = '') => {
    // Inject the /library path prefix so the authorization passes
    const url = `http://localhost/api/library?path=/library&q=${encodeURIComponent(queryParam)}${extraParams}`;
    return new Request(url);
};

describe('API Route: Library Advanced Search', () => {
    beforeEach(() => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1', role: 'ADMIN' } });
        mocks.countSeries.mockResolvedValue(1);
        mocks.findManySeries.mockResolvedValue([{ id: '1', issues: [], favorites: [] }]);
        mocks.groupByIssue.mockResolvedValue([]);
    });

    // Merged from the stalled near-duplicate __tests__/lib/library-route.test.ts (beta.014 suite
    // refactor) — the three tests that file uniquely owned.
    it('derives card counts from grouped aggregates instead of loading every issue row', async () => {
        // The page no longer include-loads all issues; it counts downloaded + read issues per series
        // via two groupBy aggregates. Verify the derived numbers: count = downloaded,
        // unread = downloaded - read, progress = round(read / downloaded * 100).
        mocks.findManySeries.mockResolvedValue([
            { id: 's1', name: 'Batman', year: 2016, publisher: 'DC', coverUrl: '/cover.jpg', folderPath: '/x', favorites: [] }
        ]);
        mocks.groupByIssue
            .mockResolvedValueOnce([{ seriesId: 's1', _count: { _all: 10 } }])  // downloaded
            .mockResolvedValueOnce([{ seriesId: 's1', _count: { _all: 4 } }]);  // read/completed

        const res = await GET(createReq('batman'));
        const body = await res.json();
        const series = body.series[0];

        expect(series.count).toBe(10);
        expect(series.unreadCount).toBe(6);
        expect(series.progressPercentage).toBe(40);
        expect(series.isPendingReq).toBe(false);
    });

    it('filters by series status for mass-monitor workflows (discussion #177)', async () => {
        // Filter Ongoing series, select all, bulk-monitor — previously status had no filter at all.
        await GET(new Request('http://localhost/api/library?path=/library&status=Ongoing'));

        const queryArg = mocks.findManySeries.mock.calls[0][0].where;
        expect(queryArg.AND).toEqual(
            expect.arrayContaining([{ status: 'Ongoing' }])
        );

        // Unknown values are ignored (no injection into the where clause).
        mocks.findManySeries.mockClear();
        await GET(new Request('http://localhost/api/library?path=/library&status=Bogus'));
        const arg2 = mocks.findManySeries.mock.calls[0][0].where;
        const clauses = Array.isArray(arg2.AND) ? arg2.AND : [];
        expect(clauses.some((c: any) => 'status' in c)).toBe(false);
    });

    it('should translate "writer: Name" into a strict writer query', async () => {
        await GET(createReq('writer: tom king'));

        const queryArg = mocks.findManySeries.mock.calls[0][0].where;
        expect(queryArg.AND).toEqual(
            expect.arrayContaining([
                { issues: { some: { writers: { contains: 'tom king' } } } }
            ])
        );
    });

    it('should default to a broad OR search if no prefix is provided', async () => {
        const req = createReq('batman');
        await GET(req);

        // Assert Prisma was called with an OR query looking across names, publishers, and creators
        const queryArg = mocks.findManySeries.mock.calls[0][0].where;
        
        expect(queryArg.AND).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    OR: expect.arrayContaining([
                        { name: { contains: 'batman' } },
                        { publisher: { contains: 'batman' } }
                    ])
                })
            ])
        );
    });

    it('should translate "character: Name" into a strict character query', async () => {
        const req = createReq('character: joker');
        await GET(req);

        const queryArg = mocks.findManySeries.mock.calls[0][0].where;
        expect(queryArg.AND).toEqual(
            expect.arrayContaining([
                { issues: { some: { characters: { contains: 'joker' } } } }
            ])
        );
    });

    it('should apply the correct Prisma query for era=1990s', async () => {
        const req = createReq('', '&era=1990s');
        await GET(req);

        const queryArg = mocks.findManySeries.mock.calls[0][0].where;
        
        // Assert it correctly maps the decade string to numeric greater/less than values
        expect(queryArg.AND).toEqual(
            expect.arrayContaining([
                { year: { gte: 1990, lt: 2000 } }
            ])
        );
    });

    it('should apply the correct Prisma query for readStatus=UNREAD', async () => {
        const req = createReq('', '&readStatus=UNREAD');
        await GET(req);

        const queryArg = mocks.findManySeries.mock.calls[0][0].where;
        
        // Assert it deeply queries the readProgresses relation to ensure NO issues are completed
        expect(queryArg.AND).toEqual(
            expect.arrayContaining([
                { issues: { none: { readProgresses: { some: { userId: 'user_1', isCompleted: true } } } } }
            ])
        );
    });

    // Beta E (2026-07-25 worklist item 6): the alphabet jump bar needs (a) a light names index in
    // the exact server order under the current filters, and (b) an absolute-offset window so a
    // letter click can anchor the list mid-alphabet without paging from the start.
    describe('alphabet jump bar support', () => {
        it('namesOnly returns the bare sorted names and skips the heavy include path', async () => {
            mocks.findManySeries.mockResolvedValue([{ name: 'Alpha' }, { name: 'Batman' }]);

            const res = await GET(new Request('http://localhost/api/library?path=/library&namesOnly=1&sort=alpha_asc'));
            const data = await res.json();

            expect(data.names).toEqual(['Alpha', 'Batman']);
            const call = mocks.findManySeries.mock.calls[0][0];
            expect(call.select).toEqual({ name: true });
            // Total order incl. tiebreaker (v1.4.1) — the index must be computed against the SAME
            // order the page windows realize, or the bar's offsets drift off the real positions.
            // Year secondary rides along (#201) because the index shares the page orderBy.
            expect(call.orderBy).toEqual([{ name: 'asc' }, { year: 'asc' }, { id: 'asc' }]);
            expect(call.skip).toBeUndefined();
            expect(call.take).toBeUndefined();
        });

        it('offset overrides page-based skip and drives hasMore from the absolute position', async () => {
            mocks.countSeries.mockResolvedValue(100);
            mocks.findManySeries.mockResolvedValue([{ id: '1', issues: [], favorites: [] }]);

            const res = await GET(new Request('http://localhost/api/library?path=/library&offset=37&limit=24'));
            const data = await res.json();

            expect(mocks.findManySeries.mock.calls[0][0].skip).toBe(37);
            expect(data.hasMore).toBe(true); // 37 + 24 < 100

            mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1', role: 'ADMIN' } });
            mocks.countSeries.mockResolvedValue(50);
            mocks.findManySeries.mockResolvedValue([{ id: '2', issues: [], favorites: [] }]);

            const res2 = await GET(new Request('http://localhost/api/library?path=/library&offset=37&limit=24'));
            const data2 = await res2.json();
            expect(data2.hasMore).toBe(false); // 37 + 24 >= 50
        });
    });

    // v1.4.1 field regression (live pg deployment): OFFSET pagination requires a TOTAL order.
    // PostgreSQL gives rows with equal sort keys no deterministic order between executions, so a
    // bare name/year sort let page windows overlap and gap on ties (rebooted volumes share exact
    // names) — infinite scroll appends starved and the library jittered between adjacent-letter
    // items. Every paginated sort must therefore end in the unique `id` tiebreaker.
    describe('v1.4.1: every paginated sort carries a unique id tiebreaker', () => {
        const orderByFor = async (sort: string) => {
            const res = await GET(new Request(`http://localhost/api/library?path=/library&sort=${sort}`));
            expect(res.status).toBe(200);
            return mocks.findManySeries.mock.calls[0][0].orderBy;
        };

        // #201 (anacronismo): the alpha sorts ALSO carry a `year` secondary — without it,
        // same-name volumes fell to id = creation order, which only looked year-sorted for
        // scan-born series (folders scan alphabetically as "Series (Year)"). X-Men volumes
        // accumulated via requests/matches read as randomly shuffled.
        it('alpha_asc orders same-name volumes oldest-first and ends in id', async () => {
            expect(await orderByFor('alpha_asc')).toEqual([{ name: 'asc' }, { year: 'asc' }, { id: 'asc' }]);
        });
        it('alpha_desc mirrors the year secondary so Z-A is the exact reverse', async () => {
            expect(await orderByFor('alpha_desc')).toEqual([{ name: 'desc' }, { year: 'desc' }, { id: 'desc' }]);
        });
        it('year sorts end in id (year ties are rampant)', async () => {
            expect(await orderByFor('year_desc')).toEqual([{ year: 'desc' }, { name: 'asc' }, { id: 'asc' }]);
        });
        it('count_desc ends in id (issue-count ties are rampant)', async () => {
            expect(await orderByFor('count_desc')).toEqual([{ issues: { _count: 'desc' } }, { name: 'asc' }, { id: 'asc' }]);
        });
        it('random keeps its already-unique id order', async () => {
            expect(await orderByFor('random')).toEqual({ id: 'asc' });
        });
    });
});