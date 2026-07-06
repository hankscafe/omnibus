import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/library/archive-preview/route';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getToken: vi.fn(),
    libraryFindMany: vi.fn(),
    fsExistsSync: vi.fn(),
    fsStatSync: vi.fn(),
    fsReaddirSync: vi.fn(),
    countArchivePages: vi.fn(),
    zipGetEntries: vi.fn(),
    log: vi.fn(),
}));

vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }));
vi.mock('@/lib/db', () => ({ prisma: { library: { findMany: mocks.libraryFindMany } } }));

vi.mock('fs', () => ({
    existsSync: mocks.fsExistsSync,
    statSync: mocks.fsStatSync,
    readdirSync: mocks.fsReaddirSync,
    default: { existsSync: mocks.fsExistsSync, statSync: mocks.fsStatSync, readdirSync: mocks.fsReaddirSync }
}));

// Root containment: the test "filesystem" allows /data/comics (library) and /unmatched.
vi.mock('@/lib/utils/paths', () => ({
    UNMATCHED_DIR: '/unmatched',
    isPathWithinRoots: (p: string, roots: string[]) => roots.some(r => p.replace(/\\/g, '/').startsWith(r)),
}));

vi.mock('@/lib/utils/archive-pages', () => ({
    countArchivePages: mocks.countArchivePages,
    isPageCountable: (p: string) => /\.(cbz|zip|epub)$/i.test(p || ''),
}));

vi.mock('adm-zip', () => ({
    default: class AdmZipMock { getEntries() { return mocks.zipGetEntries(); } }
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

function makeEntry(entryName: string, data = 'page-bytes') {
    return { entryName, isDirectory: false, getData: () => Buffer.from(data) };
}

function request(query: string) {
    return GET(new NextRequest(`http://localhost/api/library/archive-preview?${query}`));
}

describe('API Route: Smart Matcher archive preview', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getToken.mockResolvedValue({ id: 'admin_1', role: 'ADMIN' });
        mocks.libraryFindMany.mockResolvedValue([{ path: '/data/comics' }]);
        mocks.fsExistsSync.mockReturnValue(true);
        mocks.fsStatSync.mockReturnValue({ isDirectory: () => false });
        mocks.countArchivePages.mockResolvedValue(22);
        mocks.zipGetEntries.mockReturnValue([
            makeEntry('page10.jpg', 'ten'),
            makeEntry('ComicInfo.xml'),
            makeEntry('page2.jpg', 'two'),
        ]);
    });

    it('rejects non-admins', async () => {
        mocks.getToken.mockResolvedValue({ id: 'user_1', role: 'USER' });
        const res = await request('path=%2Funmatched%2Fx.cbz&info=1');
        expect(res.status).toBe(403);
    });

    it('rejects paths outside library roots and the unmatched dir', async () => {
        const res = await request(`path=${encodeURIComponent('/etc/shadow')}&info=1`);
        expect(res.status).toBe(403);
    });

    it('info mode returns the file and its page count', async () => {
        const res = await request(`path=${encodeURIComponent('/unmatched/Batman 001.cbz')}&info=1`);
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.pageCount).toBe(22);
        expect(data.file).toContain('Batman 001.cbz');
    });

    it('info mode resolves a folder to its first natural-sorted archive', async () => {
        mocks.fsStatSync.mockReturnValue({ isDirectory: () => true });
        // Natural sort must pick "Issue 2" before "Issue 10"; junk is filtered.
        mocks.fsReaddirSync.mockReturnValue(['Issue 10.cbz', 'notes.txt', 'Issue 2.cbz']);

        const res = await request(`path=${encodeURIComponent('/unmatched/Batman')}&info=1`);
        const data = await res.json();
        expect(data.file).toContain('Issue 2.cbz');
    });

    it('serves a page with natural-sorted extraction (same order as the reader/OPDS streamer)', async () => {
        const res = await request(`path=${encodeURIComponent('/unmatched/Batman 001.cbz')}&page=0`);

        expect(res.status).toBe(200);
        // Natural sort: page2 before page10; ComicInfo filtered → index 0 = page2.jpg.
        expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('two');
        expect(res.headers.get('content-type')).toBe('image/jpeg');
    });

    it('returns 404 for an out-of-bounds page', async () => {
        const res = await request(`path=${encodeURIComponent('/unmatched/Batman 001.cbz')}&page=9`);
        expect(res.status).toBe(404);
    });
});
