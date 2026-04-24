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
    beforeEach(() => {
        vi.clearAllMocks();
    });

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
});