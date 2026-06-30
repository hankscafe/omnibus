import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { AuditLogger } from '@/lib/audit-logger';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { checkRateLimit, getClientIp, checkGlobalRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    // Global backstop first (resists X-Forwarded-For rotation), then best-effort per-IP.
    const globalLimit = checkGlobalRateLimit('reset_confirm', 60, 15 * 60 * 1000);
    if (globalLimit.isLimited) return globalLimit.response!;
    const ip = getClientIp(req);
    const rateLimit = checkRateLimit(`reset_confirm_${ip}`, 5, 15 * 60 * 1000);
    if (rateLimit.isLimited) return rateLimit.response!;

    try {
        const { token, password } = await req.json();
        if (!token || !password) {
            rateLimit.trackFailure();
            return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
        }

        // SECURITY FIX: Removed fallback secret
        const secret = process.env.NEXTAUTH_SECRET;
        if (!secret || secret === 'change_this_to_a_random_secure_string_123!') {
            rateLimit.trackFailure();
            return NextResponse.json({ error: "System Configuration Error" }, { status: 500 });
        }

        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [userId, expStr, sig] = decoded.split('|');

        if (Date.now() > parseInt(expStr)) {
            rateLimit.trackFailure();
            return NextResponse.json({ error: "Token has expired." }, { status: 400 });
        }

        // Bind the signature to the user's CURRENT sessionVersion so the token is single-use: the successful
        // reset below increments sessionVersion, so any replay recomputes a different expected signature.
        const resetUser = await prisma.user.findUnique({ where: { id: userId }, select: { sessionVersion: true } });
        if (!resetUser) {
            rateLimit.trackFailure();
            return NextResponse.json({ error: "Invalid reset token." }, { status: 400 });
        }

        const expectedSig = crypto.createHmac('sha256', secret).update(`${userId}|${expStr}|${resetUser.sessionVersion}`).digest('hex');

        const sigBuffer = Buffer.from(sig);
        const expectedBuffer = Buffer.from(expectedSig);

        if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
            rateLimit.trackFailure();
            return NextResponse.json({ error: "Invalid token signature" }, { status: 400 });
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        // Conditional update closes the concurrent-replay race: only the request still seeing the signed
        // sessionVersion wins; a second one (or any replay after success) matches 0 rows.
        const result = await prisma.user.updateMany({
            where: { id: userId, sessionVersion: resetUser.sessionVersion },
            data: {
                password: hashedPassword,
                sessionVersion: { increment: 1 }
            }
        });
        if (result.count === 0) {
            rateLimit.trackFailure();
            return NextResponse.json({ error: "This reset link has already been used." }, { status: 400 });
        }

        await AuditLogger.log('PASSWORD_RESET', { message: "Password was reset via email token." }, userId);
        
        rateLimit.trackSuccess();
        return NextResponse.json({ success: true, message: "Password has been successfully reset." });

    } catch (error: unknown) {
        rateLimit.trackFailure();
        Logger.log(`[Password Reset Confirm] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: "Invalid reset token." }, { status: 400 });
    }
}