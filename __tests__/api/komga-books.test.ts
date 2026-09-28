// __tests__/api/komga-books.test.ts
//
// #206 (Paperback): the Komga-compatible facade — the book half. The source lists a series' books
// (unpaged), asks /books/{id}/pages for the page list, then loads /books/{id}/pages/{n} (1-based)
// through the same interceptor that adds Basic auth; thumbnails are bare URLs it loads the same
// way; finishing a chapter PATCHes /books/{id}/read-progress {page:1, completed:true}. Covers and
// pages are delegated in-process to the routes that already serve them (the cover route and the
// OPDS-PSE page streamer) — the middleware would 401 a Basic-only client on a redirect.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as getSeriesBooks } from '@/app/komga/api/v1/series/[id]/books/route';
import { GET as getSeriesThumb } from '@/app/komga/api/v1/series/[id]/thumbnail/route';
import { GET as getBookPages } from '@/app/komga/api/v1/books/[id]/pages/route';
import { GET as getBookPage } from '@/app/komga/api/v1/books/[id]/pages/[n]/route';
import { GET as getBookThumb } from '@/app/komga/api/v1/books/[id]/thumbnail/route';
import { PATCH as patchProgress } from '@/app/komga/api/v1/books/[id]/read-progress/route';
import { GET as getBooks } from '@/app/komga/api/v1/books/route';
import { GET as getOnDeck } from '@/app/komga/api/v1/books/ondeck/route';
import { GET as getSeriesOnDeck } from '@/app/komga/api/v1/series/ondeck/route';
import { GET as getSeriesContinue } from '@/app/komga/api/v1/series/continue/route';
import { GET as catchAllGet, POST as catchAllPost } from '@/app/komga/api/v1/[...rest]/route';
import { POST as postSeriesOne } from '@/app/komga/api/v1/series/[id]/route';

const mocks = vi.hoisted(() => ({
    validateApiKey: vi.fn(),
    getAccessibleLibraryIds: vi.fn(),
    prisma: {
        series: { findUnique: vi.fn(), findMany: vi.fn() },
        issue: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), groupBy: vi.fn() },
        readProgress: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), count: vi.fn() },
    },
    stat: vi.fn(),
    coverGet: vi.fn(),
    opdsPageGet: vi.fn(),
    countArchivePages: vi.fn(),
    countArchivePagesViaEngine: vi.fn(),
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
vi.mock('@/app/api/library/cover/route', () => ({ GET: mocks.coverGet }));
vi.mock('@/app/api/opds/page/[issueId]/[pageIndex]/route', () => ({ GET: mocks.opdsPageGet }));
vi.mock('@/lib/utils/archive-pages', () => ({
    countArchivePages: mocks.countArchivePages,
    countArchivePagesViaEngine: mocks.countArchivePagesViaEngine,
    isPageCountable: (p: string | null | undefined) => !!p && /\.(cbz|zip|epub)$/i.test(p),
    isEngineCountable: (p: string | null | undefined) => !!p && /\.(cbr|rar|cb7)$/i.test(p),
}));
vi.mock('@/lib/reading-stats', () => ({ recordDailyReading: mocks.recordDailyReading }));
vi.mock('@/lib/trophy-evaluator', () => ({ evaluateTrophies: mocks.evaluateTrophies }));

const D = new Date('2026-09-01T12:00:00.000Z');
const MTIME = new Date('2026-08-20T08:00:00.000Z');
const USER = { id: 'user_1', username: 'adam', role: 'USER' };
const AUTH = 'Basic YWRhbTpvbW5pLWtleQ==';
const req = (path: string, init: RequestInit = {}) => new Request(`http://localhost/komga/api/v1${path}`, {
    ...init,
    headers: { authorization: AUTH, ...(init.headers as Record<string, string> | undefined) },
});
const params = <P extends Record<string, string>>(p: P) => ({ params: Promise.resolve(p) });

const issue = (over: Record<string, unknown> = {}) => ({
    id: 'iss_1', seriesId: 'ser_1', number: '1', isAnnual: false, attachedVolumeId: null, attachedVolume: null,
    name: null, description: null, releaseDate: '2016-06-15', filePath: '/comics/Batman (2016)/Batman 001.cbz',
    pageCount: 24, coverUrl: null, writers: null, artists: null, createdAt: D, updatedAt: D,
    series: { id: 'ser_1', name: 'Batman', libraryId: 'lib_1' },
    ...over,
});

beforeEach(() => {
    mocks.validateApiKey.mockResolvedValue({ valid: true, user: USER, keyType: 'OPDS_KEY' });
    mocks.getAccessibleLibraryIds.mockResolvedValue(['lib_1']);
    mocks.stat.mockResolvedValue({ size: 1536, mtime: MTIME });
    mocks.prisma.readProgress.findMany.mockResolvedValue([]);
    mocks.prisma.readProgress.findUnique.mockResolvedValue(null);
    mocks.prisma.readProgress.upsert.mockResolvedValue({});
    mocks.prisma.readProgress.count.mockResolvedValue(0);
    mocks.prisma.issue.update.mockResolvedValue({});
    mocks.recordDailyReading.mockResolvedValue(undefined);
    mocks.evaluateTrophies.mockResolvedValue(undefined);
    mocks.coverGet.mockResolvedValue(new Response('cover-bytes', { headers: { 'Content-Type': 'image/webp' } }));
    mocks.opdsPageGet.mockResolvedValue(new Response('page-bytes', { headers: { 'Content-Type': 'image/webp' } }));
});

describe('Komga facade: GET /series/{id}/books', () => {
    beforeEach(() => {
        mocks.prisma.series.findUnique.mockResolvedValue({ id: 'ser_1', name: 'Batman', libraryId: 'lib_1' });
        mocks.prisma.issue.findMany.mockResolvedValue([
            issue({ id: 'iss_2', number: '2', name: 'Part Two' }),
            issue({ id: 'iss_a1', number: '1', isAnnual: true, attachedVolumeId: 'att_1', attachedVolume: { name: 'Batman Annual' }, filePath: '/comics/Batman (2016)/Batman Annual 001.cbz' }),
            issue({ id: 'iss_1', number: '1' }),
        ]);
        mocks.prisma.readProgress.findMany.mockResolvedValue([
            { issueId: 'iss_1', currentPage: 24, isCompleted: true, updatedAt: MTIME },
        ]);
    });

    it('lists the run then the annuals, 1-based numberSort, lane-labelled titles, sizes from the file', async () => {
        const res = await getSeriesBooks(req('/series/ser_1/books?unpaged=true&media_status=READY&deleted=false'), params({ id: 'ser_1' }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.totalElements).toBe(3);
        expect(body.content.map((b: any) => b.id)).toEqual(['iss_1', 'iss_2', 'iss_a1']);
        expect(body.content.map((b: any) => b.metadata.numberSort)).toEqual([1, 2, 3]);
        expect(body.content.map((b: any) => b.metadata.number)).toEqual(['1', '2', '1']);
        expect(body.content.map((b: any) => b.metadata.title)).toEqual(['Batman #1', 'Part Two', 'Batman Annual · Annual #1']);
        expect(body.content[0].size).toBe('1.5 KiB');
        expect(body.content[0].fileLastModified).toBe(MTIME.toISOString());
        expect(body.content[0].seriesId).toBe('ser_1');
        expect(body.content[0].readProgress).toEqual(expect.objectContaining({ completed: true, page: 24 }));
        expect(body.content[1].readProgress).toBeNull();

        const where = mocks.prisma.issue.findMany.mock.calls[0][0].where;
        expect(where.seriesId).toBe('ser_1');
        expect(where.filePath).toEqual({ not: null });
        const progressWhere = mocks.prisma.readProgress.findMany.mock.calls[0][0].where;
        expect(progressWhere.userId).toBe('user_1');
    });

    it('survives a file that cannot be stat-ed (size 0, modified falls back to the row)', async () => {
        mocks.stat.mockRejectedValue(new Error('ENOENT'));
        const body = await (await getSeriesBooks(req('/series/ser_1/books?unpaged=true'), params({ id: 'ser_1' }))).json();
        expect(body.content[0].sizeBytes).toBe(0);
        expect(body.content[0].fileLastModified).toBe(D.toISOString());
    });

    it('404s an unknown series and 403s an inaccessible one', async () => {
        mocks.prisma.series.findUnique.mockResolvedValueOnce(null);
        expect((await getSeriesBooks(req('/series/x/books'), params({ id: 'x' }))).status).toBe(404);
        mocks.getAccessibleLibraryIds.mockResolvedValue(['lib_other']);
        expect((await getSeriesBooks(req('/series/ser_1/books'), params({ id: 'ser_1' }))).status).toBe(403);
    });
});

describe('Komga facade: GET /books/{id}/pages', () => {
    it('lists pageCount pages, 1-based, without touching the archive when the count is known', async () => {
        mocks.prisma.issue.findUnique.mockResolvedValue(issue({ pageCount: 24 }));
        const res = await getBookPages(req('/books/iss_1/pages'), params({ id: 'iss_1' }));
        const body = await res.json();
        expect(body).toHaveLength(24);
        expect(body[0]).toEqual(expect.objectContaining({ number: 1, mediaType: 'image/jpeg' }));
        expect(body[23].number).toBe(24);
        expect(mocks.countArchivePages).not.toHaveBeenCalled();
    });

    it('self-heals a zero pageCount from the archive and persists it (same rule as the OPDS feed)', async () => {
        mocks.prisma.issue.findUnique.mockResolvedValue(issue({ pageCount: 0 }));
        mocks.countArchivePages.mockResolvedValue(30);
        const body = await (await getBookPages(req('/books/iss_1/pages'), params({ id: 'iss_1' }))).json();
        expect(body).toHaveLength(30);
        expect(mocks.countArchivePages).toHaveBeenCalledWith('/comics/Batman (2016)/Batman 001.cbz');
        expect(mocks.prisma.issue.update).toHaveBeenCalledWith({ where: { id: 'iss_1' }, data: { pageCount: 30 } });
    });

    it('counts a RAR through the engine', async () => {
        mocks.prisma.issue.findUnique.mockResolvedValue(issue({ pageCount: 0, filePath: '/c/Batman 002.cbr' }));
        mocks.countArchivePagesViaEngine.mockResolvedValue(22);
        const body = await (await getBookPages(req('/books/iss_1/pages'), params({ id: 'iss_1' }))).json();
        expect(body).toHaveLength(22);
        expect(mocks.countArchivePages).not.toHaveBeenCalled();
    });

    it('404s an unknown book, 403s an inaccessible one', async () => {
        mocks.prisma.issue.findUnique.mockResolvedValueOnce(null);
        expect((await getBookPages(req('/books/x/pages'), params({ id: 'x' }))).status).toBe(404);
        mocks.prisma.issue.findUnique.mockResolvedValue(issue());
        mocks.getAccessibleLibraryIds.mockResolvedValue([]);
        expect((await getBookPages(req('/books/iss_1/pages'), params({ id: 'iss_1' }))).status).toBe(403);
    });
});

describe('Komga facade: GET /books/{id}/pages/{n}', () => {
    it('delegates page n (1-based) to the OPDS-PSE streamer as index n-1, forwarding the auth header', async () => {
        const res = await getBookPage(req('/books/iss_1/pages/1'), params({ id: 'iss_1', n: '1' }));

        expect(res.status).toBe(200);
        expect(await res.text()).toBe('page-bytes');
        expect(mocks.opdsPageGet).toHaveBeenCalledTimes(1);
        const [forwarded, ctx] = mocks.opdsPageGet.mock.calls[0];
        expect(forwarded.headers.get('authorization')).toBe(AUTH);
        expect(await ctx.params).toEqual({ issueId: 'iss_1', pageIndex: '0' });
    });

    it('maps page 12 to index 11 and rejects 0 / non-numeric pages without delegating', async () => {
        await getBookPage(req('/books/iss_1/pages/12'), params({ id: 'iss_1', n: '12' }));
        expect(await mocks.opdsPageGet.mock.calls[0][1].params).toEqual({ issueId: 'iss_1', pageIndex: '11' });

        mocks.opdsPageGet.mockClear();
        expect((await getBookPage(req('/books/iss_1/pages/0'), params({ id: 'iss_1', n: '0' }))).status).toBe(404);
        expect((await getBookPage(req('/books/iss_1/pages/x'), params({ id: 'iss_1', n: 'x' }))).status).toBe(404);
        expect(mocks.opdsPageGet).not.toHaveBeenCalled();
    });
});

describe('Komga facade: thumbnails', () => {
    const delegatedUrl = () => new URL(mocks.coverGet.mock.calls[0][0].url);

    it('GET /series/{id}/thumbnail serves the series cover through the cover route (local cover path)', async () => {
        mocks.prisma.series.findUnique.mockResolvedValue({
            id: 'ser_1', libraryId: 'lib_1', folderPath: '/comics/Batman (2016)',
            coverUrl: '/api/library/cover?path=%2Fcomics%2FBatman%20(2016)%2Fcover.jpg&v=3',
        });
        const res = await getSeriesThumb(req('/series/ser_1/thumbnail'), params({ id: 'ser_1' }));

        expect(res.status).toBe(200);
        expect(await res.text()).toBe('cover-bytes');
        const url = delegatedUrl();
        expect(url.pathname).toBe('/api/library/cover');
        expect(url.searchParams.get('path')).toBe('/comics/Batman (2016)/cover.jpg');
        expect(url.searchParams.get('w')).toBe('640');
    });

    it('falls back to the series folder when there is no coverUrl, and passes a remote cover URL through', async () => {
        mocks.prisma.series.findUnique.mockResolvedValue({ id: 'ser_1', libraryId: 'lib_1', folderPath: '/comics/Batman (2016)', coverUrl: null });
        await getSeriesThumb(req('/series/ser_1/thumbnail'), params({ id: 'ser_1' }));
        expect(delegatedUrl().searchParams.get('path')).toBe('/comics/Batman (2016)');

        mocks.coverGet.mockClear();
        mocks.prisma.series.findUnique.mockResolvedValue({ id: 'ser_1', libraryId: 'lib_1', folderPath: '/x', coverUrl: 'https://comicvine.gamespot.com/a/cover.jpg' });
        await getSeriesThumb(req('/series/ser_1/thumbnail'), params({ id: 'ser_1' }));
        expect(delegatedUrl().searchParams.get('path')).toBe('https://comicvine.gamespot.com/a/cover.jpg');
    });

    it('GET /books/{id}/thumbnail renders the issue\'s first page when it has no cover of its own', async () => {
        mocks.prisma.issue.findUnique.mockResolvedValue(issue({ coverUrl: null }));
        await getBookThumb(req('/books/iss_1/thumbnail'), params({ id: 'iss_1' }));
        expect(delegatedUrl().searchParams.get('issueId')).toBe('iss_1');
        expect(delegatedUrl().searchParams.get('path')).toBeNull();

        mocks.coverGet.mockClear();
        mocks.prisma.issue.findUnique.mockResolvedValue(issue({ coverUrl: 'https://comicvine.gamespot.com/a/1.jpg' }));
        await getBookThumb(req('/books/iss_1/thumbnail'), params({ id: 'iss_1' }));
        expect(delegatedUrl().searchParams.get('path')).toBe('https://comicvine.gamespot.com/a/1.jpg');
    });

    it('404s / 403s before delegating', async () => {
        mocks.prisma.series.findUnique.mockResolvedValue(null);
        expect((await getSeriesThumb(req('/series/x/thumbnail'), params({ id: 'x' }))).status).toBe(404);
        mocks.prisma.issue.findUnique.mockResolvedValue(issue());
        mocks.getAccessibleLibraryIds.mockResolvedValue([]);
        expect((await getBookThumb(req('/books/iss_1/thumbnail'), params({ id: 'iss_1' }))).status).toBe(403);
        expect(mocks.coverGet).not.toHaveBeenCalled();
    });
});

describe('Komga facade: PATCH /books/{id}/read-progress', () => {
    const patch = (id: string, body: unknown) => patchProgress(
        req(`/books/${id}/read-progress`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
        params({ id }),
    );

    beforeEach(() => {
        mocks.prisma.issue.findUnique.mockResolvedValue(issue({ pageCount: 24 }));
    });

    it('{completed:true} marks the issue read at its last page, logs the pages read, evaluates trophies, answers 204', async () => {
        mocks.prisma.readProgress.findUnique.mockResolvedValue({ currentPage: 10, totalPages: 24, isCompleted: false });
        const res = await patch('iss_1', { page: 1, completed: true });

        expect(res.status).toBe(204);
        expect(mocks.recordDailyReading).toHaveBeenCalledWith('user_1', 'iss_1', 14);
        const upsert = mocks.prisma.readProgress.upsert.mock.calls[0][0];
        expect(upsert.where).toEqual({ userId_issueId: { userId: 'user_1', issueId: 'iss_1' } });
        expect(upsert.update).toEqual(expect.objectContaining({ currentPage: 24, totalPages: 24, isCompleted: true }));
        expect(upsert.create).toEqual(expect.objectContaining({ userId: 'user_1', issueId: 'iss_1', currentPage: 24, totalPages: 24, isCompleted: true }));
        expect(mocks.evaluateTrophies).toHaveBeenCalledWith('user_1');
    });

    it('a bare page update sets that page and keeps the book unfinished', async () => {
        const res = await patch('iss_1', { page: 5 });
        expect(res.status).toBe(204);
        expect(mocks.recordDailyReading).toHaveBeenCalledWith('user_1', 'iss_1', 5); // first open: the whole delta
        expect(mocks.prisma.readProgress.upsert.mock.calls[0][0].update).toEqual(expect.objectContaining({ currentPage: 5, isCompleted: false }));
    });

    it('never records a negative delta when the client reports an earlier page', async () => {
        mocks.prisma.readProgress.findUnique.mockResolvedValue({ currentPage: 20, totalPages: 24, isCompleted: false });
        await patch('iss_1', { page: 3 });
        expect(mocks.recordDailyReading).toHaveBeenCalledWith('user_1', 'iss_1', 0);
    });

    it('rejects a malformed body with 400, unknown books with 404, other libraries with 403, no key with 401', async () => {
        const bad = await patchProgress(req('/books/iss_1/read-progress', { method: 'PATCH', body: '{not json' }), params({ id: 'iss_1' }));
        expect(bad.status).toBe(400);

        mocks.prisma.issue.findUnique.mockResolvedValueOnce(null);
        expect((await patch('x', { completed: true })).status).toBe(404);

        mocks.getAccessibleLibraryIds.mockResolvedValueOnce([]);
        expect((await patch('iss_1', { completed: true })).status).toBe(403);

        mocks.validateApiKey.mockResolvedValueOnce({ valid: false, user: null });
        expect((await patch('iss_1', { completed: true })).status).toBe(401);
        expect(mocks.prisma.readProgress.upsert).not.toHaveBeenCalled();
    });
});

describe('Komga facade: GET /books (Continue Reading) and /books/ondeck', () => {
    it('read_status=IN_PROGRESS lists the user\'s unfinished books newest-read first, as a page', async () => {
        mocks.prisma.readProgress.findMany.mockResolvedValue([
            { issueId: 'iss_2', currentPage: 7, isCompleted: false, updatedAt: MTIME, issue: issue({ id: 'iss_2', number: '2' }) },
        ]);
        mocks.prisma.readProgress.count.mockResolvedValue(1);
        const res = await getBooks(req('/books?sort=readProgress.readDate,desc&read_status=IN_PROGRESS&page=0&size=20&deleted=false'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.totalElements).toBe(1);
        expect(body.content[0]).toEqual(expect.objectContaining({ id: 'iss_2', seriesId: 'ser_1' }));
        expect(body.content[0].readProgress).toEqual(expect.objectContaining({ page: 7, completed: false }));
        const call = mocks.prisma.readProgress.findMany.mock.calls[0][0];
        expect(call.where).toEqual(expect.objectContaining({ userId: 'user_1', isCompleted: false, currentPage: { gt: 0 } }));
        expect(JSON.stringify(call.where)).toContain('lib_1'); // library grants apply through the issue's series
        expect(call.orderBy).toEqual({ updatedAt: 'desc' });
        expect(call.take).toBe(20);
    });

    it('returns an empty page for any other read_status without querying', async () => {
        const body = await (await getBooks(req('/books?page=0&size=20'))).json();
        expect(body.content).toEqual([]);
        expect(body.totalElements).toBe(0);
        expect(mocks.prisma.readProgress.findMany).not.toHaveBeenCalled();
    });

    it('/books/ondeck offers the next unread book after the last one finished in each recently read series', async () => {
        mocks.prisma.readProgress.findMany.mockImplementation(async (args: any) => {
            if (args.where.isCompleted === true && !args.where.issueId) {
                // Recently finished, newest first: Batman #1.
                return [{ updatedAt: MTIME, issue: { id: 'iss_1', seriesId: 'ser_1' } }];
            }
            // Per-series progress for the user.
            return [{ issueId: 'iss_1', currentPage: 24, isCompleted: true, updatedAt: MTIME }];
        });
        mocks.prisma.series.findUnique.mockResolvedValue({ id: 'ser_1', name: 'Batman', libraryId: 'lib_1' });
        mocks.prisma.issue.findMany.mockResolvedValue([
            issue({ id: 'iss_3', number: '3' }),
            issue({ id: 'iss_1', number: '1' }),
            issue({ id: 'iss_2', number: '2' }),
        ]);

        const body = await (await getOnDeck(req('/books/ondeck?page=0&size=20&deleted=false'))).json();
        expect(body.content.map((b: any) => b.id)).toEqual(['iss_2']);
        expect(body.content[0].seriesId).toBe('ser_1');
        expect(body.content[0].readProgress).toBeNull();
    });

    it('/books/ondeck leaves a started next book to Continue Reading (no tile in both sections)', async () => {
        mocks.prisma.readProgress.findMany.mockImplementation(async (args: any) => {
            if (args.where.isCompleted === true && !args.where.issueId) {
                return [{ updatedAt: MTIME, issue: { id: 'iss_1', seriesId: 'ser_1' } }];
            }
            return [
                { issueId: 'iss_1', currentPage: 24, isCompleted: true, updatedAt: MTIME },
                { issueId: 'iss_2', currentPage: 3, isCompleted: false, updatedAt: MTIME },
            ];
        });
        mocks.prisma.series.findUnique.mockResolvedValue({ id: 'ser_1', name: 'Batman', libraryId: 'lib_1' });
        mocks.prisma.issue.findMany.mockResolvedValue([issue({ id: 'iss_1', number: '1' }), issue({ id: 'iss_2', number: '2' }), issue({ id: 'iss_3', number: '3' })]);

        const body = await (await getOnDeck(req('/books/ondeck'))).json();
        expect(body.content).toEqual([]);
    });

    it('/books/ondeck skips a series that is fully read', async () => {
        mocks.prisma.readProgress.findMany.mockImplementation(async (args: any) => {
            if (args.where.isCompleted === true && !args.where.issueId) {
                return [{ updatedAt: MTIME, issue: { id: 'iss_2', seriesId: 'ser_1' } }];
            }
            return [
                { issueId: 'iss_1', currentPage: 24, isCompleted: true, updatedAt: MTIME },
                { issueId: 'iss_2', currentPage: 24, isCompleted: true, updatedAt: MTIME },
            ];
        });
        mocks.prisma.series.findUnique.mockResolvedValue({ id: 'ser_1', name: 'Batman', libraryId: 'lib_1' });
        mocks.prisma.issue.findMany.mockResolvedValue([issue({ id: 'iss_1', number: '1' }), issue({ id: 'iss_2', number: '2' })]);

        const body = await (await getOnDeck(req('/books/ondeck'))).json();
        expect(body.content).toEqual([]);
    });
});

// #206 round 4 (the Discord poster): with Show On Deck / Show Continue Reading on, Paperback reported
// `JSON Parse error: Unexpected identifier "Not"`. The source's getViewMoreItems builds
// `/series/<section id>` for EVERY section — `/series/new` and `/series/updated` exist, but On Deck
// and Continue Reading become `/series/ondeck` and `/series/continue`, which fell to the series-by-id
// route and its plain-text "Not Found". Now both answer the series behind those books, and every
// error the facade sends is a Komga (Spring) JSON body the source can parse.
describe('Komga facade: View More for On Deck and Continue Reading', () => {
    const seriesRow = (id: string, name: string) => ({
        id, name, year: 2016, publisher: 'DC Comics', folderPath: `/comics/${name}`, libraryId: 'lib_1', isManga: false,
        description: null, status: 'Continuing', genres: null, tags: null, writers: null, artists: null, languageISO: null,
        createdAt: D, updatedAt: D,
    });
    beforeEach(() => {
        // Hydration hands rows back in its own order — the routes re-apply the section's order.
        mocks.prisma.series.findMany.mockResolvedValue([seriesRow('ser_1', 'Batman'), seriesRow('ser_2', 'Nightwing')]);
        mocks.prisma.issue.groupBy.mockResolvedValue([
            { seriesId: 'ser_1', _count: { _all: 3 }, _max: { fileAddedAt: D } },
            { seriesId: 'ser_2', _count: { _all: 2 }, _max: { fileAddedAt: D } },
        ]);
    });

    it('/series/continue lists each series with an unfinished book once, most recently read first', async () => {
        mocks.prisma.readProgress.findMany.mockImplementation(async (args: any) =>
            args.where.isCompleted === false
                ? [{ issue: { seriesId: 'ser_2' } }, { issue: { seriesId: 'ser_1' } }, { issue: { seriesId: 'ser_2' } }]
                : []
        );

        const res = await getSeriesContinue(req('/series/continue?page=0&size=20&deleted=false'));

        expect(res.status).toBe(200);
        const body = JSON.parse(await res.text()); // exactly what the source does
        expect(body.content.map((s: any) => s.id)).toEqual(['ser_2', 'ser_1']);
        expect(body.content[0].metadata.title).toBe('Nightwing (2016)');
        expect(body.totalElements).toBe(2);
        const call = mocks.prisma.readProgress.findMany.mock.calls.map((c: any) => c[0]).find((a: any) => a.where.isCompleted === false);
        expect(call.where).toEqual(expect.objectContaining({ userId: 'user_1', isCompleted: false, currentPage: { gt: 0 } }));
        expect(JSON.stringify(call.where)).toContain('lib_1');
        expect(call.orderBy).toEqual({ updatedAt: 'desc' });
    });

    it('/series/continue pages the distinct series the way View More asks for them', async () => {
        mocks.prisma.readProgress.findMany.mockImplementation(async (args: any) =>
            args.where.isCompleted === false ? [{ issue: { seriesId: 'ser_2' } }, { issue: { seriesId: 'ser_1' } }] : []
        );

        const second = await (await getSeriesContinue(req('/series/continue?page=1&size=1&deleted=false'))).json();
        expect(second.content.map((s: any) => s.id)).toEqual(['ser_1']);
        expect(second.totalElements).toBe(2);
        const past = await (await getSeriesContinue(req('/series/continue?page=2&size=1&deleted=false'))).json();
        expect(past.content).toEqual([]); // the source stops on an empty page
    });

    it('/series/ondeck lists the series behind the On Deck books', async () => {
        mocks.prisma.readProgress.findMany.mockImplementation(async (args: any) => {
            if (args.where.issue?.seriesId) return []; // the SeriesDto read counts
            if (args.where.isCompleted === true && !args.where.issueId) {
                return [{ updatedAt: MTIME, issue: { id: 'iss_1', seriesId: 'ser_1' } }];
            }
            return [{ issueId: 'iss_1', currentPage: 24, isCompleted: true, updatedAt: MTIME }];
        });
        mocks.prisma.series.findUnique.mockResolvedValue({ id: 'ser_1', name: 'Batman', libraryId: 'lib_1' });
        mocks.prisma.issue.findMany.mockResolvedValue([issue({ id: 'iss_1', number: '1' }), issue({ id: 'iss_2', number: '2' })]);

        const res = await getSeriesOnDeck(req('/series/ondeck?page=0&size=20&deleted=false'));

        expect(res.status).toBe(200);
        const body = JSON.parse(await res.text());
        expect(body.content.map((s: any) => s.id)).toEqual(['ser_1']);
        expect(body.content[0].booksCount).toBe(3);
    });

    it('answers an empty page, not an error, when nothing is on deck or in progress', async () => {
        for (const res of [await getSeriesOnDeck(req('/series/ondeck?page=0&size=20')), await getSeriesContinue(req('/series/continue?page=0&size=20'))]) {
            expect(res.status).toBe(200);
            const body = JSON.parse(await res.text());
            expect(body.content).toEqual([]);
        }
    });

    it('asks for the key like every other call', async () => {
        mocks.validateApiKey.mockResolvedValue({ valid: false, user: null });
        const res = await getSeriesContinue(req('/series/continue'));
        expect(res.status).toBe(401);
    });
});

describe('Komga facade: every error is a Komga JSON body', () => {
    const errorBody = async (res: Response, status: number) => {
        expect(res.status).toBe(status);
        expect(res.headers.get('content-type')).toContain('application/json');
        const body = JSON.parse(await res.text()); // never "Unexpected identifier"
        expect(body).toEqual(expect.objectContaining({ status, error: expect.any(String), timestamp: expect.any(String) }));
        return body;
    };

    it('404 and 403 from the book routes', async () => {
        mocks.prisma.issue.findUnique.mockResolvedValueOnce(null);
        expect((await errorBody(await getBookPages(req('/books/nope/pages'), params({ id: 'nope' })), 404)).error).toBe('Not Found');

        mocks.prisma.issue.findUnique.mockResolvedValueOnce(issue());
        mocks.getAccessibleLibraryIds.mockResolvedValueOnce([]);
        expect((await errorBody(await getBookThumb(req('/books/iss_1/thumbnail'), params({ id: 'iss_1' })), 403)).error).toBe('Forbidden');

        expect((await errorBody(await getBookPage(req('/books/iss_1/pages/0'), params({ id: 'iss_1', n: '0' })), 404)).error).toBe('Not Found');
    });

    it('400 from a malformed read-progress PATCH, 401 with the Basic challenge, 500 from a failing handler', async () => {
        mocks.prisma.issue.findUnique.mockResolvedValue(issue());
        const bad = await patchProgress(req('/books/iss_1/read-progress', { method: 'PATCH', body: '{nope', headers: { 'content-type': 'application/json' } }), params({ id: 'iss_1' }));
        expect((await errorBody(bad, 400)).error).toBe('Bad Request');

        mocks.validateApiKey.mockResolvedValueOnce({ valid: false, user: null });
        const denied = await getSeriesBooks(req('/series/ser_1/books'), params({ id: 'ser_1' }));
        expect((await errorBody(denied, 401)).error).toBe('Unauthorized');
        expect(denied.headers.get('www-authenticate')).toContain('Basic realm="Omnibus Komga"');

        mocks.prisma.series.findUnique.mockRejectedValueOnce(new Error('db gone'));
        expect((await errorBody(await getSeriesBooks(req('/series/ser_1/books'), params({ id: 'ser_1' })), 500)).error).toBe('Internal Server Error');
    });

    it('an unknown /komga/api/v1 path answers a JSON 404 for any method, not the HTML not-found page', async () => {
        const get = await catchAllGet(req('/readlists'));
        expect((await errorBody(get, 404)).path).toBe('/api/v1/readlists');
        await errorBody(await catchAllPost(req('/readlists/list', { method: 'POST', body: '{}' })), 404);
    });

    it('a POST that lands on the series/{id} segment is a JSON 405, not an empty body', async () => {
        const res = await postSeriesOne(req('/series/ser_1', { method: 'POST', body: '{}' }));
        expect((await errorBody(res, 405)).error).toBe('Method Not Allowed');
    });
});
