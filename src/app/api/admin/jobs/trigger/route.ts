import { NextResponse } from 'next/server';
import { omnibusQueue } from '@/lib/queue';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { AuditLogger } from '@/lib/audit-logger';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;

        const { job } = await request.json();
        
        const jobMap: Record<string, string> = {
            'backup': 'DATABASE_BACKUP',
            'converter': 'CBR_CONVERSION',
            'library': 'LIBRARY_SCAN',
            'metadata': 'METADATA_SYNC',
            'embed_metadata': 'EMBED_METADATA',
            'monitor': 'SERIES_MONITOR',
            'diagnostics': 'DIAGNOSTICS',
            'popular': 'DISCOVER_SYNC',
            'storage_scan': 'STORAGE_SCAN',
            'update_check': 'UPDATE_CHECK',
            'weekly_digest': 'WEEKLY_DIGEST'
        };

        const jobType = jobMap[job];

        if (!jobType) {
            return NextResponse.json({ error: "Invalid job specified" }, { status: 400 });
        }

        await omnibusQueue.add(jobType, { type: jobType }, {
            jobId: `${jobType}_${Date.now()}`
        });

        Logger.log(`[Queue] Successfully enqueued job: ${jobType}`, "info");

        // Do not audit log if the heartbeat triggers it, only if a user ID is present (Admin click)
        if (userId) {
            await AuditLogger.log('ADMIN_TRIGGERED_JOB', { job: jobType }, userId);
        }

        return NextResponse.json({ 
            success: true, 
            message: `${jobType} has been added to the background queue.` 
        });

    } catch (error: unknown) {
        Logger.log(`[Queue] Failed to enqueue job: ${getErrorMessage(error)}`, "error");
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}