import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/opds/page/[issueId]/[pageIndex]/route';

const mocks = vi.hoisted(() => ({
    validateApiKey: vi.fn(),
    issueFindUnique: vi.fn(),
    fsExistsSync: vi.fn(),
    fetch: vi.fn(),
    zipGetEntries: vi.fn(),
    log: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ validateApiKey: mocks.validateApiKey }));

vi.mock('@/lib/db', () => ({
    prisma: { issue: { findUnique: mocks.issueFindUnique } }
}));

vi.mock('fs', () => ({
    existsSync: mocks.fsExistsSync,
    default: { existsSync: mocks.fsExistsSync }
}));

// Admin session → 'ALL' library access; per-library checks pass.
vi.mock('@/lib/library-access', () => ({
    getAccessibleLibraryIds: vi.fn().mockResolvedValue('ALL'),
    canAccessLibraryId: vi.fn().mockReturnValue(true),
}));

vi.mock('adm-zip', () => {
    return {
        default: class AdmZipMock {
            getEntries() { return mocks.zipGetEntries(); }
        }
    };
});

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

function makeEntry(entryName: string, data = 'raw_page_bytes') {
    return { entryName, isDirectory: false, getData: () => Buffer.from(data) };
}

function request(issueId = 'issue_1', pageIndex = '0') {
    const req = new Request(`http://localhost/api/opds/page/${issueId}/${pageIndex}`);
    return GET(req, { params: Promise.resolve({ issueId, pageIndex }) });
}

describe('API Route: OPDS-PSE page serving', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'user_1', role: 'ADMIN' } });
        mocks.issueFindUnique.mockResolvedValue({
            id: 'issue_1',
            filePath: '/data/comics/Batman/Batman 001.cbz',
            series: { libraryId: 'lib_1' },
        });
        mocks.fsExistsSync.mockReturnValue(true);
        vi.stubGlobal('fetch', mocks.fetch);
        // Default: engine offload unavailable → the route falls back to local AdmZip extraction.
        mocks.fetch.mockRejectedValue(new Error('engine unavailable'));
        mocks.zipGetEntries.mockReturnValue([
            makeEntry('page10.jpg', 'ten'),
            makeEntry('ComicInfo.xml'),
            makeEntry('page2.jpg', 'two'),
        ]);
    });

    it('rejects requests without a valid API key', async () => {
        mocks.validateApiKey.mockResolvedValue({ valid: false });
        const res = await request();
        expect(res.status).toBe(401);
    });

    it('serves engine-produced webp bytes without touching the local zip path', async () => {
        const engineBytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;
        mocks.fetch.mockResolvedValue({ ok: true, arrayBuffer: async () => engineBytes });

        const res = await request('issue_1', '1');

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/webp');
        // Index mode: the engine gets the page index, not an entry name.
        const body = JSON.parse(mocks.fetch.mock.calls[0][1].body);
        expect(body).toMatchObject({ path: '/data/comics/Batman/Batman 001.cbz', index: 1 });
        expect(body.entry).toBeUndefined();
        // Offloaded → the local AdmZip path is never reached.
        expect(mocks.zipGetEntries).not.toHaveBeenCalled();
    });

    it('falls back to local extraction with the natural-sorted index when the engine is down', async () => {
        const res = await request('issue_1', '0');

        expect(res.status).toBe(200);
        // Natural sort puts page2 before page10, ComicInfo.xml is filtered → index 0 = page2.jpg.
        expect(res.headers.get('content-type')).toBe('image/jpeg');
        expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('two');
    });

    it('returns 404 for an out-of-bounds page index (engine down → local bounds check)', async () => {
        const res = await request('issue_1', '5');
        expect(res.status).toBe(404);
    });

    it('returns 404 for a non-numeric page index without calling the engine', async () => {
        const res = await request('issue_1', 'abc');
        expect(res.status).toBe(404);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });
});
