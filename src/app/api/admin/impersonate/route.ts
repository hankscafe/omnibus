// src/app/api/admin/impersonate/route.ts
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { cookies } from 'next/headers';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { Logger } from '@/lib/logger';
import { IMPERSONATION_COOKIE, IMPERSONATION_MAX_AGE_S, signImpersonationCookie } from '@/lib/impersonation';

// Starts an impersonation. Stopping is POST /api/impersonation/stop: it must be reachable by the
// impersonating session, whose role is the impersonated user's, so it can't sit behind /api/admin.

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        
        if (session?.user?.role !== 'ADMIN') {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const adminId = session.user.id;
        const { userId, action } = await request.json();
        
        // SECURITY FIX: Mandatory secret check for signing cookies
        const secret = process.env.NEXTAUTH_SECRET;
        if (!secret || secret === 'change_this_to_a_random_secure_string_123!') {
            return NextResponse.json({ error: "Server Configuration Error: NEXTAUTH_SECRET is not set." }, { status: 500 });
        }

        // --- NEW: STRICT PROTOCOL VALIDATION ---
        const isHttps = request.headers.get('x-forwarded-proto') === 'https' || request.url.startsWith('https://');
        const isLocalhost = request.url.includes('localhost') || request.url.includes('127.0.0.1');
        const allowInsecure = process.env.ALLOW_INSECURE_IMPERSONATION === 'true';

        if (action === 'start') {
            if (typeof userId !== 'string' || !userId) {
                return NextResponse.json({ error: "No user to impersonate." }, { status: 400 });
            }

            // Hard-block unencrypted transit unless explicitly bypassed by the server admin
            if (!isHttps && !isLocalhost && !allowInsecure) {
                Logger.log(`[Security] Blocked impersonation attempt over unencrypted HTTP from Admin ${adminId}.`, 'warn');
                return NextResponse.json({
                    error: "Security Policy: Impersonation requires an HTTPS connection to protect session tokens. If you are running on a secure private LAN, set ALLOW_INSECURE_IMPERSONATION=true in your environment variables."
                }, { status: 403 });
            }

            // Stamped with its issue time: the jwt callback honours it only for the sign-in it was
            // issued in, so signing out and back in doesn't resume it.
            const boundCookieValue = signImpersonationCookie(userId, adminId, Date.now(), secret);

            const cookieStore = await cookies();
            cookieStore.set(IMPERSONATION_COOKIE, boundCookieValue, {
                httpOnly: true,
                // Only drops the secure flag if they explicitly allowed it via ENV
                secure: isHttps || (!allowInsecure),
                sameSite: 'lax',
                maxAge: IMPERSONATION_MAX_AGE_S, // 1 hour
                path: '/'
            });

            await AuditLogger.log('IMPERSONATE_USER_START', { targetUserId: userId, secureContext: isHttps }, adminId);
            return NextResponse.json({ success: true, message: "Impersonation started." });
        }

        return NextResponse.json({ error: "Invalid action." }, { status: 400 });

    } catch (error: unknown) {
        Logger.log(`[Impersonation API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}