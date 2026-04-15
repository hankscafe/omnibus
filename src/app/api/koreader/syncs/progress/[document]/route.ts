// src/app/api/koreader/syncs/progress/[document]/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import crypto from 'crypto';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ document: string }> }) {
    try {
    // 1. Inline KOReader Auth to bypass Next.js route export restrictions
    const userHeader = request.headers.get('x-auth-user');
    const keyHeader = request.headers.get('x-auth-key');

    if (!userHeader || !keyHeader) return NextResponse.json({ authorized: "KO" }, { status: 401 });

    const keyHash = crypto.createHash('sha256').update(keyHeader).digest('hex');
    let user = null;

    const opdsKey = await prisma.opdsKey.findUnique({ where: { keyHash }, include: { user: true } });
    if (opdsKey && opdsKey.user.username === userHeader) user = opdsKey.user;

    if (!user) {
        const adminKey = await prisma.apiKey.findUnique({ where: { keyHash }, include: { user: true } });
        if (adminKey && adminKey.user.username === userHeader) user = adminKey.user;
    }

    if (!user) return NextResponse.json({ authorized: "KO" }, { status: 401 });

    // 2. Await params for Next.js 15 compatibility
    const resolvedParams = await params;

    const syncData = await prisma.koreaderSync.findUnique({
        where: { userId_document: { userId: user.id, document: resolvedParams.document } }
    });

    if (!syncData) return NextResponse.json({ error: "Not found" }, { status: 404 });

        return NextResponse.json({
            document: syncData.document,
            progress: syncData.progress,
            percentage: syncData.percentage,
            device: syncData.device,
            device_id: syncData.deviceId,
            timestamp: syncData.timestamp
        });
    } catch (error: unknown) {
        Logger.log(`[KOReader Sync Fetch API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}