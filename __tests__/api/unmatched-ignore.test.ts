// /api/admin/unmatched — the ignore state (field report from robotshavehearts2).
//
// A hand-curated series ComicVine simply doesn't have (his TPBs) could never leave the unmatched
// list: the query is an equality on matchState, and nothing else would ever change it. Marking one
// IGNORED takes it out of the list, out of the admin banner's count, and out of the engine's
// automatic sweep — reversibly, and without pretending it was matched.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, PATCH } from '@/app/api/admin/unmatched/route';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getReq } from '../helpers/request';

vi.mock('next-auth/next', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn(async () => ({})) }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: vi.fn() } }));

vi.mock('@/lib/db', () => ({
    prisma: { series: { findMany: vi.fn(), updateMany: vi.fn() } }
}));

// No loose files on disk — this test is about the DB-backed half of the list.
vi.mock('fs-extra', () => ({ default: { existsSync: () => false, promises: { readdir: async () => [] } } }));

const patchReq = (body: any) => new Request('http://localhost/api/admin/unmatched', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('API: /api/admin/unmatched — ignore state', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (getServerSession as any).mockResolvedValue({ user: { id: 'admin1', role: 'ADMIN' } });
        (prisma.series.findMany as any).mockResolvedValue([]);
        (prisma.series.updateMany as any).mockResolvedValue({ count: 2 });
    });

    it('lists only genuinely unmatched series by default', async () => {
        await GET(getReq('http://localhost/api/admin/unmatched'));
        expect(prisma.series.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { matchState: 'UNMATCHED' },
        }));
    });

    it('can include ignored series, flagged so the UI can offer a restore', async () => {
        (prisma.series.findMany as any).mockResolvedValue([
            { id: 's1', name: 'Some TPB', matchState: 'IGNORED' },
            { id: 's2', name: 'Real Unmatched', matchState: 'UNMATCHED' },
        ]);

        const res = await GET(getReq('http://localhost/api/admin/unmatched?includeIgnored=1'));
        const data = await res.json();

        expect(prisma.series.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { matchState: { in: ['UNMATCHED', 'IGNORED'] } },
        }));
        expect(data.find((s: any) => s.id === 's1').isIgnored).toBe(true);
        expect(data.find((s: any) => s.id === 's2').isIgnored).toBe(false);
    });

    it('marks series ignored, and only ones that are actually unmatched', async () => {
        const res = await PATCH(patchReq({ seriesIds: ['s1', 's2'], ignored: true }));
        const data = await res.json();

        expect(data).toEqual({ success: true, updated: 2 });
        expect(prisma.series.updateMany).toHaveBeenCalledWith({
            // The source-state guard: a mistyped id can never quietly un-match a matched series.
            where: { id: { in: ['s1', 's2'] }, matchState: 'UNMATCHED' },
            data: { matchState: 'IGNORED' },
        });
    });

    it('restores an ignored series to unmatched', async () => {
        (prisma.series.updateMany as any).mockResolvedValue({ count: 1 });

        const res = await PATCH(patchReq({ seriesIds: ['s1'], ignored: false }));

        expect(await res.json()).toEqual({ success: true, updated: 1 });
        expect(prisma.series.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ['s1'] }, matchState: 'IGNORED' },
            data: { matchState: 'UNMATCHED' },
        });
    });

    it('refuses non-admins and empty selections', async () => {
        (getServerSession as any).mockResolvedValue({ user: { id: 'u2', role: 'USER' } });
        expect((await PATCH(patchReq({ seriesIds: ['s1'], ignored: true }))).status).toBe(401);

        (getServerSession as any).mockResolvedValue({ user: { id: 'admin1', role: 'ADMIN' } });
        expect((await PATCH(patchReq({ seriesIds: [], ignored: true }))).status).toBe(400);
        expect((await PATCH(patchReq({ ignored: true }))).status).toBe(400);
        expect(prisma.series.updateMany).not.toHaveBeenCalled();
    });
});
