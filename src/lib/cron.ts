import { prisma } from './db';
import { DownloadService } from './download-clients';
import { Logger } from './logger';
import { Importer } from './importer';
import { POST as executeJobRoute } from '@/app/api/admin/jobs/trigger/route';
import { DiscordNotifier } from '@/lib/discord';

const globalForCron = globalThis as unknown as { _cronInitialized: boolean };

export function initCronJobs() {
  if (globalForCron._cronInitialized) return;
  globalForCron._cronInitialized = true;

  Logger.log("[Cron] Initializing native background automation...", "info");

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

      // --- B. Auto-Import Completed Torrents / Usenet ---
      const activeDownloads = await DownloadService.getAllActiveDownloads();
      const completedTorrents = activeDownloads.filter((t: any) => parseFloat(t.progress) >= 100);

      if (completedTorrents.length > 0) {
          const downloadingRequests = await prisma.request.findMany({
              where: { status: 'DOWNLOADING' }
          });

          for (const torrent of completedTorrents) {
              // 1. Strict match on tracking hash/guid
              let match = downloadingRequests.find(r => r.downloadLink && r.downloadLink.toLowerCase() === torrent.id.toLowerCase());
              
              // 2. Exact fallback match on active download name
              if (!match) match = downloadingRequests.find(r => r.activeDownloadName === torrent.name);
              
              // 3. FIX: Smart Fuzzy Match (Compare significant words)
              if (!match) {
                  match = downloadingRequests.find(r => {
                      if (!r.activeDownloadName) return false;
                      const reqWords = r.activeDownloadName.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 2);
                      const torWords = torrent.name.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 2);
                      
                      let matches = 0;
                      reqWords.forEach(w => { if (torWords.includes(w)) matches++; });
                      // Return true if at least 3 significant words match, OR all of them match
                      return matches >= 3 || (reqWords.length > 0 && matches === reqWords.length);
                  });
              }
              
              if (match) {
                  Logger.log(`[Cron] Client download completed: ${torrent.name}. Triggering importer...`, 'info');
                  
                  await prisma.request.update({
                      where: { id: match.id },
                      data: { activeDownloadName: torrent.name, downloadLink: torrent.id }
                  });

                  await Importer.importRequest(match.id);
              }
          }
      }

    } catch (error: any) {
      Logger.log(`[Cron] Download Checker Error: ${error.message}`, 'error');
    }
  }, 60000); 

  setInterval(async () => {
    const now = Date.now();

    const checkAndTrigger = async (jobName: string, scheduleKey: string, lastSyncKey: string, logName: string) => {
        try {
            const scheduleSetting = await prisma.systemSetting.findUnique({ where: { key: scheduleKey } });
            const scheduleHours = parseInt(scheduleSetting?.value || "0");

            if (scheduleHours > 0) {
                const lastSyncSetting = await prisma.systemSetting.findUnique({ where: { key: lastSyncKey } });
                const lastSync = parseInt(lastSyncSetting?.value || "0");

                if (now - lastSync > scheduleHours * 60 * 60 * 1000) {
                    Logger.log(`[Cron] Starting Automated ${logName}...`, "info");
                    
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

    await checkAndTrigger('metadata', 'metadata_sync_schedule', 'last_metadata_sync', 'ComicVine Metadata Sync');
    await checkAndTrigger('library', 'library_sync_schedule', 'last_library_sync', 'Library Scan');
    await checkAndTrigger('monitor', 'monitor_sync_schedule', 'last_monitor_sync', 'Series Monitor Scan');
    await checkAndTrigger('diagnostics', 'diagnostics_sync_schedule', 'last_diagnostics_sync', 'Library Diagnostics');
    await checkAndTrigger('popular', 'popular_sync_schedule', 'last_popular_sync', 'Discover Sync');
    await checkAndTrigger('backup', 'backup_sync_schedule', 'last_backup_sync', 'Database Backup');

    try {
        const lastUpdateCheck = await prisma.systemSetting.findUnique({ where: { key: 'last_update_check_time' } });
        const lastUpdateCheckTime = parseInt(lastUpdateCheck?.value || "0");

        if (now - lastUpdateCheckTime > 86400000) {
            await prisma.systemSetting.upsert({
                where: { key: 'last_update_check_time' },
                update: { value: now.toString() },
                create: { key: 'last_update_check_time', value: now.toString() }
            });

            const mockRequest = new Request('http://localhost/api/admin/jobs/trigger', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job: 'update_check' })
            });
            await executeJobRoute(mockRequest);
        }
    } catch (err: any) {
        Logger.log(`[Cron] Update Check Error: ${err.message}`, "error");
    }

  }, 900000); 
}