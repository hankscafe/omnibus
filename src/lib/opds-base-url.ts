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
 * Sources, in order:
 *   1. `x-forwarded-host`, with `x-forwarded-proto` (or, when the proxy sends no protocol header,
 *      the scheme `NEXTAUTH_URL` already carries) — the proxy knows what the client used.
 *   2. `NEXTAUTH_URL`, unless it points at the loopback — the canonical URL the app already
 *      configures elsewhere (mailer, password reset, refresh-series). A reader is never on the
 *      server itself, so `http://localhost:3000` is no more publishable than the bind address.
 *   3. the `Host` header the client sent, with `x-forwarded-proto` or else the request's own
 *      scheme — direct access, and proxies that pass `Host` through.
 *   4. `new URL(req.url).origin` — last resort, exactly as before this change.
 *
 * These values end up **unescaped** in the feeds (`href="${baseUrl}/api/opds"`), so the ones that
 * come from headers are validated, not merely parsed: parsing alone is not a guard, since
 * `new URL('https://a"b.com').origin` keeps the quote and would break out of the attribute. Only
 * the client that sent the header sees the result and these links carry no API key, so the
 * severity is low — but a value that fails validation is dropped rather than trusted.
 */
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

export function resolvePublicBaseUrl(input: {
    forwardedHost?: string | null;
    forwardedProto?: string | null;
    hostHeader?: string | null;
    canonicalUrl?: string | null;
    requestUrl?: string | null;
}): string {
    const forwardedHost = firstHeaderValue(input.forwardedHost);
    const forwardedProto = firstHeaderValue(input.forwardedProto);

    // 1. What the reverse proxy says the client reached us through.
    const forwarded = originFrom(forwardedProto || schemeOf(input.canonicalUrl), forwardedHost);
    if (forwarded) return forwarded;

    // 2. The URL this app already considers canonical, when it is reachable from a reader.
    const canonical = publicCanonicalOrigin(input.canonicalUrl);
    if (canonical) return canonical;

    // 3. The Host header the client sent: direct access, and proxies that rewrite nothing but the
    //    scheme. A proxy that sent no usable protocol header leaves the request's own scheme.
    const direct = originFrom(validScheme(forwardedProto) || schemeOf(input.requestUrl), input.hostHeader);
    if (direct) return direct;

    // 4. Last resort: the request URL, which in standalone carries the bind address.
    return originOf(input.requestUrl) || '';
}

/** Route-level convenience wrapper: read the proxy, canonical and Host values off the request. */
export function getPublicBaseUrl(req: Request): string {
    return resolvePublicBaseUrl({
        forwardedHost: req.headers.get('x-forwarded-host'),
        forwardedProto: req.headers.get('x-forwarded-proto'),
        hostHeader: req.headers.get('host'),
        canonicalUrl: process.env.NEXTAUTH_URL,
        requestUrl: req.url,
    });
}

/** A proxy may append a comma-separated list; the first entry is the one the client used. */
function firstHeaderValue(value?: string | null): string | null {
    const first = (value || '').split(',')[0]?.trim();
    return first ? first : null;
}

function validScheme(value?: string | null): string | null {
    const scheme = (value || '').trim().toLowerCase();
    return scheme === 'http' || scheme === 'https' ? scheme : null;
}

function schemeOf(value?: string | null): string | null {
    try {
        return validScheme(new URL((value || '').trim()).protocol.replace(':', ''));
    } catch {
        return null;
    }
}

/** An origin only when both halves validate — the result reaches the feed's XML unescaped. */
function originFrom(proto?: string | null, host?: string | null): string | null {
    const scheme = validScheme(proto);
    const candidate = (host || '').trim();
    if (!scheme || !HOST_RE.test(candidate)) return null;
    try {
        return new URL(`${scheme}://${candidate}`).origin;
    } catch {
        return null;
    }
}

function originOf(value?: string | null): string | null {
    try {
        const origin = new URL((value || '').trim()).origin;
        // Non-hierarchical schemes (javascript:, data:) have no origin: newer WHATWG URL returns
        // the literal string "null".
        return origin && origin !== 'null' ? origin : null;
    } catch {
        return null;
    }
}

/** `NEXTAUTH_URL` is only usable when it does not point at the machine the server runs on. */
function publicCanonicalOrigin(value?: string | null): string | null {
    const origin = originOf(value);
    if (!origin) return null;
    try {
        return isLoopbackHostname(new URL(origin).hostname) ? null : origin;
    } catch {
        return null;
    }
}

/** `localhost`, `127.0.0.0/8` and `::1` — never where an OPDS client runs from. */
function isLoopbackHostname(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}
