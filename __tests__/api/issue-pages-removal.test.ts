// __tests__/api/issue-pages-removal.test.ts
//
// Issue #189 Phase 1: POST /api/library/issue/pages removes pages from an issue's CBZ via the
// engine and re-anchors everything index-based. These tests pin the contract: entry names are
// re-verified against the engine's CURRENT page list (stale marks → 409, nothing rewritten),
// at least one page must remain, engine-down is a clean 502, and on success the pageCount /
// read-progress / bookmark fixups shift exactly as the removal math demands.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    issueFindUnique: vi.fn(),
    issueUpdate: vi.fn(),
    progressFindMany: vi.fn(),
    progressUpdate: vi.fn(),
    bookmarkFindMany: vi.fn(),
    bookmarkUpdate: vi.fn(),
    bookmarkDeleteMany: vi.fn(),
    transaction: vi.fn(),
    getServerSession: vi.fn(),
    audit: vi.fn(),
    log: vi.fn(),
    fsExistsSync: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        issue: { findUnique: mocks.issueFindUnique, update: mocks.issueUpdate },
        readProgress: { findMany: mocks.progressFindMany, update: mocks.progressUpdate },
        bookmark: { findMany: mocks.bookmarkFindMany, update: mocks.bookmarkUpdate, deleteMany: mocks.bookmarkDeleteMany },
        $transaction: mocks.transaction,
    }
}));
vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/engine', () => ({ ENGINE_URL: 'http://engine:8000', engineHeaders: (h: any = {}) => h }));
vi.mock('fs', () => ({
    existsSync: mocks.fsExistsSync,
    default: { existsSync: mocks.fsExistsSync },
}));

import { POST } from '@/app/api/library/issue/pages/route';
import { auditLog } from '../helpers/setup-global';
import { makePostJson } from '../helpers/request';

const fetchMock = vi.fn();
global.fetch = fetchMock as any;

const PAGES = ['p0.jpg', 'p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg'];

const row = () => ({
    id: 'i1', number: '1', filePath: '/comics/S/S 001.cbz', pageCount: 5,
    series: { name: 'Series' },
});

const req = makePostJson('http://localhost/api/library/issue/pages');

// Engine fetch mock: entries listing + remove call, overridable per test. The engine always
// echoes new_file_path (same path for in-place CBZ rewrites, a sibling .cbz for RAR/7z repacks).
function mockEngine({ pages = PAGES, removeStatus = 200, removeBody = { new_page_count: 3, removed: 2, new_file_path: '/comics/S/S 001.cbz' } as any } = {}) {
    fetchMock.mockImplementation(async (url: string) => {
        if (url.endsWith('/api/reader/entries')) {
            return { ok: true, json: async () => ({ pages }) };
        }
        if (url.endsWith('/api/archive/remove-pages')) {
            return { ok: removeStatus === 200, status: removeStatus, json: async () => removeBody };
        }
        throw new Error('unexpected fetch ' + url);
    });
}

beforeEach(() => {
    mocks.getServerSession.mockResolvedValue({ user: { id: 'admin1', role: 'ADMIN' } });
    mocks.issueFindUnique.mockResolvedValue(row());
    mocks.fsExistsSync.mockReturnValue(true);
    mocks.progressFindMany.mockResolvedValue([]);
    mocks.bookmarkFindMany.mockResolvedValue([]);
    mocks.transaction.mockResolvedValue([]);
    mockEngine();
});

describe('POST /api/library/issue/pages — removal + index fixups (issue #189)', () => {
    it('removes pages via the engine and shifts progress + bookmarks by the removal math', async () => {
        // Removing p1 (idx 1) and p3 (idx 3). Progress: reader at 4 → 2; reader ON removed page 1
        // lands on the next survivor's slot (1); reader at 0 stays but totalPages shrinks.
        mocks.progressFindMany.mockResolvedValue([
            { id: 'pr-a', currentPage: 4, totalPages: 5 },
            { id: 'pr-b', currentPage: 1, totalPages: 5 },
            { id: 'pr-c', currentPage: 0, totalPages: 5 },
        ]);
        // Bookmarks: on a removed page (deleted), at 2 → 1, at 4 → 2, at 0 → untouched.
        mocks.bookmarkFindMany.mockResolvedValue([
            { id: 'bm-removed', pageIndex: 1 },
            { id: 'bm-two', pageIndex: 2 },
            { id: 'bm-four', pageIndex: 4 },
            { id: 'bm-zero', pageIndex: 0 },
        ]);

        const res = await POST(req({ issueId: 'i1', entryNames: ['p1.jpg', 'p3.jpg'] }));
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json).toMatchObject({ success: true, newPageCount: 3, removed: 2 });

        const removeCall = fetchMock.mock.calls.find(([u]: any[]) => u.endsWith('/api/archive/remove-pages'));
        expect(JSON.parse(removeCall![1].body)).toEqual({ file_path: '/comics/S/S 001.cbz', entry_names: ['p1.jpg', 'p3.jpg'] });

        expect(mocks.issueUpdate).toHaveBeenCalledWith({ where: { id: 'i1' }, data: { pageCount: 3 } });
        expect(mocks.progressUpdate).toHaveBeenCalledWith({ where: { id: 'pr-a' }, data: { currentPage: 2, totalPages: 3 } });
        expect(mocks.progressUpdate).toHaveBeenCalledWith({ where: { id: 'pr-b' }, data: { currentPage: 1, totalPages: 3 } });
        expect(mocks.progressUpdate).toHaveBeenCalledWith({ where: { id: 'pr-c' }, data: { currentPage: 0, totalPages: 3 } });
        expect(mocks.bookmarkDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ['bm-removed'] } } });
        expect(mocks.bookmarkUpdate).toHaveBeenCalledWith({ where: { id: 'bm-two' }, data: { pageIndex: 1 } });
        expect(mocks.bookmarkUpdate).toHaveBeenCalledWith({ where: { id: 'bm-four' }, data: { pageIndex: 2 } });
        const touched = mocks.bookmarkUpdate.mock.calls.map(c => c[0].where.id);
        expect(touched).not.toContain('bm-zero');
        expect(mocks.transaction).toHaveBeenCalledTimes(1);
        expect(auditLog).toHaveBeenCalledWith('REMOVE_PAGES',
            expect.objectContaining({ issueId: 'i1', removedCount: 2, newPageCount: 3 }), 'admin1');
    });

    it('updates Issue.filePath when a RAR/7z was repacked as a sibling CBZ (Phase 2)', async () => {
        mocks.issueFindUnique.mockResolvedValue({ ...row(), filePath: '/comics/S/S 001.cbr' });
        mockEngine({ removeBody: { new_page_count: 4, removed: 1, new_file_path: '/comics/S/S 001.cbz' } });

        const res = await POST(req({ issueId: 'i1', entryNames: ['p1.jpg'] }));
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.convertedToCbz).toBe(true);
        expect(mocks.issueUpdate).toHaveBeenCalledWith({
            where: { id: 'i1' },
            data: { pageCount: 4, filePath: '/comics/S/S 001.cbz' },
        });
        expect(auditLog).toHaveBeenCalledWith('REMOVE_PAGES',
            expect.objectContaining({ convertedTo: '/comics/S/S 001.cbz' }), 'admin1');
    });

    it('does not touch filePath on an in-place CBZ rewrite', async () => {
        const res = await POST(req({ issueId: 'i1', entryNames: ['p1.jpg', 'p3.jpg'] }));
        const json = await res.json();

        expect(json.convertedToCbz).toBe(false);
        expect(mocks.issueUpdate).toHaveBeenCalledWith({ where: { id: 'i1' }, data: { pageCount: 3 } });
    });

    it('refuses stale entry names with a 409 and never calls the rewrite', async () => {
        const res = await POST(req({ issueId: 'i1', entryNames: ['p1.jpg', 'ghost.jpg'] }));

        expect(res.status).toBe(409);
        expect(fetchMock.mock.calls.some(([u]: any[]) => u.endsWith('/api/archive/remove-pages'))).toBe(false);
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('refuses removing every page (at least one must remain)', async () => {
        const res = await POST(req({ issueId: 'i1', entryNames: PAGES }));

        expect(res.status).toBe(400);
        expect(fetchMock.mock.calls.some(([u]: any[]) => u.endsWith('/api/archive/remove-pages'))).toBe(false);
    });

    it('returns 502 when the engine is unreachable', async () => {
        fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
        const res = await POST(req({ issueId: 'i1', entryNames: ['p1.jpg'] }));

        expect(res.status).toBe(502);
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it("passes the engine's actionable refusal message through as a 422", async () => {
        mockEngine({ removeStatus: 422, removeBody: { error: 'Only CBZ archives can be rewritten in place. Convert this file to CBZ first.' } as any });
        const res = await POST(req({ issueId: 'i1', entryNames: ['p1.jpg'] }));
        const json = await res.json();

        expect(res.status).toBe(422);
        expect(json.error).toMatch(/CBZ/);
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('is admin-only', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', role: 'USER' } });
        const res = await POST(req({ issueId: 'i1', entryNames: ['p1.jpg'] }));
        expect(res.status).toBe(403);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('404s when the issue has no file on disk', async () => {
        mocks.fsExistsSync.mockReturnValue(false);
        const res = await POST(req({ issueId: 'i1', entryNames: ['p1.jpg'] }));
        expect(res.status).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
