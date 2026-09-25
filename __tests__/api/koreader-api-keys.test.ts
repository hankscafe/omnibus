import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import {
    GET as getUserKeys,
    POST as createUserKey,
} from '@/app/api/user/api-keys/route';
import {
    GET as getAdminKeys,
    POST as createAdminKey,
} from '@/app/api/admin/api-keys/route';

const mocks = vi.hoisted(() => ({
    opdsKeyCreate: vi.fn(),
    opdsKeyFindMany: vi.fn(),
    apiKeyCreate: vi.fn(),
    apiKeyFindMany: vi.fn(),
    getServerSession: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        opdsKey: {
            create: mocks.opdsKeyCreate,
            findMany: mocks.opdsKeyFindMany,
        },
        apiKey: {
            create: mocks.apiKeyCreate,
            findMany: mocks.apiKeyFindMany,
        },
    },
}));

vi.mock('next-auth/next', () => ({
    getServerSession: mocks.getServerSession,
}));

function session(role: 'USER' | 'ADMIN' = 'ADMIN') {
    return { user: { id: 'admin_1', username: 'nicolas', role } };
}

describe('KOReader API key compatibility', () => {
    beforeEach(() => {
        mocks.getServerSession.mockResolvedValue(session());
        mocks.opdsKeyCreate.mockImplementation(async ({ data }) => ({ id: 'key_123', ...data }));
        mocks.apiKeyCreate.mockImplementation(async ({ data }) => ({
            id: 'admin_key_123',
            ...data,
            user: { username: 'nicolas', role: 'USER' },
            createdBy: { username: 'nicolas' },
        }));
    });

    it('stores sha256(md5(rawKey)) when creating a profile key without exposing either hash', async () => {
        const request = new Request('http://localhost/api/user/api-keys', {
            method: 'POST',
            body: JSON.stringify({ name: 'Kobo' }),
        });

        const response = await createUserKey(request);
        const body = await response.json();
        const rawKey = body.rawKey as string;
        const md5Hash = crypto.createHash('md5').update(rawKey).digest('hex');
        const syncKeyHash = crypto.createHash('sha256').update(md5Hash).digest('hex');

        expect(response.status).toBe(200);
        expect(mocks.opdsKeyCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                name: 'Kobo',
                userId: 'admin_1',
                keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
                syncKeyHash,
            }),
        });
        expect(body.apiKey.koreaderCompatible).toBe(true);
        expect(body.apiKey).not.toHaveProperty('keyHash');
        expect(body.apiKey).not.toHaveProperty('syncKeyHash');
    });

    it('marks only newly generated profile keys as KOReader-compatible', async () => {
        mocks.opdsKeyFindMany.mockResolvedValue([
            {
                id: 'new_key',
                name: 'Kobo',
                prefix: 'omn_123...',
                createdAt: new Date('2026-09-25T00:00:00Z'),
                lastUsedAt: null,
                syncKeyHash: 'stored-sync-hash',
            },
            {
                id: 'legacy_key',
                name: 'Legacy',
                prefix: 'omn_old...',
                createdAt: new Date('2026-09-24T00:00:00Z'),
                lastUsedAt: null,
                syncKeyHash: null,
            },
        ]);

        const response = await getUserKeys();

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual([
            expect.objectContaining({ id: 'new_key', koreaderCompatible: true }),
            expect.objectContaining({ id: 'legacy_key', koreaderCompatible: false }),
        ]);
    });

    it('stores syncKeyHash and strips both hashes when creating an admin key', async () => {
        const request = new Request('http://localhost/api/admin/api-keys', {
            method: 'POST',
            body: JSON.stringify({ name: 'Kobo admin', userId: 'user_1', expiresInDays: 7 }),
        });

        const response = await createAdminKey(request);
        const body = await response.json();
        const rawKey = body.rawKey as string;
        const syncKeyHash = crypto.createHash('sha256')
            .update(crypto.createHash('md5').update(rawKey).digest('hex'))
            .digest('hex');

        expect(response.status).toBe(200);
        expect(mocks.apiKeyCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                name: 'Kobo admin',
                userId: 'user_1',
                keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
                syncKeyHash,
            }),
        }));
        expect(body.apiKey.koreaderCompatible).toBe(true);
        expect(body.apiKey).not.toHaveProperty('keyHash');
        expect(body.apiKey).not.toHaveProperty('syncKeyHash');
    });

    it('marks only newly generated admin keys as KOReader-compatible', async () => {
        mocks.apiKeyFindMany.mockResolvedValue([
            {
                id: 'new_admin_key',
                name: 'Kobo admin',
                prefix: 'omn_123...',
                lastUsedAt: null,
                expiresAt: null,
                createdAt: new Date('2026-09-25T00:00:00Z'),
                syncKeyHash: 'stored-sync-hash',
                user: { username: 'nicolas', role: 'USER' },
                createdBy: { username: 'nicolas' },
            },
            {
                id: 'legacy_admin_key',
                name: 'Legacy admin',
                prefix: 'omn_old...',
                lastUsedAt: null,
                expiresAt: null,
                createdAt: new Date('2026-09-24T00:00:00Z'),
                syncKeyHash: null,
                user: { username: 'nicolas', role: 'USER' },
                createdBy: { username: 'nicolas' },
            },
        ]);

        const response = await getAdminKeys();

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual([
            expect.objectContaining({ id: 'new_admin_key', koreaderCompatible: true }),
            expect.objectContaining({ id: 'legacy_admin_key', koreaderCompatible: false }),
        ]);
    });
});
