// Follow-arrivals bell entry (v1.4.3): ONE dynamic summary line — "N new issues in your follows" —
// counting file-backed arrivals in followed series since the user's lastSeenUpdatesAt marker
// (30-day window bounds a missing/ancient marker). Never per-issue. POST followUpdatesSeen stamps
// the marker so the entry self-clears; the entry respects per-library access.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, POST } from '@/app/api/notifications/route';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAccessibleLibraryIds } from '@/lib/library-access';
import { makePostJson } from '../helpers/request';

vi.mock('next-auth/next', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/library-access', () => ({ getAccessibleLibraryIds: vi.fn() }));

vi.mock('@/lib/db', () => ({
    prisma: {
        request: { findMany: vi.fn(), updateMany: vi.fn() },
        userTrophy: { findMany: vi.fn(), updateMany: vi.fn() },
        issueReport: { findMany: vi.fn(), updateMany: vi.fn() },
        user: { findUnique: vi.fn(), update: vi.fn() },
        issue: { count: vi.fn(), findFirst: vi.fn() },
        series: { count: vi.fn() },
        systemSetting: { findUnique: vi.fn() },
    }
}));

const followEntry = (list: any[]) => list.find((n: any) => n.type === 'follow_updates');

describe('API: /api/notifications follow-arrivals summary (GET)', () => {
    beforeEach(() => {
        (getServerSession as any).mockResolvedValue({ user: { id: 'u1', role: 'USER' } });
        (getAccessibleLibraryIds as any).mockResolvedValue('ALL');
        (prisma.request.findMany as any).mockResolvedValue([]);
        (prisma.userTrophy.findMany as any).mockResolvedValue([]);
        (prisma.issueReport.findMany as any).mockResolvedValue([]);
        (prisma.user.findUnique as any).mockResolvedValue({ lastSeenUpdatesAt: null });
        (prisma.issue.count as any).mockResolvedValue(0);
        (prisma.issue.findFirst as any).mockResolvedValue(null);
    });

    it('pushes ONE summary entry with the count and the newest arrival date', async () => {
        const newest = new Date('2026-07-31T10:00:00Z');
        (prisma.issue.count as any).mockResolvedValue(3);
        (prisma.issue.findFirst as any).mockResolvedValue({ createdAt: newest });

        const res = await GET();
        const data = await res.json();
        const entry = followEntry(data);

        expect(entry).toBeDefined();
        expect(entry.title).toBe('3 New Issues In Your Follows');
        expect(new Date(entry.date).toISOString()).toBe(newest.toISOString());
        expect(data.filter((n: any) => n.type === 'follow_updates')).toHaveLength(1);
    });

    it('uses the singular title for one arrival', async () => {
        (prisma.issue.count as any).mockResolvedValue(1);
        (prisma.issue.findFirst as any).mockResolvedValue({ createdAt: new Date() });

        const data = await (await GET()).json();

        expect(followEntry(data).title).toBe('1 New Issue In Your Follows');
    });

    it('emits nothing when there are no arrivals since the marker', async () => {
        const data = await (await GET()).json();
        expect(followEntry(data)).toBeUndefined();
    });

    it('counts strictly after a recent marker, scoped to the follows of the session user', async () => {
        const marker = new Date(Date.now() - 2 * 60 * 60 * 1000);
        (prisma.user.findUnique as any).mockResolvedValue({ lastSeenUpdatesAt: marker });

        await GET();

        const where = (prisma.issue.count as any).mock.calls[0][0].where;
        expect(where.createdAt.gt).toEqual(marker);
        expect(where.filePath).toEqual({ not: null });
        expect(where.series.follows).toEqual({ some: { userId: 'u1' } });
    });

    it('bounds a missing marker by the 30-day feed window', async () => {
        await GET();

        const gt: Date = (prisma.issue.count as any).mock.calls[0][0].where.createdAt.gt;
        const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
        expect(Math.abs(gt.getTime() - expected)).toBeLessThan(60 * 1000);
    });

    it('applies the per-library access filter for restricted users', async () => {
        (getAccessibleLibraryIds as any).mockResolvedValue(['libA']);

        await GET();

        const where = (prisma.issue.count as any).mock.calls[0][0].where;
        expect(where.series.libraryId).toEqual({ in: ['libA'] });
    });
});

describe('API: /api/notifications marker stamp (POST)', () => {
    beforeEach(() => {
        (getServerSession as any).mockResolvedValue({ user: { id: 'u1', role: 'USER' } });
        (prisma.user.update as any).mockResolvedValue({});
    });

    const req = makePostJson('http://localhost/api/notifications');

    it('stamps lastSeenUpdatesAt when followUpdatesSeen is true', async () => {
        const before = Date.now();
        const res = await POST(req({ followUpdatesSeen: true }));

        expect(res.status).toBe(200);
        const call = (prisma.user.update as any).mock.calls[0][0];
        expect(call.where).toEqual({ id: 'u1' });
        expect(call.data.lastSeenUpdatesAt.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('does not touch the marker on ordinary clears', async () => {
        await POST(req({ requestIds: [], trophyIds: [], reportIds: [] }));
        expect(prisma.user.update).not.toHaveBeenCalled();
    });
});
