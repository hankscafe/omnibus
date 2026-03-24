import { prisma } from './db';
import { DownloadService } from './download-clients';
import { Logger } from './logger';
import { Importer } from './importer';
import { POST as executeJobRoute } from '@/app/api/admin/jobs/trigger/route';
import { DiscordNotifier } from '@/lib/discord';
import { getErrorMessage } from './utils/error';

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
                      relatedItem: req.activeDownloadName || (req as any).name || "Unknown",
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

      // --- B. Auto-Link and Auto-Import Torrents / Usenet ---
      const activeDownloads = await DownloadService.getAllActiveDownloads();

      if (activeDownloads.length > 0) {
          const downloadingRequests = await prisma.request.findMany({
              where: { status: 'DOWNLOADING' }
          });

          for (const torrent of activeDownloads) {
              // 1. Strict match on tracking hash/guid
              let match = downloadingRequests.find(r => r.downloadLink && r.downloadLink.toLowerCase() === torrent.id.toLowerCase());
              
              // 2. Exact fallback match on active download name
              if (!match) match = downloadingRequests.find(r => r.activeDownloadName === torrent.name);
              
              // 3. Mathematical Matcher (Prevents Hijacking)
              if (!match) {
                  match = downloadingRequests.find(r => {
                      if (!r.activeDownloadName) return false;
                      
                      const reqNameLower = r.activeDownloadName.toLowerCase();
                      const torNameLower = torrent.name.toLowerCase();

                      const extractNum = (str: string) => {
                          const clean = str.replace(/\.\w+$/, '').replace(/\[\d{4}(?:-\d{4})?\]/g, '').replace(/\(\d{4}(?:-\d{4})?\)/g, '');
                          const chMatch = clean.match(/(?:ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
                          if (chMatch) return parseFloat(chMatch[1]);
                          const issueMatch = clean.match(/(?:#|issue\s*#?)\s*0*(\d+(?:\.\d+)?)/i);
                          if (issueMatch) return parseFloat(issueMatch[1]);
                          const volMatch = clean.match(/(?:vol(?:ume)?\s*\.?|v\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
                          if (volMatch) return parseFloat(volMatch[1]);
                          const fallbacks = [...clean.matchAll(/(?:[^a-zA-Z0-9]|^)0*(\d+(?:\.\d+)?)(?:[^a-zA-Z0-9]|$)/g)];
                          if (fallbacks.length > 0) return parseFloat(fallbacks[fallbacks.length - 1][1]);
                          return null;
                      };

                      const reqNum = extractNum(reqNameLower);
                      const torNum = extractNum(torNameLower);

                      if (reqNum !== null && torNum !== null) {
                          if (reqNum !== torNum) return false; 
                      } else if (reqNum !== null && torNum === null) {
                          if (reqNum !== 1) return false; // Strict block: if torrent has no numbers, it can only be issue 1.
                      }

                      let cleanReqName = reqNameLower.replace(/[0-9]/g, '');
                      let cleanTorName = torNameLower.replace(/[0-9]/g, '');
                      
                      const junkWords = ['eng', 'cbz', 'cbr', 'cb7', 'zip', 'rar', 'webrip', 'digital', 'vol', 'volume', 'ch', 'chapter', 'issue', 'tpb', 'rip', 'the', 'and', 'of', 'by', 'gn'];
                      
                      const reqWords = cleanReqName.replace(/[^a-z]/g, ' ').split(/\s+/).filter((w: string) => w.length > 2 && !junkWords.includes(w));
                      const torWords = cleanTorName.replace(/[^a-z]/g, ' ').split(/\s+/).filter((w: string) => w.length > 2 && !junkWords.includes(w));
                      
                      if (reqWords.length === 0 || torWords.length === 0) return false;

                      let matches = 0;
                      reqWords.forEach((w: string) => { if (torWords.includes(w)) matches++; });
                      
                      const minLength = Math.min(reqWords.length, torWords.length);
                      return (matches / minLength) >= 0.5;
                  });
              }
              
              if (match) {
                  // Link the hash early if it was missing so the UI can track progress
                  if (match.downloadLink !== torrent.id || match.activeDownloadName !== torrent.name) {
                      await prisma.request.update({
                          where: { id: match.id },
                          data: { activeDownloadName: torrent.name, downloadLink: torrent.id }
                      });
                      match.downloadLink = torrent.id;
                      match.activeDownloadName = torrent.name;
                  }

                  // Auto-Import if 100% complete
                  if (parseFloat(torrent.progress) >= 100) {
                      Logger.log(`[Cron] Client download completed: ${torrent.name}. Triggering importer...`, 'info');
                      
                      const index = downloadingRequests.findIndex(r => r.id === match!.id);
                      if (index > -1) downloadingRequests.splice(index, 1);

                      await Importer.importRequest(match.id);
                  }
              }
          }
      }

    } catch (error: unknown) {
      Logger.log(`[Cron] Download Checker Error: ${getErrorMessage(error)}`, 'error');
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
        } catch (error: unknown) {
            Logger.log(`[Cron] ${logName} Interval Error: ${getErrorMessage(error)}`, "error");
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