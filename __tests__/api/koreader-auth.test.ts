import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { authenticateKoreader } from '@/lib/koreader-auth';

const mocks = vi.hoisted(() => ({
    opdsFindUnique: vi.fn(),
    opdsUpdate: vi.fn(),
    apiFindUnique: vi.fn(),
    apiUpdate: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        opdsKey: {
            findUnique: mocks.opdsFindUnique,
            update: mocks.opdsUpdate,
        },
        apiKey: {
            findUnique: mocks.apiFindUnique,
            update: mocks.apiUpdate,
        },
    },
}));

const USER = { id: 'user_1', username: 'nicolas', role: 'USER' };
const RAW_KEY = 'omn_test';
const MD5_KEY = crypto.createHash('md5').update(RAW_KEY).digest('hex');
const SYNC_HASH = crypto.createHash('sha256').update(MD5_KEY).digest('hex');
const REQUEST = new Request('http://localhost/api/koreader/users/auth', {
    headers: {
        'x-auth-user': 'nicolas',
        'x-auth-key': MD5_KEY,
    },
});

describe('authenticateKoreader', () => {
    beforeEach(() => {
        mocks.opdsUpdate.mockResolvedValue({});
        mocks.apiUpdate.mockResolvedValue({});
    });

    it('authenticates a new profile key with exactly what KOReader sends', async () => {
        mocks.opdsFindUnique.mockResolvedValue({ id: 'opds_1', expiresAt: null, user: USER });

        await expect(authenticateKoreader(REQUEST)).resolves.toEqual({ user: USER, error: null });
        expect(mocks.opdsFindUnique).toHaveBeenCalledWith({
            where: { syncKeyHash: SYNC_HASH },
            include: { user: true },
        });
        expect(mocks.opdsUpdate).toHaveBeenCalledWith({
            where: { id: 'opds_1' },
            data: { lastUsedAt: expect.any(Date) },
        });
    });

    it('falls back to a new admin key with exactly what KOReader sends', async () => {
        mocks.opdsFindUnique.mockResolvedValue(null);
        mocks.apiFindUnique.mockResolvedValue({ id: 'api_1', expiresAt: null, user: USER });

        await expect(authenticateKoreader(REQUEST)).resolves.toEqual({ user: USER, error: null });
        expect(mocks.apiFindUnique).toHaveBeenCalledWith({
            where: { syncKeyHash: SYNC_HASH },
            include: { user: true },
        });
        expect(mocks.apiUpdate).toHaveBeenCalledWith({
            where: { id: 'api_1' },
            data: { lastUsedAt: expect.any(Date) },
        });
    });

    it('refuses a key that belongs to another username', async () => {
        mocks.opdsFindUnique.mockResolvedValue({
            id: 'opds_1',
            expiresAt: null,
            user: { ...USER, username: 'someone-else' },
        });
        mocks.apiFindUnique.mockResolvedValue(null);

        await expect(authenticateKoreader(REQUEST)).resolves.toEqual({
            user: null,
            error: 'Unauthorized',
        });
        expect(mocks.opdsUpdate).not.toHaveBeenCalled();
    });

    it('reports an expired key distinctly', async () => {
        mocks.opdsFindUnique.mockResolvedValue({
            id: 'opds_1',
            expiresAt: new Date('2000-01-01T00:00:00Z'),
            user: USER,
        });

        await expect(authenticateKoreader(REQUEST)).resolves.toEqual({
            user: null,
            error: 'API key has expired',
        });
        expect(mocks.opdsUpdate).not.toHaveBeenCalled();
    });

    it('rejects legacy keys without a syncKeyHash', async () => {
        mocks.opdsFindUnique.mockResolvedValue(null);
        mocks.apiFindUnique.mockResolvedValue(null);

        await expect(authenticateKoreader(REQUEST)).resolves.toEqual({
            user: null,
            error: 'Unauthorized',
        });
    });
});
