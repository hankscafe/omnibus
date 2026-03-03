import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        // --- 1. AUTOMATIC GARBAGE COLLECTION ---
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 7);
        
        await prisma.jobLog.deleteMany({
            where: {
                createdAt: {
                    lt: cutoffDate
                }
            }
        });

        // --- 2. SCHEDULED JOBS EVALUATION ---
        const settings = await prisma.systemSetting.findMany({
            where: {
                key: {
                    in: [
                        'library_sync_schedule', 'metadata_sync_schedule', 'monitor_sync_schedule', 'diagnostics_sync_schedule', 'backup_sync_schedule',
                        // FIX: Added the new Popular interval setting
                        'popular_sync_schedule',
                        
                        'last_library_sync', 'last_metadata_sync', 'last_monitor_sync', 'last_diagnostics_sync', 'last_backup_sync',
                        // FIX: Added the new Popular last run timestamp
                        'last_popular_sync'
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
        
        // FIX: Added the check for the new Popular job
        checkJob('popular', 'popular_sync_schedule', 'last_popular_sync');

        const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
        for (const job of jobsToRun) {
            Logger.log(`[CRON] External heartbeat triggering job: ${job}`, 'info');
            fetch(`${baseUrl}/api/admin/jobs/trigger`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job })
            }).catch(() => {});
            // Stagger the jobs slightly so we don't overwhelm the server if multiple trigger at once
            await new Promise(r => setTimeout(r, 2000));
        }

        return NextResponse.json({ success: true, jobsTriggered: jobsToRun, logsPurged: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}