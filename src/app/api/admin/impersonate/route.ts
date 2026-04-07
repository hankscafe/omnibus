// src/app/api/admin/impersonate/route.ts
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

        if (action === 'start') {
            const payload = `${userId}|${adminId}`;
            const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
            const boundCookieValue = `${payload}|${signature}`;

            const cookieStore = await cookies();
            cookieStore.set('omnibus_impersonate', boundCookieValue, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production' || process.env.REQUIRE_SECURE_COOKIES === 'true',
                sameSite: 'lax',
                maxAge: 60 * 60, // 1 hour
                path: '/'
            });
            return NextResponse.json({ success: true, message: "Impersonation started." });
        } 
        
        if (action === 'stop') {
            const cookieStore = await cookies();
            cookieStore.delete('omnibus_impersonate');
            return NextResponse.json({ success: true, message: "Impersonation stopped." });
        }

        return NextResponse.json({ error: "Invalid action." }, { status: 400 });

    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}