// src/lib/engine.ts
// Base URL of the Rust engine (omnibus-engine). Configurable via OMNIBUS_ENGINE_URL so Node and
// the engine can run in separate containers/hosts; defaults to localhost for single-host/dev setups.
export const ENGINE_URL = process.env.OMNIBUS_ENGINE_URL || 'http://127.0.0.1:8000';

// Headers for every Node→engine request. The engine authenticates internal calls with the shared
// NEXTAUTH_SECRET (X-Internal-Secret); when the secret is unset the engine leaves its endpoints open
// (dev/localhost) so omitting the header is harmless. Pass `extra` to merge in e.g. Content-Type.
export function engineHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...(extra || {}) };
    const secret = process.env.NEXTAUTH_SECRET;
    if (secret) headers['X-Internal-Secret'] = secret;
    return headers;
}

// The synchronous long-running engine endpoints (/api/monitor/sync, /api/download/stream) hold the
// HTTP connection open for the whole operation — the engine doesn't respond until it finishes, which
// can take many minutes (a large download, a 3000-issue Metron sweep). Node's global fetch (undici)
// aborts with UND_ERR_HEADERS_TIMEOUT after its ~5-min default headers timeout, so those calls go
// through a dispatcher with the headers/body timeouts disabled. Created lazily and cached; if undici
// isn't resolvable we fall back to a plain fetch (the default timeouts then apply).
let longDispatcher: unknown;
let longDispatcherInit = false;

async function getLongDispatcher(): Promise<unknown> {
    if (longDispatcherInit) return longDispatcher;
    longDispatcherInit = true;
    try {
        const { Agent } = await import('undici');
        longDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
    } catch {
        longDispatcher = undefined;
    }
    return longDispatcher;
}

/**
 * fetch() for a long-running engine endpoint, with undici's headers/body timeouts disabled so a large
 * download or multi-minute sync isn't killed mid-flight. Falls back to a plain fetch when the undici
 * dispatcher isn't available. Set request headers via `engineHeaders()` in `init` as usual.
 */
export async function engineFetchLong(url: string, init: RequestInit): Promise<Response> {
    const dispatcher = await getLongDispatcher();
    const opts: RequestInit & { dispatcher?: unknown } = { ...init };
    if (dispatcher) opts.dispatcher = dispatcher;
    return fetch(url, opts);
}
