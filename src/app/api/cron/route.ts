import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { POST as executeJobRoute } from '@/app/api/admin/jobs/trigger/route'; 
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

// --- SECURITY FIX: Changed from GET to POST to prevent CSRF and link prefetching ---
export async function POST(req: NextRequest) {
    // --- 1. SECURITY: API KEY VALIDATION ---
    const authHeader = req.headers.get('authorization') || '';
    const tokenFromBearer = authHeader.startsWith('Bearer ') ? authHeader.replace('Bearer ', '').trim() : null;
    const apiKeyHeader = req.headers.get('x-api-key')?.trim();
    const apiKeyQuery = req.nextUrl.searchParams.get('apiKey')?.trim();

    const providedKey = apiKeyHeader || tokenFromBearer || apiKeyQuery;

    const setting = await prisma.systemSetting.findUnique({ where: { key: 'omnibus_api_key' } });
    const validKey = setting?.value?.trim();

    if (!validKey || providedKey !== validKey) {
        Logger.log(`[CRON] Blocked unauthorized execution attempt.`, 'warn');
        return NextResponse.json({ error: 'Unauthorized. Invalid API Key.' }, { status: 401 });
    }

    try {
        // --- 2. AUTOMATIC GARBAGE COLLECTION ---
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 7);
        
        await prisma.jobLog.deleteMany({
            where: {
                createdAt: {
                    lt: cutoffDate
                }
            }
        });

        // --- 3. SCHEDULED JOBS EVALUATION ---
        const settings = await prisma.systemSetting.findMany({
            where: {
                key: {
                    in: [
                        'library_sync_schedule', 'metadata_sync_schedule', 'monitor_sync_schedule', 'diagnostics_sync_schedule', 'backup_sync_schedule',
                        'popular_sync_schedule',
                        'last_library_sync', 'last_metadata_sync', 'last_monitor_sync', 'last_diagnostics_sync', 'last_backup_sync',
                        'last_popular_sync', 'lastconverter_sync'
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

        for (const job of jobsToRun) {
            Logger.log(`[CRON] External heartbeat triggering job: ${job}`, 'info');
            const reqTrigger = new Request('http://localhost/api/admin/jobs/trigger', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job })
            });
            await executeJobRoute(reqTrigger).catch(() => {});
            await new Promise(r => setTimeout(r, 2000));
        }

        return NextResponse.json({ success: true, jobsTriggered: jobsToRun, logsPurged: true });
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}