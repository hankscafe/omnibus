// __tests__/api/komga-catalog.test.ts
//
// #206 (Paperback): the Komga-compatible facade at /komga/api/v1 — the catalog half. Paperback's
// built-in "Paperback" source (a Komga client) appends /api/v1 to the Server URL and sends HTTP
// Basic on every call; "Try settings" is GET /libraries and the homepage calls /genres,
// /tags/series, /collections, /libraries, /series/new and /series/updated. Every response must
// be JSON the source can parse — the login-page HTML it was getting before is the bug report.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as getLibraries } from '@/app/komga/api/v1/libraries/route';
import { GET as getGenres } from '@/app/komga/api/v1/genres/route';
import { GET as getTags } from '@/app/komga/api/v1/tags/series/route';
import { GET as getCollections } from '@/app/komga/api/v1/collections/route';
import { GET as getSeriesList } from '@/app/komga/api/v1/series/route';
import { GET as getSeriesNew } from '@/app/komga/api/v1/series/new/route';
import { GET as getSeriesUpdated } from '@/app/komga/api/v1/series/updated/route';
import { GET as getSeriesOne } from '@/app/komga/api/v1/series/[id]/route';

const mocks = vi.hoisted(() => ({
    validateApiKey: vi.fn(),
    getAccessibleLibraryIds: vi.fn(),
    prisma: {
        library: { findMany: vi.fn() },
        series: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
        issue: { findMany: vi.fn(), groupBy: vi.fn() },
        readProgress: { findMany: vi.fn() },
        collection: { findMany: vi.fn() },
    },
}));

vi.mock('@/lib/api-auth', () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock('@/lib/db', () => ({ prisma: mocks.prisma }));
// Keep the pure where-fragment helpers real; only the DB-backed grant lookup is stubbed.
vi.mock('@/lib/library-access', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/library-access')>()),
    getAccessibleLibraryIds: mocks.getAccessibleLibraryIds,
}));

const D = new Date('2026-09-01T12:00:00.000Z');
const USER = { id: 'user_1', username: 'adam', role: 'ADMIN' };
const req = (path: string) => new Request(`http://localhost/komga/api/v1${path}`, {
    headers: { authorization: 'Basic YWRhbTpvbW5pLWtleQ==' },
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const series = (over: Record<string, unknown> = {}) => ({
    id: 'ser_1', name: 'Batman', year: 2016, publisher: 'DC Comics', folderPath: '/comics/Batman (2016)',
    libraryId: 'lib_1', isManga: false, description: null, status: 'Continuing', genres: '["Superhero"]',
    tags: null, writers: '["Tom King"]', artists: null, languageISO: null, createdAt: D, updatedAt: D, ...over,
});

describe('Komga facade: authentication', () => {
    beforeEach(() => {
        mocks.getAccessibleLibraryIds.mockResolvedValue('ALL');
        mocks.prisma.library.findMany.mockResolvedValue([]);
    });

    it('answers 401 with a Basic challenge when the key is missing or wrong (the source shows "Invalid credentials")', async () => {
        mocks.validateApiKey.mockResolvedValue({ valid: false, user: null });
        const res = await getLibraries(req('/libraries'));
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toContain('Basic realm="Omnibus Komga"');
    });

    it('rejects a key that names no user (legacy admin key) — progress needs a person', async () => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: null, keyType: 'LEGACY_ADMIN' });
        const res = await getLibraries(req('/libraries'));
        expect(res.status).toBe(401);
    });
});

describe('Komga facade: GET /libraries ("Try settings")', () => {
    beforeEach(() => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: USER, keyType: 'ADMIN_KEY' });
        mocks.prisma.library.findMany.mockResolvedValue([
            { id: 'lib_1', name: 'Comics', path: '/comics' },
            { id: 'lib_2', name: 'Manga', path: '/manga' },
        ]);
    });

    it('returns a JSON array of LibraryDto for an admin (every library)', async () => {
        mocks.getAccessibleLibraryIds.mockResolvedValue('ALL');
        const res = await getLibraries(req('/libraries'));

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
        const body = await res.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body.map((l: any) => [l.id, l.name, l.root])).toEqual([['lib_1', 'Comics', '/comics'], ['lib_2', 'Manga', '/manga']]);
        const where = mocks.prisma.library.findMany.mock.calls[0][0]?.where ?? {};
        expect(where.id).toBeUndefined();
    });

    it('limits a regular user to the libraries they were granted', async () => {
        mocks.getAccessibleLibraryIds.mockResolvedValue(['lib_2']);
        await getLibraries(req('/libraries'));
        const where = mocks.prisma.library.findMany.mock.calls[0][0].where;
        expect(where).toEqual({ id: { in: ['lib_2'] } });
    });
});

describe('Komga facade: homepage tag sources', () => {
    beforeEach(() => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: USER, keyType: 'ADMIN_KEY' });
        mocks.getAccessibleLibraryIds.mockResolvedValue('ALL');
    });

    it('GET /genres → the distinct, sorted genres of the series with files', async () => {
        mocks.prisma.series.findMany.mockResolvedValue([
            { genres: '["Superhero","Crime"]' }, { genres: '["Crime"]' }, { genres: null }, { genres: 'garbage' },
        ]);
        const res = await getGenres(req('/genres'));
        expect(await res.json()).toEqual(['Crime', 'Superhero']);
        const where = mocks.prisma.series.findMany.mock.calls[0][0].where;
        expect(JSON.stringify(where)).toContain('"filePath":{"not":null}');
    });

    it('GET /tags/series → the distinct, sorted series tags', async () => {
        mocks.prisma.series.findMany.mockResolvedValue([{ tags: '["Event"]' }, { tags: '["Event","Rebirth"]' }]);
        const res = await getTags(req('/tags/series'));
        expect(await res.json()).toEqual(['Event', 'Rebirth']);
    });

    it('GET /collections → a page of the user\'s own collections', async () => {
        mocks.prisma.collection.findMany.mockResolvedValue([{ id: 'col_1', name: 'Bat-family', createdAt: D, updatedAt: D }]);
        const res = await getCollections(req('/collections'));
        const body = await res.json();
        expect(body.content).toEqual([expect.objectContaining({ id: 'col_1', name: 'Bat-family' })]);
        expect(body.totalElements).toBe(1);
        expect(mocks.prisma.collection.findMany.mock.calls[0][0].where).toEqual({ userId: 'user_1' });
    });
});

describe('Komga facade: GET /series (search + browse)', () => {
    beforeEach(() => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: USER, keyType: 'ADMIN_KEY' });
        mocks.getAccessibleLibraryIds.mockResolvedValue('ALL');
        mocks.prisma.series.findMany.mockResolvedValue([series()]);
        mocks.prisma.series.count.mockResolvedValue(1);
        mocks.prisma.issue.groupBy.mockResolvedValue([{ seriesId: 'ser_1', _count: { _all: 3 } }]);
        mocks.prisma.readProgress.findMany.mockResolvedValue([
            { isCompleted: true, currentPage: 20, issue: { seriesId: 'ser_1' } },
            { isCompleted: false, currentPage: 5, issue: { seriesId: 'ser_1' } },
        ]);
    });

    it('returns a Page of SeriesDto with per-user counts, only series that have files, title order by default', async () => {
        const res = await getSeriesList(req('/series?page=0&size=40&sort=titleSort'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.totalElements).toBe(1);
        expect(body.number).toBe(0);
        expect(body.size).toBe(40);
        expect(body.content).toHaveLength(1);
        const dto = body.content[0];
        expect(dto.id).toBe('ser_1');
        expect(dto.metadata.title).toBe('Batman (2016)');
        expect(dto.metadata.genres).toEqual(['Superhero']);
        expect(dto.metadata.language).toBe('en');
        expect(dto.booksCount).toBe(3);
        expect(dto.booksReadCount).toBe(1);
        expect(dto.booksInProgressCount).toBe(1);
        expect(dto.booksUnreadCount).toBe(1);

        const call = mocks.prisma.series.findMany.mock.calls[0][0];
        expect(JSON.stringify(call.where)).toContain('"filePath":{"not":null}');
        expect(call.orderBy[0]).toEqual({ name: 'asc' });
        expect(call.skip).toBe(0);
        expect(call.take).toBe(40);
        // The progress scan is scoped to this user and this page's series.
        const progressWhere = mocks.prisma.readProgress.findMany.mock.calls[0][0].where;
        expect(progressWhere.userId).toBe('user_1');
        expect(JSON.stringify(progressWhere)).toContain('ser_1');
    });

    it('applies search, library, genre, tag and collection filters and the lastModified sort', async () => {
        await getSeriesList(req('/series?page=1&size=40&search=bat&tag=Event&genre=Superhero&collection_id=col_1&library_id=lib_2&sort=lastModified,desc'));

        const call = mocks.prisma.series.findMany.mock.calls[0][0];
        const where = JSON.stringify(call.where);
        expect(where).toContain('"contains":"bat"');
        expect(where).toContain('lib_2');
        expect(where).toContain('Superhero');
        expect(where).toContain('Event');
        expect(where).toContain('col_1');
        expect(call.orderBy[0]).toEqual({ updatedAt: 'desc' });
        expect(call.skip).toBe(40);
        expect(call.take).toBe(40);
        // count() sees the same filter so totalPages is honest.
        expect(JSON.stringify(mocks.prisma.series.count.mock.calls[0][0].where)).toBe(where);
    });

    it('scopes a regular user to granted libraries even when the request names another', async () => {
        mocks.getAccessibleLibraryIds.mockResolvedValue(['lib_1']);
        await getSeriesList(req('/series?library_id=lib_9'));
        const where = JSON.stringify(mocks.prisma.series.findMany.mock.calls[0][0].where);
        expect(where).toContain('lib_1');
        expect(where).toContain('lib_9'); // both constraints stand (AND), neither overwrites the other
    });

    it('GET /series/new forces newest-created first; GET /series/updated newest-modified first', async () => {
        await getSeriesNew(req('/series/new?page=0&size=20&deleted=false'));
        expect(mocks.prisma.series.findMany.mock.calls[0][0].orderBy[0]).toEqual({ createdAt: 'desc' });

        await getSeriesUpdated(req('/series/updated?page=0&size=20&deleted=false'));
        expect(mocks.prisma.series.findMany.mock.calls[1][0].orderBy[0]).toEqual({ updatedAt: 'desc' });
        const body = await (await getSeriesUpdated(req('/series/updated'))).json();
        expect(body.content[0].metadata.lastModified).toBe(D.toISOString()); // filterUpdatedManga compares this
    });
});

describe('Komga facade: GET /series/{id}', () => {
    beforeEach(() => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: USER, keyType: 'ADMIN_KEY' });
        mocks.getAccessibleLibraryIds.mockResolvedValue('ALL');
        mocks.prisma.issue.groupBy.mockResolvedValue([{ seriesId: 'ser_1', _count: { _all: 2 } }]);
        mocks.prisma.readProgress.findMany.mockResolvedValue([]);
        mocks.prisma.issue.findMany.mockResolvedValue([]);
    });

    it('404s an unknown series', async () => {
        mocks.prisma.series.findUnique.mockResolvedValue(null);
        const res = await getSeriesOne(req('/series/nope'), params('nope'));
        expect(res.status).toBe(404);
    });

    it('403s a series in a library the user was not granted', async () => {
        mocks.getAccessibleLibraryIds.mockResolvedValue(['lib_other']);
        mocks.prisma.series.findUnique.mockResolvedValue(series());
        const res = await getSeriesOne(req('/series/ser_1'), params('ser_1'));
        expect(res.status).toBe(403);
    });

    it('returns the SeriesDto with authors from the series credit columns', async () => {
        mocks.prisma.series.findUnique.mockResolvedValue(series({ artists: '["David Finch"]' }));
        const res = await getSeriesOne(req('/series/ser_1'), params('ser_1'));
        const dto = await res.json();
        expect(dto.id).toBe('ser_1');
        expect(dto.booksCount).toBe(2);
        expect(dto.booksMetadata.authors).toEqual([
            { name: 'Tom King', role: 'writer' },
            { name: 'David Finch', role: 'penciller' },
        ]);
        expect(dto.metadata.readingDirection).toBe('LEFT_TO_RIGHT');
        expect(mocks.prisma.issue.findMany).not.toHaveBeenCalled(); // no per-issue credit scan needed
    });

    it('falls back to the issues\' credits when the series columns are empty', async () => {
        mocks.prisma.series.findUnique.mockResolvedValue(series({ writers: null, artists: null }));
        mocks.prisma.issue.findMany.mockResolvedValue([
            { writers: '["Scott Snyder"]', artists: '["Greg Capullo"]' },
            { writers: '["Scott Snyder"]', artists: null },
        ]);
        const res = await getSeriesOne(req('/series/ser_1'), params('ser_1'));
        const dto = await res.json();
        expect(dto.booksMetadata.authors).toEqual([
            { name: 'Scott Snyder', role: 'writer' },
            { name: 'Greg Capullo', role: 'penciller' },
        ]);
        const where = mocks.prisma.issue.findMany.mock.calls[0][0].where;
        expect(where.seriesId).toBe('ser_1');
    });
});
