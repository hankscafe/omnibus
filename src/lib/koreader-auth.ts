// src/lib/koreader-auth.ts
//
// Shared KOReader authentication helper. It lives here rather than in a route file because Next.js App
// Router route files may only export HTTP method handlers (GET/POST/…) + segment config — exporting this
// from src/app/api/koreader/users/auth/route.ts tripped Next's generated route-type validator (tsc TS2344).
import crypto from 'crypto';
import { prisma } from '@/lib/db';

const KOREADER_UNAUTHORIZED = 'Unauthorized';
const KOREADER_UNAUTHORIZED_HINT = `${KOREADER_UNAUTHORIZED}. Use an API key created after KOReader support was added.`;

type KoreaderUser = {
    id: string;
    username: string;
    role: string;
};

type KoreaderKey = {
    id: string;
    expiresAt: Date | null;
    user: KoreaderUser;
};

export type KoreaderAuthResult =
    | { user: KoreaderUser; error: null }
    | { user: null; error: string };

/** Hash the KOReader client-side MD5 one final time before comparing it with syncKeyHash. */
export function hashKoreaderSyncKey(userKey: string) {
    return crypto.createHash('sha256').update(userKey).digest('hex');
}

/** Compute the value stored for a newly generated API key so KOReader's md5(password) can authenticate. */
export function hashRawKeyForKoreader(rawKey: string) {
    const clientKey = crypto.createHash('md5').update(rawKey).digest('hex');
    return hashKoreaderSyncKey(clientKey);
}

export function koreaderUnauthorizedResponse(message = KOREADER_UNAUTHORIZED) {
    const clientMessage = message === KOREADER_UNAUTHORIZED ? KOREADER_UNAUTHORIZED_HINT : message;
    return Response.json({ code: 2001, message: clientMessage }, { status: 401 });
}

function isExpired(key: { expiresAt: Date | null }) {
    return Boolean(key.expiresAt && key.expiresAt.getTime() <= Date.now());
}

/**
 * Authenticate a KOReader sync request via its `x-auth-user` / `x-auth-key` headers, matching a
 * profile key first and then an admin key. The header is the lowercase MD5 KOReader derives from the
 * API key; syncKeyHash stores SHA-256 of that client-side value.
 */
export async function authenticateKoreader(request: Request): Promise<KoreaderAuthResult> {
    const userHeader = request.headers.get('x-auth-user');
    const keyHeader = request.headers.get('x-auth-key');

    if (!userHeader || !keyHeader) {
        return { user: null, error: KOREADER_UNAUTHORIZED };
    }

    const syncKeyHash = hashKoreaderSyncKey(keyHeader);

    const opdsKey = await prisma.opdsKey.findUnique({
        where: { syncKeyHash },
        include: { user: true },
    }) as KoreaderKey | null;
    if (opdsKey && opdsKey.user.username === userHeader) {
        if (isExpired(opdsKey)) return { user: null, error: 'API key has expired' };
        prisma.opdsKey.update({ where: { id: opdsKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
        return { user: opdsKey.user, error: null };
    }

    const apiKey = await prisma.apiKey.findUnique({
        where: { syncKeyHash },
        include: { user: true },
    }) as KoreaderKey | null;
    if (apiKey && apiKey.user.username === userHeader) {
        if (isExpired(apiKey)) return { user: null, error: 'API key has expired' };
        prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
        return { user: apiKey.user, error: null };
    }

    return { user: null, error: KOREADER_UNAUTHORIZED };
}
