import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from './db';
import { Logger } from './logger';
import { SystemNotifier } from './notifications'; 
import { Mailer } from './mailer';
import { apiClient as axios } from '@/lib/api-client';
import { isReleasedYet } from '@/lib/utils';
import { searchAndDownload, looseCompareIssue } from '@/lib/automation';
import packageJson from '../../package.json';
import { getErrorMessage } from '@/lib/utils/error';
import { ENGINE_URL, engineHeaders, engineFetchLong } from '@/lib/engine';
import { isSameIssue, extractIssueNumber } from '@/lib/utils/issue-parser';

function isNewerVersion(latest: string, current: string): boolean {
    const cleanLatest = latest.replace(/^v/, '');
    const cleanCurrent = current.replace(/^v/, '');
    if (cleanLatest === cleanCurrent) return false;
    
    const parse = (v: string) => {
        const [main, pre] = v.split('-');
        return { nums: main.split('.').map(n => parseInt(n, 10) || 0), preParts: pre ? pre.split('.') : [] };
    };
    
    const l = parse(cleanLatest);
    const c = parse(cleanCurrent);
    
    for (let i = 0; i < 3; i++) {
        const lNum = l.nums[i] || 0;
        const cNum = c.nums[i] || 0;
        if (lNum > cNum) return true;
        if (lNum < cNum) return false;
    }
    
    if (l.preParts.length === 0 && c.preParts.length > 0) return true; 
    if (l.preParts.length > 0 && c.preParts.length === 0) return false; 
    
    for (let i = 0; i < Math.max(l.preParts.length, c.preParts.length); i++) {
        const lPart = l.preParts[i];
        const cPart = c.preParts[i];
        if (lPart === undefined) return false; 
        if (cPart === undefined) return true;
        
        const lIsNum = !isNaN(Number(lPart));
        const cIsNum = !isNaN(Number(cPart));
        
        if (lIsNum && cIsNum) {
            if (Number(lPart) > Number(cPart)) return true;
            if (Number(lPart) < Number(cPart)) return false;
        } else if (!lIsNum && !cIsNum) {
            if (lPart > cPart) return true;
            if (lPart < cPart) return false;
        } else { 
            return !lIsNum; 
        }
    }
    return false;
}

// NOTE: the deep storage scan (per-series folder-size walk + storage_deep_dive_cache) is owned by
// the Rust engine (/api/diagnostics/storage → diagnostics::run_storage_scan), which writes Series.size,
// the storage_deep_dive_cache JSON the dashboard reads, and both the storage_deep_dive_last_run /
// last_storage_scan timestamps. The old Node getFolderSize/runStorageScan walk was deleted; callers
// (LIBRARY_SCAN below, the STORAGE_SCAN job) forward to the engine instead.

const globalForMQ = globalThis as unknown as {
    omnibusQueue: Queue; 
    omnibusWorker: Worker; 
    redisConnection: IORedis;
};

const connection = globalForMQ.redisConnection || new IORedis(process.env.OMNIBUS_REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null
});

if (process.env.NODE_ENV !== 'production') globalForMQ.redisConnection = connection;

export const omnibusQueue = globalForMQ.omnibusQueue || new Queue('omnibus-background-jobs', { 
    connection,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100, 
        removeOnFail: 500
    }
});

if (process.env.NODE_ENV !== 'production') globalForMQ.omnibusQueue = omnibusQueue;

export async function syncSchedules() {
    const settings = await prisma.systemSetting.findMany({
        where: {
            key: {
                in: [
                    'library_sync_schedule', 'metadata_sync_schedule', 'monitor_sync_schedule',
                    'diagnostics_sync_schedule', 'backup_sync_schedule', 'backup_sync_day', 'popular_sync_schedule',
                    'weekly_digest_schedule', 'weekly_digest_day', 'cbr_conversion_schedule', 'embed_metadata_schedule',
                    'series_json_schedule', 'cache_cleanup_schedule', 'watched_sync_schedule', 'health_check_schedule'
                ]
            }
        }
    });
    
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

    const repeatableJobs = await omnibusQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
        await omnibusQueue.removeRepeatableByKey(job.key);
    }

    const addJob = async (jobType: string, hoursStr: string | undefined, cronPattern?: string) => {
        // --- ADDED: If a cron string is passed, use that instead of intervals ---
        if (cronPattern) {
            await omnibusQueue.add(jobType, { type: jobType }, {
                repeat: { pattern: cronPattern },
                jobId: `repeat_${jobType.toLowerCase()}`
            });
            return;
        }

        const hours = parseFloat(hoursStr || '0');
        if (hours > 0) {
            await omnibusQueue.add(jobType, { type: jobType }, {
                repeat: { every: Math.round(hours * 60 * 60 * 1000) }, 
                jobId: `repeat_${jobType.toLowerCase()}`
            });
        }
    };

    await addJob('LIBRARY_SCAN', config.library_sync_schedule);
    await addJob('METADATA_SYNC', config.metadata_sync_schedule);
    await addJob('SERIES_MONITOR', config.monitor_sync_schedule);
    await addJob('DIAGNOSTICS', config.diagnostics_sync_schedule);
    
    // --- ADDED: Backup Cron Logic ---
    let backupCron;
    if (config.backup_sync_schedule === "168" && config.backup_sync_day) {
        // Runs at 3:00 AM Server Time on the specified day of the week
        backupCron = `0 3 * * ${config.backup_sync_day}`;
    }
    await addJob('DATABASE_BACKUP', config.backup_sync_schedule, backupCron);
    // --------------------------------
    
    await addJob('DISCOVER_SYNC', config.popular_sync_schedule);
    
    // --- ADDED: Digest Cron Logic ---
    let digestCron;
    // Only use CRON if they selected "Weekly" (168 hours)
    if (config.weekly_digest_schedule === "168" && config.weekly_digest_day) {
        // Runs at 08:00 AM Server Time on the specified day of the week
        digestCron = `0 8 * * ${config.weekly_digest_day}`;
    }
    
    await addJob('WEEKLY_DIGEST', config.weekly_digest_schedule, digestCron);
    // --------------------------------
    
    await addJob('CBR_CONVERSION', config.cbr_conversion_schedule);
    await addJob('EMBED_METADATA', config.embed_metadata_schedule);
    await addJob('EXPORT_SERIES_JSON', config.series_json_schedule);
    await addJob('CACHE_CLEANUP', config.cache_cleanup_schedule);

    // --- REPLACED: Converted hardcoded 15m intervals to dynamic user variables ---
    await addJob('WATCHED_FOLDER_SYNC', config.watched_sync_schedule || '0.25'); 
    await addJob('SYSTEM_HEALTH_CHECK', config.health_check_schedule || '0.25'); 

    // Leave the GitHub update checker at 24 hours
    await omnibusQueue.add('UPDATE_CHECK', { type: 'UPDATE_CHECK' }, { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: 'repeat_update_check' });

    Logger.log("[BullMQ] Native schedules synchronized with database settings.", "info");
}

export function initWorker() {
    if (globalForMQ.omnibusWorker) {
        return;
    }

    Logger.log("[BullMQ] Initializing background worker thread...", "info");

    const worker = new Worker('omnibus-background-jobs', async (job: Job) => {
        const { type } = job.data;
        const startTime = Date.now();
        const nowStr = Date.now().toString();
        Logger.log(`[BullMQ] Processing Job ${job.id}: ${type}`, "info");

        try {
            switch (type) {
                case 'SEARCH_AND_DOWNLOAD': {
                    const { requestId, name, year, isManga, publisher, skipIndexers } = job.data;
                    Logger.log(`[BullMQ] Forwarding automated search for ${name} (Year: ${year}, Manga: ${isManga}) to Rust Engine...`, 'info');

                    // Issue-year optimization + pack isolation + blocklist (parity with upstream
                    // automation.ts at beta.035): override the series year with the matched issue's
                    // release year, allow bulk packs only when the series owns ZERO downloaded files,
                    // and forward the Request's failed-download blocklist so the engine skips
                    // known-bad releases.
                    const freshReq = await prisma.request.findUnique({ where: { id: requestId } });
                    let dynamicYear: string | null = year ? String(year) : null;
                    let allowPacksForThisRequest = false;
                    let failedItems: string[] = [];
                    if (freshReq) {
                        try { failedItems = JSON.parse((freshReq as any).failedLinks || "[]"); } catch { failedItems = []; }
                        if (freshReq.volumeId && freshReq.volumeId !== "0") {
                            const reqSource = (freshReq as any).metadataSource || 'COMICVINE';
                            const localSeries = await prisma.series.findFirst({ where: { metadataId: freshReq.volumeId, metadataSource: reqSource } });
                            if (localSeries) {
                                // If they own 0 files for this series, ALWAYS allow packs.
                                const downloadedIssuesCount = await prisma.issue.count({
                                    where: { seriesId: localSeries.id, filePath: { not: null } }
                                });
                                if (downloadedIssuesCount === 0) {
                                    allowPacksForThisRequest = true;
                                }

                                const cleanReqName = (freshReq.activeDownloadName || name).replace(/\.\w+$/, '');
                                const issueNumMatch = cleanReqName.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(-?\d+(?:\.\d+)?[a-zA-Z]?)/i);
                                if (issueNumMatch) {
                                    const allSeriesIssues = await prisma.issue.findMany({ where: { seriesId: localSeries.id } });
                                    const issueSkeleton = allSeriesIssues.find(i => looseCompareIssue(i.number, issueNumMatch[1]));
                                    if (issueSkeleton && issueSkeleton.releaseDate) {
                                        const parsedIssueYear = issueSkeleton.releaseDate.split('-')[0];
                                        if (parsedIssueYear && /^\d{4}$/.test(parsedIssueYear) && parsedIssueYear !== dynamicYear) {
                                            Logger.log(`[BullMQ] Overriding series year (${dynamicYear}) with issue release year (${parsedIssueYear}) for ${name}`, 'info');
                                            dynamicYear = parsedIssueYear;
                                        }
                                    }
                                }
                            }
                        }
                    }

                    try {
                        const rustResponse = await fetch(ENGINE_URL + '/api/automation/search', {
                            method: 'POST',
                            headers: engineHeaders({ 'Content-Type': 'application/json' }),
                            body: JSON.stringify({
                                request_id: requestId,
                                name,
                                year: dynamicYear,
                                series_year: year ? String(year) : null,
                                allow_packs: allowPacksForThisRequest,
                                is_manga: isManga || false,
                                skip_indexers: skipIndexers || false,
                                failed_links: failedItems
                            })
                        });

                        if (!rustResponse.ok) {
                            throw new Error(`Rust engine returned status: ${rustResponse.status}`);
                        }

                        const resultData = await rustResponse.json();
                        
                        if (!resultData.success || !resultData.best_match) {
                            // MANUAL_DDL fallback: GetComics matched but only on a disabled/unsupported hoster
                            // and no indexer release was found either — hold the link for human pickup instead
                            // of stalling (parity with automation.ts MANUAL_DDL).
                            if (resultData.manual_ddl?.url) {
                                Logger.log(`[BullMQ] No auto-download client for ${name}. Holding GetComics link for manual download.`, 'warn');
                                await prisma.request.update({
                                    where: { id: requestId },
                                    data: { status: 'MANUAL_DDL', downloadLink: resultData.manual_ddl.url, activeDownloadName: resultData.manual_ddl.name || name }
                                });
                                break;
                            }

                            // Notify the requester so a stalled search isn't silent (parity with the legacy Node path).
                            const currentReq = await prisma.request.findUnique({ where: { id: requestId }, include: { user: true } });
                            await prisma.request.update({ where: { id: requestId }, data: { status: 'STALLED' } });

                            if (resultData.stall_for_review) {
                                Logger.log(`[BullMQ] Multiple distinct editions found for: ${name}. Stalling for admin review.`, 'warn');
                                await SystemNotifier.sendAlert('download_failed', {
                                    title: name, imageUrl: currentReq?.imageUrl, user: currentReq?.user?.username,
                                    description: `Multiple distinct versions (variants/special editions) were found for **${name}**. Please use Interactive Search in the Active Downloads queue to select the correct edition.`,
                                    publisher, year
                                }).catch(() => {});
                            } else {
                                Logger.log(`[BullMQ] Rust engine found no valid matches for: ${name}. Stalling request.`, 'warn');
                                await SystemNotifier.sendAlert('download_failed', {
                                    title: name, imageUrl: currentReq?.imageUrl, user: currentReq?.user?.username,
                                    description: `Omnibus searched all connected indexers and direct download sites but could not find a match for **${name}**.`,
                                    publisher, year
                                }).catch(() => {});
                            }
                            break;
                        }

                        const bestMatch = resultData.best_match;
                        Logger.log(`[BullMQ] Rust Engine selected best match: ${bestMatch.title} [Protocol: ${bestMatch.protocol.toUpperCase()}]`, 'info');

                        // Fetch global system settings for paths
                        const settings = await prisma.systemSetting.findMany();
                        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

                        // --- NEW: Dynamically import DownloadService to prevent compilation errors and circular loops ---
                        const { DownloadService } = await import('./download-clients');

                        // --- PROTOCOL SENSITIVE ROUTING ---
                        if (bestMatch.protocol === 'ddl') {
                            const safeTitle = bestMatch.title.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();

                            // Batch-pack dedup: if another request is already downloading this exact URL,
                            // attach to it for batch extraction rather than downloading it twice (parity
                            // with automation.ts duplicateDownload).
                            const duplicateDownload = await prisma.request.findFirst({
                                where: { downloadLink: bestMatch.downloadUrl, status: { in: ['DOWNLOADING', 'IMPORTED', 'COMPLETED'] }, id: { not: requestId } }
                            });
                            if (duplicateDownload) {
                                Logger.log(`[BullMQ] Batch pack already downloading/downloaded (${bestMatch.downloadUrl}). Queuing ${name} for batch extraction.`, 'info');
                                await prisma.request.update({ where: { id: requestId }, data: { status: 'DOWNLOADING', activeDownloadName: safeTitle, downloadLink: bestMatch.downloadUrl } });
                                break;
                            }

                            await prisma.request.update({
                                where: { id: requestId },
                                data: { status: 'DOWNLOADING', activeDownloadName: safeTitle, downloadLink: bestMatch.downloadUrl }
                            });

                            // Added types to parameters to fix explicit any rules
                            DownloadService.downloadDirectFile(bestMatch.downloadUrl, safeTitle, config.download_path, requestId, bestMatch.indexer)
                                .then(async (success: boolean) => {
                                    if (success) {
                                        await new Promise(r => setTimeout(r, 2000));
                                        const { Importer } = await import('./importer');
                                        await Importer.importRequest(requestId);
                                    }
                                })
                                .catch((e: any) => Logger.log(`[BullMQ] Built-in DDL Stream crashed: ${e.message}`, 'error'));

                        } else {
                            const clients = await prisma.downloadClient.findMany();
                            const clientConfig = clients.find(c => (c.protocol || 'torrent').toLowerCase() === bestMatch.protocol.toLowerCase());

                            if (!clientConfig) {
                                throw new Error(`No download client configured in settings for protocol: ${bestMatch.protocol}`);
                            }

                            Logger.log(`[BullMQ] Routing ${bestMatch.protocol.toUpperCase()} release to external client: ${clientConfig.name}`, 'info');
                            
                            await DownloadService.addDownload(clientConfig, bestMatch.downloadUrl, bestMatch.title, 0, 0);
                            
                            const trackingHash = bestMatch.infoHash || bestMatch.guid || bestMatch.downloadUrl;
                            await prisma.request.update({ 
                                where: { id: requestId }, 
                                data: { status: 'DOWNLOADING', activeDownloadName: bestMatch.title, downloadLink: trackingHash, indexer: bestMatch.indexer } 
                            });
                        }

                    } catch (err: any) {
                        Logger.log(`[BullMQ] Failed to process Rust search response: ${err.message}`, 'error');
                        await prisma.request.update({ where: { id: requestId }, data: { status: 'STALLED' } });
                    }
                    break;
                }

                case 'CACHE_CLEANUP': {
                    await prisma.systemSetting.upsert({ 
                        where: { key: 'last_cache_cleanup' }, 
                        update: { value: nowStr }, 
                        create: { key: 'last_cache_cleanup', value: nowStr } 
                    });
                    
                    let dbDeletedCount = 0;
                    try {
                        const oldCacheSettings = await prisma.systemSetting.findMany({
                            where: { 
                                OR: [
                                    { key: { startsWith: 'cv_details_cache_' } },
                                    { key: { startsWith: 'meta_details_' } }
                                ]
                            }
                        });
                        
                        for (const cache of oldCacheSettings) {
                            try {
                                const parsed = JSON.parse(cache.value);
                                if (Date.now() - parsed.timestamp > 24 * 60 * 60 * 1000) {
                                    await prisma.systemSetting.delete({ where: { key: cache.key } });
                                    dbDeletedCount++;
                                }
                            } catch(e) {}
                        }
                    } catch (e) {}

                    const { cleanupMetadataExtractorCache } = await import('@/lib/metadata-extractor');
                    const memDeletedCount = cleanupMetadataExtractorCache();

                    if (dbDeletedCount > 0 || memDeletedCount > 0) {
                        Logger.log(`[Cache Cleanup] Purged ${dbDeletedCount} DB entries and ${memDeletedCount} memory entries.`, 'success');
                    } else {
                        Logger.log(`[Cache Cleanup] No expired cache entries found to purge.`, 'info');
                    }

                    await prisma.jobLog.create({
                        data: {
                            jobType: 'CACHE_CLEANUP',
                            status: 'COMPLETED',
                            durationMs: Date.now() - startTime,
                            message: `Cache cleanup finished. Purged ${dbDeletedCount} DB entries and ${memDeletedCount} memory entries.`
                        }
                    });

                    SystemNotifier.sendAlert('job_cache_cleanup', { description: `Cache cleanup finished. Purged ${dbDeletedCount} DB entries and ${memDeletedCount} memory entries.` }).catch(() => {});
                    break;
                }
                
                case 'DATABASE_BACKUP': {
                    await prisma.systemSetting.upsert({ 
                        where: { key: 'last_backup_sync' }, 
                        update: { value: nowStr }, 
                        create: { key: 'last_backup_sync', value: nowStr } 
                    });

                    Logger.log(`[BullMQ] Forwarding Database Backup Job to Rust Engine...`, 'info');
                    
                    try {
                        const rustResponse = await fetch(ENGINE_URL + '/api/backup', { method: 'POST', headers: engineHeaders() });
                        if (!rustResponse.ok) {
                            throw new Error(`Rust returned error status ${rustResponse.status}`);
                        }
                        Logger.log(`[BullMQ] Rust Engine successfully took over the Database Backup!`, 'info');
                    } catch (e) {
                        Logger.log(`[BullMQ] Failed to offload Database Backup to Rust: ${getErrorMessage(e)}`, 'error');
                        throw e;
                    }
                    
                    // The job_db_backup notification now fires from the Rust engine via
                    // POST /api/internal/notify when the backup actually completes (not at handoff).
                    break;
                }

                case 'SYSTEM_HEALTH_CHECK': {
                    const { runSystemHealthCheck } = await import('@/lib/health-checker');
                    await runSystemHealthCheck();
                    break;
                }

                case 'CBR_CONVERSION': {
                    await prisma.systemSetting.upsert({ 
                        where: { key: 'last_converter_sync' }, 
                        update: { value: nowStr }, 
                        create: { key: 'last_converter_sync', value: nowStr } 
                    });

                    // An optional issueId converts just that issue (targeted conversion, beta.034).
                    const targetIssueId = job.data?.issueId || null;
                    Logger.log(targetIssueId
                        ? `[BullMQ] Forwarding targeted CBR conversion for issue ${targetIssueId} to Rust Engine...`
                        : `[BullMQ] Forwarding CBR Conversion Sweep to Rust Engine...`, 'info');

                    try {
                        const rustResponse = await fetch(ENGINE_URL + '/api/converter/cbr-sweep', {
                            method: 'POST',
                            headers: engineHeaders({ 'Content-Type': 'application/json' }),
                            body: JSON.stringify({ issue_id: targetIssueId })
                        });
                        
                        if (!rustResponse.ok) {
                            throw new Error(`Rust returned error status ${rustResponse.status}`);
                        }
                        
                        Logger.log(`[BullMQ] Rust Engine successfully accepted the CBR Sweep!`, 'info');
                    } catch (e) {
                        Logger.log(`[BullMQ] Failed to offload CBR Conversion to Rust: ${getErrorMessage(e)}`, 'error');
                        throw e;
                    }
                    break;
                }

                // REPACK_ARCHIVES is handled exclusively by the Rust engine via /api/repack. The legacy
                // Node BullMQ handler (serial, no WebP settings) was removed to guarantee a single
                // repack engine — no producer enqueues this job type; the repack route forwards directly.

                case 'WATCHED_FOLDER_SYNC': {
                    Logger.log(`[BullMQ] Forwarding Watched Folder Sync to Rust Engine...`, 'info');
                    
                    try {
                        const rustResponse = await fetch(ENGINE_URL + '/api/watched-sync', { method: 'POST', headers: engineHeaders() });
                        if (!rustResponse.ok) {
                            throw new Error(`Rust returned error status ${rustResponse.status}`);
                        }
                        Logger.log(`[BullMQ] Rust Engine successfully took over the Watched Folder sweep!`, 'info');
                    } catch (e) {
                        Logger.log(`[BullMQ] Failed to offload Watched Folder Sync to Rust: ${getErrorMessage(e)}`, 'error');
                        throw e;
                    }
                    break;
                }
                
                case 'LIBRARY_SCAN': {
                    await prisma.systemSetting.upsert({ 
                        where: { key: 'last_library_sync' }, 
                        update: { value: nowStr }, 
                        create: { key: 'last_library_sync', value: nowStr } 
                    });
                    
                    const { LibraryScanner } = await import('@/lib/library-scanner');
                    await LibraryScanner.scan();
                    
                    const lastStorageRun = await prisma.systemSetting.findUnique({ 
                        where: { key: 'storage_deep_dive_last_run' } 
                    });
                    
                    const lastRunTime = parseInt(lastStorageRun?.value || "0");
                    const hoursSinceLastRun = (Date.now() - lastRunTime) / (1000 * 60 * 60);

                    let storageMessage = "Skipped heavy storage scan (calculated recently).";

                    if (hoursSinceLastRun >= 24) {
                        // Offload the deep storage scan to the Rust engine (fire-and-forget, like the
                        // STORAGE_SCAN job). The engine writes Series.size + the cache + the last-run
                        // timestamps this 24h gate reads.
                        try {
                            const rustResponse = await fetch(ENGINE_URL + '/api/diagnostics/storage', { method: 'POST', headers: engineHeaders() });
                            if (!rustResponse.ok) throw new Error(`Rust returned status ${rustResponse.status}`);
                            storageMessage = "Deep storage scan offloaded to the engine.";
                        } catch (e) {
                            Logger.log(`[BullMQ] Failed to offload storage scan to Rust: ${getErrorMessage(e)}`, 'warn');
                            storageMessage = "Storage scan offload failed (see logs).";
                        }
                    }

                    await prisma.jobLog.create({ 
                        data: { 
                            jobType: 'LIBRARY_SCAN', 
                            status: 'COMPLETED', 
                            durationMs: Date.now() - startTime, 
                            message: `Library scan complete. ${storageMessage}` 
                        } 
                    });
                    
                    SystemNotifier.sendAlert('job_library_scan', { description: `Library scan complete. ${storageMessage}` }).catch(() => {});
                    break;
                }

                case 'METADATA_SYNC': {
                    const isTargeted = job.data.seriesIds && Array.isArray(job.data.seriesIds) && job.data.seriesIds.length > 0;
                    
                    if (!isTargeted) {
                        await prisma.systemSetting.upsert({
                            where: { key: 'last_metadata_sync' },
                            update: { value: nowStr },
                            create: { key: 'last_metadata_sync', value: nowStr }
                        });
                    }

                    Logger.log(`[BullMQ] Forwarding metadata synchronization job to Rust Engine...`, 'info');

                    try {
                        const rustResponse = await fetch(ENGINE_URL + '/api/metadata/sync', {
                            method: 'POST',
                            headers: engineHeaders({ 'Content-Type': 'application/json' }),
                            body: JSON.stringify({
                                series_ids: isTargeted ? job.data.seriesIds : null
                            })
                        });

                        if (!rustResponse.ok) {
                            Logger.log(`[BullMQ] Rust Engine rejected metadata sync job (Status: ${rustResponse.status})`, 'error');
                            throw new Error(`Rust returned error status ${rustResponse.status}`);
                        } else {
                            Logger.log(`[BullMQ] Rust Engine successfully accepted the metadata synchronization process!`, 'info');
                            // job_metadata_sync now fires from the engine on completion (POST /api/internal/notify).
                        }
                    } catch (e) {
                        Logger.log(`[BullMQ] Failed to offload metadata sync to Rust: ${getErrorMessage(e)}`, 'error');
                        throw e;
                    }
                    break;
                }

                                case 'EMBED_METADATA': {
                    const { seriesId, issueIds } = job.data;
                    
                    // Only update the global timer if this was a scheduled bulk job
                    if (!seriesId && (!issueIds || issueIds.length === 0)) {
                        await prisma.systemSetting.upsert({ 
                            where: { key: 'last_embed_sync' }, 
                            update: { value: nowStr }, 
                            create: { key: 'last_embed_sync', value: nowStr } 
                        });
                    }

                    Logger.log(`[BullMQ] Forwarding metadata embedding job to Rust Engine...`, 'info');

                    try {
                        const rustResponse = await fetch(ENGINE_URL + '/api/metadata/embed', {
                            method: 'POST',
                            headers: engineHeaders({ 'Content-Type': 'application/json' }),
                            body: JSON.stringify({
                                series_id: seriesId || null,
                                issue_ids: issueIds && issueIds.length > 0 ? issueIds : null
                            })
                        });

                        if (!rustResponse.ok) {
                            throw new Error(`Rust returned error status ${rustResponse.status}`);
                        }

                        Logger.log(`[BullMQ] Rust Engine successfully accepted the metadata embedding process!`, 'info');

                    } catch (e) {
                        Logger.log(`[BullMQ] Failed to offload metadata embedding to Rust: ${getErrorMessage(e)}`, 'error');
                        throw e;
                    }
                    break;
                }

                case 'EXPORT_SERIES_JSON': {
                    await prisma.systemSetting.upsert({
                        where: { key: 'last_series_json_sync' },
                        update: { value: nowStr },
                        create: { key: 'last_series_json_sync', value: nowStr }
                    });

                    const exportEnabled = await prisma.systemSetting.findUnique({ where: { key: 'export_series_json' } });
                    if (exportEnabled?.value !== 'true') {
                        await prisma.jobLog.create({
                            data: {
                                jobType: 'EXPORT_SERIES_JSON',
                                status: 'COMPLETED_WITH_ERRORS',
                                durationMs: Date.now() - startTime,
                                message: 'Skipped: the series.json export feature is disabled. Enable it in Settings or via the job card toggle.'
                            }
                        });
                        break;
                    }

                    // The Mylar-spec writer lives in the engine (metadata_writer::run_series_json_export);
                    // it also runs inline after every engine embed, so this job covers the scheduled/manual path.
                    const seriesIds: string[] | null = job.data.seriesId
                        ? [job.data.seriesId]
                        : (Array.isArray(job.data.seriesIds) ? job.data.seriesIds : null);

                    Logger.log(`[BullMQ] Forwarding series.json export to Rust Engine...`, 'info');
                    const rustResponse = await fetch(ENGINE_URL + '/api/metadata/export-series-json', {
                        method: 'POST',
                        headers: engineHeaders({ 'Content-Type': 'application/json' }),
                        body: JSON.stringify({ series_ids: seriesIds })
                    });
                    if (!rustResponse.ok) throw new Error(`Rust returned error status ${rustResponse.status}`);
                    const exportResult = await rustResponse.json();

                    await prisma.jobLog.create({
                        data: {
                            jobType: 'EXPORT_SERIES_JSON',
                            status: 'COMPLETED',
                            durationMs: Date.now() - startTime,
                            message: `series.json export complete. Wrote ${exportResult.exported ?? 0} of ${exportResult.total ?? 0} series folders.`
                        }
                    });
                    break;
                }

                case 'SERIES_MONITOR': {
                    await prisma.systemSetting.upsert({
                        where: { key: 'last_monitor_sync' },
                        update: { value: nowStr },
                        create: { key: 'last_monitor_sync', value: nowStr }
                    });

                    let details = "Hybrid Series Monitor Job Started.\n\n";
                    let newRequestsFound = 0;
                    let unreleasedUpgraded = 0;

                    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });

                    // The heavy half (Metron 3000 + ComicVine 25x30 fetch/match/skeleton-upsert) is owned by
                    // the Rust engine (/api/monitor/sync -> monitor::run_series_monitor). It returns the
                    // skeleton count + the monitored, matched, not-in-library issues as candidates; request
                    // creation + searchAndDownload (BullMQ) stay here. The call is synchronous and can take
                    // minutes -- the engine awaits the full fetch before responding.
                    let monitorData: any = { skeletons_created: 0, metron_fetched: 0, notes: [], candidates: [] };
                    try {
                        const rustResponse = await engineFetchLong(ENGINE_URL + '/api/monitor/sync', { method: 'POST', headers: engineHeaders() });
                        if (!rustResponse.ok) throw new Error(`Rust returned status ${rustResponse.status}`);
                        monitorData = await rustResponse.json();
                    } catch (e) {
                        Logger.log(`[BullMQ] Series Monitor engine phase failed: ${getErrorMessage(e)}`, 'error');
                        throw e;
                    }

                    const skeletonsCreated = monitorData.skeletons_created || 0;
                    if (Array.isArray(monitorData.notes)) for (const n of monitorData.notes) details += `${n}\n`;

                    const allRequests = await prisma.request.findMany();

                    // Request creation / UNRELEASED upgrade from the engine's candidates.
                    for (const c of (monitorData.candidates || [])) {
                        const alreadyReq = allRequests.find(r => {
                            if (r.volumeId !== c.volume_id) return false;
                            const match = r.activeDownloadName?.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?[a-zA-Z]?)/i);
                            const reqNum = match ? match[1] : null;
                            return reqNum ? isSameIssue(reqNum, c.issue_number) : false;
                        });

                        if (alreadyReq) {
                            if (alreadyReq.status === 'UNRELEASED' && c.is_released) {
                                details += `[UPGRADE] ${c.search_name} released. Triggering search...\n`;
                                await prisma.request.update({ where: { id: alreadyReq.id }, data: { status: 'PENDING' } });
                                searchAndDownload(alreadyReq.id, c.search_name, c.issue_year, c.publisher, c.is_manga).catch(() => {});
                                unreleasedUpgraded++;
                                alreadyReq.status = 'PENDING';
                            }
                        } else {
                            const issueStatus = c.is_released ? 'PENDING' : 'UNRELEASED';
                            details += `[NEW] Queued ${issueStatus}: ${c.search_name}\n`;
                            const newReq = await prisma.request.create({
                                data: {
                                    userId: admin?.id || 'system',
                                    volumeId: c.volume_id,
                                    status: issueStatus,
                                    activeDownloadName: c.search_name,
                                    imageUrl: c.image_url || null
                                }
                            });
                            allRequests.push(newReq);
                            if (c.is_released) {
                                searchAndDownload(newReq.id, c.search_name, c.issue_year, c.publisher, c.is_manga).catch(() => {});
                                newRequestsFound++;
                            }
                        }
                    }

                    // Phase 3 -- UNRELEASED upgrade sweep. Re-fetch series+issues so the engine-created
                    // skeletons (with releaseDates) are visible to this pass.
                    const localSeriesList = await prisma.series.findMany({ include: { issues: true } });
                    const unreleasedRequests = allRequests.filter(r => r.status === 'UNRELEASED');
                    for (const req of unreleasedRequests) {
                        // Unified utility (negative-number aware) replaces the old inline extractor.
                        const reqNumString = extractIssueNumber(req.activeDownloadName || "");
                        const reqNum = parseFloat(reqNumString);

                        if (!isNaN(reqNum)) {
                            const matchedSeries = localSeriesList.find(s => s.metadataId === req.volumeId || s.id === req.volumeId);
                            if (matchedSeries) {
                                const skeleton = matchedSeries.issues.find((i: any) => parseFloat(i.number) === reqNum);
                                if (skeleton && skeleton.releaseDate) {
                                    if (isReleasedYet(skeleton.releaseDate, skeleton.releaseDate)) {
                                        await prisma.request.update({ where: { id: req.id }, data: { status: 'PENDING' } });
                                        searchAndDownload(req.id, req.activeDownloadName || "", skeleton.releaseDate.split('-')[0], matchedSeries.publisher || "Unknown", matchedSeries.isManga).catch(() => {});
                                        unreleasedUpgraded++;
                                    }
                                }
                            }
                        }
                    }

                    await prisma.jobLog.create({
                        data: {
                            jobType: 'SERIES_MONITOR',
                            status: 'COMPLETED',
                            durationMs: Date.now() - startTime,
                            message: details + `\nFinal Summary: ${skeletonsCreated} calendar entries, ${newRequestsFound} new downloads, ${unreleasedUpgraded} upgrades.`
                        }
                    });
                    break;
                }

                case 'DIAGNOSTICS': {
                    Logger.log(`[BullMQ] Forwarding Ghost File Check to Rust Engine...`, 'info');
                    try {
                        const rustResponse = await fetch(ENGINE_URL + '/api/diagnostics/ghosts', { method: 'POST', headers: engineHeaders() });
                        if (!rustResponse.ok) throw new Error(`Rust returned status ${rustResponse.status}`);
                        Logger.log(`[BullMQ] Rust Engine successfully took over Ghost File Diagnostics!`, 'info');
                        // job_diagnostics now fires from the engine on completion (POST /api/internal/notify).
                    } catch (e) {
                        Logger.log(`[BullMQ] Failed to offload Diagnostics to Rust: ${getErrorMessage(e)}`, 'error');
                        throw e;
                    }
                    break;
                }

                case 'UPDATE_CHECK': {
                    const res = await axios.get('https://api.github.com/repos/hankscafe/omnibus/releases?per_page=1', {
                        headers: { 'User-Agent': 'Omnibus-App', 'Accept': 'application/vnd.github.v3+json' }, 
                        timeout: 10000
                    });

                    if (res.data && res.data.length > 0) {
                        const latestVersion = res.data[0].tag_name.replace(/^v/, '');
                        const notifiedSetting = await prisma.systemSetting.findUnique({ 
                            where: { key: 'last_notified_version' } 
                        });
                        const lastNotified = notifiedSetting?.value || "";

                        if (latestVersion !== lastNotified) {
                            const currentVersion = packageJson.version || "1.0.0";
                            if (isNewerVersion(latestVersion, currentVersion)) {
                                await SystemNotifier.sendAlert('update_available', { version: latestVersion });
                                await prisma.systemSetting.upsert({ 
                                    where: { key: 'last_notified_version' }, 
                                    update: { value: latestVersion }, 
                                    create: { key: 'last_notified_version', value: latestVersion } 
                                });
                            }
                        }
                    }
                    break;
                }

                case 'STORAGE_SCAN': {
                    await prisma.systemSetting.upsert({ 
                        where: { key: 'last_storage_scan' }, 
                        update: { value: nowStr }, 
                        create: { key: 'last_storage_scan', value: nowStr } 
                    });

                    Logger.log(`[BullMQ] Forwarding Deep Storage Scan to Rust Engine...`, 'info');
                    try {
                        const rustResponse = await fetch(ENGINE_URL + '/api/diagnostics/storage', { method: 'POST', headers: engineHeaders() });
                        if (!rustResponse.ok) throw new Error(`Rust returned status ${rustResponse.status}`);
                        Logger.log(`[BullMQ] Rust Engine successfully took over Deep Storage Scan!`, 'info');
                        // job_diagnostics now fires from the engine on completion (POST /api/internal/notify).
                    } catch (e) {
                        Logger.log(`[BullMQ] Failed to offload Storage Scan to Rust: ${getErrorMessage(e)}`, 'error');
                        throw e;
                    }
                    break;
                }

                case 'DISCOVER_SYNC': {
                    // The Discover-feed rebuild (ComicVine + Metron fetch/filter/cache) is owned by the
                    // Rust engine (/api/discover/sync -> discover::run_discover_sync), which writes the
                    // discover_cache_new / discover_cache_popular caches and the COMPLETED/FAILED JobLog.
                    await prisma.systemSetting.upsert({
                        where: { key: 'last_popular_sync' },
                        update: { value: nowStr },
                        create: { key: 'last_popular_sync', value: nowStr }
                    });

                    Logger.log(`[BullMQ] Forwarding Discover Sync to Rust Engine...`, 'info');
                    try {
                        const rustResponse = await fetch(ENGINE_URL + '/api/discover/sync', { method: 'POST', headers: engineHeaders() });
                        if (!rustResponse.ok) throw new Error(`Rust returned status ${rustResponse.status}`);
                        Logger.log(`[BullMQ] Rust Engine successfully took over the Discover Sync!`, 'info');
                    } catch (e) {
                        Logger.log(`[BullMQ] Failed to offload Discover Sync to Rust: ${getErrorMessage(e)}`, 'error');
                        throw e;
                    }
                    break;
                }

                case 'WEEKLY_DIGEST': {
                    await prisma.systemSetting.upsert({ 
                        where: { key: 'last_weekly_digest' }, 
                        update: { value: nowStr }, 
                        create: { key: 'last_weekly_digest', value: nowStr } 
                    });

                    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                    const candidateIssues = await prisma.issue.findMany({
                        where: { createdAt: { gte: sevenDaysAgo }, filePath: { not: null } },
                        include: { series: true }, orderBy: { series: { name: 'asc' } }
                    });

                    if (candidateIssues.length === 0) break;

                    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
                    await prisma.digestHistory.deleteMany({ 
                        where: { sentAt: { lt: fourteenDaysAgo } } 
                    });
                    await prisma.systemSetting.deleteMany({ 
                        where: { key: 'weekly_digest_history' } 
                    });

                    const digestHistory = await prisma.digestHistory.findMany({ 
                        select: { seriesId: true, issueNum: true } 
                    });
                    const sentSet = new Set(digestHistory.map(h => `${h.seriesId}_${h.issueNum}`));

                    const newIssues = [];
                    const recordsToSave = [];

                    for (const issue of candidateIssues) {
                        const key = `${issue.seriesId}_${issue.number}`;
                        if (!sentSet.has(key)) {
                            newIssues.push(issue);
                            recordsToSave.push({ seriesId: issue.seriesId, issueNum: issue.number });
                        }
                    }

                    if (newIssues.length === 0) break;

                    const comicsMap: Record<string, any> = {}; 
                    const mangaMap: Record<string, any> = {};

                    for (const issue of newIssues) {
                        const targetMap = issue.series.isManga ? mangaMap : comicsMap;
                        const sId = issue.series.id;
                        const issueTag = `#${parseFloat(issue.number)}`;
                        
                        if (!targetMap[sId]) {
                            targetMap[sId] = { 
                                name: issue.series.name, 
                                coverUrl: issue.series.coverUrl, 
                                publisher: issue.series.publisher || "Unknown", 
                                year: issue.series.year?.toString() || "????", 
                                description: issue.series.description || "No synopsis available.", 
                                issues: [] 
                            };
                        }
                        targetMap[sId].issues.push(issueTag);
                    }

                    const formatIssueList = (issuesArr: string[]) => {
                        let sorted = [...new Set(issuesArr)].sort((a: any, b: any) => parseFloat(a.replace('#','')) - parseFloat(b.replace('#','')));
                        if (sorted.length > 15) {
                            const remainder = sorted.length - 15;
                            sorted = sorted.slice(0, 15);
                            sorted.push(`...and ${remainder} more`);
                        }
                        return sorted;
                    };

                    for (const s in comicsMap) { 
                        comicsMap[s].issues = formatIssueList(comicsMap[s].issues); 
                    }
                    for (const s in mangaMap) { 
                        mangaMap[s].issues = formatIssueList(mangaMap[s].issues); 
                    }

                    let finalComics = Object.values(comicsMap); 
                    let finalManga = Object.values(mangaMap);
                    
                    if (finalComics.length + finalManga.length > 15) {
                        finalComics = finalComics.slice(0, 10);
                        finalManga = finalManga.slice(0, 5);
                    }

                    const users = await prisma.user.findMany({ 
                        where: { email: { not: '' }, isApproved: true }, 
                        select: { email: true } 
                    });
                    const toEmails = users.map(u => u.email);

                    if (toEmails.length > 0) {
                        try {
                            await Mailer.sendWeeklyDigest(toEmails, finalComics, finalManga);
                            if (recordsToSave.length > 0) {
                                for (const record of recordsToSave) {
                                    await prisma.digestHistory.create({ data: record });
                                }
                            }
                        } catch (mailErr) { 
                            throw mailErr; 
                        }
                    }

                    await prisma.jobLog.create({
                        data: { 
                            jobType: 'WEEKLY_DIGEST', 
                            status: 'COMPLETED', 
                            durationMs: Date.now() - startTime, 
                            message: `Sent weekly digest to ${toEmails.length} users containing ${newIssues.length} unique new issues.` 
                        }
                    });
                    break;
                }

                default: 
                    throw new Error(`Unknown job type: ${type}`);
            }

            await job.updateProgress(100);

        } catch (error: any) {
            await prisma.jobLog.create({ 
                data: { jobType: type, status: 'FAILED', message: error.message } 
            });
            throw error; 
        }
    }, { connection, concurrency: 1 });

    worker.on('completed', (job: Job) => Logger.log(`[BullMQ] Job ${job?.id} (${job?.data.type}) completed successfully.`, "success"));
    worker.on('failed', (job: Job | undefined, err: Error) => Logger.log(`[BullMQ] Job ${job?.id} (${job?.data?.type || 'Unknown'}) failed: ${err.message}`, "error"));

    if (process.env.NODE_ENV !== 'production') globalForMQ.omnibusWorker = worker;
}