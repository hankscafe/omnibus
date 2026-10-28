// __tests__/api/opds-series.test.ts
//
// The OPDS series feed is what Panels/Chunky read to decide whether an issue is streamable: the
// pse:count attribute comes from Issue.pageCount in the DB. These tests pin the regression where
// scanned issues (persisted with pageCount 0) rendered as "0 pages" and unreadable — the feed must
// self-heal a zero count from the archive and write it back.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/opds/series/[id]/route';

const mocks = vi.hoisted(() => ({
    validateApiKey: vi.fn(),
    findUniqueSeries: vi.fn(),
    updateIssue: vi.fn(),
    readProgress: vi.fn().mockResolvedValue([]),
    countArchivePages: vi.fn(),
    countArchivePagesViaEngine: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findUnique: mocks.findUniqueSeries },
        issue: { update: mocks.updateIssue },
        readProgress: { findMany: mocks.readProgress },
    }
}));
vi.mock('@/lib/library-access', () => ({
    getAccessibleLibraryIds: vi.fn().mockResolvedValue(null), // null = admin/full access
    canAccessLibraryId: vi.fn().mockReturnValue(true),
}));
vi.mock('@/lib/utils/archive-pages', () => ({
    countArchivePages: mocks.countArchivePages,
    countArchivePagesViaEngine: mocks.countArchivePagesViaEngine,
    isPageCountable: (p: string | null | undefined) => !!p && /\.(cbz|zip|epub)$/i.test(p),
    isEngineCountable: (p: string | null | undefined) => !!p && /\.(cbr|rar)$/i.test(p),
}));

const createReq = () => new Request('http://localhost/api/opds/series/ser_1');
const createParams = () => Promise.resolve({ id: 'ser_1' });

const baseSeries = (issues: any[]) => ({
    id: 'ser_1',
    name: 'Batman',
    publisher: 'DC Comics',
    folderPath: '/comics/DC Comics/Batman (2016)',
    libraryId: 'lib_1',
    issues,
});

describe('API Route: OPDS Series Feed (/api/opds/series/[id])', () => {
    beforeEach(() => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'u1', role: 'ADMIN' } } as any);
        mocks.updateIssue.mockResolvedValue({});
        mocks.readProgress.mockResolvedValue([]);
    });

    it('advertises the persisted pageCount as pse:count without touching the archive', async () => {
        mocks.findUniqueSeries.mockResolvedValue(baseSeries([
            { id: 'iss_1', number: '1', name: 'Issue 1', filePath: '/comics/batman 01.cbz', pageCount: 22, coverUrl: null, description: null },
        ]));

        const res = await GET(createReq(), { params: createParams() }) as Response;
        const xml = await res.text();

        expect(res.status).toBe(200);
        expect(xml).toContain('pse:count="22"');
        expect(mocks.countArchivePages).not.toHaveBeenCalled();
        expect(mocks.updateIssue).not.toHaveBeenCalled();
    });

    it('self-heals a zero pageCount from the archive and persists it (Panels "0 pages" regression)', async () => {
        mocks.findUniqueSeries.mockResolvedValue(baseSeries([
            { id: 'iss_1', number: '1', name: 'Issue 1', filePath: '/comics/batman 01.cbz', pageCount: 0, coverUrl: null, description: null },
        ]));
        mocks.countArchivePages.mockResolvedValue(30);

        const res = await GET(createReq(), { params: createParams() }) as Response;
        const xml = await res.text();

        expect(xml).toContain('pse:count="30"');
        expect(xml).not.toContain('pse:count="0"');
        expect(mocks.countArchivePages).toHaveBeenCalledWith('/comics/batman 01.cbz');
        // Healed count is written back so the archive is only ever read once.
        expect(mocks.updateIssue).toHaveBeenCalledWith({ where: { id: 'iss_1' }, data: { pageCount: 30 } });
    });

    it('self-heals a RAR pageCount through the engine and persists it (native CBR reading)', async () => {
        mocks.findUniqueSeries.mockResolvedValue(baseSeries([
            { id: 'iss_2', number: '2', name: 'Issue 2', filePath: '/comics/batman 02.cbr', pageCount: 0, coverUrl: null, description: null },
        ]));
        mocks.countArchivePagesViaEngine.mockResolvedValue(24);

        const res = await GET(createReq(), { params: createParams() }) as Response;
        const xml = await res.text();

        expect(xml).toContain('pse:count="24"');
        expect(mocks.countArchivePagesViaEngine).toHaveBeenCalledWith('/comics/batman 02.cbr');
        expect(mocks.countArchivePages).not.toHaveBeenCalled(); // RAR never goes to the zip counter
        expect(mocks.updateIssue).toHaveBeenCalledWith({ where: { id: 'iss_2' }, data: { pageCount: 24 } });
    });

    it('leaves a RAR at 0 without a DB write when the engine cannot count it', async () => {
        mocks.findUniqueSeries.mockResolvedValue(baseSeries([
            { id: 'iss_2', number: '2', name: 'Issue 2', filePath: '/comics/batman 02.cbr', pageCount: 0, coverUrl: null, description: null },
        ]));
        mocks.countArchivePagesViaEngine.mockResolvedValue(0); // engine down / unreadable archive

        const res = await GET(createReq(), { params: createParams() }) as Response;
        const xml = await res.text();

        // No count means no page stream at all: `pse:count="0"` is a stream a client cannot render.
        // The acquisition link still stands.
        expect(xml).not.toContain('pse:count');
        expect(xml).toContain('rel="http://opds-spec.org/acquisition"');
        expect(mocks.updateIssue).not.toHaveBeenCalled();
    });

    // #203 Phase 0: annuals shelve AFTER the main run (Panels reads the feed order), and a
    // nameless annual entry composes its domain into the title instead of masquerading as #1.
    it('orders annuals after the main run and titles them "Series Annual #N"', async () => {
        mocks.findUniqueSeries.mockResolvedValue(baseSeries([
            { id: 'iss_a1', number: '1', isAnnual: true, name: null, filePath: '/comics/batman annual 01.cbz', pageCount: 30, coverUrl: null, description: null },
            { id: 'iss_2', number: '2', isAnnual: false, name: null, filePath: '/comics/batman 02.cbz', pageCount: 20, coverUrl: null, description: null },
            { id: 'iss_1', number: '1', isAnnual: false, name: null, filePath: '/comics/batman 01.cbz', pageCount: 22, coverUrl: null, description: null },
        ]));

        const res = await GET(createReq(), { params: createParams() }) as Response;
        const xml = await res.text();

        expect(xml).toContain('<title>Batman Annual #1</title>');
        const posRun1 = xml.indexOf('<title>Batman #1</title>');
        const posRun2 = xml.indexOf('<title>Batman #2</title>');
        const posAnnual = xml.indexOf('<title>Batman Annual #1</title>');
        expect(posRun1).toBeGreaterThan(-1);
        expect(posRun1).toBeLessThan(posRun2);
        expect(posRun2).toBeLessThan(posAnnual);
    });

    // #255: a Special shelves after the run AND the annuals, titled after its own volume.
    it('orders a Special after the annuals, titled after its own volume', async () => {
        mocks.findUniqueSeries.mockResolvedValue(baseSeries([
            { id: 'iss_s1', number: '1', isAnnual: false, attachedVolume: { name: 'Batman: Year 100', kind: 'SPECIAL' }, name: null, filePath: '/comics/batman year 100 01.cbz', pageCount: 48, coverUrl: null, description: null },
            { id: 'iss_a1', number: '1', isAnnual: true, name: null, filePath: '/comics/batman annual 01.cbz', pageCount: 30, coverUrl: null, description: null },
            { id: 'iss_1', number: '1', isAnnual: false, name: null, filePath: '/comics/batman 01.cbz', pageCount: 22, coverUrl: null, description: null },
        ]));

        const xml = await (await GET(createReq(), { params: createParams() }) as Response).text();

        const posRun1 = xml.indexOf('<title>Batman #1</title>');
        const posAnnual = xml.indexOf('<title>Batman Annual #1</title>');
        const posSpecial = xml.indexOf('<title>Batman: Year 100 #1</title>');
        expect(posRun1).toBeGreaterThan(-1);
        expect(posRun1).toBeLessThan(posAnnual);
        expect(posAnnual).toBeLessThan(posSpecial);
    });
});

// #218: entry metadata — creators as separate <author> elements, the publisher in <dc:publisher>,
// <updated> from the rows, and a response Content-Type that carries the OPDS kind. #221 point 4: every
// publication entry carries an acquisition link whatever the caller's permissions, typed with the
// file's real media type.
describe('API Route: OPDS Series Feed — entry conformance', () => {
    const ISSUE_UPDATED = new Date('2026-09-20T10:00:00.000Z');
    const LATER_UPDATED = new Date('2026-09-22T00:00:00.000Z');
    const SERIES_UPDATED = new Date('2026-09-25T08:30:00.000Z');

    const issue = (overrides: Record<string, unknown> = {}) => ({
        id: 'iss_1', number: '1', name: null, filePath: '/comics/batman 01.cbz',
        pageCount: 22, coverUrl: null, description: null, updatedAt: ISSUE_UPDATED, ...overrides,
    });

    const series = (overrides: Record<string, unknown> = {}) => ({
        id: 'ser_1', name: 'Batman', publisher: 'DC Comics',
        folderPath: '/comics/DC Comics/Batman (2016)', libraryId: 'lib_1',
        updatedAt: SERIES_UPDATED, writers: '["Tom King"]', artists: '["Mikel Janín"]',
        issues: [], ...overrides,
    });

    const feedFor = async (user: Record<string, unknown>, overrides: Record<string, unknown>) => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user });
        mocks.findUniqueSeries.mockResolvedValue(series(overrides));
        const res = await GET(createReq(), { params: createParams() }) as Response;
        return { res, xml: await res.text() };
    };

    it('writes each creator as its own <author> and the publisher as <dc:publisher>', async () => {
        const { xml } = await feedFor({ id: 'u1', role: 'USER', canDownload: true }, {
            issues: [issue({ writers: '["Scott Snyder"]', artists: '["Greg Capullo"]' })],
        });

        expect(xml).toContain('<author><name>Scott Snyder</name></author>');
        expect(xml).toContain('<author><name>Greg Capullo</name></author>');
        expect(xml).toContain('<dc:publisher>DC Comics</dc:publisher>');
        // The publisher is no longer published as the author (#218).
        expect(xml).not.toContain('<author><name>DC Comics</name></author>');
    });

    it('falls back per field to the series creators, and emits no <author> when neither has one', async () => {
        const fallback = await feedFor({ id: 'u1', role: 'ADMIN' }, {
            issues: [issue({ writers: null, artists: null })],
        });
        expect(fallback.xml).toContain('<author><name>Tom King</name></author>');
        expect(fallback.xml).toContain('<author><name>Mikel Janín</name></author>');

        const bare = await feedFor({ id: 'u1', role: 'ADMIN' }, {
            writers: null, artists: null, issues: [issue()],
        });
        // No entry-level <author> — only the feed's own, which keeps the document valid Atom.
        const entry = bare.xml.slice(bare.xml.indexOf('<entry>'), bare.xml.indexOf('</entry>'));
        expect(entry).not.toContain('<author>');
        expect(bare.xml).toContain('<author><name>Omnibus</name></author>');
    });

    // A credit refresh that finds nothing writes `JSON.stringify([])` rather than null, so an empty
    // list has to count as absent too — otherwise the entry carries no <author> although the series
    // has writers.
    it('falls back to the series creators when the issue\'s own credits are an empty list', async () => {
        const { xml } = await feedFor({ id: 'u1', role: 'ADMIN' }, {
            issues: [issue({ writers: '[]', artists: '[]' })],
        });

        expect(xml).toContain('<author><name>Tom King</name></author>');
        expect(xml).toContain('<author><name>Mikel Janín</name></author>');
    });

    it('titles an issue "Series #N - Title", reducing to "Series #N" when the title adds nothing', async () => {
        const { xml } = await feedFor({ id: 'u1', role: 'ADMIN' }, {
            issues: [
                issue({ id: 'iss_1', number: '1', name: 'I Am Gotham' }),
                issue({ id: 'iss_2', number: '2', name: 'Batman #2' }),
                issue({ id: 'iss_3', number: '3', name: 'Batman' }),
                issue({ id: 'iss_4', number: '4', name: null }),
            ],
        });

        expect(xml).toContain('<title>Batman #1 - I Am Gotham</title>');
        expect(xml).toContain('<title>Batman #2</title>');
        expect(xml).toContain('<title>Batman #3</title>');
        expect(xml).toContain('<title>Batman #4</title>');
    });

    it('stamps each entry from its updatedAt and the feed from its newest entry', async () => {
        const { xml } = await feedFor({ id: 'u1', role: 'ADMIN' }, {
            issues: [issue({ id: 'iss_1', updatedAt: ISSUE_UPDATED }), issue({ id: 'iss_2', number: '2', updatedAt: LATER_UPDATED })],
        });

        expect(xml).toContain(`<updated>${ISSUE_UPDATED.toISOString()}</updated>`);
        const feedHead = xml.slice(xml.indexOf('<feed'), xml.indexOf('<entry'));
        expect(feedHead).toContain(`<updated>${LATER_UPDATED.toISOString()}</updated>`);
        expect(feedHead).not.toContain('<updated>1970');
    });

    it('is an acquisition feed: the kind is on the response and on the links that point at it', async () => {
        const { res, xml } = await feedFor({ id: 'u1', role: 'ADMIN' }, {});

        expect(res.headers.get('Content-Type'))
            .toBe('application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8');
        expect(xml).toMatch(/<link rel="self" href="[^"]*\/api\/opds\/series\/ser_1" type="application\/atom\+xml;profile=opds-catalog;kind=acquisition"\/>/);
    });

    it('gives every issue an acquisition link typed with the file\'s real media type, whatever the permissions', async () => {
        const { xml } = await feedFor({ id: 'u1', role: 'USER', canDownload: false }, {
            issues: [issue({ id: 'iss_1', filePath: '/comics/batman 01.cbz' }), issue({ id: 'iss_2', number: '2', filePath: '/comics/batman 02.cbr' })],
        });

        // #221 point 4: §5.4 wants an acquisition link on every entry; the download route is where a
        // user without the permission is refused (403), not the feed.
        expect(xml).toMatch(/<link rel="http:\/\/opds-spec\.org\/acquisition" href="[^"]*\/api\/opds\/download\?issueId=iss_1" type="application\/vnd\.comicbook\+zip"\/>/);
        expect(xml).toMatch(/<link rel="http:\/\/opds-spec\.org\/acquisition" href="[^"]*\/api\/opds\/download\?issueId=iss_2" type="application\/vnd\.comicbook-rar"\/>/);
    });

    it('declares the page-stream link as the WebP the page route actually serves', async () => {
        const { xml } = await feedFor({ id: 'u1', role: 'ADMIN' }, { issues: [issue()] });

        expect(xml).toContain('rel="http://vaemendis.net/opds-pse/stream" type="image/webp"');
    });

    // #221 point 3: a page-streaming client resumes where this user stopped. The stored currentPage
    // is the app's 0-based index, so the attribute carries the 1-based page number OPDS-PSE expects.
    it('adds pse:lastRead / pse:lastReadDate from the caller\'s own progress', async () => {
        mocks.readProgress.mockResolvedValue([
            { issueId: 'iss_1', currentPage: 6, updatedAt: new Date('2026-09-27T12:00:00.000Z') },
        ]);

        const { xml } = await feedFor({ id: 'u1', role: 'ADMIN' }, { issues: [issue({ id: 'iss_1' })] });

        expect(xml).toContain('pse:lastRead="7"');
        expect(xml).toContain('pse:lastReadDate="2026-09-27T12:00:00.000Z"');
    });

    it('omits the read attributes for an issue the caller has not started', async () => {
        mocks.readProgress.mockResolvedValue([]);

        const { xml } = await feedFor({ id: 'u1', role: 'ADMIN' }, { issues: [issue()] });

        expect(xml).not.toContain('pse:lastRead');
    });

    // A finished issue stores the page count itself as its position — KOReader's finished sync and the
    // Komga mark-read both write it that way — so `currentPage + 1` would report one page past the end.
    it('reports the last page for a finished issue, never one past it', async () => {
        mocks.readProgress.mockResolvedValue([
            { issueId: 'iss_1', currentPage: 22, isCompleted: true, updatedAt: new Date('2026-09-27T12:00:00.000Z') },
        ]);

        const { xml } = await feedFor({ id: 'u1', role: 'ADMIN' }, { issues: [issue({ id: 'iss_1' })] });

        expect(xml).toContain('pse:count="22"');
        expect(xml).toContain('pse:lastRead="22"');
        expect(xml).not.toContain('pse:lastRead="23"');
    });

    // The count can move under a stored position (a re-scan, a re-numbered archive): the page a client
    // is sent to stays inside the file.
    it('clamps a stale position to the page count', async () => {
        mocks.readProgress.mockResolvedValue([
            { issueId: 'iss_1', currentPage: 40, isCompleted: false, updatedAt: new Date('2026-09-27T12:00:00.000Z') },
        ]);

        const { xml } = await feedFor({ id: 'u1', role: 'ADMIN' }, { issues: [issue({ id: 'iss_1' })] });

        expect(xml).toContain('pse:lastRead="22"');
    });
});
