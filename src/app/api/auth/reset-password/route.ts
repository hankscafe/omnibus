import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
// --- CHANGED: Using unified SystemNotifier ---
import { SystemNotifier } from '@/lib/notifications';
import crypto from 'crypto';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { checkRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    const ip = req.headers.get('x-forwarded-for') || 'unknown';
    const rateLimit = checkRateLimit(`reset_req_${ip}`, 3, 15 * 60 * 1000);
    if (rateLimit.isLimited) return rateLimit.response!;

    try {
        const { email } = await req.json();
        if (!email) {
            rateLimit.trackFailure();
            return NextResponse.json({ error: "Email is required" }, { status: 400 });
        }

        const user = await prisma.user.findFirst({ 
            where: { email: email.toLowerCase() } 
        });
        
        if (!user || !user.email) {
            rateLimit.trackSuccess(); 
            return NextResponse.json({ success: true });
        }

        const secret = process.env.NEXTAUTH_SECRET;
        if (!secret || secret === 'change_this_to_a_random_secure_string_123!') {
            rateLimit.trackFailure();
            return NextResponse.json({ error: "Internal Configuration Error" }, { status: 500 });
        }

        const expiration = Date.now() + 3600000; 
        const data = `${user.id}|${expiration}`;
        const sig = crypto.createHmac('sha256', secret).update(data).digest('hex');
        const token = Buffer.from(`${data}|${sig}`).toString('base64');

        const host = req.headers.get('host');
        const protocol = host?.includes('localhost') ? 'http' : 'https';
        const baseUrl = process.env.NEXTAUTH_URL || `${protocol}://${host}`;
        const resetLink = `${baseUrl}/login/reset?token=${encodeURIComponent(token)}`;

        // --- CHANGED: Unified Notifier Call ---
        await SystemNotifier.sendAlert('password_reset', { 
            email: user.email, 
            user: user.username, 
            resetLink 
        });

        rateLimit.trackSuccess();
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        rateLimit.trackFailure();
        Logger.log(`[Password Reset Request] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}