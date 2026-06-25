import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/auth/reset-password/confirm/route';
import crypto from 'crypto';

// 1. Hoist the mocks — the route now reads sessionVersion (findUnique) and consumes the token via a
//    conditional updateMany (single-use), so both are mocked.
const mocks = vi.hoisted(() => ({
    userFindUnique: vi.fn(),
    userUpdateMany: vi.fn(),
    log: vi.fn(),
    hash: vi.fn().mockResolvedValue('new_hashed_password')
}));

// 2. Mock dependencies
vi.mock('@/lib/db', () => ({
    prisma: { user: { findUnique: mocks.userFindUnique, updateMany: mocks.userUpdateMany } }
}));
vi.mock('bcryptjs', () => ({ default: { hash: mocks.hash } }));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: vi.fn() } }));

// Unique IP per request so the per-IP limiter never accumulates across tests in this file.
let ipCounter = 0;
const createReq = (body: any) => new Request('http://localhost/api/auth/reset-password/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.0.0.${++ipCounter}` },
    body: JSON.stringify(body)
});

describe('Security: Password Reset Confirmation', () => {
    const TEST_SECRET = 'super_secure_test_secret_key_1234567890';

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.NEXTAUTH_SECRET = TEST_SECRET;
        mocks.userFindUnique.mockResolvedValue({ sessionVersion: 3 });
        mocks.userUpdateMany.mockResolvedValue({ count: 1 });
    });

    // Mirrors the route: HMAC binds sessionVersion, but the token plaintext stays id|expiration|sig.
    const generateToken = (userId: string, expiresInMs: number, sessionVersion: number = 3) => {
        const expiration = Date.now() + expiresInMs;
        const sig = crypto.createHmac('sha256', TEST_SECRET).update(`${userId}|${expiration}|${sessionVersion}`).digest('hex');
        return Buffer.from(`${userId}|${expiration}|${sig}`).toString('base64');
    };

    it('resets the password with a valid, unexpired token via a conditional (single-use) update', async () => {
        const res = await POST(createReq({ token: generateToken('user_123', 3600000), password: 'NewSecurePassword123!' }));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.success).toBe(true);
        // Gated on the signed sessionVersion AND increments it, so a replay can't re-consume the token.
        expect(mocks.userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'user_123', sessionVersion: 3 },
            data: expect.objectContaining({ password: 'new_hashed_password', sessionVersion: { increment: 1 } })
        }));
    });

    it('rejects an expired token', async () => {
        const res = await POST(createReq({ token: generateToken('user_123', -3600000), password: 'x' }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('Token has expired.');
        expect(mocks.userUpdateMany).not.toHaveBeenCalled();
    });

    it('rejects a tampered signature (attacker swaps the user id to admin_1)', async () => {
        const valid = generateToken('user_123', 3600000);
        const decoded = Buffer.from(valid, 'base64').toString('utf-8');
        const tampered = Buffer.from(decoded.replace('user_123', 'admin_1')).toString('base64');

        const res = await POST(createReq({ token: tampered, password: 'HackedPassword123!' }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('Invalid token signature');
        expect(mocks.userUpdateMany).not.toHaveBeenCalled();
    });

    it('rejects a replay after first use: a token signed at an old sessionVersion no longer verifies', async () => {
        // The user already reset once, so the live sessionVersion (4) is past the token's signed value (3).
        mocks.userFindUnique.mockResolvedValue({ sessionVersion: 4 });
        const res = await POST(createReq({ token: generateToken('user_123', 3600000, 3), password: 'x' }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('Invalid token signature');
        expect(mocks.userUpdateMany).not.toHaveBeenCalled();
    });

    it('rejects a concurrent double-submit where the conditional update matches 0 rows', async () => {
        // Signature still matches, but another in-flight request already consumed the token.
        mocks.userUpdateMany.mockResolvedValue({ count: 0 });
        const res = await POST(createReq({ token: generateToken('user_123', 3600000), password: 'x' }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('This reset link has already been used.');
    });
});
