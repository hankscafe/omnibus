import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { cookies } from 'next/headers';
import crypto from 'crypto';
import { getErrorMessage } from '@/lib/utils/error';

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        
        // Strict Admin verification
        if (session?.user?.role !== 'ADMIN') {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const adminId = (session.user as any).id;
        const { userId, action } = await request.json();
        const cookieStore = cookies();

        if (action === 'start') {
            // --- SECURITY FIX: Cryptographically bind the cookie to the Admin's Session ---
            const secret = process.env.NEXTAUTH_SECRET || 'fallback_secret';
            const payload = `${userId}|${adminId}`;
            
            // Create a tamper-proof HMAC signature
            const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
            const boundCookieValue = `${payload}|${signature}`;

            const cookieStore = await cookies();
            cookieStore.set('omnibus_impersonate', boundCookieValue, {
                httpOnly: true,
                // Enforce secure if deployed behind HTTPS, but allow HTTP for local LAN users
                secure: process.env.NODE_ENV === 'production' || process.env.REQUIRE_SECURE_COOKIES === 'true',
                sameSite: 'lax',
                maxAge: 60 * 60, // 1 hour
                path: '/'
            });
            return NextResponse.json({ success: true, message: "Impersonation started." });
        } 
        
        if (action === 'stop') {
            // Delete the impersonation cookie
            const cookieStore = await cookies();
            cookieStore.delete('omnibus_impersonate');
            return NextResponse.json({ success: true, message: "Impersonation stopped. Welcome back, Admin." });
        }

        return NextResponse.json({ error: "Invalid action." }, { status: 400 });

    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}