import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/library/download/route';

// 1. Hoist our mocks
const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    findUniqueUser: vi.fn(),
    findManyLibraries: vi.fn(),
    existsSync: vi.fn(),
    log: vi.fn()
}));

// 2. Mock NextAuth
vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));

// 3. Mock Prisma
vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findUnique: mocks.findUniqueUser },
        library: { findMany: mocks.findManyLibraries }
    }
}));

// 4. Mock fs (native, not fs-extra, in this route)
vi.mock('fs', () => ({
    default: {
        existsSync: mocks.existsSync,
        statSync: vi.fn(),
        createReadStream: vi.fn()
    }
}));


const createReq = (filePath: string) =>
    new Request(`http://localhost/api/library/download?path=${encodeURIComponent(filePath)}`);

describe('API Route: Library File Download Permissions', () => {
    beforeEach(() => {
        mocks.findManyLibraries.mockResolvedValue([{ path: '/library' }]);
    });

    it('should reject requests with no resolvable user', async () => {
        mocks.getServerSession.mockResolvedValueOnce(null);

        const res = await GET(createReq('/library/Batman/issue1.cbz'));
        expect(res.status).toBe(401);
    });

    it('should reject authenticated users without the download permission', async () => {
        mocks.getServerSession.mockResolvedValueOnce({ user: { id: 'user_1' } });
        mocks.findUniqueUser.mockResolvedValueOnce({ id: 'user_1', role: 'USER', canDownload: false });

        const res = await GET(createReq('/library/Batman/issue1.cbz'));
        expect(res.status).toBe(403);
    });

    it('should allow users with the canDownload permission through to the file lookup', async () => {
        mocks.getServerSession.mockResolvedValueOnce({ user: { id: 'user_2' } });
        mocks.findUniqueUser.mockResolvedValueOnce({ id: 'user_2', role: 'USER', canDownload: true });
        // The permission gate passed; the missing file proves we reached the fs stage
        mocks.existsSync.mockReturnValueOnce(false);

        const res = await GET(createReq('/library/Batman/issue1.cbz'));
        expect(res.status).toBe(404);
    });

    it('should allow admins regardless of their canDownload flag', async () => {
        mocks.getServerSession.mockResolvedValueOnce({ user: { id: 'admin_1' } });
        mocks.findUniqueUser.mockResolvedValueOnce({ id: 'admin_1', role: 'ADMIN', canDownload: false });
        mocks.existsSync.mockReturnValueOnce(false);

        const res = await GET(createReq('/library/Batman/issue1.cbz'));
        expect(res.status).toBe(404);
    });

    it('should still reject paths outside the configured library roots for permitted users', async () => {
        mocks.getServerSession.mockResolvedValueOnce({ user: { id: 'admin_1' } });
        mocks.findUniqueUser.mockResolvedValueOnce({ id: 'admin_1', role: 'ADMIN', canDownload: true });

        const res = await GET(createReq('/etc/passwd'));
        expect(res.status).toBe(403);
    });
});
