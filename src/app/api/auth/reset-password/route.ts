// src/app/api/auth/reset-password/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Mailer } from '@/lib/mailer';
import crypto from 'crypto';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    try {
        const { email } = await req.json();
        if (!email) return NextResponse.json({ error: "Email is required" }, { status: 400 });

        const user = await prisma.user.findFirst({ 
            where: { email: email.toLowerCase() } 
        });
        
        // Always return success to prevent email enumeration
        if (!user || !user.email) return NextResponse.json({ success: true });

        // SECURITY FIX: Validate secret before creating HMAC
        const secret = process.env.NEXTAUTH_SECRET;
        if (!secret || secret === 'change_this_to_a_random_secure_string_123!') {
            return NextResponse.json({ error: "Internal Configuration Error" }, { status: 500 });
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

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        Logger.log(`[Password Reset Request] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}