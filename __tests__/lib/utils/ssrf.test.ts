import { describe, it, expect } from 'vitest';
import { isBlockedFetchHost, assertSafeFetchUrl } from '@/lib/utils/ssrf';

describe('SSRF: isBlockedFetchHost', () => {
    it('blocks loopback / private / link-local / internal hosts', () => {
        for (const h of [
            'localhost', 'foo.local', 'svc.internal',
            '127.0.0.1', '0.0.0.0',
            '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.169.254',
            '::1', '::', 'fe80::1', 'fd00::1',
            '2130706433', // decimal form of 127.0.0.1
        ]) {
            expect(isBlockedFetchHost(h), h).toBe(true);
        }
    });

    it('allows public hosts (including the boundaries of the 172.16/12 block)', () => {
        for (const h of ['getcomics.org', 'comicvine.gamespot.com', 'example.com', '8.8.8.8', '172.15.0.1', '172.32.0.1']) {
            expect(isBlockedFetchHost(h), h).toBe(false);
        }
    });
});

describe('SSRF: assertSafeFetchUrl', () => {
    it('returns the parsed URL for a public http(s) address', () => {
        expect(assertSafeFetchUrl('https://getcomics.org/x.cbz').hostname).toBe('getcomics.org');
    });

    it('rejects internal targets (cloud metadata, localhost, obfuscated decimal IP)', () => {
        expect(() => assertSafeFetchUrl('http://169.254.169.254/latest/meta-data/')).toThrow();
        expect(() => assertSafeFetchUrl('http://localhost:8080/admin')).toThrow();
        expect(() => assertSafeFetchUrl('http://2130706433/')).toThrow();
    });

    it('rejects non-http(s) schemes and malformed URLs', () => {
        expect(() => assertSafeFetchUrl('file:///etc/passwd')).toThrow();
        expect(() => assertSafeFetchUrl('ftp://example.com/x')).toThrow();
        expect(() => assertSafeFetchUrl('not a url')).toThrow();
    });
});
