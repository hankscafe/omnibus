// __tests__/api/komga-opds.test.ts
//
// #262: Panels writes reading progress only to a server it recognises as Komga. It browses over
// OPDS, and when the feed is Komga's (author "Komga", bare book ids) it reports progress through
// Komga's REST API at the server address minus `/opds/v1.2/catalog`, plus `/api/v1` — for a feed at
// <origin>/komga/opds/v1.2/catalog, that is the facade at /komga/api/v1. These routes serve the same
// catalog as /api/opds in Komga's shape: Komga's author and root id, bare series/book ids, Komga's
// download link (books/{id}/file/{filename}, which Panels needs to sync a downloaded book), and
// links that stay under /komga/opds/v1.2. Covers and page streams are shared with /api/opds.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as getCatalog } from '@/app/komga/opds/v1.2/catalog/route';
import { GET as getSeriesList } from '@/app/komga/opds/v1.2/series/route';
import { GET as getSeries } from '@/app/komga/opds/v1.2/series/[id]/route';
import { GET as getSection } from '@/app/komga/opds/v1.2/sections/[name]/route';
import { GET as getSearch } from '@/app/komga/opds/v1.2/search/route';
import { GET as getOpenSearch } from '@/app/komga/opds/v1.2/opensearch/route';
import { GET as getFile } from '@/app/komga/opds/v1.2/books/[id]/file/[filename]/route';
import { stockOpdsPrisma, issueRow } from '../helpers/opds-fixtures';

const mocks = vi.hoisted(() => ({
    validateApiKey: vi.fn(),
    getAccessibleLibraryIds: vi.fn(),
    prisma: {
        series: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), groupBy: vi.fn() },
        library: { count: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
        issue: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
        readProgress: { findMany: vi.fn() },
    },
    inProgressBooks: vi.fn(),
    onDeckBooks: vi.fn(),
    existsSync: vi.fn(),
    sendFileResponse: vi.fn(),
    rememberKoreaderDocument: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock('@/lib/db', () => ({ prisma: mocks.prisma }));
vi.mock('@/lib/library-access', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/library-access')>()),
    getAccessibleLibraryIds: mocks.getAccessibleLibraryIds,
}));
vi.mock('@/lib/komga/data', () => ({ inProgressBooks: mocks.inProgressBooks, onDeckBooks: mocks.onDeckBooks }));
vi.mock('fs', () => {
    const m = { existsSync: mocks.existsSync };
    return { ...m, default: m };
});
vi.mock('@/lib/file-download', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/file-download')>()),
    sendFileResponse: mocks.sendFileResponse,
}));
vi.mock('@/lib/koreader-documents', () => ({ rememberKoreaderDocument: mocks.rememberKoreaderDocument }));

const BASE = 'http://localhost/komga/opds/v1.2';
const READER = { id: 'u1', username: 'reader', role: 'USER', canDownload: true };
const req = (path: string, headers: Record<string, string> = {}) =>
    new Request(`${BASE}${path}`, { headers: { authorization: 'Basic cmVhZGVyOmtleQ==', ...headers } });
const snap = (name: string) => `./__snapshots__/komga-opds/${name}`;

/** Every link back into Omnibus's own feed: only the shared cover and page-stream routes may remain. */
const ownFeedLinks = (xml: string) =>
    [...xml.matchAll(/\/api\/opds\/[^"]*/g)].map((m) => m[0]).filter((href) => !/^\/api\/opds\/(cover|page)\//.test(href));

beforeEach(() => {
    mocks.validateApiKey.mockResolvedValue({ valid: true, user: READER, keyType: 'OPDS_KEY' });
    mocks.getAccessibleLibraryIds.mockResolvedValue('ALL');
    stockOpdsPrisma(mocks.prisma);
    mocks.inProgressBooks.mockResolvedValue({ content: [{ id: 'iss_1' }] });
    mocks.onDeckBooks.mockResolvedValue({ content: [{ id: 'iss_2' }] });
    mocks.prisma.issue.findUnique.mockResolvedValue({ ...issueRow(), series: { libraryId: 'lib_1' } });
    mocks.existsSync.mockReturnValue(true);
    mocks.sendFileResponse.mockResolvedValue(new Response('cbz-bytes', { status: 200 }));
    mocks.rememberKoreaderDocument.mockResolvedValue(undefined);
});

describe('the Komga-flavoured OPDS catalog (#262)', () => {
    it('the catalog presents itself as Komga, with its sections under /komga/opds/v1.2', async () => {
        const xml = await (await getCatalog(req('/catalog'))).text();

        expect(xml).toContain('<id>root</id>');
        expect(xml).toContain('<author><name>Komga</name><uri>https://github.com/gotson/komga</uri></author>');
        expect(xml).not.toContain('<name>Omnibus</name>');
        expect(xml).toContain(`<link rel="self" href="${BASE}/catalog"`);
        expect(xml).toContain(`<link rel="start" href="${BASE}/catalog"`);
        for (const href of ['/series', '/sections/continue', '/sections/recent', '/sections/ondeck', '/sections/libraries', '/opensearch']) {
            expect(xml).toContain(`href="${BASE}${href}"`);
        }
        expect(ownFeedLinks(xml)).toEqual([]);
        await expect(xml).toMatchFileSnapshot(snap('catalog.xml'));
    });

    it('a series feed: bare ids, Komga\'s download link, the shared page stream, the reader\'s progress', async () => {
        const xml = await (await getSeries(req('/series/ser_1'), { params: Promise.resolve({ id: 'ser_1' }) })).text();

        expect(xml).toContain('<id>ser_1</id>');
        for (const id of ['iss_1', 'iss_2', 'iss_a1', 'iss_s1']) expect(xml).toContain(`<id>${id}</id>`);
        expect(xml).not.toContain('urn:omnibus:issue:');
        expect(xml).toContain(`href="${BASE}/books/iss_1/file/Tower%20Dungeon%20v01%20(2025).cbz" type="application/vnd.comicbook+zip"`);
        expect(xml).toContain(`href="${BASE}/books/iss_2/file/Tower%20Dungeon%20v02%20(2025).cbr" type="application/vnd.comicbook-rar"`);
        expect(xml).toContain('href="http://localhost/api/opds/page/iss_1/{pageNumber}" pse:count="156" pse:lastRead="49"');
        expect(xml).toContain(`<link rel="up" href="${BASE}/series"`);
        expect(ownFeedLinks(xml)).toEqual([]);
        await expect(xml).toMatchFileSnapshot(snap('series-ser_1.xml'));
    });

    it('the series list: bare series ids, each leading to its Komga-flavoured feed', async () => {
        const xml = await (await getSeriesList(req('/series?library=lib_1&page=2'))).text();
        expect(xml).toContain('<id>ser_1</id>');
        expect(xml).toContain(`<link rel="subsection" href="${BASE}/series/ser_1"`);
        expect(xml).toContain(`<link rel="self" href="${BASE}/series?page=2&amp;library=lib_1"`);
        expect(xml).toContain(`<link rel="previous" href="${BASE}/series?page=1&amp;library=lib_1"`);
        expect(xml).toContain(`<link rel="up" href="${BASE}/catalog"`);
        expect(ownFeedLinks(xml)).toEqual([]);
    });

    it.each(['continue', 'recent', 'ondeck', 'libraries'])('the %s section stays under /komga/opds/v1.2', async (name) => {
        const xml = await (await getSection(req(`/sections/${name}`), { params: Promise.resolve({ name }) })).text();
        expect(xml).toContain(`<link rel="self" href="${BASE}/sections/${name}"`);
        expect(xml).toContain('<name>Komga</name>');
        expect(xml).not.toContain('urn:omnibus:issue:');
        expect(ownFeedLinks(xml)).toEqual([]);
        if (name === 'libraries') expect(xml).toContain(`href="${BASE}/series?library=lib_1"`);
    });

    it('search and its OpenSearch description point back into the Komga-flavoured feed', async () => {
        const xml = await (await getSearch(req('/search?q=tower'))).text();
        expect(xml).toContain(`<link rel="self" href="${BASE}/search?q=tower"`);
        expect(xml).toContain(`href="${BASE}/opensearch"`);
        expect(xml).toContain('<id>iss_1</id>');
        expect(ownFeedLinks(xml)).toEqual([]);

        const description = await (await getOpenSearch(req('/opensearch'))).text();
        expect(description).toContain(`template="${BASE}/search?q={searchTerms}"`);
    });

    it('asks for credentials like /api/opds: 401 with a Basic challenge without a key', async () => {
        mocks.validateApiKey.mockResolvedValue({ valid: false, user: null });
        const responses = [
            await getCatalog(req('/catalog')),
            await getSeriesList(req('/series')),
            await getSeries(req('/series/ser_1'), { params: Promise.resolve({ id: 'ser_1' }) }),
            await getSection(req('/sections/continue'), { params: Promise.resolve({ name: 'continue' }) }),
            await getSearch(req('/search?q=tower')),
            await getOpenSearch(req('/opensearch')),
            await getFile(req('/books/iss_1/file/x.cbz'), { params: Promise.resolve({ id: 'iss_1', filename: 'x.cbz' }) }),
        ];
        for (const res of responses) {
            expect(res.status).toBe(401);
            expect(res.headers.get('www-authenticate')).toMatch(/^Basic /);
        }
    });

    it('keeps the library grants: a series in a library the reader may not see is refused', async () => {
        mocks.getAccessibleLibraryIds.mockResolvedValue(['lib_2']);
        const res = await getSeries(req('/series/ser_1'), { params: Promise.resolve({ id: 'ser_1' }) });
        expect(res.status).toBe(403);
    });
});

describe('the Komga-shaped download, books/{id}/file/{filename} (#262)', () => {
    const file = (id: string, filename = 'Tower Dungeon v01 (2025).cbz', headers: Record<string, string> = {}) =>
        getFile(req(`/books/${id}/file/${encodeURIComponent(filename)}`, headers), { params: Promise.resolve({ id, filename }) });

    it('streams the issue the id names, through the OPDS download (Range and all)', async () => {
        const res = await file('iss_1', 'Tower Dungeon v01 (2025).cbz', { range: 'bytes=0-99' });

        expect(res.status).toBe(200);
        expect(await res.text()).toBe('cbz-bytes');
        expect(mocks.prisma.issue.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'iss_1' } }));
        const [delegated, filePath] = mocks.sendFileResponse.mock.calls[0];
        expect(filePath).toBe('/data/library/Tower Dungeon/Tower Dungeon v01 (2025).cbz');
        expect((delegated as Request).headers.get('range')).toBe('bytes=0-99');
        expect(mocks.rememberKoreaderDocument).toHaveBeenCalledWith('iss_1', filePath);
    });

    it('the filename is only a label: the id decides which file is served', async () => {
        await file('iss_1', 'anything.cbz');
        expect(mocks.sendFileResponse.mock.calls[0][1]).toBe('/data/library/Tower Dungeon/Tower Dungeon v01 (2025).cbz');
    });

    it('keeps the download permission and the library grants; an unknown book is 404', async () => {
        mocks.validateApiKey.mockResolvedValueOnce({ valid: true, user: { ...READER, canDownload: false }, keyType: 'OPDS_KEY' });
        expect((await file('iss_1')).status).toBe(403);

        mocks.getAccessibleLibraryIds.mockResolvedValueOnce(['lib_2']);
        expect((await file('iss_1')).status).toBe(403);

        mocks.prisma.issue.findUnique.mockResolvedValueOnce(null);
        expect((await file('nope')).status).toBe(404);

        expect(mocks.sendFileResponse).not.toHaveBeenCalled();
    });
});
