// src/lib/koreader-auth.ts
//
// Shared KOReader authentication helper. It lives here rather than in a route file because Next.js App
// Router route files may only export HTTP method handlers (GET/POST/…) + segment config — exporting this
// from src/app/api/koreader/users/auth/route.ts tripped Next's generated route-type validator (tsc TS2344).
import { prisma } from '@/lib/db';
import crypto from 'crypto';

/**
 * Authenticate a KOReader sync request via its `x-auth-user` / `x-auth-key` headers, matching an Omnibus
 * OPDS API key first and then an admin API key. Returns the matching user, or null if unauthenticated.
 */
export async function authenticateKoreader(request: Request) {
    const userHeader = request.headers.get('x-auth-user');
    const keyHeader = request.headers.get('x-auth-key');

    if (!userHeader || !keyHeader) return null;

    // Hash the incoming key to match the database
    const keyHash = crypto.createHash('sha256').update(keyHeader).digest('hex');

    // Authenticate using Omnibus OPDS API Keys
    const opdsKey = await prisma.opdsKey.findUnique({
        where: { keyHash },
        include: { user: true }
    });

    if (opdsKey && opdsKey.user.username === userHeader) {
        // Optional: Update last used timestamp
        prisma.opdsKey.update({ where: { id: opdsKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
        return opdsKey.user;
    }

    // Fallback: Check Admin API Keys
    const adminKey = await prisma.apiKey.findUnique({
        where: { keyHash },
        include: { user: true }
    });

    if (adminKey && adminKey.user.username === userHeader) {
        prisma.apiKey.update({ where: { id: adminKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
        return adminKey.user;
    }

    return null;
}
