// src/lib/cron.ts
import { prisma } from './db';
import { healStuckJobs } from './job-heal';
import { DownloadService } from './download-clients';
import { Logger } from './logger';
import { Importer } from './importer';
import { omnibusQueue, syncSchedules } from '@/lib/queue';
import { DiscordNotifier } from '@/lib/discord';
import { getErrorMessage } from './utils/error';
import { extractIssueNumber } from '@/lib/utils/issue-parser';
import { JUNK_WORDS as junkWords } from '@/lib/utils/search-terms';
import { deleteUsenetSource } from '@/lib/utils/usenet-cleanup';
import { resolveRemotePath } from '@/lib/utils/path-resolver';
import path from 'path';

const globalForCron = globalThis as unknown as { _cronInitialized: boolean };

// In-process re-entrancy guard for the 60s download checker. A completed download triggers an in-process
// importRequest (copy + CBR→CBZ WebP conversion) that can run well past 60s for a large issue; without
// this, the next tick would re-fire the importer for the still-DOWNLOADING request and copy duplicate
// files. (The DB JobLock's 55s staleness window is shorter than a slow import, so it can't prevent this alone.)
let downloadCheckerRunning = false;

async function acquireLock(lockId: string, timeoutMs: number): Promise<boolean> {
    const cutoff = new Date(Date.now() - timeoutMs);
    try {
        const existing = await prisma.jobLock.findUnique({ where: { id: lockId } });
        if (!existing) {
            try {
                await prisma.jobLock.create({ data: { id: lockId, lockedAt: new Date() } });
                return true;
            } catch (e: any) {
                // P2002: Unique constraint failed. Another instance created the lock milliseconds before us.
                if (e.code === 'P2002') return false;
                throw e;
            }
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
    if (downloadCheckerRunning) return; // a prior cycle (e.g. a slow import) is still in flight
    downloadCheckerRunning = true;

    try {
      const locked = await acquireLock('CRON_DOWNLOAD_CHECKER', 55000);
      if (!locked) return;

      // Stuck-job auto-heal (moved off the 3s-polled job-logs GET — issue #183). Read-only when
      // nothing is stuck; best-effort, never blocks the download checks below.
      try {
        const healed = await healStuckJobs();
        if (healed > 0) Logger.log(`[Cron] Auto-healed ${healed} stuck job log(s) (server restart likely).`, 'warn');
      } catch { /* next tick retries */ }

      const stalledRequests = await prisma.request.findMany({
        where: { status: 'STALLED', retryCount: { lt: 3 } }
      });

      // Release parked batch siblings stranded by a permanently-failed lead. A getcomics batch can
      // short-circuit duplicate requests (automation.ts), parking the siblings as DOWNLOADING against a
      // single lead download. If that lead exhausts its retries and goes terminally STALLED, the active-
      // torrent reconciler further down never touches the siblings (it only matches client torrents), so
      // they sit DOWNLOADING forever. Mark them STALLED too — and terminal, since re-downloading a pack
      // that already failed three times is pointless — so the whole pack reflects the failure consistently.
      const deadLeads = await prisma.request.findMany({
        where: { status: 'STALLED', retryCount: { gte: 3 }, downloadLink: { startsWith: 'http' } },
        select: { downloadLink: true }
      });
      const deadLinks = [...new Set(deadLeads.map(r => r.downloadLink).filter((l): l is string => !!l))];
      if (deadLinks.length > 0) {
        const released = await prisma.request.updateMany({
          where: { status: 'DOWNLOADING', downloadLink: { in: deadLinks } },
          data: { status: 'STALLED', retryCount: 3, progress: 0 }
        });
        if (released.count > 0) {
          Logger.log(`[Cron] Released ${released.count} parked download(s) stranded by a failed batch lead.`, 'warn');
        }
      }

      if (stalledRequests.length > 0) {
        const retryDelaySetting = await prisma.systemSetting.findUnique({ where: { key: 'download_retry_delay' } });
        const retryDelayMinutes = parseInt(retryDelaySetting?.value || "5");

        for (const req of stalledRequests) {
          if (req.downloadLink && req.downloadLink.startsWith('http')) {
            const timeSinceLastUpdate = Date.now() - req.updatedAt.getTime();
            Logger.log(`[Cron Debug] Evaluating stalled request ${req.id}. Time since last update: ${Math.round(timeSinceLastUpdate / 60000)}m (Threshold: ${retryDelayMinutes}m)`, 'debug');
            
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

      // --- NEW: Sync Progress across batch DDL downloads ---
      const activeDbRequests = await prisma.request.findMany({
          where: { 
              status: 'DOWNLOADING', 
              downloadLink: { not: null },
              NOT: [
                  { downloadLink: "" },
                  { downloadLink: "PENDING_MATCH" }
              ]
          }
      });

      const linkProgressMap = new Map<string, number>();
      for (const r of activeDbRequests) {
          const currentMax = linkProgressMap.get(r.downloadLink!) || 0;
          if (r.progress && r.progress > currentMax) {
              linkProgressMap.set(r.downloadLink!, r.progress);
          }
      }

      for (const r of activeDbRequests) {
          const maxProgress = linkProgressMap.get(r.downloadLink!);
          if (maxProgress !== undefined && maxProgress > (r.progress || 0)) {
              Logger.log(`[Cron Debug] Syncing batch progress for request ${r.id} to ${maxProgress}%`, 'debug');
              await prisma.request.update({
                  where: { id: r.id },
                  data: { progress: maxProgress }
              });
          }
      }
      // -----------------------------------------------

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
                      
                      Logger.log(`[Cron Debug] Evaluating active torrent "${torrent.name}" against DB Request "${r.activeDownloadName}"`, 'debug');

                      const reqNum = parseFloat(extractIssueNumber(reqNameLower));
                      const torNum = parseFloat(extractIssueNumber(torNameLower));

                      const reqYear = seriesYearMap.get(r.volumeId);
                      // #202: group 1 must capture the WHOLE year — /(19|20)\d{2}/ captured the
                      // literal "19"/"20", so every dated torrent failed this gate. Engine twin:
                      // search_engine.rs re_year_find.
                      const torYearMatch = torNameLower.match(/[\(\[]?((?:19|20)\d{2})[\)\]]?/);
                      const torYear = torYearMatch ? torYearMatch[1] : null;

                      if (reqYear && torYear && reqYear !== torYear) {
                          Logger.log(`[Cron Debug] Match failed: Year mismatch (Req: ${reqYear} vs Tor: ${torYear})`, 'debug');
                          return false;
                      }

                      if (reqNum !== null && torNum !== null) {
                          if (reqNum !== torNum) {
                              Logger.log(`[Cron Debug] Match failed: Issue number mismatch (Req: ${reqNum} vs Tor: ${torNum})`, 'debug');
                              return false; 
                          }
                      } else if (reqNum !== null && torNum === null) {
                          if (reqNum !== 1) {
                              Logger.log(`[Cron Debug] Match failed: Missing torrent issue number, but request is not #1 (Req: ${reqNum})`, 'debug');
                              return false; 
                          }
                      }

                      const cleanReqName = reqNameLower.replace(/[0-9]/g, '');
                      const cleanTorName = torNameLower.replace(/[0-9]/g, '');
                      
                      const reqWords = cleanReqName.replace(/[^a-z]/g, ' ').split(/\s+/).filter((w: string) => w.length > 2 && !junkWords.includes(w));
                      const torWords = cleanTorName.replace(/[^a-z]/g, ' ').split(/\s+/).filter((w: string) => w.length > 2 && !junkWords.includes(w));
                      
                      if (reqWords.length === 0 || torWords.length === 0) return false;

                      let matches = 0;
                      reqWords.forEach((w: string) => { if (torWords.includes(w)) matches++; });
                      
                      const maxLength = Math.max(reqWords.length, torWords.length);
                      const matchRatio = matches / maxLength;
                      
                      if (matchRatio < 0.7) {
                          Logger.log(`[Cron Debug] Match failed: Text similarity ratio too low (${matchRatio.toFixed(2)} < 0.7)`, 'debug');
                          return false;
                      }
                      
                      Logger.log(`[Cron Debug] Match SUCCESS! Ratio: ${matchRatio.toFixed(2)}`, 'debug');
                      return true; 
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

                  // --- NEW: Detect Failed Downloads ---
                  const isFailed = torrent.status?.toLowerCase() === 'failed' || 
                                   torrent.status?.toLowerCase() === 'failure' || 
                                   torrent.status?.toLowerCase().includes('error') || 
                                   torrent.status?.toLowerCase() === 'missingfiles';

                  if (isFailed) {
                      Logger.log(`[Cron] Client reported download failure for: ${torrent.name}. Executing try-next-release fallback...`, 'warn');
                      
                      // 1. Wipe the failed job from the external client
                      const clientConfig = await prisma.downloadClient.findFirst({ where: { name: torrent.clientName } });
                      if (clientConfig) {
                          await DownloadService.removeDownload(clientConfig, torrent.id).catch(() => {});

                          // Issue #198 companion fix: SAB/NZBGet report failures from HISTORY, where the
                          // queue-scoped wipe above can't delete files (SAB's history del_files only covers
                          // failed jobs it still knows; NZBGet's never touches disk) — clear the leftover
                          // job folder from the category folder ourselves. Torrents are excluded: their
                          // client-side delete already removed the payload.
                          if (['sab', 'nzbget'].includes(clientConfig.type)) {
                              try {
                                  const dlRoot = clientConfig.localPath
                                      || (await prisma.systemSetting.findUnique({ where: { key: 'download_path' } }))?.value
                                      || './downloads';
                                  const failedSource = await resolveRemotePath(path.join(dlRoot, torrent.name));
                                  await deleteUsenetSource({ clientType: clientConfig.type, clientRoot: dlRoot, sourcePath: failedSource, reason: 'failed' });
                              } catch (cleanupErr) {
                                  Logger.log(`[Cron] Failed-download cleanup skipped: ${getErrorMessage(cleanupErr)}`, 'debug');
                              }
                          }
                      }

                      // 2. Fetch request and check retry cap
                      const req = await prisma.request.findUnique({ where: { id: match.id } });
                      if (req && (req.retryCount || 0) < 3) {
                          let currentFailed: string[] = [];
                          try { currentFailed = JSON.parse((req as any).failedLinks || "[]"); } catch(e){}
                          
                          // Block BOTH the specific hash/url and the exact Release Title
                          if (req.downloadLink && !currentFailed.includes(req.downloadLink)) currentFailed.push(req.downloadLink);
                          if (torrent.name && !currentFailed.includes(torrent.name)) currentFailed.push(torrent.name);

                          await prisma.request.update({
                              where: { id: match.id },
                              data: {
                                  status: 'PENDING',
                                  downloadLink: null,
                                  retryCount: (req.retryCount || 0) + 1,
                                  failedLinks: JSON.stringify(currentFailed)
                              } as any
                          });

                          Logger.log(`[Cron] Re-queuing failed request "${req.activeDownloadName || req.id}" (Attempt ${(req.retryCount || 0) + 1}/3)`, 'info');
                          
                          // 3. Reconstruct Search Context safely
                          const { searchAndDownload } = await import('@/lib/automation');
                          const series = req.volumeId !== "0" ? await prisma.series.findFirst({ where: { metadataId: req.volumeId } }) : null;
                          
                          // Fallback year parsing if series isn't in DB
                          let searchYear = series?.year?.toString() || "";
                          if (!searchYear && req.activeDownloadName) {
                              const yearMatch = req.activeDownloadName.match(/\b(19\d{2}|20\d{2})\b/);
                              if (yearMatch) searchYear = yearMatch[1];
                          }

                          // Reconstruct clean query name to prevent dirty release groups from corrupting queries
                          let cleanSearchName = (req as any).name || req.activeDownloadName || "Unknown";
                          if (series) {
                              const cleanTitleStr = (req.activeDownloadName || "").replace(/\.\w+$/, '');
                              const issueMatch = cleanTitleStr.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?[a-zA-Z]?)/i);
                              const issueNum = issueMatch ? issueMatch[1] : "1";
                              cleanSearchName = `${series.name} #${issueNum}`;
                          }
                          
                          await searchAndDownload(
                              req.id, 
                              cleanSearchName, 
                              searchYear, 
                              series?.publisher || "Unknown", 
                              series?.isManga || false, 
                              false
                          );
                      } else if (req) {
                          Logger.log(`[Cron] Request "${req.activeDownloadName || req.id}" failed 3 times. Marking as STALLED.`, 'error');
                          await prisma.request.update({
                              where: { id: match.id },
                              data: { status: 'STALLED' }
                          });
                      }
                      
                      const index = downloadingRequests.findIndex(r => r.id === match!.id);
                      if (index > -1) downloadingRequests.splice(index, 1);
                      continue;
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
    } finally {
      downloadCheckerRunning = false;
    }
  }, 60000);
}