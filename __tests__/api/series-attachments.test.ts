// /api/library/series/attachments (#203 Phase 1): attaching an annual volume to a series, the
// honest result summary the attach dialog reports, and a detach that keeps every file the user owns.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, POST, DELETE } from '@/app/api/library/series/attachments/route';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { engineFetchLong } from '@/lib/engine';
import { makePostJson, getReq } from '../helpers/request';

vi.mock('next-auth/next', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn(async () => ({})) }));

vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findUnique: vi.fn() },
        attachedVolume: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
        issue: { groupBy: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    }
}));

vi.mock('@/lib/engine', () => ({
    ENGINE_URL: 'http://engine',
    engineHeaders: (extra: any) => ({ ...extra }),
    engineFetchLong: vi.fn(),
}));

vi.mock('@/lib/queue', () => ({ omnibusQueue: { add: vi.fn().mockResolvedValue({}) } }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: vi.fn() } }));

const createReq = makePostJson('http://localhost/api/library/series/attachments');
const deleteReq = (body: any) => new Request('http://localhost/api/library/series/attachments', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const engineOk = (summary: any) => ({ ok: true, status: 200, json: async () => ({ ok: true, results: [summary] }) });

describe('API: /api/library/series/attachments', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (getServerSession as any).mockResolvedValue({ user: { id: 'admin1', role: 'ADMIN' } });
        (prisma.series.findUnique as any).mockResolvedValue({
            id: 's1', name: 'Batman', metadataSource: 'COMICVINE', metadataId: '42821',
        });
        (prisma.attachedVolume.upsert as any).mockResolvedValue({ id: 'att1', name: null });
        (engineFetchLong as any).mockResolvedValue(engineOk({
            attachment_id: 'att1', name: 'Batman Annual', total: 4, claimed: 2, created: 2, updated: 0, unclaimed: 1,
        }));
    });

    it('attaches a volume and reports what the pass actually did', async () => {
        const res = await POST(createReq({ seriesId: 's1', volumeId: '49197', metadataSource: 'COMICVINE' }));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(prisma.attachedVolume.upsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { seriesId_metadataSource_volumeId: { seriesId: 's1', metadataSource: 'COMICVINE', volumeId: '49197' } },
        }));
        // Import runs through the engine's id-anchored lane, with the claim pass on.
        const [url, init] = (engineFetchLong as any).mock.calls[0];
        expect(url).toBe('http://engine/api/metadata/attach-sync');
        expect(JSON.parse(init.body)).toEqual({ attachment_id: 'att1', claim: true });
        // The summary is the user-facing honesty: claimed / created / left unclaimed.
        expect(data).toMatchObject({
            success: true,
            attachmentId: 'att1',
            name: 'Batman Annual',
            summary: { total: 4, claimed: 2, created: 2, unclaimed: 1 },
        });
    });

    it("refuses to attach a series' own volume to itself", async () => {
        const res = await POST(createReq({ seriesId: 's1', volumeId: '42821', metadataSource: 'COMICVINE' }));
        expect(res.status).toBe(400);
        expect(prisma.attachedVolume.upsert).not.toHaveBeenCalled();
    });

    it('keeps the attachment when the provider import fails', async () => {
        (engineFetchLong as any).mockResolvedValue({ ok: false, status: 502, json: async () => ({ ok: false, error: 'ComicVine rate limited (429)' }) });

        const res = await POST(createReq({ seriesId: 's1', volumeId: '49197' }));
        const data = await res.json();

        expect(res.status).toBe(502);
        expect(data.error).toContain('rate limited');
        // The link is the user's decision — a provider outage must not undo it.
        expect(data.attachmentId).toBe('att1');
        expect(prisma.attachedVolume.delete).not.toHaveBeenCalled();
    });

    it('rejects non-admins and unknown sources/kinds', async () => {
        (getServerSession as any).mockResolvedValue({ user: { id: 'u2', role: 'USER' } });
        expect((await POST(createReq({ seriesId: 's1', volumeId: '49197' }))).status).toBe(403);

        (getServerSession as any).mockResolvedValue({ user: { id: 'admin1', role: 'ADMIN' } });
        expect((await POST(createReq({ seriesId: 's1', volumeId: '49197', metadataSource: 'ANILIST' }))).status).toBe(400);
        expect((await POST(createReq({ seriesId: 's1', volumeId: '49197', kind: 'OMNIBUS' }))).status).toBe(400);
        expect(prisma.attachedVolume.upsert).not.toHaveBeenCalled();
    });

    it('detaches without touching owned files, and only removes skeletons when asked', async () => {
        (prisma.attachedVolume.findUnique as any).mockResolvedValue({ id: 'att1', seriesId: 's1', volumeId: '49197', metadataSource: 'COMICVINE' });
        (prisma.issue.updateMany as any).mockResolvedValue({ count: 3 });
        (prisma.issue.deleteMany as any).mockResolvedValue({ count: 2 });

        const kept = await DELETE(deleteReq({ attachmentId: 'att1' }));
        expect(await kept.json()).toEqual({ success: true, keptIssues: 3, skeletonsDeleted: 0 });
        expect(prisma.issue.deleteMany).not.toHaveBeenCalled();
        // Unlink, never delete: the rows go back to being plain annuals.
        expect(prisma.issue.updateMany).toHaveBeenCalledWith({
            where: { attachedVolumeId: 'att1' }, data: { attachedVolumeId: null },
        });

        vi.clearAllMocks();
        (getServerSession as any).mockResolvedValue({ user: { id: 'admin1', role: 'ADMIN' } });
        (prisma.attachedVolume.findUnique as any).mockResolvedValue({ id: 'att1', seriesId: 's1', volumeId: '49197', metadataSource: 'COMICVINE' });
        (prisma.issue.updateMany as any).mockResolvedValue({ count: 1 });
        (prisma.issue.deleteMany as any).mockResolvedValue({ count: 2 });

        const swept = await DELETE(deleteReq({ attachmentId: 'att1', deleteSkeletons: true }));
        expect(await swept.json()).toEqual({ success: true, keptIssues: 1, skeletonsDeleted: 2 });
        // Only the FILE-LESS rows — an owned annual is never in the delete's blast radius.
        expect(prisma.issue.deleteMany).toHaveBeenCalledWith({
            where: { attachedVolumeId: 'att1', OR: [{ filePath: null }, { filePath: '' }] },
        });
    });

    it('lists a series attachments with the count of files actually owned', async () => {
        (prisma.attachedVolume.findMany as any).mockResolvedValue([
            { id: 'att1', metadataSource: 'COMICVINE', volumeId: '49197', kind: 'ANNUAL', name: 'Batman Annual', startYear: 2012, issueCount: 4, lastSyncedAt: null },
        ]);
        (prisma.issue.groupBy as any).mockResolvedValue([{ attachedVolumeId: 'att1', _count: { _all: 2 } }]);

        const res = await GET(getReq('http://localhost/api/library/series/attachments?seriesId=s1'));
        const data = await res.json();

        expect(data.attachments).toHaveLength(1);
        expect(data.attachments[0]).toMatchObject({ volumeId: '49197', issueCount: 4, ownedCount: 2 });
    });
});
