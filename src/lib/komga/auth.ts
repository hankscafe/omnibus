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

export function unauthorized(): Response {
    // The source reads only the status: 401 → "Error 401 Unauthorized: Invalid credentials".
    return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': KOMGA_CHALLENGE } });
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

export function komgaText(status: number, text: string): Response {
    return new Response(text, { status });
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
        return new Response('Internal Server Error', { status: 500 });
    }
}
