// GET /api/library/updates (Beta B): the Following-only feed. Contracts pinned: auth required;
// the query is scoped to FOLLOWED series with a real file, inside the arrival window, respecting
// per-library access; ordering carries the id tiebreaker (v1.4.1 total-order rule) with a hard
// cap; read state maps per-user; cover precedence mirrors the issues-browse route.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/library/updates/route';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAccessibleLibraryIds } from '@/lib/library-access';

vi.mock('next-auth/next', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/library-access', () => ({ getAccessibleLibraryIds: vi.fn() }));

vi.mock('@/lib/db', () => ({
    prisma: {
        issue: { findMany: vi.fn() },
        readProgress: { findMany: vi.fn() },
    }
}));

const dbIssue = (id: string, over: Record<string, any> = {}) => ({
    id,
    number: '1',
    name: null,
    filePath: `/data/comics/S/${id}.cbz`,
    coverUrl: null,
    createdAt: new Date('2026-07-31T10:00:00Z'),
    series: { id: 'ser1', name: 'Saga', folderPath: '/data/comics/S' },
    ...over,
});

describe('API: /api/library/updates (GET)', () => {
    beforeEach(() => {
        (getServerSession as any).mockResolvedValue({ user: { id: 'u1', role: 'USER' } });
        (getAccessibleLibraryIds as any).mockResolvedValue('ALL');
        (prisma.issue.findMany as any).mockResolvedValue([]);
        (prisma.readProgress.findMany as any).mockResolvedValue([]);
    });

    it('rejects unauthenticated calls', async () => {
        (getServerSession as any).mockResolvedValue(null);

        const res = await GET();

        expect(res.status).toBe(401);
        expect(prisma.issue.findMany).not.toHaveBeenCalled();
    });

    it('queries only FOLLOWED, file-backed issues inside the window, totally ordered and capped', async () => {
        await GET();

        const arg = (prisma.issue.findMany as any).mock.calls[0][0];
        expect(arg.where.series.follows).toEqual({ some: { userId: 'u1' } });
        expect(arg.where.filePath).toEqual({ not: null });
        expect(arg.where.createdAt.gte).toBeInstanceOf(Date);
        expect(arg.where.series.libraryId).toBeUndefined(); // 'ALL' access adds no filter
        expect(arg.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
        expect(arg.take).toBe(500);
    });

    it('applies the per-library access filter for restricted users', async () => {
        (getAccessibleLibraryIds as any).mockResolvedValue(['libA', 'libB']);

        await GET();

        const arg = (prisma.issue.findMany as any).mock.calls[0][0];
        expect(arg.where.series.libraryId).toEqual({ in: ['libA', 'libB'] });
    });

    it('maps per-user read state: completed → read, in-progress or absent → unread', async () => {
        (prisma.issue.findMany as any).mockResolvedValue([dbIssue('i1'), dbIssue('i2'), dbIssue('i3')]);
        (prisma.readProgress.findMany as any).mockResolvedValue([
            { issueId: 'i1', isCompleted: true },
            { issueId: 'i2', isCompleted: false },
        ]);

        const res = await GET();
        const data = await res.json();

        expect(data.items.map((i: any) => i.isRead)).toEqual([true, false, false]);
        expect((prisma.readProgress.findMany as any).mock.calls[0][0].where).toEqual({
            userId: 'u1', issueId: { in: ['i1', 'i2', 'i3'] },
        });
    });

    it('builds covers with the issues-browse precedence: provider URL proxied, else own first-page render', async () => {
        (prisma.issue.findMany as any).mockResolvedValue([
            dbIssue('i1', { coverUrl: 'https://comicvine.gamespot.com/a/cover.jpg' }),
            dbIssue('i2'), // no provider art, file-backed → issueId render
        ]);

        const res = await GET();
        const data = await res.json();

        expect(data.items[0].coverUrl).toBe(`/api/library/cover?path=${encodeURIComponent('https://comicvine.gamespot.com/a/cover.jpg')}`);
        expect(data.items[1].coverUrl).toBe('/api/library/cover?issueId=i2');
    });

    it('reports the window and whether the cap was hit', async () => {
        const res = await GET();
        const data = await res.json();

        expect(data.windowDays).toBe(30);
        expect(data.capped).toBe(false);
    });
});
