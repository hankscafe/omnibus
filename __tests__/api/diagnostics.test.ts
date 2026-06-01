import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/admin/diagnostics/route';

const mocks = vi.hoisted(() => ({
    libraryFindMany: vi.fn(),
    fsRemove: vi.fn(),
    fsExistsSync: vi.fn(),
    log: vi.fn()
}));

vi.mock('@/lib/db', () => ({
    prisma: { library: { findMany: mocks.libraryFindMany } }
}));

vi.mock('fs-extra', () => ({
    default: { remove: mocks.fsRemove, existsSync: mocks.fsExistsSync }
}));

vi.mock('next-auth/next', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } })
}));

vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn() }));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: vi.fn() } }));

describe('API Route: System Diagnostics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('SECURITY: should block directory traversal attempts when deleting orphans', async () => {
        mocks.libraryFindMany.mockResolvedValue([{ path: '/data/comics' }]);
        mocks.fsExistsSync.mockReturnValue(true);

        const req = new Request('http://localhost/api/admin/diagnostics', {
            method: 'POST',
            body: JSON.stringify({
                action: 'delete-orphans',
                payload: { paths: ['/data/comics/../../../etc/passwd'] }
            })
        });

        const res = await POST(req);
        const data = await res.json();

        expect(data.success).toBe(true); // Fails open to the client, but doesn't actually delete
        expect(mocks.fsRemove).not.toHaveBeenCalled(); // The actual physical deletion MUST be blocked
        expect(mocks.log).toHaveBeenCalledWith(
            expect.stringContaining('Blocked unauthorized path deletion'),
            'warn'
        );
    });

    it('should successfully delete orphans if within authorized bounds', async () => {
        mocks.libraryFindMany.mockResolvedValue([{ path: '/data/comics' }]);
        mocks.fsExistsSync.mockReturnValue(true);

        const req = new Request('http://localhost/api/admin/diagnostics', {
            method: 'POST',
            body: JSON.stringify({
                action: 'delete-orphans',
                payload: { paths: ['/data/comics/orphaned_file.cbz'] }
            })
        });

        await POST(req);
        
        expect(mocks.fsRemove).toHaveBeenCalledWith('/data/comics/orphaned_file.cbz');
    });
});