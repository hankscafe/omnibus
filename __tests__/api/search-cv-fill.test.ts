import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/search/route';

// Since about 2026-10-23 ComicVine's /search/ answers with stub volumes: the right id, name and
// start_year, but publisher null, count_of_issues 0 and CV's "Blank!" cover. /volumes/ still has all
// three, so a stripped page is filled with one /volumes/?filter=id: call. Every caller of /api/search
// gets the fill: the Home search, the Smart Matcher (its Auto-Scan too), Fix Match and Attach volume.

const mocks = vi.hoisted(() => ({
    cachedCvGet: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: { systemSetting: { findMany: mocks.findMany, findUnique: mocks.findUnique, upsert: mocks.upsert } },
}));
vi.mock('@/lib/metadata/providers/metron', () => ({ MetronProvider: class {} }));
vi.mock('@/lib/metadata/metadata-cache', () => ({ cachedCvGet: mocks.cachedCvGet }));

const BLANK = 'https://comicvine.gamespot.com/a/uploads/scale_medium/11122/111222211/6373148-blank.png';
const stub = (id: number, name: string, year: number) => ({
    id, name, start_year: String(year), publisher: null, count_of_issues: 0,
    image: { medium_url: BLANK, small_url: BLANK, super_url: BLANK }, deck: null, description: null,
});
const full = (id: number, publisher: string, count: number) => ({
    id, publisher: { id: 10 + id, name: publisher }, count_of_issues: count,
    image: { medium_url: `https://comicvine.gamespot.com/a/uploads/scale_medium/${id}-cover.jpg` },
});
const cover = (url: string) => `/api/library/cover?path=${encodeURIComponent(url)}`;

type Result = { id: number; name: string; year: string; publisher: string; count: number; image: string };
type CvParams = Record<string, string>;

let searchResults: Record<string, unknown>[] = [];
let volumes: Record<string, unknown>[] | Error = [];
let volumesAnswer: Record<string, unknown> | null = null;
const cvCalls = () => mocks.cachedCvGet.mock.calls.map(([url, opts]) => ({ url: url as string, params: opts?.params as CvParams }));
const volumeCalls = () => cvCalls().filter(c => c.url.endsWith('/volumes/'));
const search = (qs: string) => GET(new Request(`http://localhost/api/search?${qs}`));
const results = async (qs: string): Promise<Result[]> => (await (await search(qs)).json()).results;
const cachedKeys = () => mocks.upsert.mock.calls.map(([arg]) => arg.where.key as string);

describe('GET /api/search - ComicVine stub volumes are filled from /volumes/', () => {
    beforeEach(() => {
        searchResults = [];
        volumes = [];
        volumesAnswer = null;
        mocks.findMany.mockResolvedValue([{ key: 'cv_api_key', value: 'k' }]);
        mocks.findUnique.mockResolvedValue(null);
        mocks.upsert.mockResolvedValue({});
        mocks.cachedCvGet.mockImplementation(async (url: string) => {
            if (url.endsWith('/search/')) {
                return { data: { status_code: 1, number_of_total_results: searchResults.length, results: searchResults }, cached: false };
            }
            if (url.endsWith('/volumes/')) {
                if (volumes instanceof Error) throw volumes;
                return { data: volumesAnswer ?? { status_code: 1, results: volumes }, cached: false };
            }
            throw new Error(`unexpected ${url}`);
        });
    });

    it('fills a stripped page with one /volumes/ call: publisher, issue count and cover', async () => {
        searchResults = [stub(46568, 'Saga', 2012), stub(52845, 'Saga', 2012)];
        volumes = [full(52845, 'Image', 12), full(46568, 'Image', 72)];

        const found = await results('q=saga');

        expect(volumeCalls()).toHaveLength(1);
        expect(volumeCalls()[0].params).toMatchObject({ api_key: 'k', filter: 'id:46568|52845' });
        expect(volumeCalls()[0].params.field_list.split(',').sort()).toEqual(['count_of_issues', 'id', 'image', 'publisher']);
        expect(found.map(r => [r.id, r.name, r.year, r.publisher, r.count])).toEqual([
            [46568, 'Saga', '2012', 'Image', 72],
            [52845, 'Saga', '2012', 'Image', 12],
        ]);
        expect(found[0].image).toBe(cover('https://comicvine.gamespot.com/a/uploads/scale_medium/46568-cover.jpg'));
    });

    it('a complete page costs no extra call', async () => {
        searchResults = [{ ...stub(1, 'Batman', 2016), ...full(1, 'DC Comics', 150) }];

        const found = await results('q=batman');

        expect(volumeCalls()).toHaveLength(0);
        expect(found[0]).toMatchObject({ publisher: 'DC Comics', count: 150 });
    });

    it('asks only for the results that came back stripped', async () => {
        searchResults = [{ ...stub(1, 'Batman', 2016), ...full(1, 'DC Comics', 150) }, stub(2, 'Batman', 1940)];
        volumes = [full(2, 'DC Comics', 713)];

        const found = await results('q=batman');

        expect(volumeCalls()[0].params.filter).toBe('id:2');
        expect(found.map(r => r.count)).toEqual([150, 713]);
    });

    it('the foreign-publisher filter sees the filled publishers', async () => {
        mocks.findMany.mockResolvedValue([
            { key: 'cv_api_key', value: 'k' }, { key: 'filter_foreign_publishers', value: 'Cross Cult, Urban Comics' },
        ]);
        searchResults = [stub(46568, 'Saga', 2012), stub(110032, 'Saga', 2013), stub(140385, 'Saga', 2013)];
        volumes = [full(46568, 'Image', 72), full(110032, 'Cross Cult', 12), full(140385, 'Urban Comics', 10)];

        const found = await results('q=saga');

        expect(found.map(r => r.id)).toEqual([46568]);
    });

    it('the Smart Matcher Auto-Scan (covers=none) is filled too', async () => {
        searchResults = [stub(46568, 'Saga', 2012)];
        volumes = [full(46568, 'Image', 72)];

        const found = await results('q=saga&covers=none');

        expect(volumeCalls()).toHaveLength(1);
        expect(found[0]).toMatchObject({ publisher: 'Image', count: 72 });
    });

    it('when the fill fails the search still answers, the publisher reads Unknown, and the page is not cached', async () => {
        searchResults = [stub(46568, 'Saga', 2012)];
        volumes = new Error('Request failed with status code 420');

        const res = await search('q=saga');
        const found: Result[] = (await res.json()).results;

        expect(res.status).toBe(200);
        expect(found[0]).toMatchObject({ id: 46568, name: 'Saga', year: '2012', publisher: 'Unknown', count: 0 });
        expect(mocks.upsert).not.toHaveBeenCalled();
    });

    it("ComicVine's error answer counts as a failed fill", async () => {
        searchResults = [stub(46568, 'Saga', 2012)];
        volumesAnswer = { status_code: 107, error: 'Rate limit exceeded', results: [] };

        const found = await results('q=saga');

        expect(found[0]).toMatchObject({ publisher: 'Unknown', count: 0 });
        expect(mocks.upsert).not.toHaveBeenCalled();
    });

    it('a volume /volumes/ leaves out keeps the search data, and the page is cached', async () => {
        searchResults = [stub(46568, 'Saga', 2012), stub(999, 'Saga', 2030)];
        volumes = [full(46568, 'Image', 72)];

        const found = await results('q=saga');

        expect(found.map(r => r.publisher)).toEqual(['Image', 'Unknown']);
        expect(cachedKeys()).toHaveLength(1);
    });

    it('a filled page is cached under search_v4, and a search_v3 page cached while ComicVine was stripped is not served', async () => {
        mocks.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
            where.key.startsWith('search_v3_')
                ? { value: JSON.stringify({ timestamp: Date.now(), results: [{ id: 46568, publisher: 'Other', count: 0 }], hasMore: false }) }
                : null);
        searchResults = [stub(46568, 'Saga', 2012)];
        volumes = [full(46568, 'Image', 72)];

        const found = await results('q=saga');

        expect(found[0].publisher).toBe('Image');
        expect(cachedKeys()).toEqual(['search_v4_COMICVINE_saga_p1']);
    });
});
