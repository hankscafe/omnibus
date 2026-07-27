// src/lib/utils/ssrf.ts
//
// SSRF guard for server-side fetches of UNTRUSTED / scraped URLs (CBL import, scraped hoster download
// links, etc.). Rejects non-http(s) schemes and hosts in loopback / private / link-local space — cloud
// metadata (169.254.169.254), localhost, RFC1918, IPv6 loopback/ULA/link-local. The WHATWG URL parser
// normalizes obfuscated IPv4 literals (decimal/hex/octal) for http(s), so the dotted-decimal checks below
// also catch http://2130706433 etc. This raises the bar against scrape-poisoning; it does NOT re-resolve
// DNS, so it is not a full DNS-rebinding defense.

export function isBlockedFetchHost(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, ''); // strip IPv6 brackets

    // Internal-looking hostnames
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;

    // Obfuscated literal IPv4 (decimal / hex) — no legitimate hostname is purely numeric or 0x-prefixed.
    // (WHATWG URL usually normalizes these to dotted-decimal, but block defensively in case it didn't.)
    if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/.test(h)) return true;

    // IPv4 loopback / unspecified / private / link-local
    if (/^127\./.test(h)) return true;
    if (/^0\./.test(h) || h === '0.0.0.0') return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (/^169\.254\./.test(h)) return true;

    // IPv6 loopback / unspecified / unique-local (fc00::/7) / link-local (fe80::/10), incl. IPv4-mapped
    if (h === '::1' || h === '::') return true;
    if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
    if (/^::ffff:(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return true;

    return false;
}

/**
 * True when `rawUrl` targets the exact same origin (scheme+host+port) as one of the
 * admin-configured base URLs (issue #197: Prowlarr download links point back at Prowlarr itself —
 * usually a LAN host the internal-host block rightly rejects for untrusted input, but an origin
 * the admin typed into settings is first-party infrastructure, not scraped data). Callers may
 * bypass assertSafeFetchUrl for exactly that origin; redirect hops must still be validated
 * individually (assertSafeRedirect), so a trusted first hop cannot bounce to an internal target.
 */
export function isTrustedConfiguredOrigin(rawUrl: string, configuredBaseUrls: (string | null | undefined)[]): boolean {
    let target: URL;
    try {
        target = new URL(rawUrl);
    } catch {
        return false;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
    for (const base of configuredBaseUrls) {
        if (!base) continue;
        try {
            const b = new URL(base);
            if ((b.protocol === 'http:' || b.protocol === 'https:') && b.origin === target.origin) return true;
        } catch { /* unparseable configured value — never widens trust */ }
    }
    return false;
}

/**
 * Validate a URL before fetching it server-side. Returns the parsed URL or throws with a safe message.
 */
export function assertSafeFetchUrl(rawUrl: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('Refusing to fetch a malformed URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Refusing to fetch a non-http(s) URL (${parsed.protocol}).`);
    }
    if (isBlockedFetchHost(parsed.hostname)) {
        throw new Error(`Refusing to fetch an internal/private address (${parsed.hostname}).`);
    }
    return parsed;
}

/**
 * axios `beforeRedirect` hook: re-validate every redirect hop so a public URL can't bounce to an internal
 * host. Defensive about the option shape — only blocks when it can parse a target AND that target is
 * blocked (the initial URL is validated separately by assertSafeFetchUrl).
 */
export function assertSafeRedirect(options: any): void {
    let next: string | null = null;
    try {
        if (options?.href) next = String(options.href);
        else if (options?.protocol && options?.host) next = `${options.protocol}//${options.host}${options.path || ''}`;
    } catch {
        next = null;
    }
    if (next) assertSafeFetchUrl(next);
}
