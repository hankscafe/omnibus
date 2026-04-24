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
        }
    }
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));

const createReq = (queryParam: string) => {
    return new Request(`http://localhost/api/library?q=${encodeURIComponent(queryParam)}`);
};

describe('API Route: Library Advanced Search', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
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
        
        // Assert it strictly targeted the characters array on the issues relation
        expect(queryArg.AND).toEqual(
            expect.arrayContaining([
                { issues: { some: { characters: { contains: 'joker' } } } }
            ])
        );
    });

    it('should translate "writer: Name" into a strict writer query', async () => {
        const req = createReq('writer: tom king');
        await GET(req);

        const queryArg = mocks.findManySeries.mock.calls[0][0].where;
        
        expect(queryArg.AND).toEqual(
            expect.arrayContaining([
                { issues: { some: { writers: { contains: 'tom king' } } } }
            ])
        );
    });
});