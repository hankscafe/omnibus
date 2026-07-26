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
            expect(call.orderBy).toEqual({ name: 'asc' });
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
});