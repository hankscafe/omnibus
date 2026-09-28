// src/app/api/koreader/syncs/progress/[document]/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { authenticateKoreader, koreaderUnauthorizedResponse } from '@/lib/koreader-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ document: string }> }) {
    try {
        const auth = await authenticateKoreader(request);
        if (!auth.user) return koreaderUnauthorizedResponse(auth.error);
        const { user } = auth;

        // Next.js 15 params are asynchronous.
        const resolvedParams = await params;
        const syncData = await prisma.koreaderSync.findUnique({
            where: { userId_document: { userId: user.id, document: resolvedParams.document } }
        });

        // KOReader treats a successful response without percentage as "No progress found".
        if (!syncData) return NextResponse.json({});

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
        return NextResponse.json({ code: 2000, message: 'KOReader progress pull failed' }, { status: 500 });
    }
}
