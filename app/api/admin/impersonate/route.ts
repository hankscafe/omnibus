import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { cookies } from 'next/headers';

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        
        // Strict Admin verification
        if (session?.user?.role !== 'ADMIN') {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { userId, action } = await request.json();
        const cookieStore = cookies();

        if (action === 'start') {
            // Set a cookie that expires in 1 hour
            cookieStore.set('omnibus_impersonate', userId, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                maxAge: 60 * 60, // 1 hour
                path: '/'
            });
            return NextResponse.json({ success: true, message: "Impersonation started." });
        } 
        
        if (action === 'stop') {
            // Delete the impersonation cookie
            cookieStore.delete('omnibus_impersonate');
            return NextResponse.json({ success: true, message: "Impersonation stopped. Welcome back, Admin." });
        }

        return NextResponse.json({ error: "Invalid action." }, { status: 400 });

    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}