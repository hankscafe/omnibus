// __tests__/api/api-keys.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST, DELETE } from '@/app/api/user/api-keys/route';
import crypto from 'crypto';

const mocks = vi.hoisted(() => ({
    opdsKeyCreate: vi.fn(),
    opdsKeyDelete: vi.fn(),
    opdsKeyFindUnique: vi.fn(),
    log: vi.fn()
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        opdsKey: { 
            create: mocks.opdsKeyCreate,
            delete: mocks.opdsKeyDelete,
            findUnique: mocks.opdsKeyFindUnique
        }
    }
}));

vi.mock('next-auth/next', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { id: 'user_1' } })
}));

vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn() }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

describe('API Route: OPDS API Keys', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should generate a secure key, store its hash, and return the raw key only once', async () => {
        mocks.opdsKeyCreate.mockImplementation(async (args) => ({ id: 'key_123', ...args.data }));

        const req = new Request('http://localhost/api/user/api-keys', {
            method: 'POST',
            body: JSON.stringify({ name: 'iPad Panels App' })
        });

        const res = await POST(req);
        const data = await res.json();

        expect(data.success).toBe(true);
        expect(data.rawKey).toBeDefined();
        expect(data.rawKey.startsWith('omn_')).toBe(true);

        // Verify the database received the HASH, not the raw key
        const expectedHash = crypto.createHash('sha256').update(data.rawKey).digest('hex');
        expect(mocks.opdsKeyCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                keyHash: expectedHash,
                userId: 'user_1',
                name: 'iPad Panels App'
            })
        }));
    });

    it('should securely revoke a key if the user owns it', async () => {
        mocks.opdsKeyFindUnique.mockResolvedValue({ id: 'key_123', userId: 'user_1' });

        const req = new Request('http://localhost/api/user/api-keys?id=key_123', { method: 'DELETE' });
        const res = await DELETE(req);
        const data = await res.json();

        expect(data.success).toBe(true);
        expect(mocks.opdsKeyDelete).toHaveBeenCalledWith({ where: { id: 'key_123' } });
    });
});