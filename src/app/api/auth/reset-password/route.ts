// src/app/api/auth/reset-password/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Mailer } from '@/lib/mailer';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    try {
        const { email } = await req.json();
        
        if (!email) {
            return NextResponse.json({ error: "Email is required" }, { status: 400 });
        }

        const user = await prisma.user.findFirst({ 
            where: { email: email.toLowerCase() } 
        });
        
        // Security: Always return success to prevent email enumeration attacks
        if (!user || !user.email) {
            return NextResponse.json({ success: true });
        }

        const secret = process.env.NEXTAUTH_SECRET || 'fallback';
        const expiration = Date.now() + 3600000; // 1 hour expiry
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
    } catch (error) {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}