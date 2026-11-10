// /api/admin/users - the admin Users page's list (GET), permission changes (PATCH) and new accounts (POST).
//
// GET has always listed users through a fixed select. Until beta.032 PATCH and POST re-read the changed
// user with the WHOLE row and removed only `password`, so every permission toggle, tier, library grant,
// 2FA reset and new account put that user's encrypted TOTP secret, sessionVersion, avatar/banner paths
// and lastSeenUpdatesAt in the admin's browser. These tests pin the reply to the GET's fields.
//
// The Prisma fake keeps one stored row and honours `select` / `include` the way Prisma does, so the same
// tests run against the old include-based reads and the new select-based ones.
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
type Args = { where?: { id?: string }; select?: Record<string, unknown>; include?: Record<string, unknown>; data?: Row };

const store = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), access: new Map<string, string[]>(), vanishOnReread: false }));

const shape = (row: Row, args?: Args): Row => {
    const access = (store.access.get(row.id as string) ?? []).map((libraryId) => ({ libraryId }));
    if (args?.select) {
        const out: Row = {};
        for (const [key, on] of Object.entries(args.select)) {
            if (!on) continue;
            out[key] = key === 'libraryAccess' ? access : row[key];
        }
        return out;
    }
    const out: Row = { ...row };
    if (args?.include?.libraryAccess) out.libraryAccess = access;
    return out;
};

const mocks = vi.hoisted(() => ({
    getToken: vi.fn(),
    findUniqueCalls: 0,
}));

vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: vi.fn(async () => {}) } }));
vi.mock('@/lib/notifications', () => ({ SystemNotifier: { sendAlert: vi.fn(async () => {}) } }));
vi.mock('bcryptjs', () => ({ default: { hash: vi.fn(async () => BCRYPT_NEW) } }));
vi.mock('@/lib/library-access', () => ({
    setUserLibraryAccess: vi.fn(async (id: string, ids: string[]) => { store.access.set(id, [...ids]); }),
    grantAllLibraries: vi.fn(async (id: string) => { store.access.set(id, ['lib_comics', 'lib_manga']); }),
    getDefaultLibraryIds: vi.fn(async () => ['lib_comics']),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        user: {
            findMany: vi.fn(async (args?: Args) => [...store.rows.values()].map((r) => shape(r, args))),
            findFirst: vi.fn(async () => null),
            findUnique: vi.fn(async (args: Args) => {
                mocks.findUniqueCalls += 1;
                // PATCH reads the user once before the update; the read after it is the reply's.
                if (store.vanishOnReread && mocks.findUniqueCalls > 1) return null;
                const row = store.rows.get(args.where?.id as string);
                return row ? shape(row, args) : null;
            }),
            update: vi.fn(async (args: Args) => {
                const row = store.rows.get(args.where?.id as string);
                if (!row) throw new Error('Record to update not found.');
                Object.assign(row, args.data);
                return shape(row, args);
            }),
            create: vi.fn(async (args: Args) => {
                const row: Row = {
                    id: 'u_new', avatar: null, banner: null, createdAt: new Date('2026-11-10T12:00:00Z'),
                    twoFactorEnabled: false, twoFactorSecret: null, sessionVersion: 0, lastSeenUpdatesAt: null,
                    ...args.data,
                };
                store.rows.set('u_new', row);
                return shape(row, args);
            }),
        },
    },
}));

import { GET, PATCH, POST } from '@/app/api/admin/users/route';
import { NextRequest } from 'next/server';

const BCRYPT = '$2b$12$abcdefghijklmnopqrstuuDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
const BCRYPT_NEW = '$2b$12$zyxwvutsrqponmlkjihgfeEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';
const TOTP_CIPHERTEXT = 'enc:v2:c2VjcmV0LXRvdHAtc2VlZC1jaXBoZXJ0ZXh0';

/** The fields the Users page shows for one account (AdminUserRow) - all the GET has ever sent. */
const ROW_FIELDS = [
    'autoApproveRequests', 'canCreateGlobalLists', 'canDownload', 'canRequest', 'createdAt', 'email', 'id',
    'isApproved', 'libraryAccess', 'role', 'twoFactorEnabled', 'username',
];
const NEVER_SENT = ['password', 'twoFactorSecret', 'sessionVersion', 'avatar', 'banner', 'lastSeenUpdatesAt'];

const seed = () => {
    store.rows.clear();
    store.access.clear();
    store.vanishOnReread = false;
    mocks.findUniqueCalls = 0;
    store.rows.set('u_2', {
        id: 'u_2', username: 'reader', email: 'reader@example.test', password: BCRYPT, role: 'USER',
        isApproved: true, autoApproveRequests: false, canRequest: true, canDownload: false, canCreateGlobalLists: false,
        avatar: '/avatars/u_2.png', banner: '/banners/u_2.png', createdAt: new Date('2026-01-02T03:04:05Z'),
        twoFactorEnabled: true, twoFactorSecret: TOTP_CIPHERTEXT, sessionVersion: 7,
        lastSeenUpdatesAt: new Date('2026-11-01T00:00:00Z'),
    });
    store.access.set('u_2', ['lib_comics']);
};

const req = (method: string, body?: unknown) => new NextRequest('http://localhost/api/admin/users', {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
});
const call = async (handler: (r: NextRequest) => Promise<Response>, method: string, body?: unknown) => {
    const res = await handler(req(method, body));
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
};

const expectRowOnly = (user: Row, text: string) => {
    expect(Object.keys(user).sort()).toEqual(ROW_FIELDS);
    for (const key of NEVER_SENT) expect(user).not.toHaveProperty(key);
    expect(text).not.toContain(TOTP_CIPHERTEXT);
    expect(text).not.toContain(BCRYPT);
    expect(text).not.toContain(BCRYPT_NEW);
};

describe('/api/admin/users', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        seed();
        mocks.getToken.mockResolvedValue({ id: 'u_admin', role: 'ADMIN' });
    });

    it('GET lists users with the row fields only', async () => {
        const { status, text, body } = await call(GET, 'GET');

        expect(status).toBe(200);
        expect(body).toHaveLength(1);
        expectRowOnly(body[0], text);
    });

    it('PATCH answers with the row fields only, never the TOTP secret, hash or sessionVersion', async () => {
        const { status, text, body } = await call(PATCH, 'PATCH', { id: 'u_2', canDownload: true });

        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expectRowOnly(body.user, text);
    });

    it('PATCH answers with the user as changed, in the same shape the GET lists', async () => {
        const { body } = await call(PATCH, 'PATCH', { id: 'u_2', canDownload: true, libraryIds: ['lib_comics', 'lib_manga'] });

        expect(body.user).toEqual({
            id: 'u_2', username: 'reader', email: 'reader@example.test', role: 'USER',
            isApproved: true, autoApproveRequests: false, canRequest: true, canDownload: true, canCreateGlobalLists: false,
            createdAt: '2026-01-02T03:04:05.000Z', twoFactorEnabled: true,
            libraryAccess: [{ libraryId: 'lib_comics' }, { libraryId: 'lib_manga' }],
        });
        const listed = (await call(GET, 'GET')).body[0];
        expect(body.user).toEqual(listed);
    });

    it('PATCH reset2FA clears the secret and answers twoFactorEnabled false without it', async () => {
        const { text, body } = await call(PATCH, 'PATCH', { id: 'u_2', reset2FA: true });

        expect(store.rows.get('u_2')).toMatchObject({ twoFactorEnabled: false, twoFactorSecret: null });
        expect(body.user.twoFactorEnabled).toBe(false);
        expectRowOnly(body.user, text);
    });

    it('PATCH promoting to ADMIN answers with every flag on and all libraries', async () => {
        const { text, body } = await call(PATCH, 'PATCH', { id: 'u_2', role: 'ADMIN' });

        expect(body.user).toMatchObject({
            role: 'ADMIN', isApproved: true, autoApproveRequests: true, canRequest: true, canDownload: true, canCreateGlobalLists: true,
            libraryAccess: [{ libraryId: 'lib_comics' }, { libraryId: 'lib_manga' }],
        });
        expectRowOnly(body.user, text);
    });

    it('PATCH answers 404 when the user is gone by the time the reply is read', async () => {
        store.vanishOnReread = true;
        const { status, text, body } = await call(PATCH, 'PATCH', { id: 'u_2', canDownload: true });

        expect(status).toBe(404);
        expect(body).toEqual({ error: 'User not found.' });
        expect(text).not.toContain(TOTP_CIPHERTEXT);
    });

    it('POST answers with the new account in the row shape, never its password hash', async () => {
        const { status, text, body } = await call(POST, 'POST', {
            username: 'newbie', email: 'newbie@example.test', password: 'pw-from-admin', tier: 'Civilian',
        });

        expect(status).toBe(200);
        expectRowOnly(body, text);
        expect(body).toMatchObject({ id: 'u_new', username: 'newbie', role: 'USER', libraryAccess: [{ libraryId: 'lib_comics' }] });
        expect(store.rows.get('u_new')?.password).toBe(BCRYPT_NEW);
    });

    it('POST answers 404 when the new account is gone by the time the reply is read', async () => {
        store.vanishOnReread = true;
        mocks.findUniqueCalls = 1;
        const { status, text, body } = await call(POST, 'POST', {
            username: 'newbie', email: 'newbie@example.test', password: 'pw-from-admin',
        });

        expect(status).toBe(404);
        expect(body).toEqual({ error: 'User not found.' });
        expect(text).not.toContain(BCRYPT_NEW);
    });

    it('still answers 401 to anyone but an admin', async () => {
        mocks.getToken.mockResolvedValue({ id: 'u_2', role: 'USER' });

        expect((await call(GET, 'GET')).status).toBe(401);
        expect((await call(PATCH, 'PATCH', { id: 'u_2', canDownload: true })).status).toBe(401);
        expect((await call(POST, 'POST', { username: 'x', email: 'x@example.test', password: 'p' })).status).toBe(401);
        expect(store.rows.get('u_2')?.canDownload).toBe(false);
    });
});
