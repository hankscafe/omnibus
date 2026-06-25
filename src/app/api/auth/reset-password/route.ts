import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
// --- CHANGED: Using unified SystemNotifier ---
import { SystemNotifier } from '@/lib/notifications';
import crypto from 'crypto';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { checkRateLimit, getClientIp, checkGlobalRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    const globalLimit = checkGlobalRateLimit('reset_req', 40, 15 * 60 * 1000);
    if (globalLimit.isLimited) return globalLimit.response!;
    const ip = getClientIp(req);
    const rateLimit = checkRateLimit(`reset_req_${ip}`, 3, 15 * 60 * 1000);
    if (rateLimit.isLimited) return rateLimit.response!;

    try {

        // --- NEW: Block resets if Force SSO is enabled ---
        const forceSsoSetting = await prisma.systemSetting.findUnique({ where: { key: 'oidc_force_sso' } });
        if (forceSsoSetting?.value === 'true') {
            rateLimit.trackFailure();
            return NextResponse.json({ error: "Native authentication is disabled. Please reset your password at your Identity Provider." }, { status: 403 });
        }

        const { email } = await req.json();
        // Validate format early (mirrors register) so a malformed value can't reach the DB query.
        if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            rateLimit.trackFailure();
            return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
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
        // HMAC binds sessionVersion so the token self-invalidates after one use (confirm increments it).
        // sessionVersion is NOT placed in the token plaintext, which stays id|expiration|sig.
        const sig = crypto.createHmac('sha256', secret).update(`${user.id}|${expiration}|${user.sessionVersion}`).digest('hex');
        const token = Buffer.from(`${user.id}|${expiration}|${sig}`).toString('base64');

        const host = req.headers.get('host');
        const protocol = host?.includes('localhost') ? 'http' : 'https';
        const baseUrl = process.env.NEXTAUTH_URL || `${protocol}://${host}`;
        const resetLink = `${baseUrl}/login/reset?token=${encodeURIComponent(token)}`;

        // Fire-and-forget so response time doesn't reveal whether the account exists — the no-account branch
        // above returns immediately, so awaiting SMTP/HTTP here would make the existent path observably slower.
        SystemNotifier.sendAlert('password_reset', {
            email: user.email,
            user: user.username,
            resetLink
        }).catch(() => {});

        rateLimit.trackSuccess();
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        rateLimit.trackFailure();
        Logger.log(`[Password Reset Request] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}