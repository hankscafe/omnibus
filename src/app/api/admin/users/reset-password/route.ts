// src/app/api/admin/users/reset-password/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Mailer } from '@/lib/mailer';
import crypto from 'crypto';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { AuditLogger } from '@/lib/audit-logger';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        
        if (session?.user?.role !== 'ADMIN') {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { userId } = await req.json();
        const user = await prisma.user.findUnique({ where: { id: userId } });
        
        if (!user) {
            return NextResponse.json({ error: "User not found" }, { status: 400 });
        }
        if (!user.email) {
            return NextResponse.json({ error: "This user does not have an email address configured." }, { status: 400 });
        }

        // SECURITY FIX: Remove insecure string fallback.
        // If NEXTAUTH_SECRET is missing or using the known default, block token generation.
        const secret = process.env.NEXTAUTH_SECRET;
        if (!secret || secret === 'change_this_to_a_random_secure_string_123!') {
            return NextResponse.json({ error: "Internal Configuration Error: NEXTAUTH_SECRET is not set." }, { status: 500 });
        }

        const expiration = Date.now() + 3600000; // 1 hour
        const data = `${user.id}|${expiration}`;
        const sig = crypto.createHmac('sha256', secret).update(data).digest('hex');
        const token = Buffer.from(`${data}|${sig}`).toString('base64');

        const host = req.headers.get('host');
        const protocol = host?.includes('localhost') ? 'http' : 'https';
        const baseUrl = process.env.NEXTAUTH_URL || `${protocol}://${host}`;
        
        const resetLink = `${baseUrl}/login/reset?token=${encodeURIComponent(token)}`;

        await Mailer.sendAlert('password_reset', { 
            email: user.email, 
            user: user.username, 
            resetLink 
        });

        await AuditLogger.log('ADMIN_SENT_PASSWORD_RESET', { targetUser: user.username }, (session.user as any).id);

        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}