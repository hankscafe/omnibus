// beta.014: this file tests the REAL module — undo setup-global's suite-wide mock.
vi.unmock('@/app/api/auth/[...nextauth]/options');
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
import { loggerLog } from '../helpers/setup-global';

vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findMany: mocks.systemSettingFindMany },
        user: { findUnique: mocks.userFindUnique },
    }
}));
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

// Fork review 2026-07-29, their #4: the sessionVersion sweep and the impersonation lookups used to
// run bare — a THROWN prisma read (SQLite busy while a restore monopolizes the single connection,
// a pg blip) blew up the jwt callback and logged every open tab out. The fixed contract: thrown
// reads fail OPEN (token survives, check deferred one 5-minute cycle); reads that RESOLVE keep
// their teeth — a missing user or a version mismatch still revokes.
describe('Security: transient DB errors must not kill the session (jwt callback)', () => {

    // Token whose lastSessionCheck is stale, so the 5-minute sessionVersion sweep MUST run.
    const sweepDueToken = (overrides: Record<string, any> = {}) => liveToken({
        lastSessionCheck: Date.now() - 6 * 60 * 1000,
        ...overrides,
    });

    it('keeps the session alive when the sessionVersion read THROWS, and defers the recheck', async () => {
        const jwt = await getJwtCallback();
        mocks.userFindUnique.mockRejectedValue(new Error('Timed out fetching a new connection from the connection pool (P2024)'));
        const staleCheck = Date.now() - 6 * 60 * 1000;

        const result = await jwt({ token: sweepDueToken({ lastSessionCheck: staleCheck }), user: undefined, trigger: undefined, session: undefined });

        expect(result.error).toBeUndefined();
        expect(result.id).toBe('admin_1');
        // Deferred to the next 5-minute cycle — a struggling DB gets one probe per cycle, not one per fetch.
        expect(result.lastSessionCheck).toBeGreaterThan(staleCheck);
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('deferred'), 'warn');
    });

    it('still revokes when the read RESOLVES null (deleted account is not a transient error)', async () => {
        const jwt = await getJwtCallback();
        mocks.userFindUnique.mockResolvedValue(null);

        const result = await jwt({ token: sweepDueToken(), user: undefined, trigger: undefined, session: undefined });

        expect(result).toEqual({ error: 'SessionExpired' });
    });

    it('still revokes on a sessionVersion mismatch', async () => {
        const jwt = await getJwtCallback();
        mocks.userFindUnique.mockResolvedValue({ sessionVersion: 5 });

        const result = await jwt({ token: sweepDueToken({ sessionVersion: 0 }), user: undefined, trigger: undefined, session: undefined });

        expect(result).toEqual({ error: 'SessionExpired' });
    });

    it('keeps the token unchanged for this round when the impersonation revert lookup throws', async () => {
        const jwt = await getJwtCallback();
        // Fresh lastSessionCheck keeps the sweep out of the way; the only DB read is the revert
        // lookup (isImpersonating with no cookie present).
        mocks.userFindUnique.mockRejectedValue(new Error('db unreachable'));

        const result = await jwt({
            token: liveToken({ id: 'user_2', role: 'USER', isImpersonating: true, originalAdminId: 'admin_1' }),
            user: undefined, trigger: undefined, session: undefined,
        });

        expect(result.error).toBeUndefined();
        // Unchanged this round — the revert simply retries on the next callback run.
        expect(result.id).toBe('user_2');
        expect(result.isImpersonating).toBe(true);
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('deferred'), 'warn');
    });
});
