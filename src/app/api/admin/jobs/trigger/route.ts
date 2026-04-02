import { NextResponse } from 'next/server';
import { omnibusQueue } from '@/lib/queue';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    try {
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
            'update_check': 'UPDATE_CHECK'
        };

        const jobType = jobMap[job];

        if (!jobType) {
            return NextResponse.json({ error: "Invalid job specified" }, { status: 400 });
        }

        await omnibusQueue.add(jobType, { type: jobType }, {
            jobId: `${jobType}_${Date.now()}`
        });

        Logger.log(`[Queue] Successfully enqueued job: ${jobType}`, "info");

        return NextResponse.json({ 
            success: true, 
            message: `${jobType} has been added to the background queue.` 
        });

    } catch (error: unknown) {
        Logger.log(`[Queue] Failed to enqueue job: ${getErrorMessage(error)}`, "error");
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}