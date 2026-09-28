// src/lib/komga/auth.ts
//
// #206: request plumbing shared by every /komga/api/v1 handler. Paperback's Komga source sends
// HTTP Basic `email:password` on every request (through its interceptor — image loads included);
// validateApiKey already reads Basic with the password as the key, so Email = the Omnibus
// username (informational) and Password = a per-user API key. A key that names no user (the
// legacy admin key) is refused: read progress has to belong to somebody.
import { validateApiKey } from '@/lib/api-auth';
import { getAccessibleLibraryIds, type AccessibleLibraries } from '@/lib/library-access';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export const KOMGA_CHALLENGE = 'Basic realm="Omnibus Komga"';

export interface KomgaIdentity {
    user: { id: string; username: string; role: string };
    libs: AccessibleLibraries;
}

export type KomgaAuthResult = { ok: true } & KomgaIdentity | { ok: false; response: Response };

const REASONS: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    413: 'Payload Too Large',
    500: 'Internal Server Error',
};

/**
 * An error as Komga (Spring Boot) sends it: a JSON body, never plain text. Paperback's source
 * JSON.parses every response it gets — a real Komga's error body parses, `result.content ?? []`
 * finds nothing and the app shows an empty list; our plain "Not Found" threw `JSON Parse error:
 * Unexpected identifier "Not"` instead (#206 round 4: the source's View More asks for
 * /series/<section id> for every homepage section, On Deck and Continue Reading included).
 */
export function komgaError(status: number, path?: string, headers: Record<string, string> = {}): Response {
    const body = { timestamp: new Date().toISOString(), status, error: REASONS[status] ?? 'Error', ...(path ? { path } : {}) };
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
    });
}

export function unauthorized(): Response {
    // The source reads the status: 401 → "Error 401 Unauthorized: Invalid credentials".
    return komgaError(401, undefined, { 'WWW-Authenticate': KOMGA_CHALLENGE });
}

export async function authenticateKomga(req: Request): Promise<KomgaAuthResult> {
    const auth = await validateApiKey(req);
    if (!auth.valid || !auth.user) return { ok: false, response: unauthorized() };
    const libs = await getAccessibleLibraryIds(auth.user.id, auth.user.role);
    return { ok: true, user: { id: auth.user.id, username: auth.user.username, role: auth.user.role }, libs };
}

export function komgaJson(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
}

export function noContent(): Response {
    return new Response(null, { status: 204 });
}

/** try/catch + log for a handler body, so a bad row never leaks a stack trace to the app. */
export async function komgaGuard(name: string, run: () => Promise<Response>): Promise<Response> {
    try {
        return await run();
    } catch (error: unknown) {
        Logger.log(`[Komga ${name}] Error: ${getErrorMessage(error)}`, 'error');
        return komgaError(500);
    }
}
