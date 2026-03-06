import { prisma } from './db';
import { DownloadService } from './download-clients';
import { Logger } from './logger';
import axios from 'axios';
import { Importer } from './importer';

export function initCronJobs() {
  Logger.log("[Cron] Initializing background automation...", "info");

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
  }, 60000);

  // 2. ComicVine Metadata Auto-Sync
  setInterval(async () => {
    try {
        const scheduleSetting = await prisma.systemSetting.findUnique({ where: { key: 'metadata_sync_schedule' } });
        const scheduleHours = parseInt(scheduleSetting?.value || "0");

        if (scheduleHours > 0) {
            const lastSyncSetting = await prisma.systemSetting.findUnique({ where: { key: 'last_metadata_sync' } });
            const lastSync = parseInt(lastSyncSetting?.value || "0");
            const now = Date.now();

            if (now - lastSync > scheduleHours * 60 * 60 * 1000) {
                Logger.log(`[Cron] Starting Automated ComicVine Metadata Sync...`, "info");
                // Force internal loopback routing
                await axios.post(`http://127.0.0.1:3000/api/admin/jobs/trigger`, { job: 'metadata' }).catch(() => {});
            }
        }
    } catch (error: any) {
        Logger.log(`[Cron] Metadata Sync Interval Error: ${error.message}`, "error");
    }
  }, 3600000); 

  // 3. Local Library Auto-Scan
  setInterval(async () => {
    try {
        const scheduleSetting = await prisma.systemSetting.findUnique({ where: { key: 'library_sync_schedule' } });
        const scheduleHours = parseInt(scheduleSetting?.value || "0");

        if (scheduleHours > 0) {
            const lastSyncSetting = await prisma.systemSetting.findUnique({ where: { key: 'last_library_sync' } });
            const lastSync = parseInt(lastSyncSetting?.value || "0");
            const now = Date.now();

            if (now - lastSync > scheduleHours * 60 * 60 * 1000) {
                Logger.log(`[Cron] Starting Automated Library Scan...`, "info");
                // Force internal loopback routing
                await axios.post(`http://127.0.0.1:3000/api/admin/jobs/trigger`, { job: 'library' }).catch(() => {});
            }
        }
    } catch (error: any) {}
  }, 3600000);

  // 4. Series Monitor Auto-Scan
  setInterval(async () => {
    try {
        const scheduleSetting = await prisma.systemSetting.findUnique({ where: { key: 'monitor_sync_schedule' } });
        const scheduleHours = parseInt(scheduleSetting?.value || "0");

        if (scheduleHours > 0) {
            const lastSyncSetting = await prisma.systemSetting.findUnique({ where: { key: 'last_monitor_sync' } });
            const lastSync = parseInt(lastSyncSetting?.value || "0");
            const now = Date.now();

            if (now - lastSync > scheduleHours * 60 * 60 * 1000) {
                Logger.log(`[Cron] Starting Automated Series Monitor Scan...`, "info");
                // Force internal loopback routing
                await axios.post(`http://127.0.0.1:3000/api/admin/jobs/trigger`, { job: 'monitor' }).catch(() => {});
            }
        }
    } catch (error: any) {}
  }, 3600000);

  // 5. Automated Diagnostics
  setInterval(async () => {
    try {
        const scheduleSetting = await prisma.systemSetting.findUnique({ where: { key: 'diagnostics_sync_schedule' } });
        const scheduleHours = parseInt(scheduleSetting?.value || "0");

        if (scheduleHours > 0) {
            const lastSyncSetting = await prisma.systemSetting.findUnique({ where: { key: 'last_diagnostics_sync' } });
            const lastSync = parseInt(lastSyncSetting?.value || "0");
            const now = Date.now();

            if (now - lastSync > scheduleHours * 60 * 60 * 1000) {
                Logger.log(`[Cron] Starting Automated Library Diagnostics...`, "info");
                // Force internal loopback routing
                await axios.post(`http://127.0.0.1:3000/api/admin/jobs/trigger`, { job: 'diagnostics' }).catch(() => {});
            }
        }
    } catch (error: any) {}
  }, 3600000);
}