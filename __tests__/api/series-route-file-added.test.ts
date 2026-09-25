// __tests__/api/series-route-file-added.test.ts
//
// /api/library/series file sync — Issue.fileAddedAt (#206 follow-up). Opening a series page
// reconciles the folder with the rows: a file with no row gets one, and a row whose number matches
// a file gets pointed at it. The RESCAN rule: a placeholder that finally has its file is stamped
// now; a row that already had a file (renamed outside Omnibus) keeps its stamp; a new row is now.
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
        attachedVolume: { findMany: vi.fn(async () => []) },
        favorite: { findUnique: vi.fn() },
        seriesFollow: { findUnique: vi.fn() },
        readProgress: { findMany: vi.fn() },
    }
}));
const disk = vi.hoisted(() => ({ files: [] as string[] }));
vi.mock('fs-extra', () => ({
    default: {
        existsSync: vi.fn(() => true),
        promises: { readdir: vi.fn(async () => disk.files), access: vi.fn(async () => undefined) },
    }
}));

const F = '/comics/Batman';
const OLD = new Date('2026-06-01T08:00:00.000Z');
const BORN = new Date('2026-05-01T08:00:00.000Z');
const row = (id: string, n: string, filePath: string | null, fileAddedAt: Date | null) => ({
    id, number: n, isAnnual: false, metadataId: `30000${n}`, filePath, fileAddedAt, createdAt: BORN,
    attachedVolumeId: null, attachedVolume: null, name: null, status: filePath ? 'DOWNLOADED' : 'WANTED',
});

describe('series page file sync — fileAddedAt', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (prisma.library.findMany as any).mockResolvedValue([{ id: 'lib1', path: '/comics' }]);
        (prisma.series.findFirst as any).mockResolvedValue({ id: 's1', name: 'Batman', year: 2011, folderPath: F, metadataId: '42821', metadataSource: 'COMICVINE' });
        (prisma.issue.deleteMany as any).mockResolvedValue({ count: 0 });
        (prisma.issue.createMany as any).mockResolvedValue({ count: 1 });
        (prisma.issue.update as any).mockResolvedValue({});
        (prisma.readProgress.findMany as any).mockResolvedValue([]);
    });

    const load = () => GET(getReq(`http://localhost/api/library/series?path=${encodeURIComponent(F)}`));
    const updateFor = (id: string) => (prisma.issue.update as any).mock.calls.map((c: any) => c[0]).find((c: any) => c.where.id === id);

    it('stamps a placeholder that finally has its file', async () => {
        disk.files = ['Batman #002.cbz'];
        (prisma.issue.findMany as any).mockResolvedValue([row('i2', '2', null, null)]);
        const before = Date.now();

        await load();

        const u = updateFor('i2');
        expect(u.data.filePath).toContain('Batman #002.cbz');
        expect(u.data.fileAddedAt).toBeInstanceOf(Date);
        expect(u.data.fileAddedAt.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('leaves the stamp alone when a file-backed row is re-pointed at a renamed file', async () => {
        disk.files = ['Batman 003 (2011).cbz'];
        (prisma.issue.findMany as any).mockResolvedValue([row('i3', '3', `${F}/Batman #003.cbz`, OLD)]);

        await load();

        const u = updateFor('i3');
        expect(u.data.filePath).toContain('Batman 003 (2011).cbz');
        expect('fileAddedAt' in u.data).toBe(false);
    });

    it('stamps a row it creates for a file that had none', async () => {
        disk.files = ['Batman #004.cbz'];
        (prisma.issue.findMany as any).mockResolvedValue([]);

        await load();

        const created = (prisma.issue.createMany as any).mock.calls[0][0].data;
        expect(created).toHaveLength(1);
        expect(created[0].fileAddedAt).toBeInstanceOf(Date);
    });
});
