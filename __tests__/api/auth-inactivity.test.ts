// __tests__/api/auth-inactivity.test.ts
//
// Admin auto-logout regression: the jwt callback used to refresh token.lastActive on EVERY run,
// so the SessionProvider's 300s background refetch (plus the 60s notification poll) kept every
// open tab alive forever and the 2h admin inactivity window never elapsed. These tests pin the
// fixed contract: ambient reads only CHECK expiry; only sign-in and the client activity ping
// (trigger "update") slide the window — and a ping can never revive an already-expired session.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
    process.env.NEXTAUTH_SECRET = 'super_secure_test_secret_key_1234567890';
    return {
        systemSettingFindMany: vi.fn(),
        userFindUnique: vi.fn(),
        log: vi.fn(),
    };
});

import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findMany: mocks.systemSettingFindMany },
        user: { findUnique: mocks.userFindUnique },
    }
}));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('@/lib/encryption', () => ({ decrypt2FA: vi.fn() }));
// The jwt callback reads the impersonation cookie; outside a request scope cookies() would throw.
vi.mock('next/headers', () => ({
    cookies: vi.fn().mockResolvedValue({ get: () => undefined })
}));

const HOUR = 60 * 60 * 1000;

// lastSessionCheck is fresh so the 5-minute sessionVersion DB sweep stays out of the way.
const liveToken = (overrides: Record<string, any> = {}) => ({
    id: 'admin_1',
    role: 'ADMIN',
    sessionVersion: 0,
    lastActive: Date.now() - 30 * 60 * 1000,
    lastSessionCheck: Date.now(),
    ...overrides,
});

const getJwtCallback = async () => {
    mocks.systemSettingFindMany.mockResolvedValue([]);
    const options = await getAuthOptions();
    return options.callbacks!.jwt as any;
};

describe('Security: session inactivity window (jwt callback)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does NOT slide lastActive on an ambient session read (background refetch/poll)', async () => {
        const jwt = await getJwtCallback();
        const before = Date.now() - 30 * 60 * 1000;

        const result = await jwt({ token: liveToken({ lastActive: before }), user: undefined, trigger: undefined, session: undefined });

        expect(result.error).toBeUndefined();
        // The refetch must not count as activity — otherwise the window never elapses.
        expect(result.lastActive).toBe(before);
    });

    it('expires an admin idle beyond 2 hours', async () => {
        const jwt = await getJwtCallback();

        const result = await jwt({ token: liveToken({ lastActive: Date.now() - 2 * HOUR - 60_000 }), user: undefined, trigger: undefined, session: undefined });

        expect(result).toEqual({ error: 'SessionExpired' });
    });

    it('keeps a regular USER alive at 3h idle (6h window) while an admin would be expired', async () => {
        const jwt = await getJwtCallback();
        const threeHoursAgo = Date.now() - 3 * HOUR;

        const userResult = await jwt({ token: liveToken({ id: 'user_1', role: 'USER', lastActive: threeHoursAgo }), user: undefined, trigger: undefined, session: undefined });
        const adminResult = await jwt({ token: liveToken({ lastActive: threeHoursAgo }), user: undefined, trigger: undefined, session: undefined });

        expect(userResult.error).toBeUndefined();
        expect(adminResult).toEqual({ error: 'SessionExpired' });
    });

    it('slides lastActive on the client activity ping (trigger "update")', async () => {
        const jwt = await getJwtCallback();
        const before = Date.now() - 30 * 60 * 1000;

        const result = await jwt({ token: liveToken({ lastActive: before }), user: undefined, trigger: 'update', session: undefined });

        expect(result.error).toBeUndefined();
        expect(result.lastActive).toBeGreaterThan(before);
    });

    it('does NOT let an activity ping revive an already-expired session', async () => {
        const jwt = await getJwtCallback();

        const result = await jwt({ token: liveToken({ lastActive: Date.now() - 3 * HOUR }), user: undefined, trigger: 'update', session: undefined });

        expect(result).toEqual({ error: 'SessionExpired' });
    });

    it('stamps lastActive at sign-in', async () => {
        const jwt = await getJwtCallback();
        const start = Date.now();

        const result = await jwt({
            token: {},
            user: { id: 'admin_1', role: 'ADMIN', image: null, sessionVersion: 0 },
            trigger: 'signIn',
            session: undefined,
        });

        expect(result.error).toBeUndefined();
        expect(result.lastActive).toBeGreaterThanOrEqual(start);
    });
});
