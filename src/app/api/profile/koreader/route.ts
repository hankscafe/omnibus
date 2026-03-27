// src/app/api/profile/koreader/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;

    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
        // Fetch all syncs for the user, newest first
        const syncs = await prisma.koreaderSync.findMany({
            where: { userId },
            orderBy: { timestamp: 'desc' }
        });

        // Group by unique Device ID to just get the latest activity per device
        const devicesMap = new Map();
        for (const sync of syncs) {
            if (!devicesMap.has(sync.deviceId)) {
                // Clean up the document name to make it look nicer (remove path/extensions)
                const cleanDocName = sync.document.split('/').pop()?.replace(/\.[^/.]+$/, "") || sync.document;

                devicesMap.set(sync.deviceId, {
                    deviceId: sync.deviceId,
                    deviceName: sync.device || 'Unknown eReader',
                    lastDocument: cleanDocName,
                    percentage: sync.percentage,
                    lastSync: sync.timestamp // KOReader uses unix timestamps (seconds)
                });
            }
        }

        return NextResponse.json(Array.from(devicesMap.values()));
    } catch (error: any) {
        Logger.log(`Failed to fetch KOReader devices: ${error.message}`, 'error');
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}