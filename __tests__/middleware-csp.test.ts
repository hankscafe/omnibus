// The middleware gives every PAGE request a Content-Security-Policy with a fresh nonce, and hands that
// nonce to the render (the x-nonce request header for the root layout's inline script; the policy itself,
// which Next reads to put the nonce on its own scripts). API routes answer JSON / files: no policy.
// OMNIBUS_CSP=report-only|off is the escape hatch for a setup the policy breaks (a proxy injecting scripts).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

const mocks = vi.hoisted(() => ({ getToken: vi.fn() }));
vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }));

const page = async (pathname: string, headers: Record<string, string> = {}, signedIn = true) => {
    mocks.getToken.mockResolvedValueOnce(signedIn ? { id: 'user_1', role: 'USER', lastActive: Date.now() } : null);
    const req = new NextRequest(`http://localhost${pathname}`, { headers });
    req.cookies.set('next-auth.session-token', 'dummy_token');
    return await middleware(req) as Response;
};
// NextResponse.next({ request: { headers } }) exposes the forwarded request headers with this prefix.
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);
const nonceIn = (policy: string | null) => policy?.match(/'nonce-([^']+)'/)?.[1] ?? null;

afterEach(() => { vi.unstubAllEnvs(); });

describe('Middleware: Content-Security-Policy on pages', () => {
    it('a page answers with the policy, and the render gets the same nonce', async () => {
        const res = await page('/library');

        const policy = res.headers.get('Content-Security-Policy');
        expect(policy).toContain("script-src 'self' 'nonce-");
        expect(policy).toContain("'strict-dynamic'");
        const nonce = nonceIn(policy);
        expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
        expect(forwarded(res, 'x-nonce')).toBe(nonce);
        expect(forwarded(res, 'content-security-policy')).toBe(policy);
        expect(res.headers.get('Content-Security-Policy-Report-Only')).toBeNull();
        // The existing forwarding is untouched.
        expect(forwarded(res, 'x-pathname')).toBe('/library');
    });

    it('every request gets its own nonce', async () => {
        const a = nonceIn((await page('/library')).headers.get('Content-Security-Policy'));
        const b = nonceIn((await page('/library')).headers.get('Content-Security-Policy'));
        expect(a).not.toBe(b);
    });

    it('the sign-in page has it too (signed out, nothing to redirect)', async () => {
        const res = await page('/login', {}, false);
        expect(res.headers.get('Location')).toBeNull();
        expect(nonceIn(res.headers.get('Content-Security-Policy'))).not.toBeNull();
    });

    it("a nonce or policy the browser sends is replaced, never passed on", async () => {
        const res = await page('/library', { 'x-nonce': 'attacker', 'content-security-policy': "script-src 'nonce-attacker'" });
        const nonce = nonceIn(res.headers.get('Content-Security-Policy'));
        expect(forwarded(res, 'x-nonce')).toBe(nonce);
        expect(nonce).not.toBe('attacker');
        expect(forwarded(res, 'content-security-policy')).not.toContain('attacker');
    });

    it('API routes get no policy and no nonce', async () => {
        mocks.getToken.mockResolvedValueOnce({ id: 'user_1', role: 'USER', lastActive: Date.now() });
        const res = await middleware(new NextRequest('http://localhost/api/library/series')) as Response;
        expect(res.headers.get('Content-Security-Policy')).toBeNull();
        expect(forwarded(res, 'x-nonce')).toBeNull();
        expect(forwarded(res, 'content-security-policy')).toBeNull();
    });

    it('OMNIBUS_CSP=report-only reports instead of blocking, with the nonce still applied', async () => {
        vi.stubEnv('OMNIBUS_CSP', 'report-only');
        const res = await page('/library');

        expect(res.headers.get('Content-Security-Policy')).toBeNull();
        const policy = res.headers.get('Content-Security-Policy-Report-Only');
        const nonce = nonceIn(policy);
        expect(nonce).not.toBeNull();
        expect(forwarded(res, 'x-nonce')).toBe(nonce);
        // Next reads either header for the nonce of its own scripts.
        expect(forwarded(res, 'content-security-policy-report-only')).toBe(policy);
        expect(forwarded(res, 'content-security-policy')).toBeNull();
    });

    it('OMNIBUS_CSP=off sends no policy, and passes no nonce - not even one the browser sent', async () => {
        vi.stubEnv('OMNIBUS_CSP', 'off');
        const res = await page('/library', { 'x-nonce': 'attacker', 'content-security-policy': "script-src 'nonce-attacker'" });

        expect(res.headers.get('Content-Security-Policy')).toBeNull();
        expect(res.headers.get('Content-Security-Policy-Report-Only')).toBeNull();
        expect(forwarded(res, 'x-nonce')).toBeNull();
        expect(forwarded(res, 'content-security-policy')).toBeNull();
        expect(forwarded(res, 'x-pathname')).toBe('/library');
    });

    it('development adds eval for the dev server; production does not', async () => {
        vi.stubEnv('NODE_ENV', 'development');
        expect((await page('/library')).headers.get('Content-Security-Policy')).toContain("'unsafe-eval'");
        vi.stubEnv('NODE_ENV', 'production');
        expect((await page('/library')).headers.get('Content-Security-Policy')).not.toContain("'unsafe-eval'");
    });
});
