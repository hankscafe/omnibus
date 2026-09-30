import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/admin/metron-status/route';

// The Health modal's live Metron limits (Metron beta 3): what Metron last reported, read from the
// shared SystemSetting both processes write - admins only, and never a request to Metron itself.

const store = vi.hoisted(() => new Map<string, string>());
const mocks = vi.hoisted(() => ({ getServerSession: vi.fn() }));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: {
            findUnique: vi.fn(async ({ where }: any) => (store.has(where.key) ? { key: where.key, value: store.get(where.key) } : null)),
            findMany: vi.fn(async ({ where }: any) => [...store.entries()]
                .filter(([key]) => !where?.key?.in || where.key.in.includes(key))
                .map(([key, value]) => ({ key, value }))),
        },
    },
}));

describe('GET /api/admin/metron-status', () => {
    beforeEach(() => {
        store.clear();
        mocks.getServerSession.mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } });
    });

    it('is for admins only', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', role: 'USER' } });
        expect((await GET()).status).toBe(401);
    });

    it('returns what Metron last reported, the rate-limit flag and our own 24h count', async () => {
        const now = Date.now();
        const status = { burst: { limit: 60, remaining: 59, reset: Math.floor(now / 1000) + 30 }, sustained: { limit: 10_000, remaining: 9_990, reset: Math.floor(now / 1000) + 3600 }, updatedAt: now - 5_000 };
        store.set('metron_rate_status', JSON.stringify(status));
        store.set('metron_rate_limit_time', String(now - 60_000));
        store.set('metron_api_usage', JSON.stringify({ '/issue': [now - 1_000, now - 2_000] }));
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.status).toEqual(status);
        expect(body.rateLimitFlagMs).toBe(now - 60_000);
        expect(body.localCalls24h).toBe(2);
        expect(typeof body.nowMs).toBe('number');
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });

    it('with nothing reported yet: empty windows, zero counts', async () => {
        const body = await (await GET()).json();
        expect(body).toMatchObject({ status: { burst: {}, sustained: {} }, rateLimitFlagMs: 0, localCalls24h: 0 });
    });
});
