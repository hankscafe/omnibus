// src/app/api/admin/impersonate/route.ts
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { cookies } from 'next/headers';
import crypto from 'crypto';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { Logger } from '@/lib/logger';

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        
        if (session?.user?.role !== 'ADMIN') {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const adminId = (session.user as any).id;
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
            // Hard-block unencrypted transit unless explicitly bypassed by the server admin
            if (!isHttps && !isLocalhost && !allowInsecure) {
                Logger.log(`[Security] Blocked impersonation attempt over unencrypted HTTP from Admin ${adminId}.`, 'warn');
                return NextResponse.json({ 
                    error: "Security Policy: Impersonation requires an HTTPS connection to protect session tokens. If you are running on a secure private LAN, set ALLOW_INSECURE_IMPERSONATION=true in your environment variables." 
                }, { status: 403 });
            }

            const payload = `${userId}|${adminId}`;
            const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
            const boundCookieValue = `${payload}|${signature}`;

            const cookieStore = await cookies();
            cookieStore.set('omnibus_impersonate', boundCookieValue, {
                httpOnly: true,
                // Only drops the secure flag if they explicitly allowed it via ENV
                secure: isHttps || (!allowInsecure), 
                sameSite: 'lax',
                maxAge: 60 * 60, // 1 hour
                path: '/'
            });
            
            await AuditLogger.log('IMPERSONATE_USER_START', { targetUserId: userId, secureContext: isHttps }, adminId);
            return NextResponse.json({ success: true, message: "Impersonation started." });
        } 
        
        if (action === 'stop') {
            const cookieStore = await cookies();
            cookieStore.delete('omnibus_impersonate');
            await AuditLogger.log('IMPERSONATE_USER_STOP', { targetUserId: userId }, adminId);
            return NextResponse.json({ success: true, message: "Impersonation stopped." });
        }

        return NextResponse.json({ error: "Invalid action." }, { status: 400 });

    } catch (error: unknown) {
        Logger.log(`[Impersonation API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}