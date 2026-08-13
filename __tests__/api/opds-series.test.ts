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
    countArchivePages: vi.fn(),
    countArchivePagesViaEngine: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findUnique: mocks.findUniqueSeries },
        issue: { update: mocks.updateIssue },
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

        expect(xml).toContain('pse:count="0"');
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
});
