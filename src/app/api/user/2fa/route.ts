import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { encrypt2FA } from '@/lib/encryption';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';

const otplib = require('otplib');
const authenticator = otplib.authenticator || otplib.default?.authenticator || otplib;
const QRCode = require('qrcode');

export async function GET(req: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const user = await prisma.user.findUnique({
            where: { id: (session.user as any).id },
            select: { twoFactorEnabled: true }
        });

        return NextResponse.json({ enabled: user?.twoFactorEnabled || false });
    } catch (error: unknown) {
        Logger.log(`[2FA GET Error]: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        
        const userId = (session.user as any).id;
        const body = await req.json();
        const { action } = body;

        // ACTION 1: Generate a new secret and QR Code for the user to scan
        if (action === 'generate') {
            const secret = authenticator.generateSecret();
            
            const accountName = session.user.email || session.user.name || 'User';
            
            // Manually construct the standard Google Authenticator URI
            const encodedIssuer = encodeURIComponent('Omnibus');
            const encodedAccount = encodeURIComponent(accountName);
            const otpauth = `otpauth://totp/${encodedIssuer}:${encodedAccount}?secret=${secret}&issuer=${encodedIssuer}`;
            
            const qrCodeDataUrl = await QRCode.toDataURL(otpauth);
            
            return NextResponse.json({ secret, qrCode: qrCodeDataUrl });
        }

        // ACTION 2: Verify the code they typed and save it to the database
        if (action === 'enable') {
            const { secret, code } = body;
            if (!secret || !code) return NextResponse.json({ error: "Missing parameters" }, { status: 400 });

            // FIX: Use the modern .verify({ token, secret }) method with a fallback
            const isValid = typeof authenticator.verify === 'function' 
                ? authenticator.verify({ token: code, secret: secret }) 
                : authenticator.check(code, secret);
            
            if (!isValid) {
                return NextResponse.json({ error: "Invalid verification code. Try again." }, { status: 400 });
            }

            // --- UPDATED: Await the encryption now that it pulls from DB ---
            const encryptedSecret = await encrypt2FA(secret);

            await prisma.user.update({
                where: { id: userId },
                data: { 
                    twoFactorEnabled: true, 
                    twoFactorSecret: encryptedSecret 
                }
            });
            await AuditLogger.log('2FA_ENABLED', "User enabled Two-Factor Authentication.", userId);
            return NextResponse.json({ success: true, message: "Two-Factor Authentication enabled!" });
        }

        // ACTION 3: Disable 2FA
        if (action === 'disable') {
            await prisma.user.update({
                where: { id: userId },
                data: { 
                    twoFactorEnabled: false, 
                    twoFactorSecret: null 
                }
            });
            await AuditLogger.log('2FA_DISABLED', "User disabled Two-Factor Authentication.", userId);
            return NextResponse.json({ success: true, message: "Two-Factor Authentication disabled." });
        }

        return NextResponse.json({ error: "Invalid action" }, { status: 400 });

    } catch (error: unknown) {
        Logger.log(`[2FA POST Error]: ${getErrorMessage(error)}`, 'error');

        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}