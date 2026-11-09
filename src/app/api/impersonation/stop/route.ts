// src/app/api/impersonation/stop/route.ts
//
// Ends an impersonation. Deliberately outside /api/admin: while impersonating, the session's role is
// the impersonated user's, so the middleware's admin gate (and any ADMIN check) refuses the very
// session that needs this — the old `stop` action of /api/admin/impersonate could never be reached
// that way (found in the v1.4.7 permission sweep). No admin check is needed: all this does is drop
// the cookie, and the jwt callback then reverts the session to the admin who started it, which it
// only ever does for a swap it verified.
import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { cookies } from 'next/headers';
import { AuditLogger } from '@/lib/audit-logger';
import { IMPERSONATION_COOKIE } from '@/lib/impersonation';

export async function POST(req: NextRequest) {
    const token = await getToken({ req });
    if (!token || token.error) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Always: also clears a cookie left behind by an earlier sign-in (it no longer counts, but tidy).
    const cookieStore = await cookies();
    cookieStore.delete(IMPERSONATION_COOKIE);

    if (!token.isImpersonating || !token.originalAdminId) {
        return NextResponse.json({ error: "Not impersonating anyone." }, { status: 409 });
    }

    await AuditLogger.log('IMPERSONATE_USER_STOP', { targetUserId: token.id }, token.originalAdminId as string);
    return NextResponse.json({ success: true, message: "Impersonation stopped." });
}
