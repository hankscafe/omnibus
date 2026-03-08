import { prisma } from './db';
import { DownloadService } from './download-clients';
import { Logger } from './logger';
import { Importer } from './importer';
// FIX: Import the API route directly so we can bypass the network
import { POST as executeJobRoute } from '@/app/api/admin/jobs/trigger/route';

// Attach strictly to globalThis so Next.js internal reloads never bypass the lock
const globalForCron = globalThis as unknown as { _cronInitialized: boolean };

export function initCronJobs() {
  if (globalForCron._cronInitialized) return;
  globalForCron._cronInitialized = true;

  Logger.log("[Cron] Initializing native background automation...", "info");

  // 1. Download Status Checker (Runs every 60 seconds)
  setInterval(async () => {
    try {
      const stalledRequests = await prisma.request.findMany({
        where: { status: 'STALLED', retryCount: { lt: 3 } }
      });

      if (stalledRequests.length > 0) {
        const retryDelaySetting = await prisma.systemSetting.findUnique({ where: { key: 'download_retry_delay' } });
        const retryDelayMinutes = parseInt(retryDelaySetting?.value || "5");

        for (const req of stalledRequests) {
          if (req.downloadLink && req.downloadLink.startsWith('http')) {
            const timeSinceLastUpdate = Date.now() - req.updatedAt.getTime();
            
            if (timeSinceLastUpdate >= retryDelayMinutes * 60 * 1000) {
              const attemptNum = (req.retryCount || 0) + 1;
              Logger.log(`[Cron] Retrying stalled download for ${req.activeDownloadName || req.id} (Attempt ${attemptNum}/3)`, 'info');
              
              await prisma.jobLog.create({
                  data: {
                      jobType: 'DOWNLOAD_RETRY',
                      status: 'IN_PROGRESS',
                      relatedItem: req.activeDownloadName || req.seriesName,
                      message: `Automatic retry triggered after ${retryDelayMinutes}m stall limit.`
                  }
              });

              await prisma.request.update({
                where: { id: req.id },
                data: { retryCount: attemptNum, status: 'DOWNLOADING', progress: 0 }
              });

              const settings = await prisma.systemSetting.findMany();
              const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
              
              DownloadService.downloadDirectFile(req.downloadLink, req.activeDownloadName || "comic", config.download_path, req.id)
                .then(async (success) => {
                    if (success) {
                        await new Promise(r => setTimeout(r, 2000));
                        await Importer.importRequest(req.id);
                    }
                })
                .catch(() => {});
            }
          }
        }
      }
    } catch (error: any) {
      Logger.log(`[Cron] Download Checker Error: ${error.message}`, 'error');
    }
  }, 60000); // 60 seconds

  // 2. General Scheduled Jobs (Runs every 15 minutes)
  setInterval(async () => {
    const now = Date.now();

    // Reusable helper function to check database schedules and trigger internal API
    const checkAndTrigger = async (jobName: string, scheduleKey: string, lastSyncKey: string, logName: string) => {
        try {
            const scheduleSetting = await prisma.systemSetting.findUnique({ where: { key: scheduleKey } });
            const scheduleHours = parseInt(scheduleSetting?.value || "0");

            if (scheduleHours > 0) {
                const lastSyncSetting = await prisma.systemSetting.findUnique({ where: { key: lastSyncKey } });
                const lastSync = parseInt(lastSyncSetting?.value || "0");

                if (now - lastSync > scheduleHours * 60 * 60 * 1000) {
                    Logger.log(`[Cron] Starting Automated ${logName}...`, "info");
                    
                    // FIX: Execute the route function directly in memory!
                    // This completely bypasses the broken Docker loopback network.
                    try {
                        const mockRequest = new Request('http://localhost/api/admin/jobs/trigger', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ job: jobName })
                        });
                        
                        await executeJobRoute(mockRequest);
                    } catch (err: any) {
                        Logger.log(`[Cron] Internal Execution Failed for ${jobName}: ${err.message}`, "error");
                    }
                }
            }
        } catch (error: any) {
            Logger.log(`[Cron] ${logName} Interval Error: ${error.message}`, "error");
        }
    };

    // Process all 4 job queues sequentially
    await checkAndTrigger('metadata', 'metadata_sync_schedule', 'last_metadata_sync', 'ComicVine Metadata Sync');
    await checkAndTrigger('library', 'library_sync_schedule', 'last_library_sync', 'Library Scan');
    await checkAndTrigger('monitor', 'monitor_sync_schedule', 'last_monitor_sync', 'Series Monitor Scan');
    await checkAndTrigger('diagnostics', 'diagnostics_sync_schedule', 'last_diagnostics_sync', 'Library Diagnostics');
  }, 900000); // 15 minutes (900,000 ms)
}