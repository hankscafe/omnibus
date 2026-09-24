/**
 * Origin resolution for consumers that receive absolute URLs from us (OPDS clients, PSE links).
 *
 * OPDS routes used to build every link from `new URL(req.url).origin`. Behind a reverse proxy that
 * origin is the address the Next.js server itself was started on, not the address the client
 * reached us through: the standalone server derives the request URL from `process.env.HOSTNAME`
 * and `PORT` (see `next-server.js`, `initUrl`). A container that binds `0.0.0.0` therefore
 * published a catalog whose entries pointed at `https://0.0.0.0:3000/api/opds/series`, and
 * `hostname:container-id:3000` when HOSTNAME is left at the Docker default — neither is reachable
 * from the reader, so following any entry fails with a client-side error before the request ever
 * reaches the server (KOReader reports "Cannot get catalog. Server response status: Invalid
 * argument").
 *
 * A reverse proxy already knows what the client used: use it first, then the canonical URL the app
 * configures elsewhere (`NEXTAUTH_URL`), then the request URL for direct/unproxied access.
 */
export function resolvePublicBaseUrl(input: {
    forwardedHost?: string | null;
    forwardedProto?: string | null;
    canonicalUrl?: string | null;
    requestUrl?: string | null;
}): string {
    const host = firstHeaderValue(input.forwardedHost);
    if (host) {
        // X-Forwarded-Host keeps the port the client used; a proxy may append a comma-separated
        // list, in which case the first entry is the original one.
        const proto = firstHeaderValue(input.forwardedProto)
            || schemeOf(input.canonicalUrl)
            || 'http';
        return `${proto}://${host}`;
    }

    const canonical = originOf(input.canonicalUrl);
    if (canonical) return canonical;

    return originOf(input.requestUrl) || '';
}

/** Route-level convenience wrapper: read the proxy headers, then the app's canonical URL. */
export function getPublicBaseUrl(req: Request): string {
    return resolvePublicBaseUrl({
        forwardedHost: req.headers.get('x-forwarded-host'),
        forwardedProto: req.headers.get('x-forwarded-proto'),
        canonicalUrl: process.env.NEXTAUTH_URL,
        requestUrl: req.url,
    });
}

function firstHeaderValue(value?: string | null): string | null {
    const first = (value || '').split(',')[0]?.trim();
    return first ? first : null;
}

function schemeOf(value?: string | null): string | null {
    try {
        const scheme = new URL((value || '').trim()).protocol.replace(':', '');
        return scheme || null;
    } catch {
        return null;
    }
}

function originOf(value?: string | null): string | null {
    try {
        const url = new URL((value || '').trim());
        return url.origin;
    } catch {
        return null;
    }
}
