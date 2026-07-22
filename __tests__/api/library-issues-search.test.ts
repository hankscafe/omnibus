// __tests__/api/library-issues-search.test.ts
// Regression for the issues-browse search 500 (beta.014): the route hardcoded mode:'insensitive',
// which the sqlite-generated Prisma client rejects at runtime. The where clause must now be
// provider-shaped: no `mode` key under SQLite, mode:'insensitive' under Postgres.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET } from '@/app/api/library/issues/route';

const mocks = vi.hoisted(() => ({
    issueFindMany: vi.fn(),
    seriesFindMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        issue: { findMany: mocks.issueFindMany },
        series: { findMany: mocks.seriesFindMany },
    }
}));

vi.mock('next-auth/next', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } })
}));

vi.mock('@/app/api/auth/[...nextauth]/options', () => ({
    getAuthOptions: vi.fn().mockResolvedValue({})
}));

vi.mock('@/lib/library-access', () => ({
    getAccessibleLibraryIds: vi.fn().mockResolvedValue('ALL')
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));

const req = (q: string) => new Request(`http://localhost/api/library/issues?limit=5&q=${encodeURIComponent(q)}`);

describe('API Route: /api/library/issues search (provider-aware contains)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.issueFindMany.mockResolvedValue([]);
        mocks.seriesFindMany.mockResolvedValue([]);
    });
    afterEach(() => vi.unstubAllEnvs());

    it('never sends the mode argument to a SQLite client (the 500 regression)', async () => {
        vi.stubEnv('DATABASE_URL', 'file:./omnibus.db');

        const res = await GET(req('bat'));
        expect(res.status).toBe(200);

        const where = mocks.issueFindMany.mock.calls[0][0].where;
        expect(where.OR).toHaveLength(2);
        expect(where.OR[0].name).toEqual({ contains: 'bat' });
        expect('mode' in where.OR[0].name).toBe(false);
        expect('mode' in where.OR[1].series.name).toBe(false);
    });

    it('sends mode insensitive on Postgres so search is case-insensitive there', async () => {
        vi.stubEnv('DATABASE_URL', 'postgresql://u:p@host:5432/omnibus');

        const res = await GET(req('bat'));
        expect(res.status).toBe(200);

        const where = mocks.issueFindMany.mock.calls[0][0].where;
        expect(where.OR[0].name).toEqual({ contains: 'bat', mode: 'insensitive' });
        expect(where.OR[1].series.name).toEqual({ contains: 'bat', mode: 'insensitive' });
    });
});
