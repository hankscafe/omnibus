import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as authorize } from '@/app/api/koreader/users/auth/route';
import { POST as createUser } from '@/app/api/koreader/users/create/route';

const mocks = vi.hoisted(() => ({
    authenticateKoreader: vi.fn(),
    log: vi.fn(),
}));

vi.mock('@/lib/koreader-auth', () => ({
    authenticateKoreader: mocks.authenticateKoreader,
    koreaderUnauthorizedResponse: (message: string) => Response.json({
        code: 2001,
        message: message === 'Unauthorized'
            ? 'Unauthorized. Use an API key created after KOReader support was added.'
            : message,
    }, { status: 401 }),
}));

vi.mock('@/lib/logger', () => ({
    Logger: { log: mocks.log },
}));

const USER = { id: 'user_1', username: 'nicolas', role: 'USER' };

function authRequest(password = 'client-md5') {
    return new Request('http://localhost/api/koreader/users/auth', {
        headers: {
            'x-auth-user': 'nicolas',
            'x-auth-key': password,
        },
    });
}

describe('KOReader user protocol', () => {
    beforeEach(() => {
        mocks.authenticateKoreader.mockResolvedValue({ user: null, error: 'Unauthorized' });
    });

    it('returns a protocol-readable 401 message for failed login', async () => {
        const response = await authorize(authRequest());

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
            code: 2001,
            message: 'Unauthorized. Use an API key created after KOReader support was added.',
        });
    });

    it('returns the matched username for Register when credentials are valid', async () => {
        mocks.authenticateKoreader.mockResolvedValue({ user: USER, error: null });
        const request = new Request('http://localhost/api/koreader/users/create', {
            method: 'POST',
            body: JSON.stringify({ username: 'nicolas', password: 'client-md5' }),
        });

        const response = await createUser(request);

        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toEqual({ username: 'nicolas' });
    });

    it('returns a protocol-readable 402 when Register credentials are invalid', async () => {
        const request = new Request('http://localhost/api/koreader/users/create', {
            method: 'POST',
            body: JSON.stringify({ username: 'nicolas', password: 'wrong-md5' }),
        });

        const response = await createUser(request);

        expect(response.status).toBe(402);
        await expect(response.json()).resolves.toEqual({
            code: 2002,
            message: 'Unauthorized. Use an API key created after KOReader support was added.',
        });
    });

    it('uses the internal-error code for an unexpected Register failure', async () => {
        mocks.authenticateKoreader.mockRejectedValue(new Error('database unavailable'));
        const request = new Request('http://localhost/api/koreader/users/create', {
            method: 'POST',
            body: JSON.stringify({ username: 'nicolas', password: 'client-md5' }),
        });

        const response = await createUser(request);

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({
            code: 2000,
            message: 'Unable to validate KOReader credentials',
        });
    });
});
