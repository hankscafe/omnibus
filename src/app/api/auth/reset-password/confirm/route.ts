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
        
        if (!token || !password) {
            return NextResponse.json({ error: "Missing required parameters" }, { status: 400 });
        }

        // Enforce identical complexity rules
        const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/;
        if (!passwordRegex.test(password)) {
            return NextResponse.json({ 
                error: "Password must be at least 12 characters and include uppercase, lowercase, numbers, and symbols." 
            }, { status: 400 });
        }

        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [userId, expStr, sig] = decoded.split('|');

        if (!userId || !expStr || !sig) {
            throw new Error("Invalid token format");
        }

        if (Date.now() > parseInt(expStr)) {
            return NextResponse.json({ error: "Token has expired. Please request a new one." }, { status: 400 });
        }

        const secret = process.env.NEXTAUTH_SECRET || 'fallback';
        const expectedSig = crypto.createHmac('sha256', secret).update(`${userId}|${expStr}`).digest('hex');

        if (sig !== expectedSig) {
            return NextResponse.json({ error: "Invalid token signature" }, { status: 400 });
        }

        const hashedPassword = await bcrypt.hash(password, 12);

        await prisma.user.update({
            where: { id: userId },
            data: { 
                password: hashedPassword,
                sessionVersion: { increment: 1 } // Logs out all active sessions but preserves 2FA
            }
        });

        await AuditLogger.log('PASSWORD_RESET', { message: "Password was reset via email token." }, userId);

        return NextResponse.json({ success: true, message: "Password has been successfully reset." });

    } catch (error) {
        return NextResponse.json({ error: "Invalid or corrupt reset token." }, { status: 400 });
    }
}