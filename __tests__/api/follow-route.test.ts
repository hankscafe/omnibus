// /api/library/follow (Beta A toggle + Beta C extensions): toggle on bare seriesId, explicit
// idempotent set via `follow`, bulk set for the selection bar (filter-first inserts, validated
// against existing series — no skipDuplicates on SQLite), GET lists the user's followed ids,
// 401 without a session. Read-side only — no monitored writes anywhere in sight.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST, GET } from '@/app/api/library/follow/route';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { makePostJson } from '../helpers/request';

vi.mock('next-auth/next', () => ({ getServerSession: vi.fn() }));

vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findUnique: vi.fn() },
        seriesFollow: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), createMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
        series: { findMany: vi.fn() },
    }
}));

const req = makePostJson('http://localhost/api/library/follow');

describe('API: /api/library/follow (POST toggle)', () => {
    beforeEach(() => {
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

    it('explicit follow:true is idempotent — no duplicate create when already following', async () => {
        (prisma.seriesFollow.findUnique as any).mockResolvedValue({ id: 'f1' });

        const res = await POST(req({ seriesId: 's1', follow: true }));
        const data = await res.json();

        expect(data).toEqual({ success: true, isFollowing: true });
        expect(prisma.seriesFollow.create).not.toHaveBeenCalled();
        expect(prisma.seriesFollow.delete).not.toHaveBeenCalled();
    });

    it('explicit follow:false on a non-follow is a clean no-op', async () => {
        (prisma.seriesFollow.findUnique as any).mockResolvedValue(null);

        const res = await POST(req({ seriesId: 's1', follow: false }));
        const data = await res.json();

        expect(data).toEqual({ success: true, isFollowing: false });
        expect(prisma.seriesFollow.create).not.toHaveBeenCalled();
        expect(prisma.seriesFollow.delete).not.toHaveBeenCalled();
    });
});

describe('API: /api/library/follow (bulk + GET, Beta C)', () => {
    beforeEach(() => {
        (getServerSession as any).mockResolvedValue({ user: { id: 'u1' } });
        (prisma.seriesFollow.createMany as any).mockResolvedValue({ count: 0 });
        (prisma.seriesFollow.deleteMany as any).mockResolvedValue({ count: 2 });
    });

    it('bulk follow validates series, filters already-followed, and inserts the rest', async () => {
        (prisma.series.findMany as any).mockResolvedValue([{ id: 's1' }, { id: 's2' }]); // 's3' doesn't exist
        (prisma.seriesFollow.findMany as any).mockResolvedValue([{ seriesId: 's1' }]);   // s1 already followed

        const res = await POST(req({ seriesIds: ['s1', 's2', 's3'], follow: true }));
        const data = await res.json();

        expect(data).toEqual({ success: true, followed: 1 });
        expect(prisma.seriesFollow.createMany).toHaveBeenCalledWith({
            data: [{ userId: 'u1', seriesId: 's2' }]
        });
    });

    it('bulk unfollow deletes by id list', async () => {
        const res = await POST(req({ seriesIds: ['s1', 's2'], follow: false }));
        const data = await res.json();

        expect(data).toEqual({ success: true, unfollowed: 2 });
        expect(prisma.seriesFollow.deleteMany).toHaveBeenCalledWith({
            where: { userId: 'u1', seriesId: { in: ['s1', 's2'] } }
        });
    });

    it('bulk without an explicit follow flag is rejected (never bulk-toggle a mixed selection)', async () => {
        const res = await POST(req({ seriesIds: ['s1', 's2'] }));
        expect(res.status).toBe(400);
        expect(prisma.seriesFollow.createMany).not.toHaveBeenCalled();
        expect(prisma.seriesFollow.deleteMany).not.toHaveBeenCalled();
    });

    it('GET returns the followed id list for the session user', async () => {
        (prisma.seriesFollow.findMany as any).mockResolvedValue([{ seriesId: 's1' }, { seriesId: 's9' }]);

        const res = await GET();
        const data = await res.json();

        expect(data).toEqual({ seriesIds: ['s1', 's9'] });
        expect((prisma.seriesFollow.findMany as any).mock.calls[0][0].where).toEqual({ userId: 'u1' });
    });

    it('GET rejects unauthenticated calls', async () => {
        (getServerSession as any).mockResolvedValue(null);
        const res = await GET();
        expect(res.status).toBe(401);
    });
});
