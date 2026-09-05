// /api/library/series (GET reconciler) — #203 Phase 1: the same-number dedupe must never delete a
// row that belongs to an ATTACHED volume. Two one-off annual volumes both arriving as "#1" (the
// Amazing Spider-Man case) is a supported state; the user renumbers them to slot chronologically,
// and the duplicate warning is the nudge. Deleting one would destroy a hand-made provider link.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/library/series/route';
import { prisma } from '@/lib/db';
import { getReq } from '../helpers/request';

vi.mock('next-auth/next', () => ({ getServerSession: vi.fn().mockResolvedValue(null) }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn(async () => ({})) }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: vi.fn() } }));
vi.mock('@/lib/library-access', () => ({
    getAccessibleLibraryPaths: vi.fn(async () => []),
    canAccessPath: vi.fn(() => true),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        library: { findMany: vi.fn() },
        series: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
        issue: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), update: vi.fn() },
        favorite: { findUnique: vi.fn() },
        seriesFollow: { findUnique: vi.fn() },
        readProgress: { findMany: vi.fn() },
    }
}));

// The folder is absent on purpose: this test is about the DB-side reconciliation, not file syncing.
vi.mock('fs-extra', () => ({
    default: {
        existsSync: vi.fn(() => false),
        promises: { readdir: vi.fn(async () => []), access: vi.fn(async () => { throw new Error('gone'); }) },
    }
}));

describe('#203: series reconciler vs. attached-volume rows', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (prisma.library.findMany as any).mockResolvedValue([{ id: 'lib1', path: '/comics' }]);
        (prisma.series.findFirst as any).mockResolvedValue({
            id: 's1', name: 'The Amazing Spider-Man', year: 1963, folderPath: '/comics/ASM',
            metadataId: '2350', metadataSource: 'COMICVINE',
        });
        (prisma.issue.deleteMany as any).mockResolvedValue({ count: 0 });
    });

    it('keeps every attached "#1" row and still prunes a genuine unattached duplicate', async () => {
        const rows = [
            // Two one-off annual volumes, each freshly imported as its volume's issue #1. Each
            // attached lane is its own numbering domain, so these are not duplicates of anything.
            { id: 'a96', number: '1', isAnnual: true, metadataId: '60436', filePath: null, attachedVolumeId: 'att_96' },
            { id: 'a97', number: '1', isAnnual: true, metadataId: '60437', filePath: null, attachedVolumeId: 'att_97' },
            // Two UNATTACHED annual rows sharing a number — a real duplicate pair from the old
            // churn. The better record survives; the placeholder is pruned.
            { id: 'keep', number: '1', isAnnual: true, metadataId: '999', filePath: '/comics/ASM/annual.cbz', attachedVolumeId: null },
            { id: 'stray', number: '1', isAnnual: true, metadataId: 'unmatched_x', filePath: null, attachedVolumeId: null },
            // The main run's #1 lives in its own domain and is untouched either way.
            { id: 'main1', number: '1', isAnnual: false, metadataId: '300001', filePath: null, attachedVolumeId: null },
        ];
        (prisma.issue.findMany as any).mockResolvedValue(rows);

        const res = await GET(getReq('http://localhost/api/library/series?path=/comics/ASM'));
        expect(res.status).toBe(200);

        const deleted = (prisma.issue.deleteMany as any).mock.calls
            .flatMap((c: any[]) => c[0]?.where?.id?.in || []);
        expect(deleted).toEqual(['stray']);
        expect(deleted).not.toContain('a96');
        expect(deleted).not.toContain('a97');
        expect(deleted).not.toContain('keep');
    });

    it('composes attached annuals as "Series Annual #N" and sorts them after the main run', async () => {
        const rows = [
            { id: 'a1', number: '1', isAnnual: true, metadataId: '60436', filePath: null, attachedVolumeId: 'att_96', name: null },
            { id: 'main2', number: '2', isAnnual: false, metadataId: '300002', filePath: null, attachedVolumeId: null, name: null },
            { id: 'main1', number: '1', isAnnual: false, metadataId: '300001', filePath: null, attachedVolumeId: null, name: null },
        ];
        (prisma.issue.findMany as any).mockResolvedValue(rows);

        const data = await (await GET(getReq('http://localhost/api/library/series?path=/comics/ASM'))).json();

        // All three have real provider ids and no file → they're the "missing" (requestable) set.
        expect(data.missingIssues.map((i: any) => i.id)).toEqual(['main1', 'main2', 'a1']);
        expect(data.missingIssues[2]).toMatchObject({
            isAnnual: true,
            name: 'The Amazing Spider-Man Annual #1',
        });
    });
});

describe('#203 COLLECTED: collections are their own shelf, not part of the run', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (prisma.library.findMany as any).mockResolvedValue([{ id: 'lib1', path: '/comics' }]);
        (prisma.series.findFirst as any).mockResolvedValue({
            id: 's1', name: 'Batman', year: 2011, folderPath: '/comics/Batman',
            metadataId: '42821', metadataSource: 'COMICVINE',
        });
        (prisma.issue.deleteMany as any).mockResolvedValue({ count: 0 });
    });

    it('keeps trades out of the issue lists and returns them separately', async () => {
        (prisma.issue.findMany as any).mockResolvedValue([
            { id: 'i1', number: '1', isAnnual: false, metadataId: '300001', filePath: null, attachedVolumeId: null },
            { id: 'ann', number: '1', isAnnual: true, metadataId: '400001', filePath: null, attachedVolumeId: 'att_a',
              attachedVolume: { kind: 'ANNUAL', name: 'Batman Annual' } },
            { id: 'tpb1', number: '1', isAnnual: false, metadataId: '500001', filePath: null, attachedVolumeId: 'att_c',
              attachedVolume: { kind: 'COLLECTED', name: 'The Court of Owls' } },
        ]);

        const data = await (await GET(getReq('http://localhost/api/library/series?path=/comics/Batman'))).json();

        // The run and its annuals are unchanged; the trade is nowhere among them.
        expect(data.missingIssues.map((i: any) => i.id)).toEqual(['i1', 'ann']);
        // It reads as a collection instead — with the collection's name for the shelf.
        expect(data.missingCollectedEditions.map((i: any) => i.id)).toEqual(['tpb1']);
        expect(data.missingCollectedEditions[0]).toMatchObject({ isCollected: true, collectionName: 'The Court of Owls' });
        // An annual is still part of the run: it's a distinct comic, not a reprint.
        expect(data.missingIssues.find((i: any) => i.id === 'ann').isCollected).toBe(false);
    });

    it('sorts owned collections by the number the user curated — that IS the reading order', async () => {
        const owned = (id: string, number: string) => ({
            id, number, isAnnual: false, metadataId: `5000${number}`, filePath: `/comics/Batman/${id}.cbz`,
            attachedVolumeId: 'att_c', attachedVolume: { kind: 'COLLECTED', name: 'Court of Owls' },
        });
        (prisma.issue.findMany as any).mockResolvedValue([owned('v3', '3'), owned('v1', '1'), owned('v2', '2')]);

        const data = await (await GET(getReq('http://localhost/api/library/series?path=/comics/Batman'))).json();

        // No files exist on disk in this test, so they land in the "missing" collection list.
        expect(data.missingCollectedEditions.map((i: any) => i.number)).toEqual(['1', '2', '3']);
        expect(data.downloadedIssues).toHaveLength(0);
    });
});
