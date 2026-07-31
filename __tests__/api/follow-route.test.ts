// /api/library/follow toggle (twin of the favorite route): create on first call, delete on the
// second, 401 without a session. Read-side only — no monitored writes anywhere in sight.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/library/follow/route';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';

vi.mock('next-auth/next', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn().mockResolvedValue({}) }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));

vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findUnique: vi.fn() },
        seriesFollow: { findUnique: vi.fn(), create: vi.fn(), delete: vi.fn() },
        series: {},
    }
}));

const req = (body: any) => new Request('http://localhost/api/library/follow', {
    method: 'POST',
    body: JSON.stringify(body),
});

describe('API: /api/library/follow (POST toggle)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (getServerSession as any).mockResolvedValue({ user: { id: 'u1' } });
        (prisma.seriesFollow.create as any).mockResolvedValue({});
        (prisma.seriesFollow.delete as any).mockResolvedValue({});
    });

    it('creates a follow when none exists', async () => {
        (prisma.seriesFollow.findUnique as any).mockResolvedValue(null);

        const res = await POST(req({ seriesId: 's1' }));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data).toEqual({ success: true, isFollowing: true });
        expect(prisma.seriesFollow.create).toHaveBeenCalledWith({ data: { userId: 'u1', seriesId: 's1' } });
    });

    it('removes the follow when one exists', async () => {
        (prisma.seriesFollow.findUnique as any).mockResolvedValue({ id: 'f1' });

        const res = await POST(req({ seriesId: 's1' }));
        const data = await res.json();

        expect(data).toEqual({ success: true, isFollowing: false });
        expect(prisma.seriesFollow.delete).toHaveBeenCalledWith({ where: { id: 'f1' } });
    });

    it('rejects unauthenticated calls', async () => {
        (getServerSession as any).mockResolvedValue(null);

        const res = await POST(req({ seriesId: 's1' }));

        expect(res.status).toBe(401);
        expect(prisma.seriesFollow.create).not.toHaveBeenCalled();
    });

    it('rejects a missing seriesId', async () => {
        const res = await POST(req({}));
        expect(res.status).toBe(400);
    });
});
