// src/lib/csp.ts
//
// The Content-Security-Policy every page is served with (the middleware sets it; v1.4.11-beta.035).
// Scripts run only with the request's nonce - Next's own, the root layout's theme script, next-themes' -
// or when one of those loads them ('strict-dynamic'). So markup injected into a page can't run script:
// an <img onerror=…> or <script> in a description that got past the sanitizer (beta.034's bug) is inert.
// Runs in the middleware's edge runtime: no Node imports.

export type CspMode = 'enforce' | 'report-only' | 'off';

/**
 * OMNIBUS_CSP: unset / "enforce" = block; "report-only" = only report violations (browser console);
 * "off" = no policy. The escape hatch for a setup the policy breaks - a reverse proxy that injects its
 * own scripts, say. Anything it doesn't recognise enforces: a typo must not switch protection off.
 */
export function cspMode(value: string | undefined): CspMode {
    const v = (value ?? '').trim().toLowerCase();
    if (v === 'off') return 'off';
    if (v === 'report-only') return 'report-only';
    return 'enforce';
}

export function cspHeaderName(mode: CspMode): 'Content-Security-Policy' | 'Content-Security-Policy-Report-Only' | null {
    if (mode === 'off') return null;
    return mode === 'report-only' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
}

/** A fresh nonce per request: base64 of 16 random bytes. */
export function makeNonce(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes));
}

export function buildCsp(nonce: string, { dev }: { dev: boolean }): string {
    const directives: Record<string, string[]> = {
        'default-src': ["'self'"],
        // 'self' is the fallback for browsers without 'strict-dynamic' (which ignore it otherwise).
        // The dev server evaluates modules with eval (React Refresh); production never does.
        'script-src': ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])],
        // React writes style="" attributes and Next inlines CSS: inline styles stay allowed. No nonce
        // here - a nonce makes browsers ignore 'unsafe-inline'. Styles can't run script.
        'style-src': ["'self'", "'unsafe-inline'"],
        // Covers come straight from the providers (ComicVine, Metron, MangaDex …) and the reader shows
        // pages as blob: URLs. Images can't run script either.
        'img-src': ["'self'", 'data:', 'blob:', 'https:', 'http:'],
        'font-src': ["'self'", 'data:'],
        // Every fetch the pages make is to the app itself; the dev server adds its hot-reload socket.
        'connect-src': ["'self'", ...(dev ? ['ws:', 'wss:'] : [])],
        'media-src': ["'self'", 'blob:'],
        'worker-src': ["'self'", 'blob:'],
        'manifest-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'frame-ancestors': ["'none'"],
        // Left out on purpose: form-action (signing in with SSO posts a form that redirects to the
        // identity provider, which form-action would block) and upgrade-insecure-requests (many
        // installs are served over plain http on a LAN, where it would break every request).
    };
    return Object.entries(directives).map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}
