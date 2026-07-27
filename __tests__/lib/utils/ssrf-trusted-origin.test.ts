// Issue #197: Prowlarr download links point back at Prowlarr itself — a LAN origin the SSRF
// guard rightly blocks for untrusted input. An origin the ADMIN typed into settings is
// first-party infrastructure, so exactly that origin (scheme+host+port) may bypass the
// internal-host block. Everything else keeps the full guard.
import { describe, it, expect } from 'vitest';
import { isTrustedConfiguredOrigin } from '@/lib/utils/ssrf';

describe('isTrustedConfiguredOrigin (issue #197)', () => {
    const prowlarr = 'http://192.168.2.210:9696';

    it('matches only the exact configured origin', () => {
        expect(isTrustedConfiguredOrigin('http://192.168.2.210:9696/1/download?apikey=x&link=y', [prowlarr])).toBe(true);
        expect(isTrustedConfiguredOrigin('http://192.168.2.210:9696', [prowlarr + '/'])).toBe(true); // trailing slash on the setting
        expect(isTrustedConfiguredOrigin('http://192.168.2.210:9697/download', [prowlarr])).toBe(false); // other port
        expect(isTrustedConfiguredOrigin('https://192.168.2.210:9696/download', [prowlarr])).toBe(false); // other scheme
        expect(isTrustedConfiguredOrigin('http://192.168.2.211:9696/download', [prowlarr])).toBe(false); // other host
    });

    it('never trusts when nothing is configured, and ignores junk config values', () => {
        expect(isTrustedConfiguredOrigin('http://192.168.2.210:9696/download', [])).toBe(false);
        expect(isTrustedConfiguredOrigin('http://192.168.2.210:9696/download', [null, undefined, ''])).toBe(false);
        expect(isTrustedConfiguredOrigin('http://192.168.2.210:9696/download', ['not a url'])).toBe(false);
    });

    it('refuses non-http(s) targets outright', () => {
        expect(isTrustedConfiguredOrigin('file:///etc/passwd', [prowlarr])).toBe(false);
        expect(isTrustedConfiguredOrigin('not a url at all', [prowlarr])).toBe(false);
    });
});
