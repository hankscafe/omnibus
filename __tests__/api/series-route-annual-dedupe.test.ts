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

    it('keeps both attached "#1" rows and still prunes an unattached duplicate', async () => {
        const rows = [
            // Two one-off annual volumes, each freshly imported as its volume's issue #1.
            { id: 'a96', number: '1', isAnnual: true, metadataId: '60436', filePath: null, attachedVolumeId: 'att_96' },
            { id: 'a97', number: '1', isAnnual: true, metadataId: '60437', filePath: null, attachedVolumeId: 'att_97' },
            // A stray unattached annual row from the old churn — still fair game.
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
