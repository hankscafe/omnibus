// src/app/api/cron/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { POST as executeJobRoute } from '@/app/api/admin/jobs/trigger/route'; 
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
        
        await prisma.jobLog.deleteMany({
            where: {
                createdAt: {
                    lt: cutoffDate
                }
            }
        });

        const settings = await prisma.systemSetting.findMany({
            where: {
                key: {
                    in: [
                        'library_sync_schedule', 'metadata_sync_schedule', 'monitor_sync_schedule', 'diagnostics_sync_schedule', 'backup_sync_schedule',
                        'popular_sync_schedule', 'weekly_digest_schedule',
                        'last_library_sync', 'last_metadata_sync', 'last_monitor_sync', 'last_diagnostics_sync', 'last_backup_sync',
                        'last_popular_sync', 'lastconverter_sync', 'last_weekly_digest'
                    ]
                }
            }
        });

        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
        const now = Date.now();
        const jobsToRun: string[] = [];

        const checkJob = (jobName: string, intervalKey: string, lastSyncKey: string) => {
            const hours = parseInt(config[intervalKey] || '0');
            if (hours > 0) {
                const lastRun = parseInt(config[lastSyncKey] || '0');
                if (now - lastRun >= hours * 60 * 60 * 1000) {
                    jobsToRun.push(jobName);
                }
            }
        };

        checkJob('library', 'library_sync_schedule', 'last_library_sync');
        checkJob('metadata', 'metadata_sync_schedule', 'last_metadata_sync');
        checkJob('monitor', 'monitor_sync_schedule', 'last_monitor_sync');
        checkJob('diagnostics', 'diagnostics_sync_schedule', 'last_diagnostics_sync');
        checkJob('backup', 'backup_sync_schedule', 'last_backup_sync');
        checkJob('popular', 'popular_sync_schedule', 'last_popular_sync');
        checkJob('converter', 'cbr_conversion_schedule', 'last_converter_sync');
        checkJob('weekly_digest', 'weekly_digest_schedule', 'last_weekly_digest'); // <-- ADDED

        for (const job of jobsToRun) {
            Logger.log(`[CRON] External heartbeat triggering job: ${job}`, 'info');
            const reqTrigger = new Request('http://localhost/api/admin/jobs/trigger', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job })
            });
            await executeJobRoute(reqTrigger).catch((err) => {
                Logger.log(`[CRON] Job ${job} execution failed: ${getErrorMessage(err)}`, 'error');
            });
            await new Promise(r => setTimeout(r, 2000));
        }

        return NextResponse.json({ success: true, jobsTriggered: jobsToRun, logsPurged: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}