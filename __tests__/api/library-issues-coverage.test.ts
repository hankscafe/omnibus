// /api/library/issues — #203 COLLECTED coverage: the Missing Issues view (and so "Request all
// shown") leaves out a main-run issue an OWNED collected book reprints, unless includeCovered=1
// asks for it, in which case it carries `coveredBy`. One coverage lookup per page, series-scoped.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/library/issues/route';

const mocks = vi.hoisted(() => ({ issueFindMany: vi.fn(), seriesFindMany: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { issue: { findMany: mocks.issueFindMany }, series: { findMany: mocks.seriesFindMany } } }));
vi.mock('next-auth/next', () => ({ getServerSession: vi.fn().mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } }) }));
vi.mock('@/lib/library-access', () => ({ getAccessibleLibraryIds: vi.fn().mockResolvedValue('ALL') }));

const series = { name: 'Batman', publisher: 'DC Comics', year: 2011, folderPath: '/comics/Batman', metadataId: '42821', metadataSource: 'COMICVINE' };
const wanted = (id: string, n: string, over: any = {}) => ({
    id, number: n, name: null, coverUrl: null, releaseDate: '2012-01-01', filePath: null, isAnnual: false,
    seriesId: 's1', attachedVolumeId: null, attachedVolume: null, series, ...over,
});
const book = (n: string, covers: string) => ({ seriesId: 's1', number: n, name: `Vol. ${n}`, coversIssues: covers, attachedVolume: { name: 'Batman: The Court of Owls' } });

describe('GET /api/library/issues — covered issues', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.seriesFindMany.mockResolvedValue([]);
    });

    it('drops covered issues from the WANTED page by default, keeping the rest', async () => {
        mocks.issueFindMany
            .mockResolvedValueOnce([wanted('i2', '2'), wanted('i3', '3'), wanted('i7', '7'), wanted('a1', '1', { isAnnual: true })]) // the page
            .mockResolvedValueOnce([book('1', '1-6')]);                                                                              // owned covering books
        const body = await (await GET(new Request('http://localhost/api/library/issues?status=WANTED&limit=10'))).json();
        expect(body.issues.map((i: any) => `${i.isAnnual ? 'A' : ''}${i.number}`)).toEqual(['7', 'A1']);
        // The coverage lookup is scoped to the series on the page and to owned COLLECTED books.
        const lookup = mocks.issueFindMany.mock.calls[1][0].where;
        expect(lookup.seriesId).toEqual({ in: ['s1'] });
        expect(lookup.filePath).toEqual({ not: null });
        expect(lookup.attachedVolume).toEqual({ kind: 'COLLECTED' });
    });

    it('includeCovered=1 keeps them and says which book covers each', async () => {
        mocks.issueFindMany
            .mockResolvedValueOnce([wanted('i2', '2'), wanted('i7', '7')])
            .mockResolvedValueOnce([book('1', '1-6')]);
        const body = await (await GET(new Request('http://localhost/api/library/issues?status=WANTED&limit=10&includeCovered=1'))).json();
        expect(body.issues.map((i: any) => i.number)).toEqual(['2', '7']);
        expect(body.issues[0].coveredBy).toEqual({ name: 'Vol. 1', number: '1', collectionName: 'Batman: The Court of Owls' });
        expect(body.issues[1].coveredBy).toBeUndefined();
    });

    it('makes no coverage lookup when the page holds nothing coverable', async () => {
        mocks.issueFindMany.mockResolvedValueOnce([wanted('d1', '1', { filePath: '/comics/Batman/Batman #001.cbz' })]);
        const body = await (await GET(new Request('http://localhost/api/library/issues?status=DOWNLOADED&limit=10'))).json();
        expect(body.issues).toHaveLength(1);
        expect(mocks.issueFindMany).toHaveBeenCalledTimes(1);
    });
});

// #255: a missing Special is listed with its domain, so a request from this view files it under the
// Special's own name (request-name.ts), as the series page does — never as the run's "#1".
describe('GET /api/library/issues — a Special', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.seriesFindMany.mockResolvedValue([]);
    });

    it("marks a Special's row with its own volume's name", async () => {
        mocks.issueFindMany.mockResolvedValueOnce([
            wanted('sp1', '1', { attachedVolumeId: 'av_sp', attachedVolume: { kind: 'SPECIAL', name: 'Batman: Ark-M' } }),
            wanted('i1', '1'),
        ]).mockResolvedValueOnce([]); // no owned covering books
        const body = await (await GET(new Request('http://localhost/api/library/issues?status=WANTED&limit=10'))).json();
        expect(body.issues.map((i: any) => [i.id, i.isSpecial, i.specialName, i.isCollected])).toEqual([
            ['sp1', true, 'Batman: Ark-M', false],
            ['i1', false, null, false],
        ]);
    });
});
