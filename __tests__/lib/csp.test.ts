// The Content-Security-Policy every page carries (beta.034 follow-up): a per-request nonce for scripts,
// so markup injected into a page - an `<img onerror=…>` in a description, say - can't run script even if
// it gets past the sanitizer.
import { describe, it, expect } from 'vitest';
import { buildCsp, cspMode, cspHeaderName, makeNonce } from '@/lib/csp';

/** The policy as { directive: [sources] }. */
const directives = (policy: string) => Object.fromEntries(policy.split(';').map(d => d.trim()).filter(Boolean)
    .map(d => { const [name, ...sources] = d.split(/\s+/); return [name, sources]; }));

describe('buildCsp', () => {
    const prod = directives(buildCsp('abc123', { dev: false }));

    it('lets scripts run only with the nonce (and what they load), never inline handlers or eval', () => {
        expect(prod['script-src']).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
        expect(prod['script-src']).not.toContain("'unsafe-inline'");
        expect(prod['script-src']).not.toContain("'unsafe-eval'");
    });

    it('allows inline styles (React writes style attributes) without a nonce, which would switch that off', () => {
        expect(prod['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    });

    it('allows images from anywhere - covers come straight from the providers - plus data: and blob: (the reader)', () => {
        expect(prod['img-src']).toEqual(["'self'", 'data:', 'blob:', 'https:', 'http:']);
    });

    it('keeps everything else to the app itself', () => {
        expect(prod['default-src']).toEqual(["'self'"]);
        expect(prod['connect-src']).toEqual(["'self'"]);
        expect(prod['font-src']).toEqual(["'self'", 'data:']);
        expect(prod['worker-src']).toEqual(["'self'", 'blob:']);
        expect(prod['manifest-src']).toEqual(["'self'"]);
        expect(prod['media-src']).toEqual(["'self'", 'blob:']);
    });

    it('shuts plugins, base-tag hijacks and framing out', () => {
        expect(prod['object-src']).toEqual(["'none'"]);
        expect(prod['base-uri']).toEqual(["'self'"]);
        expect(prod['frame-ancestors']).toEqual(["'none'"]);
    });

    it('leaves out form-action (SSO sign-in posts, then redirects to the identity provider) and upgrade-insecure-requests (plain-http LAN installs)', () => {
        expect(prod).not.toHaveProperty('form-action');
        expect(prod).not.toHaveProperty('upgrade-insecure-requests');
    });

    it("adds only what Next's dev server needs in development: eval and the hot-reload socket", () => {
        const dev = directives(buildCsp('abc123', { dev: true }));
        expect(dev['script-src']).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'", "'unsafe-eval'"]);
        expect(dev['connect-src']).toEqual(["'self'", 'ws:', 'wss:']);
        expect({ ...dev, 'script-src': null, 'connect-src': null }).toEqual({ ...prod, 'script-src': null, 'connect-src': null });
    });
});

describe('cspMode (OMNIBUS_CSP)', () => {
    it('enforces by default', () => {
        expect(cspMode(undefined)).toBe('enforce');
        expect(cspMode('')).toBe('enforce');
        expect(cspMode('enforce')).toBe('enforce');
    });

    it('reads report-only and off, in any case and with spaces', () => {
        expect(cspMode('report-only')).toBe('report-only');
        expect(cspMode(' Report-Only ')).toBe('report-only');
        expect(cspMode('off')).toBe('off');
        expect(cspMode('OFF')).toBe('off');
    });

    it('enforces on anything it does not recognise (a typo must not switch protection off)', () => {
        expect(cspMode('of')).toBe('enforce');
        expect(cspMode('false')).toBe('enforce');
        expect(cspMode('reportonly')).toBe('enforce');
    });

    it('names the header for each mode', () => {
        expect(cspHeaderName('enforce')).toBe('Content-Security-Policy');
        expect(cspHeaderName('report-only')).toBe('Content-Security-Policy-Report-Only');
        expect(cspHeaderName('off')).toBeNull();
    });
});

describe('makeNonce', () => {
    it('is base64 of 16 random bytes, new every time', () => {
        const a = makeNonce();
        const b = makeNonce();
        expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
        expect(a).not.toBe(b);
    });
});
