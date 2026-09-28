// __tests__/lib/opds-base-url.test.ts
// The OPDS feeds hand absolute URLs to readers (KOReader, Panels, ...). Behind a reverse proxy the
// request URL carries the server's own bind address, which readers cannot reach, so the origin must
// come from the proxy headers, then from NEXTAUTH_URL, then from the Host header the client sent.
// The resolved origin is interpolated unescaped into the feed XML, so a header value that looks
// like an origin but is not one (a quote, an ampersand, a javascript: scheme) must be dropped
// rather than published.
import { describe, it, expect, afterEach } from 'vitest';
import { resolvePublicBaseUrl, getPublicBaseUrl } from '@/lib/opds-base-url';

// The bind address of a Next.js standalone container: what the old code published.
const BIND_REQUEST_URL = 'https://0.0.0.0:3000/api/opds';

afterEach(() => {
    delete process.env.NEXTAUTH_URL;
});

describe('resolvePublicBaseUrl()', () => {
    it('prefers the host and protocol the client reached us through', () => {
        expect(resolvePublicBaseUrl({
            forwardedHost: 'omnibus.example.com',
            forwardedProto: 'https',
            canonicalUrl: 'http://192.168.1.50:3000',
            requestUrl: BIND_REQUEST_URL
        })).toBe('https://omnibus.example.com');
    });

    it('keeps the port the proxy passed on', () => {
        expect(resolvePublicBaseUrl({
            forwardedHost: 'omnibus.example.com:8443',
            forwardedProto: 'https',
            requestUrl: BIND_REQUEST_URL
        })).toBe('https://omnibus.example.com:8443');
    });

    it('takes the first entry of a comma-separated proxy list', () => {
        expect(resolvePublicBaseUrl({
            forwardedHost: 'omnibus.example.com, internal.lb',
            forwardedProto: 'https, http',
            requestUrl: BIND_REQUEST_URL
        })).toBe('https://omnibus.example.com');
    });

    it('borrows the scheme from NEXTAUTH_URL when the proxy omits the protocol header', () => {
        expect(resolvePublicBaseUrl({
            forwardedHost: 'omnibus.example.com',
            canonicalUrl: 'https://omnibus.example.com',
            requestUrl: BIND_REQUEST_URL
        })).toBe('https://omnibus.example.com');
    });

    it('accepts a bracketed IPv6 host with a port', () => {
        expect(resolvePublicBaseUrl({
            forwardedHost: '[2001:db8::1]:8080',
            forwardedProto: 'https',
            requestUrl: BIND_REQUEST_URL
        })).toBe('https://[2001:db8::1]:8080');
    });

    it('falls back to NEXTAUTH_URL when no proxy headers are present', () => {
        expect(resolvePublicBaseUrl({
            canonicalUrl: 'https://omnibus.example.com/',
            requestUrl: BIND_REQUEST_URL
        })).toBe('https://omnibus.example.com');
    });

    it('uses the Host header when there is no proxy header and no NEXTAUTH_URL', () => {
        expect(resolvePublicBaseUrl({
            hostHeader: '192.168.1.50:3000',
            requestUrl: BIND_REQUEST_URL
        })).toBe('https://192.168.1.50:3000');
    });

    it('uses the Host header when the request URL only carries the bind address', () => {
        const baseUrl = resolvePublicBaseUrl({
            hostHeader: 'omnibus.example.com',
            requestUrl: BIND_REQUEST_URL
        });
        expect(baseUrl).toBe('https://omnibus.example.com');
        expect(baseUrl).not.toContain('0.0.0.0');
    });

    it('takes the Host scheme from the request when the proxy sent none', () => {
        expect(resolvePublicBaseUrl({
            hostHeader: '192.168.1.50:3000',
            requestUrl: 'http://0.0.0.0:3000/api/opds'
        })).toBe('http://192.168.1.50:3000');
    });

    it('skips a loopback NEXTAUTH_URL in favour of the Host header', () => {
        // docker-compose.yml defaults NEXTAUTH_URL to http://localhost:3000: publishing that gives
        // a Kobo the same unreachable catalog as the container id.
        expect(resolvePublicBaseUrl({
            canonicalUrl: 'http://localhost:3000',
            hostHeader: '192.168.1.50:3000',
            requestUrl: 'http://0.0.0.0:3000/api/opds'
        })).toBe('http://192.168.1.50:3000');
    });

    it.each([
        'http://127.0.0.1:3000',
        'http://127.1.2.3:3000',
        'http://[::1]:3000'
    ])('skips the loopback canonical URL %s', (canonicalUrl) => {
        expect(resolvePublicBaseUrl({
            canonicalUrl,
            hostHeader: '192.168.1.50:3000',
            requestUrl: BIND_REQUEST_URL
        })).toBe('https://192.168.1.50:3000');
    });

    it('keeps a non-loopback canonical URL ahead of the Host header', () => {
        // A stock nginx proxy_pass rewrites Host to the upstream name (omnibus:3000) and sends no
        // x-forwarded-host: only the configured URL can be right there.
        expect(resolvePublicBaseUrl({
            canonicalUrl: 'https://omnibus.example.com',
            hostHeader: 'omnibus:3000',
            requestUrl: BIND_REQUEST_URL
        })).toBe('https://omnibus.example.com');
    });

    it.each([
        'a"b.com',
        "a'b.com",
        'a&b.com',
        'a b.com',
        'host/path',
        'user@host',
        'omnibus.example.com/../evil'
    ])('drops the forwarded host %s, which would break out of the href attribute', (forwardedHost) => {
        expect(resolvePublicBaseUrl({
            forwardedHost,
            forwardedProto: 'https',
            canonicalUrl: 'https://omnibus.example.com',
            requestUrl: BIND_REQUEST_URL
        })).toBe('https://omnibus.example.com');
    });

    it('drops a forwarded host that fails validation and uses the Host header next', () => {
        // The protocol header was valid, so the scheme it named survives; only the untrusted host
        // is dropped, and the Host header the client sent supplies the rest.
        expect(resolvePublicBaseUrl({
            forwardedHost: 'a"b.com',
            forwardedProto: 'https',
            hostHeader: '192.168.1.50:3000',
            requestUrl: 'http://0.0.0.0:3000/api/opds'
        })).toBe('https://192.168.1.50:3000');
    });

    it.each(['javascript', 'data', 'file', 'HTTP/1.1'])('drops the protocol header %s', (forwardedProto) => {
        expect(resolvePublicBaseUrl({
            forwardedHost: 'omnibus.example.com',
            forwardedProto,
            canonicalUrl: 'https://omnibus.example.com',
            requestUrl: BIND_REQUEST_URL
        })).toBe('https://omnibus.example.com');
    });

    it('does not publish a javascript: scheme even when the Host header is present', () => {
        expect(resolvePublicBaseUrl({
            forwardedHost: 'omnibus.example.com',
            forwardedProto: 'javascript',
            hostHeader: '192.168.1.50:3000',
            requestUrl: BIND_REQUEST_URL
        })).toBe('https://192.168.1.50:3000');
    });

    it('ignores a malformed NEXTAUTH_URL', () => {
        expect(resolvePublicBaseUrl({
            canonicalUrl: 'not a url',
            hostHeader: '192.168.1.50:3000',
            requestUrl: BIND_REQUEST_URL
        })).toBe('https://192.168.1.50:3000');
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
            requestUrl: BIND_REQUEST_URL
        });
        expect(baseUrl).not.toContain('0.0.0.0');
        expect(baseUrl).not.toContain(':3000');
    });
});

describe('getPublicBaseUrl()', () => {
    it('reads the proxy headers off the request', () => {
        const req = new Request(BIND_REQUEST_URL, {
            headers: { 'x-forwarded-host': 'omnibus.example.com', 'x-forwarded-proto': 'https' }
        });
        expect(getPublicBaseUrl(req)).toBe('https://omnibus.example.com');
    });

    it('reads the Host header off the request', () => {
        const req = new Request(BIND_REQUEST_URL, { headers: { host: '192.168.1.50:3000' } });
        expect(getPublicBaseUrl(req)).toBe('https://192.168.1.50:3000');
    });

    it('reads NEXTAUTH_URL when the proxy sends nothing, unless it is a loopback', () => {
        process.env.NEXTAUTH_URL = 'https://omnibus.example.com';
        expect(getPublicBaseUrl(new Request(BIND_REQUEST_URL))).toBe('https://omnibus.example.com');

        process.env.NEXTAUTH_URL = 'http://localhost:3000';
        const req = new Request(BIND_REQUEST_URL, { headers: { host: '192.168.1.50:3000' } });
        expect(getPublicBaseUrl(req)).toBe('https://192.168.1.50:3000');
    });

    it('ignores an empty forwarded host header', () => {
        const req = new Request('http://192.168.1.50:3000/api/opds', {
            headers: { 'x-forwarded-host': '   ' }
        });
        expect(getPublicBaseUrl(req)).toBe('http://192.168.1.50:3000');
    });
});
