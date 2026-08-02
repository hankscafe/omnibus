import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/admin/config/route';
import { makePostJson } from '../helpers/request';

// 1. Hoist our mocks
const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    findUniqueSetting: vi.fn(),
    transaction: vi.fn(),
    log: vi.fn()
}));

// 2. Mock NextAuth
vi.mock('next-auth/next', () => ({
    getServerSession: mocks.getServerSession
}));

// 3. Mock the Database & Dependencies
vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findUnique: mocks.findUniqueSetting },
        $transaction: mocks.transaction
    }
}));

vi.mock('@/lib/queue', () => ({ syncSchedules: vi.fn().mockResolvedValue(true) }));

const createReq = makePostJson('http://localhost/api/admin/config');

describe('Security: RBAC Admin API Route', () => {
    beforeEach(() => {
        // Simulate that initial setup is complete so RBAC is strictly enforced
        mocks.findUniqueSetting.mockResolvedValue({ value: 'true' });
    });

    it('should return 403 Forbidden if not logged in', async () => {
        mocks.getServerSession.mockResolvedValueOnce(null);

        const req = createReq({ settings: { test: '123' } });
        const res = await POST(req);

        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.error).toContain('Unauthorized');
        expect(mocks.transaction).not.toHaveBeenCalled(); 
    });

    it('should return 403 Forbidden if a standard USER tries to access it', async () => {
        // Simulate an active session, but their role is only 'USER'
        mocks.getServerSession.mockResolvedValueOnce({
            user: { id: 'user_123', role: 'USER' }
        });

        const req = createReq({ settings: { test: '123' } });
        const res = await POST(req);

        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.error).toContain('Unauthorized');
        
        // Ensure the database transaction was completely protected
        expect(mocks.transaction).not.toHaveBeenCalled(); 
    });

    it('should execute successfully if an ADMIN makes the request', async () => {
        // Simulate an active session with the 'ADMIN' role
        mocks.getServerSession.mockResolvedValueOnce({
            user: { id: 'admin_1', role: 'ADMIN' }
        });

        const req = createReq({ settings: { test: '123' } });
        const res = await POST(req);

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(mocks.transaction).toHaveBeenCalledTimes(1); 
    });
});