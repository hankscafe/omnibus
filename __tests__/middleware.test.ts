import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

// 1. Hoist the auth mock
const mocks = vi.hoisted(() => ({
    getToken: vi.fn()
}));

// 2. Mock next-auth's token extractor to simulate logged in vs logged out
vi.mock('next-auth/jwt', () => ({
    getToken: mocks.getToken
}));

describe('Security: Next.js Front-Door Middleware', () => {

    // Helper to easily generate incoming requests
    const createReq = (pathname: string) => {
        const req = new NextRequest(`http://localhost${pathname}`);
        // Add a dummy cookie so NextAuth doesn't instantly reject it as malformed
        req.cookies.set('next-auth.session-token', 'dummy_token');
        return req;
    };

    it('should redirect unauthenticated users from protected UI routes to the login page', async () => {
        mocks.getToken.mockResolvedValueOnce(null); // No active session
        const req = createReq('/library');
        const res = await middleware(req) as Response;

        expect([302, 307]).toContain(res?.status);
        expect(res?.headers.get('Location')).toMatch(/\/login/);
    });

    it('should allow authenticated users to seamlessly access protected UI routes', async () => {
        mocks.getToken.mockResolvedValueOnce({ id: 'user_123', role: 'USER' });
        const req = createReq('/library');
        const res = await middleware(req) as Response;

        expect(res?.headers.get('Location')).toBeNull();
        
        // FIX: Next.js exposes modified request headers on the response using this specific prefix!
        expect(res.headers.get('x-middleware-request-x-pathname')).toBe('/library');
    });

    it('should redirect standard users away from /admin pages back to the home page', async () => {
        mocks.getToken.mockResolvedValueOnce({ id: 'user_123', role: 'USER' });
        const req = createReq('/admin/settings');
        const res = await middleware(req) as Response;

        expect([302, 307]).toContain(res?.status);
        expect(res?.headers.get('Location')).toBe('http://localhost/');
    });

    it('should return 401 Unauthorized JSON for unauthenticated API requests', async () => {
        mocks.getToken.mockResolvedValueOnce(null);
        const req = createReq('/api/library/series');
        const res = await middleware(req) as Response;

        expect(res?.status).toBe(401);
        const data = await res.json();
        expect(data.error).toBe('Unauthorized Access');
    });

    it('should return 403 Forbidden JSON for standard users accessing admin APIs', async () => {
        mocks.getToken.mockResolvedValueOnce({ id: 'user_123', role: 'USER' });
        const req = createReq('/api/admin/users');
        const res = await middleware(req) as Response;

        expect(res?.status).toBe(403);
        const data = await res.json();
        expect(data.error).toBe('Forbidden: Admin privileges required.');
    });

    // Issue #178: the Rust engine calls /api/internal/* with an X-Internal-Secret header and no
    // NextAuth cookie. The middleware must pass these through — each handler self-authenticates via
    // secretsMatch() — otherwise every engine notify/log callback dies at 401 before the secret is
    // ever checked.
    it('should pass engine /api/internal callbacks through to their self-authenticating handlers', async () => {
        for (const pathname of ['/api/internal/notify', '/api/internal/log']) {
            mocks.getToken.mockResolvedValueOnce(null); // engine has no session cookie
            const res = await middleware(createReq(pathname)) as Response;

            expect(res?.status, `${pathname} must not be blocked by the middleware`).not.toBe(401);
            // Pass-through (not a redirect/deny): the pathname header the middleware forwards is set.
            expect(res.headers.get('x-middleware-request-x-pathname')).toBe(pathname);
        }
    });

    // Admin auto-logout: once the jwt callback flags a session as expired the cookie holds a
    // truthy { error: "SessionExpired" } token. `isAuth = !!token` treated that as logged-in,
    // leaving enforcement entirely to a client-side effect. The middleware must reject it.
    describe('inactivity expiry enforcement', () => {
        const HOUR = 60 * 60 * 1000;

        it('redirects a SessionExpired-flagged token to /login on UI routes', async () => {
            mocks.getToken.mockResolvedValueOnce({ error: 'SessionExpired' });
            const res = await middleware(createReq('/library')) as Response;

            expect([302, 307]).toContain(res?.status);
            expect(res?.headers.get('Location')).toMatch(/\/login/);
        });

        it('returns 401 for a SessionExpired-flagged token on API routes', async () => {
            mocks.getToken.mockResolvedValueOnce({ error: 'SessionExpired' });
            const res = await middleware(createReq('/api/library/series')) as Response;

            expect(res?.status).toBe(401);
        });

        it('rejects an admin token whose lastActive is beyond the 2h window even if the cookie was never rewritten', async () => {
            mocks.getToken.mockResolvedValueOnce({ id: 'admin_1', role: 'ADMIN', lastActive: Date.now() - 3 * HOUR });
            const res = await middleware(createReq('/admin/settings')) as Response;

            expect([302, 307]).toContain(res?.status);
            expect(res?.headers.get('Location')).toMatch(/\/login/);
        });

        it('still admits an admin token inside the window', async () => {
            mocks.getToken.mockResolvedValueOnce({ id: 'admin_1', role: 'ADMIN', lastActive: Date.now() - 30 * 60 * 1000 });
            const res = await middleware(createReq('/admin/settings')) as Response;

            expect(res?.headers.get('Location')).toBeNull();
            expect(res.headers.get('x-middleware-request-x-pathname')).toBe('/admin/settings');
        });

        it('gives a regular USER the 6h window (3h idle still admitted)', async () => {
            mocks.getToken.mockResolvedValueOnce({ id: 'user_1', role: 'USER', lastActive: Date.now() - 3 * HOUR });
            const res = await middleware(createReq('/library')) as Response;

            expect(res?.headers.get('Location')).toBeNull();
        });
    });
});