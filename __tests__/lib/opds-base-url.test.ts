// __tests__/lib/opds-base-url.test.ts
// The OPDS feeds hand absolute URLs to readers (KOReader, Panels, ...). Behind a reverse proxy the
// request URL carries the server's own bind address, which readers cannot reach, so the origin must
// come from the proxy headers and then from NEXTAUTH_URL instead.
import { describe, it, expect } from 'vitest';
import { resolvePublicBaseUrl, getPublicBaseUrl } from '@/lib/opds-base-url';

describe('resolvePublicBaseUrl()', () => {
    it('prefers the host and protocol the client reached us through', () => {
        expect(resolvePublicBaseUrl({
            forwardedHost: 'omnibus.example.com',
            forwardedProto: 'https',
            canonicalUrl: 'http://192.168.1.50:3000',
            requestUrl: 'https://0.0.0.0:3000/api/opds'
        })).toBe('https://omnibus.example.com');
    });

    it('keeps the port the proxy passed on', () => {
        expect(resolvePublicBaseUrl({
            forwardedHost: 'omnibus.example.com:8443',
            forwardedProto: 'https',
            requestUrl: 'https://0.0.0.0:3000/api/opds'
        })).toBe('https://omnibus.example.com:8443');
    });

    it('takes the first entry of a comma-separated proxy list', () => {
        expect(resolvePublicBaseUrl({
            forwardedHost: 'omnibus.example.com, internal.lb',
            forwardedProto: 'https, http',
            requestUrl: 'https://0.0.0.0:3000/api/opds'
        })).toBe('https://omnibus.example.com');
    });

    it('borrows the scheme from NEXTAUTH_URL when the proxy omits the protocol header', () => {
        expect(resolvePublicBaseUrl({
            forwardedHost: 'omnibus.example.com',
            canonicalUrl: 'https://omnibus.example.com',
            requestUrl: 'https://0.0.0.0:3000/api/opds'
        })).toBe('https://omnibus.example.com');
    });

    it('falls back to NEXTAUTH_URL when no proxy headers are present', () => {
        expect(resolvePublicBaseUrl({
            canonicalUrl: 'https://omnibus.example.com/',
            requestUrl: 'https://0.0.0.0:3000/api/opds'
        })).toBe('https://omnibus.example.com');
    });

    it('falls back to the request URL for direct, unproxied access', () => {
        expect(resolvePublicBaseUrl({
            requestUrl: 'http://192.168.1.50:3000/api/opds'
        })).toBe('http://192.168.1.50:3000');
    });

    it('never republishes the bind address when the client host is known', () => {
        const baseUrl = resolvePublicBaseUrl({
            forwardedHost: 'omnibus.example.com',
            forwardedProto: 'https',
            requestUrl: 'https://0.0.0.0:3000/api/opds'
        });
        expect(baseUrl).not.toContain('0.0.0.0');
        expect(baseUrl).not.toContain(':3000');
    });
});

describe('getPublicBaseUrl()', () => {
    it('reads the proxy headers off the request', () => {
        const req = new Request('https://0.0.0.0:3000/api/opds', {
            headers: { 'x-forwarded-host': 'omnibus.example.com', 'x-forwarded-proto': 'https' }
        });
        expect(getPublicBaseUrl(req)).toBe('https://omnibus.example.com');
    });

    it('ignores an empty forwarded host header', () => {
        const req = new Request('http://192.168.1.50:3000/api/opds', {
            headers: { 'x-forwarded-host': '   ' }
        });
        expect(getPublicBaseUrl(req)).toBe('http://192.168.1.50:3000');
    });
});
