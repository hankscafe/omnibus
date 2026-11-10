// GET /api/user/profile - the signed-in user's profile page data.
//
// The route reads the account's password column only to tell whether it's an SSO account (no local
// password). Until beta.028 it stripped the hash into a copy, flagged the COPY isSsoUser, and then sent
// the original: every profile load put the account's bcrypt hash in the browser (an admin impersonating
// someone got theirs), and the page's SSO checks never saw the flag. These tests pin what the reply may
// and must carry.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    getToken: vi.fn(),
    userFindUnique: vi.fn(),
}));

vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));
vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findUnique: mocks.userFindUnique },
        request: { findMany: vi.fn(async () => []) },
        readProgress: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
        trophy: { findMany: vi.fn(async () => []) },
        userTrophy: { findMany: vi.fn(async () => []) },
        $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    },
}));

import { GET } from '@/app/api/user/profile/route';

const BCRYPT = '$2b$12$abcdefghijklmnopqrstuuDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
const account = (password: string | null) => ({
    username: 'reader', role: 'USER', avatar: null, banner: null,
    createdAt: new Date('2026-01-02T03:04:05Z'), password,
});

const load = async () => {
    const res = await GET(new Request('http://localhost/api/user/profile'));
    return { status: res.status, body: await res.json() };
};

describe('GET /api/user/profile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getToken.mockResolvedValue({ id: 'user_1', role: 'USER' });
    });

    it('never sends the password hash', async () => {
        mocks.userFindUnique.mockResolvedValue(account(BCRYPT));
        const { status, body } = await load();

        expect(status).toBe(200);
        expect(body.user).not.toHaveProperty('password');
        expect(JSON.stringify(body)).not.toContain(BCRYPT);
    });

    it('says a local account is not SSO', async () => {
        mocks.userFindUnique.mockResolvedValue(account(BCRYPT));
        const { body } = await load();

        expect(body.user.isSsoUser).toBe(false);
        expect(body.user).toEqual({
            username: 'reader', role: 'USER', avatar: null, banner: null,
            createdAt: '2026-01-02T03:04:05.000Z', isSsoUser: false,
        });
    });

    it.each([['no password', null], ['an empty password', '']])('says an account with %s is SSO', async (_label, password) => {
        mocks.userFindUnique.mockResolvedValue(account(password));
        const { body } = await load();

        expect(body.user.isSsoUser).toBe(true);
        expect(body.user).not.toHaveProperty('password');
    });

    it('still answers 401 without a session and 404 for a missing account', async () => {
        mocks.getToken.mockResolvedValueOnce(null);
        expect((await load()).status).toBe(401);

        mocks.userFindUnique.mockResolvedValue(null);
        expect((await load()).status).toBe(404);
    });
});
