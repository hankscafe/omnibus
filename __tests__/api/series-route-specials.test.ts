// /api/library/series — #255: a Special (a one-shot attached as kind SPECIAL) is its own section.
// It is not an annual (isAnnual is false), so without its own branch it read as the run's "#1": in
// the run's issue list, its Missing count and Request Missing. These pin that it never is, and that
// a Special kept as its own series ("Leave it as its own series") is listed the same way.
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
        attachedVolume: { findMany: vi.fn() },
        favorite: { findUnique: vi.fn() },
        seriesFollow: { findUnique: vi.fn() },
        readProgress: { findMany: vi.fn(async () => []) },
    }
}));
// Every stored path is on disk; the folder itself is absent (no file sync).
vi.mock('fs-extra', () => ({
    default: {
        existsSync: vi.fn(() => false),
        promises: { readdir: vi.fn(async () => []), access: vi.fn(async () => undefined) },
    }
}));

const PARENT = '/comics/DC Comics/Absolute Batman (2024)';
const arkM = { kind: 'SPECIAL', name: 'Absolute Batman: Ark-M' };

const row = (id: string, n: string, meta: string, file: string | null, lane: { kind: string; name: string } | null = null, annual = false) => ({
    id, number: n, isAnnual: annual, metadataId: meta, filePath: file, name: null,
    attachedVolumeId: lane ? `av_${lane.kind}` : null, attachedVolume: lane,
    coverUrl: null, releaseDate: null, coversIssues: null, writers: null, artists: null, characters: null, genres: null, storyArcs: null,
});

describe('#255 Specials on the series page', () => {
    let rows: any[];
    let kept: any[];
    let childBooks: any[];

    beforeEach(() => {
        vi.clearAllMocks();
        (prisma.library.findMany as any).mockResolvedValue([{ id: 'lib1', path: '/comics' }]);
        (prisma.series.findFirst as any).mockResolvedValue({ id: 's1', name: 'Absolute Batman', year: 2024, folderPath: PARENT, metadataId: '160294', metadataSource: 'COMICVINE' });
        (prisma.issue.deleteMany as any).mockResolvedValue({ count: 0 });
        kept = [];
        childBooks = [];
        // Honours the query's kind filter, so a kept Special is only listed if the route asks for its kind.
        (prisma.attachedVolume.findMany as any).mockImplementation(async ({ where }: any) =>
            (where?.retained ? kept.filter(a => (where.kind?.in ?? [where.kind]).includes(a.kind)) : []));
        (prisma.series.findMany as any).mockImplementation(async ({ where }: any) =>
            where?.metadataId === '169970' && where?.id?.not === 's1' ? [{ id: 's_arkm', name: 'Absolute Batman: Ark-M', folderPath: '/comics/DC Comics/Absolute Batman Ark-M (2026)' }] : []);
        (prisma.issue.findMany as any).mockImplementation(async ({ where }: any) => (where.seriesId === 's_arkm' ? childBooks : rows));
        rows = [];
    });

    const load = async () => (await GET(getReq(`http://localhost/api/library/series?path=${encodeURIComponent(PARENT)}`))).json();

    it("keeps an owned and a missing Special out of the run's lists, Missing count and Request Missing", async () => {
        rows = [
            row('i1', '1', '9100001', `${PARENT}/Absolute Batman #001.cbz`),
            row('i2', '2', '9100002', null),
            row('sp1', '1', '1151955', `${PARENT}/Absolute Batman Ark-M #001 (2026).cbz`, arkM),
            row('sp2', '2', '1151956', null, arkM),
        ];
        const body = await load();

        expect(body.downloadedIssues.map((i: any) => i.id)).toEqual(['i1']);
        expect(body.missingIssues.map((i: any) => i.id)).toEqual(['i2']);
        expect(body.specials.map((i: any) => i.id)).toEqual(['sp1']);
        expect(body.missingSpecials.map((i: any) => i.id)).toEqual(['sp2']);
        expect(body.specials[0]).toMatchObject({ isSpecial: true, isAnnual: false, isCollected: false, specialName: 'Absolute Batman: Ark-M', name: 'Absolute Batman: Ark-M #1' });
        // Specials are neither collected editions nor covered issues.
        expect(body.collectedEditions).toEqual([]);
        expect(body.coveredIssues).toEqual([]);
    });

    it("lists a Special kept as its own series in the Specials section, linked to it", async () => {
        kept = [{ id: 'av_SPECIAL', seriesId: 's1', metadataSource: 'COMICVINE', volumeId: '169970', kind: 'SPECIAL', retained: true, name: 'Absolute Batman: Ark-M' }];
        childBooks = [
            { ...row('c1', '1', '1151955', '/comics/DC Comics/Absolute Batman Ark-M (2026)/Absolute Batman Ark-M #001 (2026).cbz'), seriesId: 's_arkm' },
            { ...row('c2', '2', '1151956', null), seriesId: 's_arkm' },
        ];
        rows = [row('i1', '1', '9100001', `${PARENT}/Absolute Batman #001.cbz`)];
        const body = await load();

        expect(body.specials.map((b: any) => [b.id, b.isSpecial, b.isCollected, b.retainedSeries?.id])).toEqual([['c1', true, false, 's_arkm']]);
        expect(body.missingSpecials.map((b: any) => b.id)).toEqual(['c2']);
        expect(body.specials[0].name).toBe('Absolute Batman: Ark-M #1');
        expect(body.collectedEditions).toEqual([]);
        expect(body.missingCollectedEditions).toEqual([]);
        expect(body.downloadedIssues.map((i: any) => i.id)).toEqual(['i1']);
    });
});
