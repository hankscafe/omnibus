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

async function getDownloadClient() {
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'download_clients_config' } });
    if (!setting?.value) return null;
    const clients = JSON.parse(setting.value);
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
        const nowStr = Date.now().toString(); // Generate timestamp immediately

        if (job === 'backup') {
            Logger.log("[Background Job] Starting Database Backup...", "info");
            
            // FIX: Immediate DB Lock to prevent overlapping triggers
            await prisma.systemSetting.upsert({ where: { key: 'last_backup_sync' }, update: { value: nowStr }, create: { key: 'last_backup_sync', value: nowStr } });

            (async () => {
                try {
                    const [users, series, issues, readProgresses, settings, requests] = await Promise.all([
                        prisma.user.findMany(),
                        prisma.series.findMany(),
                        prisma.issue.findMany(),
                        prisma.readProgress.findMany(),
                        prisma.systemSetting.findMany(),
                        prisma.request.findMany()
                    ]);

                    const backupData = {
                        timestamp: new Date().toISOString(),
                        version: "1.0",
                        data: { users, series, issues, readProgresses, settings, requests }
                    };

                    const backupDir = path.join(process.cwd(), 'backups');
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

                    await prisma.jobLog.create({ data: { jobType: 'DATABASE_BACKUP', status: 'COMPLETED', durationMs: Date.now() - startTime, message: `Backup saved successfully to /backups/${fileName}. Retaining last 5 backups.` } });
                    Logger.log(`[Background Job] Database Backup Complete. Saved to ${fileName}`, "success");
                } catch (e: any) {
                    await prisma.jobLog.create({ data: { jobType: 'DATABASE_BACKUP', status: 'FAILED', durationMs: Date.now() - startTime, message: e.message } });
                    Logger.log(`[Background Job] Database Backup Failed: ${e.message}`, "error");
                }
            })();

            return NextResponse.json({ success: true, message: "Database backup started in the background." });
        }

        if (job === 'library') {
            Logger.log("[Manual Job] Starting Local Library Auto-Scan...", "info");
            
            // FIX: Immediate DB Lock
            await prisma.systemSetting.upsert({ where: { key: 'last_library_sync' }, update: { value: nowStr }, create: { key: 'last_library_sync', value: nowStr } });
            
            try {
                const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
                await axios.get(`${baseUrl}/api/library`).catch(() => {});
                
                const allSeries = await prisma.series.findMany({ select: { id: true, folderPath: true } });
                let processedCount = 0;
                
                const batchSize = 10;
                for (let i = 0; i < allSeries.length; i += batchSize) {
                    const batch = allSeries.slice(i, i + batchSize);
                    await Promise.all(batch.map(async (s) => {
                        if (s.folderPath) {
                            const size = await getFolderSize(s.folderPath);
                            await prisma.series.update({
                                where: { id: s.id },
                                data: { size }
                            });
                            processedCount++;
                        }
                    }));
                }

                await prisma.jobLog.create({ 
                    data: { jobType: 'LIBRARY_SCAN', status: 'COMPLETED', durationMs: Date.now() - startTime, message: `Scan and storage calculation completed for ${processedCount} series.` } 
                });

                Logger.log(`[Manual Job] Local Library Auto-Scan completed. Updated storage for ${processedCount} series.`, "success");
                return NextResponse.json({ success: true, message: "Library scan and storage calculation completed." });
            } catch (e: any) {
                await prisma.jobLog.create({ data: { jobType: 'LIBRARY_SCAN', status: 'FAILED', durationMs: Date.now() - startTime, message: e.message } });
                throw e;
            }
        }

        if (job === 'metadata') {
            Logger.log("[Manual Job] Initiating background ComicVine Metadata Sync...", "info");
            
            // FIX: Immediate DB Lock
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

                Logger.log(`[Manual Job] Metadata Sync Finished. Success: ${successCount} | Failed: ${failCount}`, "success");
            })();

            return NextResponse.json({ success: true, message: "Metadata sync started in the background." });
        }

        if (job === 'monitor') {
            const cvKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
            const cvApiKey = cvKeySetting?.value;

            if (!cvApiKey) return NextResponse.json({ error: "Missing ComicVine API Key" }, { status: 400 });

            Logger.log("[Manual Job] Starting scan for monitored series...", "info");
            
            // FIX: Immediate DB Lock
            await prisma.systemSetting.upsert({ where: { key: 'last_monitor_sync' }, update: { value: nowStr }, create: { key: 'last_monitor_sync', value: nowStr } });

            (async () => {
                const monitoredSeries = await prisma.series.findMany({
                    where: { monitored: true },
                    include: { issues: true }
                });

                if (monitoredSeries.length === 0) {
                    Logger.log("[Monitor] No series are marked as 'Monitored' in your database.", "warn");
                } else {
                    Logger.log(`[Monitor] Found ${monitoredSeries.length} series to check.`, "info");
                }

                let newIssuesFound = 0;
                let details = `Scanning ${monitoredSeries.length} monitored series for new issues.\n\n`;

                for (const series of monitoredSeries) {
                    try {
                        Logger.log(`[Monitor] Checking CV for: ${series.name} (CV ID: ${series.cvId})`, 'info');
                        
                        let offset = 0;
                        let totalResults = 1;
                        let loopCount = 0;
                        const allCvIssues = [];

                        while (offset < totalResults && loopCount < 20) {
                            const cvRes = await axios.get(`https://comicvine.gamespot.com/api/issues/`, {
                                params: { 
                                    api_key: cvApiKey, format: 'json', filter: `volume:${series.cvId}`, 
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

                        Logger.log(`[Monitor] ComicVine returned ${allCvIssues.length} issues for ${series.name}`, 'info');

                        const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
                        const existingRequests = await prisma.request.findMany({
                            where: { volumeId: series.cvId.toString() }
                        });

                        let seriesNewCount = 0;

                        for (const cvIssue of allCvIssues) {
                            const cvNum = parseFloat(cvIssue.issue_number);
                            if (isNaN(cvNum)) continue;

                            const alreadyInLibrary = series.issues.some(i => 
                                parseFloat(i.number) === cvNum && 
                                i.filePath && 
                                i.filePath.length > 0
                            );
                            if (alreadyInLibrary) continue;

                            const searchName = `${series.name} #${cvIssue.issue_number}`;
                            
                            const alreadyReq = existingRequests.find(r => {
                                if (r.activeDownloadName === searchName) return true;
                                const match = (r.activeDownloadName || "").match(/(?:#|issue\s*#?)\s*(\d+(?:\.\d+)?)/i);
                                if (match && parseFloat(match[1]) === cvNum) return true;
                                return false;
                            });

                            if (alreadyReq) {
                                Logger.log(`[Monitor] Skipping ${searchName} - Already in Request Queue (Status: ${alreadyReq.status})`, 'info');
                                continue;
                            }

                            Logger.log(`[Monitor] Found NEW missing issue: ${searchName}`, 'success');
                            details += `[NEW] Found and Queued: ${searchName}\n`;
                            
                            const issueImage = cvIssue.image?.medium_url || cvIssue.image?.small_url;
                            const issueYear = (cvIssue.store_date || cvIssue.cover_date || series.year.toString() || "").split('-')[0];

                            const newReq = await prisma.request.create({
                                data: {
                                    userId: admin?.id || 'system',
                                    volumeId: series.cvId.toString(),
                                    status: 'PENDING',
                                    activeDownloadName: searchName,
                                    imageUrl: issueImage
                                }
                            });

                            searchAndDownload(newReq.id, searchName, issueYear, series.publisher || "Unknown", (series as any).isManga)
                                .catch(e => console.error("Monitor Automation Error:", e));

                            newIssuesFound++;
                            seriesNewCount++;
                        }

                        if (seriesNewCount === 0) {
                            Logger.log(`[Monitor] No new issues needed for ${series.name}.`, 'info');
                        }

                    } catch (err: any) {
                        Logger.log(`[Monitor] Failed to scan series ${series.name}: ${err.message}`, 'error');
                        details += `[ERROR] Failed to scan ${series.name}: ${err.message}\n`;
                    }
                }

                await prisma.jobLog.create({ 
                    data: { jobType: 'SERIES_MONITOR', status: 'COMPLETED', durationMs: Date.now() - startTime, message: details + `\nScan Complete. Total new issues queued: ${newIssuesFound}` } 
                });

                Logger.log(`[Manual Job] Monitor Scan Complete. Queued ${newIssuesFound} new issues.`, "success");
            })();

            return NextResponse.json({ success: true, message: "Series monitor scan started in the background." });
        }

        if (job === 'diagnostics') {
            Logger.log("[Background Job] Starting Auto-Diagnostics...", "info");
            
            // FIX: Immediate DB Lock
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
                    Logger.log(`[Background Job] Diagnostics Complete. Issues found: ${issuesFound}`, issuesFound > 0 ? "warn" : "success");
                } catch (e: any) {
                    await prisma.jobLog.create({ data: { jobType: 'DIAGNOSTICS', status: 'FAILED', durationMs: Date.now() - startTime, message: e.message } });
                    Logger.log(`[Background Job] Diagnostics Failed: ${e.message}`, "error");
                }
            })();

            return NextResponse.json({ success: true, message: "Diagnostics scan started in the background." });
        }

        if (job === 'storage_scan' || job === 'analytics') {
            Logger.log("[Background Job] Initiating Storage Deep Dive Scan...", "info");
            
            // FIX: Immediate DB Lock
            await prisma.systemSetting.upsert({
                where: { key: 'storage_deep_dive_last_run' },
                update: { value: nowStr },
                create: { key: 'storage_deep_dive_last_run', value: nowStr }
            });

            (async () => {
                const seriesList = await prisma.series.findMany({
                  select: { id: true, name: true, publisher: true, folderPath: true, isManga: true, _count: { select: { issues: true } } }
                });

                const storageData: any[] = [];
                const batchSize = 10;
                
                for (let i = 0; i < seriesList.length; i += batchSize) {
                    const batch = seriesList.slice(i, i + batchSize);
                    const batchResults = await Promise.all(batch.map(async (s) => {
                        const size = s.folderPath ? await getFolderSize(s.folderPath) : 0;
                        return {
                            id: s.id, name: s.name, publisher: s.publisher || "Unknown",
                            isManga: s.isManga, issueCount: s._count.issues,
                            path: s.folderPath, sizeBytes: size
                        };
                    }));
                    storageData.push(...batchResults);
                }

                storageData.sort((a, b) => b.sizeBytes - a.sizeBytes);

                await prisma.systemSetting.upsert({
                    where: { key: 'storage_deep_dive_cache' },
                    update: { value: JSON.stringify(storageData) },
                    create: { key: 'storage_deep_dive_cache', value: JSON.stringify(storageData) }
                });

                Logger.log(`[Background Job] Storage Scan Complete. Processed ${storageData.length} series.`, "success");
            })();

            if (job === 'storage_scan') {
                return NextResponse.json({ success: true, message: "Storage scan started in the background." });
            }
        }

        if (job === 'popular') {
            Logger.log("[Background Job] Rebuilding 8-page Discover Cache...", "info");
            
            // FIX: Immediate DB Lock
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

                    Logger.log("[Background Job] Discover Cache Rebuilt (8 Pages).", "success");
                } catch (e: any) {
                    await prisma.jobLog.create({
                        data: { jobType: 'DISCOVER_SYNC', status: 'FAILED', durationMs: Date.now() - startTime, message: e.message }
                    });
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