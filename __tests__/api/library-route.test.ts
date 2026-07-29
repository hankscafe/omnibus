// __tests__/api/library-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/library/route';

// 1. Hoist our mocks
const mocks = vi.hoisted(() => ({
    findManySeries: vi.fn(),
    countSeries: vi.fn(),
    getServerSession: vi.fn()
}));

// 2. Mock NextAuth
vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn() }));

// 3. Mock Prisma
vi.mock('@/lib/db', () => ({
    prisma: {
        series: {
            findMany: mocks.findManySeries,
            count: mocks.countSeries
        },
        issue: {
            groupBy: vi.fn().mockResolvedValue([]),
            findMany: vi.fn().mockResolvedValue([])
        },
        library: {
            findMany: vi.fn().mockResolvedValue([{ id: 'lib_1', path: '/library', isManga: false }])
        }
    }
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));

const createReq = (queryParam: string, extraParams: string = '') => {
    // Inject the /library path prefix so the authorization passes
    const url = `http://localhost/api/library?path=/library&q=${encodeURIComponent(queryParam)}${extraParams}`;
    return new Request(url);
};

describe('API Route: Library Advanced Search', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1', role: 'ADMIN' } });
        mocks.countSeries.mockResolvedValue(1);
        mocks.findManySeries.mockResolvedValue([{ id: '1', issues: [], favorites: [] }]);
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
            expect(call.orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }]);
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

            vi.clearAllMocks();
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

        it('alpha_asc ends in id', async () => {
            expect(await orderByFor('alpha_asc')).toEqual([{ name: 'asc' }, { id: 'asc' }]);
        });
        it('alpha_desc ends in id', async () => {
            expect(await orderByFor('alpha_desc')).toEqual([{ name: 'desc' }, { id: 'desc' }]);
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