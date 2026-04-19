// src/lib/cron.ts
import { prisma } from './db';
import { DownloadService } from './download-clients';
import { Logger } from './logger';
import { Importer } from './importer';
import { omnibusQueue, syncSchedules } from '@/lib/queue';
import { DiscordNotifier } from '@/lib/discord';
import { getErrorMessage } from './utils/error';

const globalForCron = globalThis as unknown as { _cronInitialized: boolean };

async function acquireLock(lockId: string, timeoutMs: number): Promise<boolean> {
    const cutoff = new Date(Date.now() - timeoutMs);
    try {
        const existing = await prisma.jobLock.findUnique({ where: { id: lockId } });
        if (!existing) {
            await prisma.jobLock.create({ data: { id: lockId, lockedAt: new Date() } });
            return true;
        }

        const result = await prisma.jobLock.updateMany({
            where: {
                id: lockId,
                lockedAt: { lt: cutoff }
            },
            data: {
                lockedAt: new Date()
            }
        });

        return result.count > 0;
    } catch (e) {
        return false;
    }
}

export function initCronJobs() {
  if (globalForCron._cronInitialized) return;
  globalForCron._cronInitialized = true;

  Logger.log("[Cron] Initializing background automation...", "info");

  // Sync BullMQ schedules on server boot
  syncSchedules().catch(err => Logger.log(`[Cron] Failed to sync schedules: ${getErrorMessage(err)}`, "error"));

  // Keep the 60-second Download Checker running independently
  setInterval(async () => {
    const locked = await acquireLock('CRON_DOWNLOAD_CHECKER', 55000); 
    if (!locked) return;

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

      const activeDownloads = await DownloadService.getAllActiveDownloads();

      if (activeDownloads.length > 0) {
          const downloadingRequests = await prisma.request.findMany({
              where: { status: 'DOWNLOADING' }
          });

          const reqMetadataIds = [...new Set(downloadingRequests.map(r => r.volumeId).filter(id => id !== "0"))];
          const relevantSeries = await prisma.series.findMany({
              where: { metadataId: { in: reqMetadataIds } },
              select: { metadataId: true, year: true }
          });
          const seriesYearMap = new Map(relevantSeries.map(s => [s.metadataId, s.year.toString()]));

          for (const torrent of activeDownloads) {
              let match = downloadingRequests.find(r => r.downloadLink && r.downloadLink.toLowerCase() === torrent.id.toLowerCase());
              
              if (!match) match = downloadingRequests.find(r => r.activeDownloadName === torrent.name);
              
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
                          const fallbacks = [...clean.matchAll(/(?<=^|[^a-zA-Z0-9])0*(\d+(?:\.\d+)?)(?=[^a-zA-Z0-9]|$)/g)];
                          if (fallbacks.length > 0) return parseFloat(fallbacks[fallbacks.length - 1][1]);
                          return null;
                      };

                      const reqNum = extractNum(reqNameLower);
                      const torNum = extractNum(torNameLower);

                      const reqYear = seriesYearMap.get(r.volumeId);
                      const torYearMatch = torNameLower.match(/[\(\[]?(19|20)\d{2}[\)\]]?/);
                      const torYear = torYearMatch ? torYearMatch[1] : null;

                      if (reqYear && torYear && reqYear !== torYear) return false;

                      if (reqNum !== null && torNum !== null) {
                          if (reqNum !== torNum) return false; 
                      } else if (reqNum !== null && torNum === null) {
                          if (reqNum !== 1) return false; 
                      }

                      let cleanReqName = reqNameLower.replace(/[0-9]/g, '');
                      let cleanTorName = torNameLower.replace(/[0-9]/g, '');
                      
                      const junkWords = ['eng', 'cbz', 'cbr', 'cb7', 'zip', 'rar', 'webrip', 'digital', 'vol', 'volume', 'ch', 'chapter', 'issue', 'tpb', 'rip', 'the', 'and', 'of', 'by', 'gn'];
                      
                      const reqWords = cleanReqName.replace(/[^a-z]/g, ' ').split(/\s+/).filter((w: string) => w.length > 2 && !junkWords.includes(w));
                      const torWords = cleanTorName.replace(/[^a-z]/g, ' ').split(/\s+/).filter((w: string) => w.length > 2 && !junkWords.includes(w));
                      
                      if (reqWords.length === 0 || torWords.length === 0) return false;

                      let matches = 0;
                      reqWords.forEach((w: string) => { if (torWords.includes(w)) matches++; });
                      
                      const maxLength = Math.max(reqWords.length, torWords.length);
                      return (matches / maxLength) >= 0.7; 
                  });
              }
              
              if (match) {
                  if (match.downloadLink !== torrent.id || match.activeDownloadName !== torrent.name) {
                      await prisma.request.update({
                          where: { id: match.id },
                          data: { activeDownloadName: torrent.name, downloadLink: torrent.id }
                      });
                      match.downloadLink = torrent.id;
                      match.activeDownloadName = torrent.name;
                  }

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
}