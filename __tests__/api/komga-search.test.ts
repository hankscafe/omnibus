// __tests__/api/komga-search.test.ts
//
// #206 prep for Paperback's 0.9 "Komga" source: the three calls it makes that the 0.8 source never
// did — POST /api/v1/series/list (search + its Continue Reading section), POST /api/v1/books/list
// (a series' chapters) and GET /api/v2/series/{id}/read-progress/tachiyomi (where the reader is up
// to). Read-only; the caller's library grants apply outside whatever the body asks for.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as getSeriesListGet, POST as postSeriesList } from '@/app/komga/api/v1/series/list/route';
import { POST as postBooksList } from '@/app/komga/api/v1/books/list/route';
import { GET as getTachiyomi } from '@/app/komga/api/v2/series/[id]/read-progress/tachiyomi/route';
import { PATCH as patchProgress } from '@/app/komga/api/v1/books/[id]/read-progress/route';

const mocks = vi.hoisted(() => ({
    validateApiKey: vi.fn(),
    getAccessibleLibraryIds: vi.fn(),
    prisma: {
        series: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
        issue: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), findUnique: vi.fn() },
        readProgress: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    },
    stat: vi.fn(),
    recordDailyReading: vi.fn(),
    evaluateTrophies: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock('@/lib/db', () => ({ prisma: mocks.prisma }));
vi.mock('@/lib/library-access', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/library-access')>()),
    getAccessibleLibraryIds: mocks.getAccessibleLibraryIds,
}));
vi.mock('fs', () => {
    const m = { promises: { stat: mocks.stat }, existsSync: vi.fn().mockReturnValue(true) };
    return { ...m, default: m };
});
vi.mock('@/lib/reading-stats', () => ({ recordDailyReading: mocks.recordDailyReading }));
vi.mock('@/lib/trophy-evaluator', () => ({ evaluateTrophies: mocks.evaluateTrophies }));

const D = new Date('2026-09-01T12:00:00.000Z');
const USER = { id: 'user_1', username: 'adam', role: 'USER' };
const req = (path: string, init: RequestInit = {}, headers: Record<string, string> = {}) =>
    new Request(`http://localhost/komga/api${path}`, { ...init, headers: { authorization: 'Basic YWRhbTpvbW5pLWtleQ==', 'content-type': 'application/json', ...headers } });
const post = (path: string, body: unknown) => req(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
const params = <P extends Record<string, string>>(p: P) => ({ params: Promise.resolve(p) });

const seriesRow = (id: string, name: string, libraryId = 'lib_1') => ({
    id, name, year: 2016, publisher: 'DC Comics', folderPath: `/comics/${name}`, libraryId, isManga: false,
    description: null, status: 'Continuing', genres: '["Superhero"]', tags: null, writers: null, artists: null, languageISO: null,
    createdAt: D, updatedAt: D,
});
const issue = (id: string, number: string, over: Record<string, unknown> = {}) => ({
    id, seriesId: 'ser_1', number, isAnnual: false, attachedVolumeId: null, attachedVolume: null, name: null, description: null,
    releaseDate: null, filePath: `/comics/Batman/Batman ${number}.cbz`, pageCount: 24, coverUrl: null, writers: null, artists: null,
    createdAt: D, updatedAt: D, series: { id: 'ser_1', name: 'Batman', libraryId: 'lib_1' }, ...over,
});

beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateApiKey.mockResolvedValue({ valid: true, user: USER, keyType: 'OPDS_KEY' });
    mocks.getAccessibleLibraryIds.mockResolvedValue(['lib_1']);
    mocks.stat.mockResolvedValue({ size: 1024, mtime: D });
    mocks.prisma.issue.groupBy.mockResolvedValue([]);
    mocks.prisma.readProgress.findMany.mockResolvedValue([]);
    mocks.prisma.series.findMany.mockResolvedValue([]);
    mocks.prisma.series.count.mockResolvedValue(0);
    mocks.prisma.issue.findMany.mockResolvedValue([]);
    mocks.prisma.issue.count.mockResolvedValue(0);
});

describe('POST /api/v1/series/list — the 0.9 source\'s search', () => {
    const SEARCH = {
        fullTextSearch: 'bat',
        condition: { allOf: [
            { tag: { operator: 'is', value: 'Event%20Book' } },
            { collectionId: { operator: 'is', value: 'col_1' } },
            { libraryId: { operator: 'isNot', value: 'lib_9' } },
        ] },
    };

    it('answers a Page of SeriesDto, title order, the grants AND the request both applied', async () => {
        mocks.prisma.series.findMany.mockResolvedValue([seriesRow('ser_1', 'Batman')]);
        mocks.prisma.series.count.mockResolvedValue(1);

        const res = await postSeriesList(post('/v1/series/list?page=0&size=40&sort=titleSort', SEARCH));

        expect(res.status).toBe(200);
        const body = JSON.parse(await res.text());
        expect(body.content.map((s: any) => s.id)).toEqual(['ser_1']);
        expect(body.totalElements).toBe(1);
        const call = mocks.prisma.series.findMany.mock.calls[0][0];
        const where = JSON.stringify(call.where);
        expect(where).toContain('"libraryId":{"in":["lib_1"]}');      // the caller's grants…
        expect(where).toContain('"contains":"bat"');                  // …and the full-text search…
        expect(where).toContain('"contains":"\\"Event Book\\""');     // …and the decoded tag…
        expect(where).toContain('"userId":"user_1"');                 // …a collection the caller owns…
        expect(where).toContain('{"OR":[{"libraryId":null},{"NOT":{"libraryId":"lib_9"}}]}'); // …minus the excluded library
        expect(call.orderBy[0]).toEqual({ name: 'asc' });
        expect(call.skip).toBe(0);
        expect(call.take).toBe(40);
        expect(JSON.stringify(mocks.prisma.series.count.mock.calls[0][0].where)).toBe(where);
    });

    it('can never reach past the grants — an anyOf of any library still sits inside them', async () => {
        await postSeriesList(post('/v1/series/list', { condition: { anyOf: [{ libraryId: { operator: 'is', value: 'lib_secret' } }, { libraryId: { operator: 'isNot', value: 'x' } }] } }));
        const where = mocks.prisma.series.findMany.mock.calls[0][0].where;
        expect(where.AND[0]).toEqual({ libraryId: { in: ['lib_1'] } });
        expect(JSON.stringify(where.AND.slice(1))).toContain('lib_secret'); // the request is one more AND clause, not an alternative to the grants
    });

    it('Continue Reading: IN_PROGRESS series ordered by when they were last read', async () => {
        mocks.prisma.readProgress.findMany.mockImplementation(async (args: any) =>
            args.where.isCompleted === false
                ? [{ issue: { seriesId: 'ser_1' } }, { issue: { seriesId: 'ser_2' } }]          // the in-progress set
                : [{ issue: { seriesId: 'ser_2' } }, { issue: { seriesId: 'ser_3' } }, { issue: { seriesId: 'ser_1' } }] // any progress, newest first
        );
        mocks.prisma.series.findMany.mockImplementation(async (args: any) =>
            args.select ? [{ id: 'ser_1' }, { id: 'ser_2' }] : [seriesRow('ser_1', 'Batman'), seriesRow('ser_2', 'Nightwing')]
        );

        const res = await postSeriesList(post('/v1/series/list?sort=readProgress.readDate,desc&page=0', {
            condition: { deleted: { operator: 'isFalse' }, readStatus: { operator: 'is', value: 'IN_PROGRESS' } },
        }));

        const body = JSON.parse(await res.text());
        expect(body.content.map((s: any) => s.id)).toEqual(['ser_2', 'ser_1']);
        expect(body.totalElements).toBe(2);
        const matchQuery = mocks.prisma.series.findMany.mock.calls.map((c: any) => c[0]).find((a: any) => a.select);
        expect(JSON.stringify(matchQuery.where)).toContain('"id":{"in":["ser_1","ser_2"]}');
    });

    it('rejects what no client sends: bad JSON 400, a huge body 413, no key 401 — all as JSON', async () => {
        const parsed = async (res: Response) => ({ status: res.status, body: JSON.parse(await res.text()) });
        expect((await parsed(await postSeriesList(post('/v1/series/list', '{nope')))).body.status).toBe(400);
        const big = await postSeriesList(req('/v1/series/list', { method: 'POST', body: '{}' }, { 'content-length': '999999' }));
        expect((await parsed(big)).status).toBe(413);
        mocks.validateApiKey.mockResolvedValueOnce({ valid: false, user: null });
        expect((await parsed(await postSeriesList(post('/v1/series/list', {})))).status).toBe(401);
        expect(mocks.prisma.series.findMany).not.toHaveBeenCalled();
    });

    it('GET on the search path is a JSON 405', async () => {
        const res = await getSeriesListGet(req('/v1/series/list'));
        expect(res.status).toBe(405);
        expect(JSON.parse(await res.text()).error).toBe('Method Not Allowed');
    });
});

describe('POST /api/v1/books/list — the 0.9 source\'s chapter list', () => {
    const CHAPTERS = { condition: {
        seriesId: { operator: 'is', value: 'ser_1' },
        deleted: { operator: 'isFalse' },
        mediaStatus: { operator: 'is', value: 'READY' },
    } };

    it('lists the series\' books in reading order with 1-based numberSort, unpaged', async () => {
        mocks.prisma.series.findUnique.mockResolvedValue({ id: 'ser_1', name: 'Batman', libraryId: 'lib_1' });
        mocks.prisma.issue.findMany.mockImplementation(async (args: any) =>
            args.select
                ? [{ id: 'iss_2' }, { id: 'iss_1' }, { id: 'iss_3' }]                             // what the filter matched
                : [issue('iss_3', '3'), issue('iss_1', '1'), issue('iss_2', '2')]                  // the series' books
        );

        const res = await postBooksList(post('/v1/books/list?unpaged=true', CHAPTERS));

        expect(res.status).toBe(200);
        const body = JSON.parse(await res.text());
        expect(body.content.map((b: any) => [b.id, b.metadata.numberSort])).toEqual([['iss_1', 1], ['iss_2', 2], ['iss_3', 3]]);
        expect(body.totalElements).toBe(3);
        const filter = mocks.prisma.issue.findMany.mock.calls.map((c: any) => c[0]).find((a: any) => a.select);
        const fw = JSON.stringify(filter.where);
        expect(fw).toContain('"filePath":{"not":null}');
        expect(fw).toContain('"libraryId":{"in":["lib_1"]}');
        expect(fw).toContain('"seriesId":"ser_1"');
    });

    it('a series outside the grants lists nothing (a search, not a leak)', async () => {
        mocks.prisma.series.findUnique.mockResolvedValue({ id: 'ser_1', name: 'Batman', libraryId: 'lib_other' });
        mocks.prisma.issue.findMany.mockResolvedValue([issue('iss_1', '1')]);

        const body = JSON.parse(await (await postBooksList(post('/v1/books/list?unpaged=true', CHAPTERS))).text());
        expect(body.content).toEqual([]);
        expect(body.totalElements).toBe(0);
    });

    it('without a single series, unpaged is not honoured — a page, like any other list', async () => {
        mocks.prisma.issue.findMany.mockResolvedValue([issue('iss_1', '1')]);
        mocks.prisma.issue.count.mockResolvedValue(1);

        const body = JSON.parse(await (await postBooksList(post('/v1/books/list?unpaged=true', { condition: { libraryId: { operator: 'is', value: 'lib_1' } } }))).text());

        const call = mocks.prisma.issue.findMany.mock.calls[0][0];
        expect(call.skip).toBe(0);
        expect(call.take).toBe(20);
        expect(JSON.stringify(call.where)).toContain('"libraryId":{"in":["lib_1"]}');
        expect(body.content.map((b: any) => b.id)).toEqual(['iss_1']);
    });
});

describe('GET /api/v2/series/{id}/read-progress/tachiyomi — where the reader is up to', () => {
    beforeEach(() => {
        mocks.prisma.series.findUnique.mockResolvedValue(seriesRow('ser_1', 'Batman'));
        mocks.prisma.issue.findMany.mockResolvedValue([issue('iss_3', '3'), issue('iss_1', '1'), issue('iss_2', '2')]);
    });
    const progress = (rows: Array<[string, number, boolean]>) =>
        mocks.prisma.readProgress.findMany.mockResolvedValue(rows.map(([issueId, currentPage, isCompleted]) => ({ issueId, currentPage, isCompleted, updatedAt: D })));

    it('counts the books and names the last one read without a gap from the start', async () => {
        progress([['iss_1', 24, true], ['iss_2', 24, true]]);
        const res = await getTachiyomi(req('/v2/series/ser_1/read-progress/tachiyomi'), params({ id: 'ser_1' }));
        expect(res.status).toBe(200);
        expect(JSON.parse(await res.text())).toEqual({
            booksCount: 3, booksReadCount: 2, booksUnreadCount: 1, booksInProgressCount: 0,
            lastReadContinuousNumberSort: 2, maxNumberSort: 3,
        });
    });

    it('stops at the first gap, and is 0 when the first book is unread', async () => {
        progress([['iss_1', 24, true], ['iss_2', 5, false], ['iss_3', 24, true]]);
        const gap = JSON.parse(await (await getTachiyomi(req('/v2/series/ser_1/read-progress/tachiyomi'), params({ id: 'ser_1' }))).text());
        expect(gap).toEqual(expect.objectContaining({ booksReadCount: 2, booksInProgressCount: 1, booksUnreadCount: 0, lastReadContinuousNumberSort: 1 }));

        progress([['iss_2', 24, true]]);
        const none = JSON.parse(await (await getTachiyomi(req('/v2/series/ser_1/read-progress/tachiyomi'), params({ id: 'ser_1' }))).text());
        expect(none.lastReadContinuousNumberSort).toBe(0);
    });

    it('404 / 403 as JSON, and the key is required', async () => {
        mocks.prisma.series.findUnique.mockResolvedValueOnce(null);
        const nf = await getTachiyomi(req('/v2/series/nope/read-progress/tachiyomi'), params({ id: 'nope' }));
        expect([nf.status, JSON.parse(await nf.text()).error]).toEqual([404, 'Not Found']);
        mocks.prisma.series.findUnique.mockResolvedValueOnce(seriesRow('ser_1', 'Batman', 'lib_other'));
        const fb = await getTachiyomi(req('/v2/series/ser_1/read-progress/tachiyomi'), params({ id: 'ser_1' }));
        expect([fb.status, JSON.parse(await fb.text()).error]).toEqual([403, 'Forbidden']);
        mocks.validateApiKey.mockResolvedValueOnce({ valid: false, user: null });
        expect((await getTachiyomi(req('/v2/series/ser_1/read-progress/tachiyomi'), params({ id: 'ser_1' }))).status).toBe(401);
    });
});

describe('PATCH /api/v1/books/{id}/read-progress — the 0.9 source marks a chapter read with { completed: true } alone', () => {
    it('records it as finished', async () => {
        mocks.prisma.issue.findUnique.mockResolvedValue({ ...issue('iss_1', '1'), series: { id: 'ser_1', name: 'Batman', libraryId: 'lib_1' } });
        mocks.prisma.readProgress.findUnique.mockResolvedValue(null);
        mocks.prisma.readProgress.upsert.mockResolvedValue({});
        mocks.recordDailyReading.mockResolvedValue(undefined);
        mocks.evaluateTrophies.mockResolvedValue(undefined);

        const res = await patchProgress(req('/v1/books/iss_1/read-progress', { method: 'PATCH', body: JSON.stringify({ completed: true }) }), params({ id: 'iss_1' }));

        expect(res.status).toBe(204);
        const up = mocks.prisma.readProgress.upsert.mock.calls[0][0];
        expect(up.create).toEqual(expect.objectContaining({ isCompleted: true, currentPage: 24, totalPages: 24 }));
    });
});
