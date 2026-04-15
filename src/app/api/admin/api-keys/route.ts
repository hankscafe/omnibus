// src/app/api/admin/api-keys/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import crypto from 'crypto';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { Logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const apiKeys = await prisma.apiKey.findMany({
            include: {
                user: { select: { username: true, role: true } },
                createdBy: { select: { username: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        return NextResponse.json(apiKeys);
    } catch (error) {
        Logger.log(`[Admin API Keys] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { name, userId, expiresInDays } = await request.json();
        if (!name || !userId) return NextResponse.json({ error: "Name and User are required" }, { status: 400 });

        // Generate a secure 32-byte hex string
        const rawKey = 'omn_' + crypto.randomBytes(32).toString('hex');
        
        // Hash it for DB storage
        const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
        
        // Create a prefix for display (e.g. omn_a1b2c3d4...)
        const prefix = rawKey.substring(0, 12) + '...';

        let expiresAt = null;
        if (expiresInDays && expiresInDays > 0) {
            expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + parseInt(expiresInDays));
        }

        const apiKey = await prisma.apiKey.create({
            data: {
                name,
                keyHash,
                prefix,
                userId,
                createdById: (session.user as any).id,
                expiresAt
            },
            include: {
                user: { select: { username: true, role: true } },
                createdBy: { select: { username: true } }
            }
        });

        await AuditLogger.log('CREATED_ADMIN_API_KEY', { keyName: name, assignedTo: apiKey.user.username }, (session.user as any).id);
        return NextResponse.json({ success: true, rawKey, apiKey });
    } catch (error) {
        Logger.log(`[Admin API Keys] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');
        if (!id) return NextResponse.json({ error: "Missing ID" }, { status: 400 });

        await prisma.apiKey.delete({ where: { id } });
        
        // --- AUDIT LOG ---
        await AuditLogger.log('REVOKE_API_KEY', { keyId: id }, (session.user as any).id);

        return NextResponse.json({ success: true });
    } catch (error) {
        Logger.log(`[Admin API Keys] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}