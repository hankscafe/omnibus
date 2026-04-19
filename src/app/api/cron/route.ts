// src/app/api/cron/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { validateApiKey } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
    const authResult = await validateApiKey(req);

    if (!authResult.valid) {
        Logger.log(`[CRON] Blocked unauthorized execution attempt. ${authResult.error || ''}`, 'warn');
        return NextResponse.json({ error: authResult.error || 'Unauthorized. Invalid API Key.' }, { status: 401 });
    }

    try {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 7);
        
        // Retain the log cleanup feature
        await prisma.jobLog.deleteMany({
            where: {
                createdAt: {
                    lt: cutoffDate
                }
            }
        });

        Logger.log(`[CRON] External heartbeat received. Logs purged.`, 'info');

        return NextResponse.json({ 
            success: true, 
            message: "Heartbeat received. BullMQ is managing schedules natively." 
        });
    } catch (error: unknown) {
        Logger.log(`[Cron API] Fatal Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}