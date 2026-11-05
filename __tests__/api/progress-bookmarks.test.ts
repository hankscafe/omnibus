// The reader's page bookmarks: GET lists the caller's bookmarks for a file, POST adds one, DELETE
// removes one. Always the signed-in user's own rows - the body never names a user. The reader
// called /api/progress/bookmark (singular) from v1.0.7-beta.004 until v1.4.11-beta.011, so these
// routes went unused and untested until then.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, POST, DELETE } from '@/app/api/progress/bookmarks/route';
import { makePostJson } from '../helpers/request';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    findManyIssues: vi.fn(),
    findManyBookmarks: vi.fn(),
    upsertBookmark: vi.fn(),
    deleteManyBookmarks: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/db', () => ({
    prisma: {
        issue: { findMany: mocks.findManyIssues },
        bookmark: { findMany: mocks.findManyBookmarks, upsert: mocks.upsertBookmark, deleteMany: mocks.deleteManyBookmarks },
    },
}));

const URL_ = 'http://localhost/api/progress/bookmarks';
const FILE = '/comics/Crisis/Crisis 001.cbz';
const post = makePostJson(URL_);
const del = (body: object) => new Request(URL_, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('API: /api/progress/bookmarks', () => {
    beforeEach(() => {
        Object.values(mocks).forEach(m => m.mockReset());
        mocks.getServerSession.mockResolvedValue({ user: { id: 'u1' } });
        // The name prefilter can bring in a namesake from another folder; only the exact path counts.
        mocks.findManyIssues.mockResolvedValue([
            { id: 'other', filePath: '/comics/Elsewhere/Crisis 001.cbz' },
            { id: 'i1', filePath: FILE },
        ]);
    });

    it("GET lists the caller's bookmarks for the file, in page order", async () => {
        mocks.findManyBookmarks.mockResolvedValue([{ pageIndex: 3 }, { pageIndex: 9 }]);

        const res = await GET(new Request(`${URL_}?path=${encodeURIComponent(FILE)}`));

        expect(await res.json()).toEqual({ bookmarks: [{ pageIndex: 3 }, { pageIndex: 9 }] });
        expect(mocks.findManyBookmarks).toHaveBeenCalledWith({ where: { userId: 'u1', issueId: 'i1' }, orderBy: { pageIndex: 'asc' } });
    });

    it('GET matches the file whatever its slashes and letter case', async () => {
        mocks.findManyBookmarks.mockResolvedValue([]);
        await GET(new Request(`${URL_}?path=${encodeURIComponent('\\COMICS\\Crisis\\crisis 001.CBZ')}`));
        expect(mocks.findManyBookmarks).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1', issueId: 'i1' } }));
    });

    it('GET answers an empty list when signed out, without a path, or for a file that is not in the library', async () => {
        mocks.getServerSession.mockResolvedValueOnce(null);
        expect(await (await GET(new Request(`${URL_}?path=${encodeURIComponent(FILE)}`))).json()).toEqual({ bookmarks: [] });
        expect(await (await GET(new Request(URL_))).json()).toEqual({ bookmarks: [] });
        expect(await (await GET(new Request(`${URL_}?path=${encodeURIComponent('/comics/Nope.cbz')}`))).json()).toEqual({ bookmarks: [] });
        expect(mocks.findManyBookmarks).not.toHaveBeenCalled();
    });

    it("POST adds a bookmark on the page for the signed-in user (never one the body names)", async () => {
        mocks.upsertBookmark.mockResolvedValue({ id: 'b1' });

        const res = await POST(post({ filePath: FILE, pageIndex: '4', userId: 'someone-else' }));

        expect(res.status).toBe(200);
        expect(mocks.upsertBookmark).toHaveBeenCalledWith({
            where: { userId_issueId_pageIndex: { userId: 'u1', issueId: 'i1', pageIndex: 4 } },
            update: { note: undefined },
            create: { userId: 'u1', issueId: 'i1', pageIndex: 4, note: undefined },
        });
    });

    it('POST turns away a signed-out caller, a missing page, and a file that is not in the library', async () => {
        mocks.getServerSession.mockResolvedValueOnce(null);
        expect((await POST(post({ filePath: FILE, pageIndex: 0 }))).status).toBe(401);
        expect((await POST(post({ filePath: FILE }))).status).toBe(400);
        expect((await POST(post({ filePath: '/comics/Nope.cbz', pageIndex: 0 }))).status).toBe(404);
        expect(mocks.upsertBookmark).not.toHaveBeenCalled();
    });

    it("DELETE removes that page's bookmark, the caller's only", async () => {
        mocks.deleteManyBookmarks.mockResolvedValue({ count: 1 });

        const res = await DELETE(del({ filePath: FILE, pageIndex: 0 }));

        expect(res.status).toBe(200);
        expect(mocks.deleteManyBookmarks).toHaveBeenCalledWith({ where: { userId: 'u1', issueId: 'i1', pageIndex: 0 } });
    });

    it('DELETE turns away a signed-out caller', async () => {
        mocks.getServerSession.mockResolvedValueOnce(null);
        expect((await DELETE(del({ filePath: FILE, pageIndex: 0 }))).status).toBe(401);
        expect(mocks.deleteManyBookmarks).not.toHaveBeenCalled();
    });
});
