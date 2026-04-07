// src/app/api/auth/reset-password/confirm/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { AuditLogger } from '@/lib/audit-logger';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    try {
        const { token, password } = await req.json();
        if (!token || !password) return NextResponse.json({ error: "Missing parameters" }, { status: 400 });

        // SECURITY FIX: Removed fallback secret
        const secret = process.env.NEXTAUTH_SECRET;
        if (!secret || secret === 'change_this_to_a_random_secure_string_123!') {
            return NextResponse.json({ error: "System Configuration Error" }, { status: 500 });
        }

        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [userId, expStr, sig] = decoded.split('|');

        if (Date.now() > parseInt(expStr)) {
            return NextResponse.json({ error: "Token has expired." }, { status: 400 });
        }

        const expectedSig = crypto.createHmac('sha256', secret).update(`${userId}|${expStr}`).digest('hex');
        if (sig !== expectedSig) {
            return NextResponse.json({ error: "Invalid token signature" }, { status: 400 });
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        await prisma.user.update({
            where: { id: userId },
            data: { 
                password: hashedPassword,
                sessionVersion: { increment: 1 } 
            }
        });

        await AuditLogger.log('PASSWORD_RESET', { message: "Password was reset via email token." }, userId);
        return NextResponse.json({ success: true, message: "Password has been successfully reset." });

    } catch (error) {
        return NextResponse.json({ error: "Invalid reset token." }, { status: 400 });
    }
}