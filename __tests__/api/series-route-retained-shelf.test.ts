// /api/library/series — #239: a collected volume kept as its own series ("Leave it as its own
// series") lists ITS books on the parent's Collected Editions shelf. One row per book: owned books
// link to the series they live in, missing ones keep Request, a copy the parent's lane owns wins, and
// a leftover parent skeleton gives way to the child's owned copy instead of reading as missing.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/library/series/route';
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import { canAccessPath } from '@/lib/library-access';
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
        attachedVolume: { findMany: vi.fn() },
        favorite: { findUnique: vi.fn() },
        seriesFollow: { findUnique: vi.fn() },
        readProgress: { findMany: vi.fn(async () => []) },
    }
}));
// A stored path "exists" unless it names a missing file; the folder itself is absent (no file sync).
vi.mock('fs-extra', () => ({
    default: {
        existsSync: vi.fn(() => false),
        promises: { readdir: vi.fn(async () => []), access: vi.fn(async () => undefined) },
    }
}));

const PARENT = '/comics/DC Comics/Absolute Batman (2024)';
const CHILD = { id: 's_child', name: 'Absolute Batman', folderPath: '/comics/DC Comics/Absolute Batman (2025)' };
const kept = { id: 'att', seriesId: 's1', metadataSource: 'COMICVINE', volumeId: '167340', kind: 'COLLECTED', retained: true, name: 'Absolute Batman' };

const parentRow = (id: string, n: string, meta: string, file: string | null, attached = false) => ({
    id, number: n, isAnnual: false, metadataId: meta, filePath: file, name: null,
    attachedVolumeId: attached ? 'att' : null, attachedVolume: attached ? { kind: 'COLLECTED', name: 'Absolute Batman' } : null,
});
const childBook = (id: string, n: string, meta: string, file: string | null, name: string, attachedVolumeId: string | null = null) => ({
    id, seriesId: 's_child', number: n, isAnnual: false, metadataId: meta, filePath: file, name, attachedVolumeId,
    coverUrl: null, releaseDate: null, coversIssues: null, writers: null, artists: null, characters: null, genres: null, storyArcs: null,
});

describe('#239 the parent shelf lists a kept collection\'s books', () => {
    let parentRows: any[];
    let childBooks: any[];

    beforeEach(() => {
        vi.clearAllMocks();
        (canAccessPath as any).mockImplementation(() => true);
        (prisma.library.findMany as any).mockResolvedValue([{ id: 'lib1', path: '/comics' }]);
        (prisma.series.findFirst as any).mockResolvedValue({ id: 's1', name: 'Absolute Batman', year: 2024, folderPath: PARENT, metadataId: '160294', metadataSource: 'COMICVINE' });
        (prisma.series.findMany as any).mockImplementation(async ({ where }: any) =>
            where?.metadataId === '167340' && where?.id?.not === 's1' ? [CHILD] : []);
        (prisma.issue.deleteMany as any).mockResolvedValue({ count: 0 });
        (prisma.attachedVolume.findMany as any).mockImplementation(async ({ where }: any) => (where?.retained ? [kept] : []));
        (prisma.issue.findMany as any).mockImplementation(async ({ where }: any) =>
            where.seriesId === 's_child'
                ? childBooks.filter(b => where.attachedVolumeId !== null || !b.attachedVolumeId)
                : parentRows);
        (fs.promises.access as any).mockImplementation(async (p: string) => {
            if (p.includes('MISSING')) throw new Error('ENOENT');
        });
        parentRows = [parentRow('p1', '1', '9100001', `${PARENT}/Absolute Batman #001.cbz`)];
        childBooks = [];
    });

    const load = async () => (await GET(getReq(`http://localhost/api/library/series?path=${encodeURIComponent(PARENT)}`))).json();

    it('shows the owned book as owned, linked to its series, and the missing one with its Request', async () => {
        childBooks = [
            childBook('c1', '1', '9200001', `${CHILD.folderPath}/Absolute Batman Vol. 001 (2025).cbz`, 'The Zoo'),
            childBook('c2', '2', '9200002', null, 'Abomination'),
        ];
        const body = await load();

        expect(body.collectedEditions).toHaveLength(1);
        expect(body.collectedEditions[0]).toMatchObject({
            id: 'c1', number: '1', isCollected: true, collectionName: 'Absolute Batman',
            fullPath: `${CHILD.folderPath}/Absolute Batman Vol. 001 (2025).cbz`, retainedSeries: CHILD,
        });
        expect(body.missingCollectedEditions.map((b: any) => [b.id, b.cvId, b.fullPath])).toEqual([['c2', 9200002, null]]);
        // The child's books never join the parent's run.
        expect(body.downloadedIssues.map((i: any) => i.id)).toEqual(['p1']);
        expect(body.missingIssues).toEqual([]);
    });

    it("one row per book: the parent's own copy wins, and a leftover skeleton gives way to the child's owned copy", async () => {
        parentRows = [
            parentRow('p1', '1', '9100001', `${PARENT}/Absolute Batman #001.cbz`),
            parentRow('lane_owned', '3', '9200003', `${PARENT}/Absolute Batman Vol. 003 (2026).cbz`, true),
            parentRow('lane_skel', '1', '9200001', null, true),
        ];
        childBooks = [
            childBook('c1', '1', '9200001', `${CHILD.folderPath}/Absolute Batman Vol. 001 (2025).cbz`, 'The Zoo'),
            childBook('c3', '3', '9200003', `${CHILD.folderPath}/Absolute Batman Vol. 003 (2026).cbz`, 'Three'),
            childBook('c4', '4', 'unmatched_x', `${CHILD.folderPath}/MISSING.cbz`, 'Gone'),
        ];
        const body = await load();

        expect(body.collectedEditions.map((b: any) => b.id).sort()).toEqual(['c1', 'lane_owned']);
        expect(body.missingCollectedEditions).toEqual([]);
    });

    it("leaves out books of the child's own attachments, which Standardize names by their lane", async () => {
        childBooks = [
            childBook('c1', '1', '9200001', `${CHILD.folderPath}/Absolute Batman Vol. 001 (2025).cbz`, 'The Zoo'),
            childBook('c_ann', '1', '9300001', `${CHILD.folderPath}/Absolute Batman Annual 001 (2025).cbz`, 'Annual', 'child_att'),
        ];
        const body = await load();
        expect(body.collectedEditions.map((b: any) => b.id)).toEqual(['c1']);
        expect(body.missingCollectedEditions).toEqual([]);
    });

    it("lists none of the child's books when the viewer can't open the child's library", async () => {
        (canAccessPath as any).mockImplementation((_paths: any, p: string) => p !== CHILD.folderPath);
        childBooks = [
            childBook('c1', '1', '9200001', `${CHILD.folderPath}/Absolute Batman Vol. 001 (2025).cbz`, 'The Zoo'),
            childBook('c2', '2', '9200002', null, 'Abomination'),
        ];
        const body = await load();
        expect(body.collectedEditions).toEqual([]);
        expect(body.missingCollectedEditions).toEqual([]);
        expect(body.downloadedIssues.map((i: any) => i.id)).toEqual(['p1']);
        expect(prisma.issue.findMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ seriesId: 's_child' }) }));
    });

    it('lists nothing extra for an attachment that is not kept', async () => {
        (prisma.attachedVolume.findMany as any).mockResolvedValue([]);
        childBooks = [childBook('c1', '1', '9200001', `${CHILD.folderPath}/Absolute Batman Vol. 001 (2025).cbz`, 'The Zoo')];
        const body = await load();
        expect(body.collectedEditions).toEqual([]);
        expect(prisma.issue.findMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ seriesId: 's_child' }) }));
    });
});
