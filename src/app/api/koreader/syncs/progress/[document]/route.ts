// src/app/api/koreader/syncs/progress/[document]/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { authenticateKoreader } from '../../../users/auth/route';

export async function GET(request: Request, { params }: { params: { document: string } }) {
    const user = await authenticateKoreader(request);
    if (!user) return NextResponse.json({ authorized: "KO" }, { status: 401 });

    const syncData = await prisma.koreaderSync.findUnique({
        where: { userId_document: { userId: user.id, document: params.document } }
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
}