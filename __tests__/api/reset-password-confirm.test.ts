import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/auth/reset-password/confirm/route';
import crypto from 'crypto';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    userUpdate: vi.fn(),
    log: vi.fn(),
    hash: vi.fn().mockResolvedValue('new_hashed_password')
}));

// 2. Mock dependencies
vi.mock('@/lib/db', () => ({
    prisma: { user: { update: mocks.userUpdate } }
}));
vi.mock('bcryptjs', () => ({ default: { hash: mocks.hash } }));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: vi.fn() } }));

// Helper to create fake Next.js requests
const createReq = (body: any) => new Request('http://localhost/api/auth/reset-password/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    body: JSON.stringify(body)
});

describe('Security: Password Reset Confirmation', () => {
    const TEST_SECRET = 'super_secure_test_secret_key_1234567890';

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.NEXTAUTH_SECRET = TEST_SECRET;
    });

    // Helper to generate a valid token just like your real app does
    const generateToken = (userId: string, expiresInMs: number) => {
        const expiration = Date.now() + expiresInMs;
        const data = `${userId}|${expiration}`;
        const sig = crypto.createHmac('sha256', TEST_SECRET).update(data).digest('hex');
        return Buffer.from(`${data}|${sig}`).toString('base64');
    };

    it('should successfully reset password with a valid, unexpired token', async () => {
        const validToken = generateToken('user_123', 3600000); // Expires in 1 hour
        const req = createReq({ token: validToken, password: 'NewSecurePassword123!' });

        const res = await POST(req);
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.success).toBe(true);
        expect(mocks.userUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'user_123' },
            data: expect.objectContaining({ password: 'new_hashed_password' }) // Verifies password was hashed
        }));
    });

    it('should reject a token that has expired', async () => {
        const expiredToken = generateToken('user_123', -3600000); // Expired 1 hour ago
        const req = createReq({ token: expiredToken, password: 'NewSecurePassword123!' });

        const res = await POST(req);
        const data = await res.json();

        expect(res.status).toBe(400);
        expect(data.error).toBe('Token has expired.');
        expect(mocks.userUpdate).not.toHaveBeenCalled();
    });

    it('should reject a token with an invalid signature (tampering attempt)', async () => {
        const validToken = generateToken('user_123', 3600000); 
        
        // Decode it, change the target user ID to 'admin_1', and re-encode it (Attacker tries to reset admin password)
        const decoded = Buffer.from(validToken, 'base64').toString('utf-8');
        const tamperedDecoded = decoded.replace('user_123', 'admin_1');
        const tamperedToken = Buffer.from(tamperedDecoded).toString('base64');

        const req = createReq({ token: tamperedToken, password: 'HackedPassword123!' });

        const res = await POST(req);
        const data = await res.json();

        expect(res.status).toBe(400);
        expect(data.error).toBe('Invalid token signature');
        expect(mocks.userUpdate).not.toHaveBeenCalled(); // Database must NOT be updated
    });
});