import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/reader/pages/route';

const mocks = vi.hoisted(() => ({
    libraryFindMany: vi.fn(),
    fsExistsSync: vi.fn(),
    zipGetEntries: vi.fn().mockReturnValue([]),
    getAccessibleLibraryPaths: vi.fn(),
    canAccessPath: vi.fn(),
    log: vi.fn(),
    session: { user: { id: 'user_1', role: 'USER' } }
}));

vi.mock('@/lib/db', () => ({ prisma: { library: { findMany: mocks.libraryFindMany } } }));
vi.mock('fs', () => ({ default: { existsSync: mocks.fsExistsSync }, existsSync: mocks.fsExistsSync }));
vi.mock('adm-zip', () => ({ default: class { getEntries() { return mocks.zipGetEntries(); } } }));
vi.mock('next-auth/next', () => ({ getServerSession: vi.fn().mockResolvedValue(mocks.session) }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn() }));
vi.mock('@/lib/library-access', () => ({
    getAccessibleLibraryPaths: mocks.getAccessibleLibraryPaths,
    canAccessPath: mocks.canAccessPath
}));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

const req = (path: string) => new Request(`http://localhost/api/reader/pages?path=${encodeURIComponent(path)}`);

describe('API Route: Reader Pages (per-library access)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.libraryFindMany.mockResolvedValue([{ path: '/data/comics' }]);
        mocks.fsExistsSync.mockReturnValue(true);
        mocks.getAccessibleLibraryPaths.mockResolvedValue(['/data/comics']);
        mocks.canAccessPath.mockReturnValue(true);
    });

    it('rejects a path outside any library root with 403', async () => {
        const res = await GET(req('/etc/passwd')) as Response;
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe('Unauthorized path access');
    });

    it('rejects a user who lacks access to the (in-root) library — the per-user gate fix (#11)', async () => {
        // Path IS within a configured library root, but this user was never granted that library.
        mocks.canAccessPath.mockReturnValue(false);
        const res = await GET(req('/data/comics/restricted/batman.cbz')) as Response;
        expect(res.status).toBe(403);
        expect((await res.json()).error).toContain("don't have access");
        // Gate runs before any archive read.
        expect(mocks.zipGetEntries).not.toHaveBeenCalled();
    });
});
