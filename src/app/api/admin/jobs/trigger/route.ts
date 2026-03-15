import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import axios from 'axios';
import { Logger } from '@/lib/logger'; 
import AdmZip from 'adm-zip';
import fs from 'fs-extra';
import path from 'path';

import { getCustomAcronyms, generateSearchQueries } from '@/lib/search-engine'; 
import { ProwlarrService } from '@/lib/prowlarr';
import { GetComicsService } from '@/lib/getcomics';
import { DownloadService } from '@/lib/download-clients';
import { Importer } from '@/lib/importer';
import { DiscordNotifier } from '@/lib/discord';

function isReleasedYet(storeDate: string | null, coverDate: string | null) {
    const now = new Date();
    if (storeDate) return new Date(storeDate) <= now;
    if (coverDate) {
        const buffer = new Date();
        buffer.setDate(buffer.getDate() + 45); 
        return new Date(coverDate) <= buffer;
    }
    return true; 
}

async function getFolderSize(folderPath: string): Promise<number> {
    try {
        if (!folderPath || !fs.existsSync(folderPath)) return 0;
        const files = await fs.promises.readdir(folderPath, { withFileTypes: true });
        let totalSize = 0;
        for (const file of files) {
            const fullPath = path.join(folderPath, file.name);
            if (file.isFile()) {
                const stats = await fs.promises.stat(fullPath);
                totalSize += stats.size;
            } else if (file.isDirectory()) {
                totalSize += await getFolderSize(fullPath);
            }
        }
        return totalSize;
    } catch (e) {
        return 0;
    }
}

// --- UNIFIED STORAGE ENGINE ---
// Rebuilds the Storage Deep Dive Cache & updates DB sizes for Analytics
async function runStorageScan() {
    const nowStr = Date.now().toString();
    await prisma.systemSetting.upsert({
        where: { key: 'storage_deep_dive_last_run' },
        update: { value: nowStr },
        create: { key: 'storage_deep_dive_last_run', value: nowStr }
    });

    const seriesList = await prisma.series.findMany({
        select: { id: true, name: true, publisher: true, folderPath: true, isManga: true, _count: { select: { issues: true } } }
    });

    const storageData: any[] = [];
    const batchSize = 10;
    
    for (let i = 0; i < seriesList.length; i += batchSize) {
        const batch = seriesList.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(async (s) => {
            const size = s.folderPath ? await getFolderSize(s.folderPath) : 0;
            
            // Sync to the DB for the Analytics Page
            await prisma.series.update({ where: { id: s.id }, data: { size } }).catch(() => {});
            
            return {
                id: s.id, name: s.name, publisher: s.publisher || "Unknown",
                isManga: s.isManga, issueCount: s._count.issues,
                path: s.folderPath, sizeBytes: size
            };
        }));
        storageData.push(...batchResults);
    }

    storageData.sort((a, b) => b.sizeBytes - a.sizeBytes);

    // Save to cache for the Storage Deep Dive Page
    await prisma.systemSetting.upsert({
        where: { key: 'storage_deep_dive_cache' },
        update: { value: JSON.stringify(storageData) },
        create: { key: 'storage_deep_dive_cache', value: JSON.stringify(storageData) }
    });
    
    return storageData.length;
}

async function getDownloadClient() {
    const clients = await prisma.downloadClient.findMany();
    return clients.length > 0 ? clients[0] : null;
}

async function searchAndDownload(requestId: string, name: string, year: string, publisher?: string, isManga: boolean = false) {
    const acronyms = await getCustomAcronyms();
    const queries = generateSearchQueries(name, year, acronyms);
    
    Logger.log(`[Automation] Generated ${queries.length} search variations for: ${name}`, 'info');
    
    let healthyResults: any[] = [];
    let successfulQuery = "";

    for (const query of queries) {
        Logger.log(`[Automation] Searching Prowlarr: "${query}"`, 'info');
        const prowlarrResults = await ProwlarrService.searchComics(query);
        healthyResults = prowlarrResults.filter((r: any) => r.seeders > 0 || r.protocol === 'usenet');
        if (healthyResults.length > 0) {
            successfulQuery = query;
            break; 
        }
    }

    if (healthyResults.length > 0) {
      healthyResults.sort((a: any, b: any) => b.score - a.score);
      const best = healthyResults[0];
      
      const config = await getDownloadClient();
      if (config) {
        Logger.log(`[Automation] Sending to Client: ${best.title} (Priority: ${best.priority})`, 'info');
        await DownloadService.addDownload(config, best.downloadUrl, best.title, best.seedTime || 0, best.seedRatio || 0);
        
        const trackingHash = best.infoHash || best.guid || null;
        
        await prisma.request.update({
          where: { id: requestId },
          data: { status: 'DOWNLOADING', activeDownloadName: best.title, downloadLink: trackingHash }
        });
        return; 
      }
    }

    Logger.log(`[Automation] Not found on Indexers. Falling back to GetComics...`, 'info');
    let getComicsResults: any[] = [];
    
    for (const query of queries) {
        Logger.log(`[Automation] Searching GetComics: "${query}"`, 'info');
        getComicsResults = await GetComicsService.search(query);
        if (getComicsResults.length > 0) {
            successfulQuery = query;
            break;
        }
    }
    
    if (getComicsResults.length > 0) {
      const best = getComicsResults[0];
      const { url, isDirect } = await GetComicsService.scrapeDeepLink(best.downloadUrl);
      
      if (isDirect) {
        const settings = await prisma.systemSetting.findMany();
        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
        const safeTitle = best.title.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();

        await prisma.request.update({
          where: { id: requestId },
          data: { status: 'DOWNLOADING', activeDownloadName: safeTitle }
        });

        DownloadService.downloadDirectFile(url, safeTitle, config.download_path, requestId)
          .then(async (success) => {
              if (success) {
                  await new Promise(r => setTimeout(r, 2000));
                  await Importer.importRequest(requestId);
              }
          })
          .catch(e => console.error(e));
      } else {
        await prisma.request.update({
          where: { id: requestId },
          data: { status: 'MANUAL_DDL', downloadLink: url }
        });
      }
    } else {
       Logger.log(`[Automation] No results found anywhere for: ${name}`, 'warn');
       await prisma.request.update({
          where: { id: requestId },
          data: { status: 'STALLED' }
       });
    }
}

export async function POST(request: Request) {
    try {
        const { job } = await request.json();
        const startTime = Date.now();
        const nowStr = Date.now().toString();

        if (job === 'backup') {
            Logger.log("[Background Job] Starting Database Backup...", "info");
            
            await prisma.systemSetting.upsert({ where: { key: 'last_backup_sync' }, update: { value: nowStr }, create: { key: 'last_backup_sync', value: nowStr } });

            (async () => {
                try {
                    const [
                        users, series, issues, readProgresses, settings, requests,
                        libraries, downloadClients, discordWebhooks, indexers, customHeaders, searchAcronyms,
                        collections, collectionItems, readingLists, readingListItems, trophies, userTrophies, issueReports
                    ] = await Promise.all([
                        prisma.user.findMany(), prisma.series.findMany(), prisma.issue.findMany(),
                        prisma.readProgress.findMany(), prisma.systemSetting.findMany(), prisma.request.findMany(),
                        prisma.library.findMany(), prisma.downloadClient.findMany(), prisma.discordWebhook.findMany(),
                        prisma.indexer.findMany(), prisma.customHeader.findMany(), prisma.searchAcronym.findMany(),
                        prisma.collection.findMany(), prisma.collectionItem.findMany(), prisma.readingList.findMany(),
                        prisma.readingListItem.findMany(), prisma.trophy.findMany(), prisma.userTrophy.findMany(), prisma.issueReport.findMany()
                    ]);

                    const backupData = {
                        timestamp: new Date().toISOString(),
                        version: "2.0",
                        data: { 
                            users, series, issues, readProgresses, settings, requests,
                            libraries, downloadClients, discordWebhooks, indexers, customHeaders, searchAcronyms,
                            collections, collectionItems, readingLists, readingListItems, trophies, userTrophies, issueReports
                        }
                    };

                    const backupDir = process.env.BACKUP_PATH || '/backups';
                    
                    await fs.ensureDir(backupDir);
                    const fileName = `omnibus_backup_${Date.now()}.json`;
                    const filePath = path.join(backupDir, fileName);
                    
                    await fs.writeJson(filePath, backupData, { spaces: 2 });

                    const files = await fs.readdir(backupDir);
                    const backupFiles = files.filter(f => f.startsWith('omnibus_backup_')).sort();
                    
                    if (backupFiles.length > 5) {
                        const toDelete = backupFiles.slice(0, backupFiles.length - 5);
                        for (const file of toDelete) {
                            await fs.remove(path.join(backupDir, file));
                        }
                    }

                    await prisma.jobLog.create({ data: { jobType: 'DATABASE_BACKUP', status: 'COMPLETED', durationMs: Date.now() - startTime, message: `Backup saved successfully to ${filePath}. Retaining last 5 backups.` } });
                    DiscordNotifier.sendAlert('job_db_backup', { description: `Backup saved successfully to ${fileName}.` }).catch(() => {});
                    Logger.log(`[Background Job] Database Backup Complete. Saved to ${filePath}`, "success");
                } catch (e: any) {
                    await prisma.jobLog.create({ data: { jobType: 'DATABASE_BACKUP', status: 'FAILED', durationMs: Date.now() - startTime, message: e.message } });
                    DiscordNotifier.sendAlert('job_db_backup', { description: `Database backup failed: ${e.message}` }).catch(() => {});
                    Logger.log(`[Background Job] Database Backup Failed: ${e.message}`, "error");
                }
            })();

            return NextResponse.json({ success: true, message: "Database backup started in the background." });
        }

        if (job === 'library') {
            Logger.log("[Manual Job] Starting Local Library Auto-Scan...", "info");
            
            await prisma.systemSetting.upsert({ where: { key: 'last_library_sync' }, update: { value: nowStr }, create: { key: 'last_library_sync', value: nowStr } });
            
            try {
                // 1. Force the physical disk scan (Fast - only looks for new folders)
                const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
                await axios.get(`${baseUrl}/api/library?refresh=true`, { timeout: 300000 }).catch(() => {});
                
                // 2. SMART THROTTLE: Only run the heavy storage scan if it's been > 24 hours
                const lastStorageRun = await prisma.systemSetting.findUnique({ where: { key: 'storage_deep_dive_last_run' } });
                const lastRunTime = parseInt(lastStorageRun?.value || "0");
                const hoursSinceLastRun = (Date.now() - lastRunTime) / (1000 * 60 * 60);

                let processedCount = 0;
                let storageMessage = "Skipped heavy storage scan (calculated recently).";

                if (hoursSinceLastRun >= 24) {
                    Logger.log("[Background Job] 24+ hours passed. Running heavy storage size calculation...", "info");
                    processedCount = await runStorageScan();
                    storageMessage = `Storage calculation completed for ${processedCount} series.`;
                }

                await prisma.jobLog.create({ 
                    data: { jobType: 'LIBRARY_SCAN', status: 'COMPLETED', durationMs: Date.now() - startTime, message: `Library scan complete. ${storageMessage}` } 
                });

                Logger.log(`[Manual Job] Local Library Auto-Scan completed.`, "success");
                DiscordNotifier.sendAlert('job_library_scan', { description: `Library scan complete. ${storageMessage}` }).catch(() => {});
                
                return NextResponse.json({ success: true, message: `Library scan complete. ${storageMessage}` });
            } catch (e: any) {
                await prisma.jobLog.create({ data: { jobType: 'LIBRARY_SCAN', status: 'FAILED', durationMs: Date.now() - startTime, message: e.message } });
                DiscordNotifier.sendAlert('job_library_scan', { description: `Failed to scan library.` }).catch(() => {});
                throw e;
            }
        }

        if (job === 'metadata') {
            Logger.log("[Manual Job] Initiating background ComicVine Metadata Sync...", "info");
            
            await prisma.systemSetting.upsert({ where: { key: 'last_metadata_sync' }, update: { value: nowStr }, create: { key: 'last_metadata_sync', value: nowStr } });

            (async () => {
                const { syncSeriesMetadata } = await import('@/lib/metadata-fetcher');
                const allSeries = await prisma.series.findMany({ where: { cvId: { gt: 0 } } });
                Logger.log(`[Manual Job] Found ${allSeries.length} matched series to sync.`, "info");

                let successCount = 0;
                let failCount = 0;
                let details = `Started Manual Metadata Sync for ${allSeries.length} series.\n\n`;

                for (const series of allSeries) {
                    try {
                        await syncSeriesMetadata(series.cvId, series.folderPath);
                        successCount++;
                        details += `[OK] Synced: ${series.name}\n`;
                    } catch (e: any) {
                        failCount++;
                        details += `[FAIL] ${series.name} - ${e.message}\n`;
                        Logger.log(`[Manual Job] Failed to sync series: ${series.name}`, "error");
                        await prisma.jobLog.create({ data: { jobType: 'METADATA_SYNC', status: 'FAILED', relatedItem: series.name, message: e.message } });
                    }
                }

                await prisma.jobLog.create({
                    data: {
                        jobType: 'METADATA_SYNC',
                        status: failCount > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
                        durationMs: Date.now() - startTime,
                        message: details + `\nFinal Summary: ${successCount} Success, ${failCount} Failed.`
                    }
                });
                DiscordNotifier.sendAlert('job_metadata_sync', { description: `Metadata Sync Finished. Success: ${successCount} | Failed: ${failCount}` }).catch(() => {});
                Logger.log(`[Manual Job] Metadata Sync Finished. Success: ${successCount} | Failed: ${failCount}`, "success");
            })();

            return NextResponse.json({ success: true, message: "Metadata sync started in the background." });
        }

        if (job === 'monitor') {
            const cvKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
            const cvApiKey = cvKeySetting?.value;

            if (!cvApiKey) return NextResponse.json({ error: "Missing ComicVine API Key" }, { status: 400 });

            Logger.log("[Manual Job] Starting scan for monitored series & unreleased requests...", "info");
            
            await prisma.systemSetting.upsert({ where: { key: 'last_monitor_sync' }, update: { value: nowStr }, create: { key: 'last_monitor_sync', value: nowStr } });

            (async () => {
                const monitoredSeries = await prisma.series.findMany({
                    where: { monitored: true },
                    include: { issues: true }
                });
                const monitoredCvIds = monitoredSeries.map(s => s.cvId);

                const unreleasedRequests = await prisma.request.findMany({
                    where: { status: 'UNRELEASED' }
                });
                const unreleasedVolumeIds = unreleasedRequests.map(r => parseInt(r.volumeId)).filter(id => !isNaN(id));

                const allCvIdsToCheck = [...new Set([...monitoredCvIds, ...unreleasedVolumeIds])];

                if (allCvIdsToCheck.length === 0) {
                    Logger.log("[Monitor] No monitored series or unreleased requests to check.", "info");
                    return;
                } else {
                    Logger.log(`[Monitor] Checking ${allCvIdsToCheck.length} volumes for new/unreleased issues.`, "info");
                }

                let newIssuesFound = 0;
                let unreleasedUpgraded = 0;
                let details = `Scanning ${allCvIdsToCheck.length} volumes for new/unreleased issues.\n\n`;

                const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });

                for (const cvId of allCvIdsToCheck) {
                    try {
                        Logger.log(`[Monitor] Checking CV for Volume ID: ${cvId}`, 'info');
                        
                        const seriesRecord = monitoredSeries.find(s => s.cvId === cvId);
                        const isMonitored = !!seriesRecord;
                        
                        const seriesName = seriesRecord?.name || unreleasedRequests.find(r => parseInt(r.volumeId) === cvId)?.activeDownloadName?.split(' #')[0] || `Volume ${cvId}`;
                        const seriesPublisher = seriesRecord?.publisher || "Unknown";
                        const seriesYear = seriesRecord?.year?.toString() || new Date().getFullYear().toString();
                        const isManga = seriesRecord ? (seriesRecord as any).isManga : false;

                        let offset = 0;
                        let totalResults = 1;
                        let loopCount = 0;
                        const allCvIssues = [];

                        while (offset < totalResults && loopCount < 20) {
                            const cvRes = await axios.get(`https://comicvine.gamespot.com/api/issues/`, {
                                params: { 
                                    api_key: cvApiKey, format: 'json', filter: `volume:${cvId}`, 
                                    sort: 'store_date:desc', limit: 100, offset: offset,
                                    field_list: 'id,name,issue_number,cover_date,store_date,image' 
                                },
                                headers: { 'User-Agent': 'Omnibus/1.0' }
                            });

                            if (offset === 0) totalResults = cvRes.data.number_of_total_results || 0;
                            const cvIssues = cvRes.data.results || [];
                            allCvIssues.push(...cvIssues);
                            
                            offset += 100;
                            loopCount++;
                            await new Promise(r => setTimeout(r, 1500)); 
                        }

                        const existingRequestsForVolume = await prisma.request.findMany({
                            where: { volumeId: cvId.toString() }
                        });

                        for (const cvIssue of allCvIssues) {
                            const cvNum = parseFloat(cvIssue.issue_number);
                            if (isNaN(cvNum)) continue;

                            const alreadyInLibrary = seriesRecord?.issues.some(i => 
                                parseFloat(i.number) === cvNum && i.filePath && i.filePath.length > 0
                            );
                            if (alreadyInLibrary) continue;

                            const searchName = `${seriesName} #${cvIssue.issue_number}`;
                            const isReleased = isReleasedYet(cvIssue.store_date, cvIssue.cover_date);
                            
                            const alreadyReq = existingRequestsForVolume.find(r => {
                                if (r.activeDownloadName === searchName) return true;
                                const match = (r.activeDownloadName || "").match(/(?:#|issue\s*#?)\s*(\d+(?:\.\d+)?)/i);
                                if (match && parseFloat(match[1]) === cvNum) return true;
                                return false;
                            });

                            const issueImage = cvIssue.image?.medium_url || cvIssue.image?.small_url;
                            const issueYear = (cvIssue.store_date || cvIssue.cover_date || seriesYear).split('-')[0];

                            if (alreadyReq) {
                                if (alreadyReq.status === 'UNRELEASED' && isReleased) {
                                    Logger.log(`[Monitor] Issue ${searchName} is now released! Upgrading to PENDING.`, 'success');
                                    details += `[RELEASED] Upgraded to Pending: ${searchName}\n`;
                                    
                                    await prisma.request.update({
                                        where: { id: alreadyReq.id },
                                        data: { status: 'PENDING' }
                                    });
                                    
                                    searchAndDownload(alreadyReq.id, searchName, issueYear, seriesPublisher, isManga)
                                        .catch(e => console.error("Monitor Automation Error:", e));
                                        
                                    unreleasedUpgraded++;
                                }
                                continue; 
                            }

                            if (isMonitored) {
                                const issueStatus = isReleased ? 'PENDING' : 'UNRELEASED';

                                Logger.log(`[Monitor] Found NEW missing issue: ${searchName} (${issueStatus})`, 'success');
                                details += `[NEW] Found and Queued (${issueStatus}): ${searchName}\n`;

                                const newReq = await prisma.request.create({
                                    data: {
                                        userId: admin?.id || 'system',
                                        volumeId: cvId.toString(),
                                        status: issueStatus,
                                        activeDownloadName: searchName,
                                        imageUrl: issueImage
                                    }
                                });

                                if (isReleased) {
                                    searchAndDownload(newReq.id, searchName, issueYear, seriesPublisher, isManga)
                                        .catch(e => console.error("Monitor Automation Error:", e));
                                    newIssuesFound++;
                                }
                            }
                        }

                    } catch (err: any) {
                        Logger.log(`[Monitor] Failed to scan volume ${cvId}: ${err.message}`, 'error');
                        details += `[ERROR] Failed to scan volume ${cvId}: ${err.message}\n`;
                    }
                }

                await prisma.jobLog.create({ 
                    data: { jobType: 'SERIES_MONITOR', status: 'COMPLETED', durationMs: Date.now() - startTime, message: details + `\nScan Complete. New issues queued: ${newIssuesFound} | Unreleased issues upgraded: ${unreleasedUpgraded}` } 
                });
                
                DiscordNotifier.sendAlert('job_issue_monitor', { description: `Monitor Scan Complete. Queued: ${newIssuesFound}, Upgraded: ${unreleasedUpgraded}` }).catch(() => {});

                Logger.log(`[Manual Job] Monitor Scan Complete. Queued: ${newIssuesFound}, Upgraded: ${unreleasedUpgraded}`, "success");
            })();

            return NextResponse.json({ success: true, message: "Series monitor scan started in the background." });
        }

        if (job === 'diagnostics') {
            Logger.log("[Background Job] Starting Auto-Diagnostics...", "info");
            
            await prisma.systemSetting.upsert({ where: { key: 'last_diagnostics_sync' }, update: { value: nowStr }, create: { key: 'last_diagnostics_sync', value: nowStr } });

            (async () => {
                let details = "Diagnostics Scan Started.\n\n";
                let issuesFound = 0;
                try {
                    const series = await prisma.series.findMany();
                    const ghosts = series.filter(s => !s.folderPath || !fs.existsSync(s.folderPath));
                    
                    if (ghosts.length > 0) {
                        details += `[WARNING] Found ${ghosts.length} ghost series records.\n`;
                        issuesFound += ghosts.length;
                    }

                    const issues = await prisma.issue.findMany({ include: { series: true } });
                    let corrupted = 0;
                    for (const issue of issues) {
                        if (issue.filePath && fs.existsSync(issue.filePath) && issue.filePath.toLowerCase().endsWith('.cbz')) {
                            try {
                                const zip = new AdmZip(issue.filePath);
                                zip.getEntries();
                            } catch (e) {
                                corrupted++;
                                Logger.log(`[Diagnostics] Corrupt archive detected: ${issue.filePath}`, "error");
                            }
                        }
                    }

                    if (corrupted > 0) {
                        details += `[CRITICAL] Found ${corrupted} corrupted or incomplete archives!\n`;
                        issuesFound += corrupted;
                    }

                    if (issuesFound === 0) details += "Library is in perfect health. 100% Integrity.\n";

                    await prisma.jobLog.create({ data: { jobType: 'DIAGNOSTICS', status: issuesFound > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED', durationMs: Date.now() - startTime, message: details } });
                    DiscordNotifier.sendAlert('job_diagnostics', { description: `Diagnostics Complete. Issues found: ${issuesFound}` }).catch(() => {});
                    Logger.log(`[Background Job] Diagnostics Complete. Issues found: ${issuesFound}`, issuesFound > 0 ? "warn" : "success");
                } catch (e: any) {
                    await prisma.jobLog.create({ data: { jobType: 'DIAGNOSTICS', status: 'FAILED', durationMs: Date.now() - startTime, message: e.message } });
                    DiscordNotifier.sendAlert('job_diagnostics', { description: `Diagnostics Failed: ${e.message}` }).catch(() => {});
                    Logger.log(`[Background Job] Diagnostics Failed: ${e.message}`, "error");
                }
            })();

            return NextResponse.json({ success: true, message: "Diagnostics scan started in the background." });
        }

        if (job === 'update_check') {
            Logger.log("[Background Job] Checking GitHub for Omnibus updates...", "info");
            
            try {
                const res = await axios.get('https://api.github.com/repos/hankscafe/omnibus/releases?per_page=1', {
                    headers: { 'User-Agent': 'Omnibus-App', 'Accept': 'application/vnd.github.v3+json' },
                    timeout: 10000
                });

                if (res.data && res.data.length > 0) {
                    const latestVersion = res.data[0].tag_name.replace(/^v/, '');
                    
                    const notifiedSetting = await prisma.systemSetting.findUnique({ where: { key: 'last_notified_version' } });
                    const lastNotified = notifiedSetting?.value || "";

                    if (latestVersion !== lastNotified) {
                        const packageJson = require(process.cwd() + '/package.json');
                        const currentVersion = packageJson.version || "1.0.0";

                        if (latestVersion !== currentVersion) {
                            await DiscordNotifier.sendAlert('update_available', { version: latestVersion });
                            
                            await prisma.systemSetting.upsert({
                                where: { key: 'last_notified_version' },
                                update: { value: latestVersion },
                                create: { key: 'last_notified_version', value: latestVersion }
                            });
                            
                            Logger.log(`[Background Job] Update notification sent for v${latestVersion}`, "success");
                        }
                    }
                }
            } catch (e: any) {
                Logger.log(`[Background Job] Update check failed: ${e.message}`, "warn");
            }

            return NextResponse.json({ success: true, message: "Update check completed." });
        }

        if (job === 'storage_scan' || job === 'analytics') {
            Logger.log("[Background Job] Initiating Storage Deep Dive Scan...", "info");
            
            (async () => {
                try {
                    const processedCount = await runStorageScan();
                    Logger.log(`[Background Job] Storage Scan Complete. Processed ${processedCount} series.`, "success");
                } catch(e) {
                    Logger.log(`[Background Job] Storage Scan Failed.`, "error");
                }
            })();

            if (job === 'storage_scan') {
                return NextResponse.json({ success: true, message: "Storage scan started in the background." });
            }
        }

        if (job === 'popular') {
            Logger.log("[Background Job] Rebuilding 8-page Discover Cache...", "info");
            
            await prisma.systemSetting.upsert({ where: { key: 'last_popular_sync' }, update: { value: nowStr }, create: { key: 'last_popular_sync', value: nowStr } });

            (async () => {
                const allSettings = await prisma.systemSetting.findMany();
                const config = Object.fromEntries(allSettings.map(s => [s.key, s.value]));
                const CV_API_KEY = config.cv_api_key || process.env.CV_API_KEY;

                if (!CV_API_KEY) return;

                const filterEnabled = config.filter_enabled === "true";
                const blockedPublishers = config.filter_publishers ? config.filter_publishers.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean) : [];
                const blockedKeywords = config.filter_keywords ? config.filter_keywords.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean) : [];

                const isValid = (item: any) => {
                    if (!filterEnabled) return true;
                    const pubName = (item.volume?.publisher?.name || '').toLowerCase();
                    const volName = (item.volume?.name || '').toLowerCase();
                    if (blockedPublishers.some((bp: string) => pubName.includes(bp))) return false;
                    if (blockedKeywords.some((bk: string) => volName.includes(bk))) return false;
                    return true;
                };

                const formatItem = (item: any) => {
                    let desc = item.deck;
                    if (!desc && item.description) {
                       desc = item.description.replace(/<[^>]*>?/gm, '');
                       if (desc.length > 800) desc = desc.substring(0, 800) + '...';
                    }
                    const writers: string[] = [];
                    const artists: string[] = []; 
                    const coverArtists: string[] = [];

                    if (item.person_credits) {
                      item.person_credits.forEach((p: any) => {
                        const role = (p.role || '').toLowerCase();
                        if (role.includes('writer') || role.includes('script') || role.includes('plot') || role.includes('story')) writers.push(p.name);
                        if (role.includes('pencil') || role.includes('ink') || role.includes('artist') || role.includes('color') || role.includes('illustrator')) artists.push(p.name);
                        if (role.includes('cover')) coverArtists.push(p.name);
                      });
                    }

                    const dateStr = item.store_date || item.cover_date;
                    return {
                      id: item.id, volumeId: item.volume.id,
                      name: `${item.volume.name} #${item.issue_number}`,
                      year: dateStr ? dateStr.split('-')[0] : '????',
                      publisher: item.volume?.publisher?.name || null,
                      image: item.image?.medium_url,
                      description: desc || "No description available.",
                      siteUrl: item.site_detail_url,
                      writers: [...new Set(writers)].slice(0, 3), 
                      artists: [...new Set(artists)].slice(0, 3),
                      coverArtists: [...new Set(coverArtists)].slice(0, 3),
                    };
                };

                const fetchCategory = async (sort: string) => {
                    let validItems: any[] = [];
                    let offset = 0;
                    while (validItems.length < 112) { 
                        const response = await axios.get(`https://comicvine.gamespot.com/api/issues/`, {
                            params: {
                                api_key: CV_API_KEY, format: 'json', limit: 100, offset: offset, sort: sort,
                                field_list: 'id,name,issue_number,store_date,cover_date,image,deck,description,volume,person_credits,site_detail_url'
                            },
                            headers: { 'User-Agent': 'Omnibus/1.0' }
                        });

                        const items = response.data.results || [];
                        if (items.length === 0) break;

                        for (const item of items) {
                            offset++; 
                            if (isValid(item)) validItems.push(formatItem(item));
                            if (validItems.length === 112) break;
                        }
                        await new Promise(r => setTimeout(r, 1000));
                    }
                    return validItems;
                };

                try {
                    const [newReleases, popular] = await Promise.all([
                        fetchCategory('store_date:desc'),
                        fetchCategory('cover_date:desc') 
                    ]);

                    await prisma.$transaction([
                        prisma.systemSetting.upsert({ where: { key: 'discover_cache_new' }, update: { value: JSON.stringify(newReleases) }, create: { key: 'discover_cache_new', value: JSON.stringify(newReleases) } }),
                        prisma.systemSetting.upsert({ where: { key: 'discover_cache_popular' }, update: { value: JSON.stringify(popular) }, create: { key: 'discover_cache_popular', value: JSON.stringify(popular) } }),
                    ]);

                    await prisma.jobLog.create({
                        data: { jobType: 'DISCOVER_SYNC', status: 'COMPLETED', durationMs: Date.now() - startTime, message: `Successfully rebuilt the Discover cache (New & Popular). Filter enabled: ${filterEnabled}` }
                    });
                    DiscordNotifier.sendAlert('job_discover_sync', { description: `Successfully rebuilt the Discover cache (New & Popular).` }).catch(() => {});
                    Logger.log("[Background Job] Discover Cache Rebuilt (8 Pages).", "success");
                } catch (e: any) {
                    await prisma.jobLog.create({
                        data: { jobType: 'DISCOVER_SYNC', status: 'FAILED', durationMs: Date.now() - startTime, message: e.message }
                    });
                    DiscordNotifier.sendAlert('job_discover_sync', { description: `Failed to rebuild Discover cache: ${e.message}` }).catch(() => {});
                    Logger.log(`[Background Job] Discover Cache Failed: ${e.message}`, "error");
                }
            })();

            return NextResponse.json({ success: true, message: "Deep discovery scan started." });
        }

        return NextResponse.json({ error: "Invalid job specified" }, { status: 400 });

    } catch (error: any) {
        Logger.log(`[Manual Job] Fatal Error: ${error.message}`, "error");
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}