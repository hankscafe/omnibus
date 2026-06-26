import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from './db';
import { Logger } from './logger';
import { SystemNotifier } from './notifications'; 
import { Mailer } from './mailer';
import crypto from 'crypto';
import { apiClient as axios } from '@/lib/api-client';
import fs from 'fs-extra';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isReleasedYet } from '@/lib/utils';
import { searchAndDownload } from '@/lib/automation';
import packageJson from '../../package.json';
import { getErrorMessage } from '@/lib/utils/error';
import { isSameIssue, extractIssueNumber } from '@/lib/utils/issue-parser';
import { COMIC_EXTENSIONS } from '@/lib/utils/formats';
import { sanitizeFilename as sanitize } from '@/lib/utils/sanitize';
import { BACKUPS_DIR, WATCHED_DIR, UNMATCHED_DIR } from '@/lib/utils/paths';
import { containsWord } from '@/lib/filter-defaults';

const execFileAsync = promisify(execFile);

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

async function getFolderSize(folderPath: string): Promise<number> {
    try {
        if (!folderPath || !fs.existsSync(folderPath)) {
            Logger.log(`[Storage Scan Debug] Path invalid or missing: ${folderPath}`, 'debug');
            return 0;
        }

        if (process.platform !== 'win32') {
            try {
                const { stdout } = await execFileAsync('du', ['-sb', folderPath]);
                const match = stdout.match(/^(\d+)/);
                if (match) {
                    const size = parseInt(match[1], 10);
                    Logger.log(`[Storage Scan Debug] Fast 'du' calculation for ${folderPath}: ${Math.round(size / 1024 / 1024)} MB`, 'debug');
                    return size;
                }
            } catch (duError) {
                Logger.log(`[Storage Scan Debug] du command failed for ${folderPath}: ${getErrorMessage(duError)}`, 'debug');
            }
        }
        
        Logger.log(`[Storage Scan Debug] Manually calculating folder size for: ${folderPath}`, 'debug');
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
    } catch (e: any) {
        Logger.log(`[Storage Scan Debug] Failed to calculate size for ${folderPath}: ${e.message}`, 'error');
        return 0;
    }
}

async function runStorageScan() {
    Logger.log(`[Storage Scan Debug] Initializing deep storage scan...`, 'debug');
    const nowStr = Date.now().toString();
    
    await prisma.systemSetting.upsert({
        where: { key: 'storage_deep_dive_last_run' },
        update: { value: nowStr },
        create: { key: 'storage_deep_dive_last_run', value: nowStr }
    });

    const seriesList = await prisma.series.findMany({
        select: { id: true, name: true, publisher: true, folderPath: true, isManga: true, _count: { select: { issues: true } } }
    });

    Logger.log(`[Storage Scan Debug] Found ${seriesList.length} series to evaluate.`, 'debug');

    const storageData: any[] = [];
    for (const s of seriesList) {
        Logger.log(`[Storage Scan Debug] Evaluating Series: "${s.name}" at path [${s.folderPath}]`, 'debug');
        const size = s.folderPath ? await getFolderSize(s.folderPath) : 0;
        
        await prisma.series.update({ where: { id: s.id }, data: { size } }).catch(() => {});
        
        storageData.push({
            id: s.id, 
            name: s.name, 
            publisher: s.publisher || "Unknown",
            isManga: s.isManga, 
            issueCount: s._count.issues,
            path: s.folderPath, 
            sizeBytes: size
        });
    }

    storageData.sort((a, b) => b.sizeBytes - a.sizeBytes);
    Logger.log(`[Storage Scan Debug] Completed deep storage scan. Caching results...`, 'debug');

    await prisma.systemSetting.upsert({
        where: { key: 'storage_deep_dive_cache' },
        update: { value: JSON.stringify(storageData) },
        create: { key: 'storage_deep_dive_cache', value: JSON.stringify(storageData) }
    });
    
    return storageData.length;
}

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
                    const { requestId, name, year, publisher, isManga, skipIndexers } = job.data;
                    const { executeSearchAndDownload } = await import('@/lib/automation');
                    
                    await executeSearchAndDownload(requestId, name, year, publisher, isManga, skipIndexers);
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
                    
                    const algorithm = 'aes-256-cbc';
                    const secret = process.env.NEXTAUTH_SECRET || 'omnibus_default_encryption_key_!@#';
                    const key = crypto.createHash('sha256').update(String(secret)).digest();
                    const iv = crypto.randomBytes(16);
                    
                    const backupDir = BACKUPS_DIR;
                    await fs.ensureDir(backupDir);
                    const fileName = `omnibus_backup_${Date.now()}.json`;
                    const filePath = path.join(backupDir, fileName);

                    const writeStream = fs.createWriteStream(filePath);
                    const cipher = crypto.createCipheriv(algorithm, key, iv);

                    writeStream.write(`{\n  "encrypted": true,\n  "version": "2.2",\n  "iv": "${iv.toString('hex')}",\n  "data": "`);
                    cipher.on('data', (chunk) => writeStream.write(chunk.toString('hex')));

                    const streamFinished = new Promise<void>((resolve, reject) => {
                        cipher.on('end', () => { 
                            writeStream.write(`"\n}`); 
                            writeStream.end(); 
                        });
                        writeStream.on('finish', resolve);
                        writeStream.on('error', reject);
                    });

                    cipher.write('{"timestamp":"' + new Date().toISOString() + '","data":{');

                    const tables = [
                        { name: 'users', model: prisma.user },
                        { name: 'settings', model: prisma.systemSetting },
                        { name: 'libraries', model: prisma.library },
                        { name: 'downloadClients', model: prisma.downloadClient },
                        { name: 'discordWebhooks', model: prisma.discordWebhook },
                        { name: 'indexers', model: prisma.indexer },
                        { name: 'customHeaders', model: prisma.customHeader },
                        { name: 'searchAcronyms', model: prisma.searchAcronym },
                        { name: 'collections', model: prisma.collection },
                        { name: 'readingLists', model: prisma.readingList },
                        { name: 'trophies', model: prisma.trophy },
                        { name: 'series', model: prisma.series },
                        { name: 'issues', model: prisma.issue },
                        { name: 'requests', model: prisma.request },
                        { name: 'readProgresses', model: prisma.readProgress },
                        { name: 'collectionItems', model: prisma.collectionItem },
                        { name: 'readingListItems', model: prisma.readingListItem },
                        { name: 'userTrophies', model: prisma.userTrophy },
                        { name: 'issueReports', model: prisma.issueReport },
                        { name: 'digestHistory', model: prisma.digestHistory }
                    ];

                    let firstTable = true;
                    for (const table of tables) {
                        Logger.log(`[Backup Debug] Exporting table: ${table.name}`, 'debug');
                        if (!firstTable) cipher.write(',');
                        firstTable = false;
                        cipher.write(`"${table.name}":[`);
                        let skip = 0;
                        const take = 500;
                        let firstRow = true;
                        
                        while (true) {
                            // @ts-expect-error table.model is a union of Prisma delegates; findMany's args type isn't common across the union
                            const rows = await table.model.findMany({ skip, take });
                            if (rows.length === 0) break;
                            
                            for (const row of rows) {
                                if (!firstRow) cipher.write(',');
                                firstRow = false;
                                cipher.write(JSON.stringify(row));
                            }
                            skip += take;
                        }
                        cipher.write(`]`);
                    }

                    cipher.write('}}');
                    cipher.end(); 
                    await streamFinished;

                    const files = await fs.readdir(backupDir);
                    const backupFiles = files.filter(f => f.startsWith('omnibus_backup_')).sort();
                    if (backupFiles.length > 5) {
                        const toDelete = backupFiles.slice(0, backupFiles.length - 5);
                        for (const file of toDelete) {
                            await fs.remove(path.join(backupDir, file));
                        }
                    }

                    await prisma.jobLog.create({ 
                        data: { 
                            jobType: 'DATABASE_BACKUP', 
                            status: 'COMPLETED', 
                            durationMs: Date.now() - startTime, 
                            message: `Backup saved successfully to ${filePath}. Retaining last 5 backups.` 
                        } 
                    });
                    SystemNotifier.sendAlert('job_db_backup', { description: `Backup saved successfully to ${fileName}.` }).catch(() => {});
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
                                         
                    const { convertCbrToCbz } = await import('@/lib/converter');
                    const targetIssueId = job.data?.issueId;
                    
                    let cbrIssues = [];
                    if (targetIssueId) {
                        const singleIssue = await prisma.issue.findUnique({ where: { id: targetIssueId } });
                        if (singleIssue) cbrIssues.push(singleIssue);
                    } else {
                        cbrIssues = await prisma.issue.findMany({
                            where: {
                                 OR: [
                                     { filePath: { endsWith: '.cbr' } },
                                     { filePath: { endsWith: '.CBR' } },
                                     { filePath: { endsWith: '.rar' } },
                                     { filePath: { endsWith: '.RAR' } },
                                     { filePath: { endsWith: '.cb7' } },
                                     { filePath: { endsWith: '.CB7' } }
                                 ]
                             }
                        });
                    }

                    if (cbrIssues.length === 0) {
                        await prisma.jobLog.create({
                             data: {
                                 jobType: 'CBR_CONVERTER',
                                 status: 'COMPLETED',
                                 durationMs: Date.now() - startTime,
                                 message: targetIssueId ? `Targeted issue ${targetIssueId} not found or already converted.` : "No CBR files found to convert."
                             }
                         });
                        break;
                    }
                    let successCount = 0;
                    let failCount = 0;
                    let details = `Found ${cbrIssues.length} CBR files to convert.\n\n`;
                    for (const issue of cbrIssues) {
                        if (!issue.filePath) continue;
                        try {
                            const newPath = await convertCbrToCbz(issue.filePath);
                            if (newPath) {
                                successCount++;
                                details += `[OK] Converted: ${path.basename(issue.filePath)}\n`;
                            } else {
                                failCount++;
                                details += `[FAIL] Could not convert: ${path.basename(issue.filePath)}\n`;
                            }
                        } catch (e: any) {
                            failCount++;
                            details += `[FAIL] Error converting ${path.basename(issue.filePath)}: ${e.message}\n`;
                        }
                    }
                    await prisma.jobLog.create({
                        data: {
                            jobType: 'CBR_CONVERTER',
                            status: failCount > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
                            durationMs: Date.now() - startTime,
                            message: details + `\nSummary: ${successCount} Converted, ${failCount} Failed.`
                        }
                    });
                                         
                    SystemNotifier.sendAlert('job_diagnostics', { description: `CBR Conversion Sweep Complete. Converted: ${successCount}, Failed: ${failCount}` }).catch(() => {});
                    break;
                }

                case 'REPACK_ARCHIVES': {
                    const { seriesIds } = job.data;
                    const { repackArchive } = await import('@/lib/converter');
                    
                    let successCount = 0;
                    let failCount = 0;

                    const issues = await prisma.issue.findMany({
                        where: { seriesId: { in: seriesIds }, filePath: { not: null } },
                        include: { series: true }
                    });

                    if (issues.length === 0) {
                        await prisma.jobLog.create({
                            data: { 
                                jobType: 'REPACK_ARCHIVES', 
                                status: 'COMPLETED', 
                                durationMs: Date.now() - startTime, 
                                message: "No valid files found to repack." 
                            }
                        });
                        break;
                    }

                    let currentIdx = 0;
                    for (const issue of issues) {
                        if (issue.filePath) {
                            const ok = await repackArchive(issue.filePath);
                            if (ok) {
                                successCount++;
                            } else {
                                failCount++;
                            }
                        }
                        currentIdx++;
                        await job.updateProgress(Math.round((currentIdx / issues.length) * 100));
                    }

                    await prisma.jobLog.create({
                        data: {
                            jobType: 'REPACK_ARCHIVES',
                            status: failCount > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
                            durationMs: Date.now() - startTime,
                            message: `Internal repack complete. Processed ${successCount} archives successfully. Failed: ${failCount}.`
                        }
                    });
                    break;
                }

                case 'WATCHED_FOLDER_SYNC': {
                    const watchedDir = WATCHED_DIR;
                    const unmatchedDir = UNMATCHED_DIR;

                    await fs.ensureDir(watchedDir);
                    await fs.ensureDir(unmatchedDir);

                    const filesToProcess: string[] = [];
                    async function scanWatchedDir(currentPath: string) {
                        const items = await fs.readdir(currentPath, { withFileTypes: true });
                        for (const item of items) {
                            const fullPath = path.join(currentPath, item.name);
                            if (item.isDirectory()) {
                                await scanWatchedDir(fullPath);
                            } else {
                                const ext = path.extname(item.name).toLowerCase();
                                if (COMIC_EXTENSIONS.includes(ext)) {
                                    filesToProcess.push(fullPath);
                                }
                            }
                        }
                    }
                    await scanWatchedDir(watchedDir);

                    let successCount = 0;
                    let unmatchedCount = 0;
                    const syncedSeriesIds = new Set<string>();

                    const { convertCbrToCbz } = await import('@/lib/converter');
                    const { parseComicInfo } = await import('@/lib/metadata-extractor');
                    const { detectManga } = await import('@/lib/manga-detector');

                    const libraries = await prisma.library.findMany();
                    if (libraries.length === 0) break;

                    const settings = await prisma.systemSetting.findMany();
                    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
                    
                    const folderPattern = config.folder_naming_pattern || "{Publisher}/{Series} ({Year})";
                    const filePattern = config.file_naming_pattern || "{Series} #{Issue}";
                    const mangaFilePattern = config.manga_file_naming_pattern || "{Series} Vol. {Issue}";

                    for (let filePath of filesToProcess) {
                        const file = path.basename(filePath); 
                        const ext = path.extname(filePath).toLowerCase();
                        
                        if (!COMIC_EXTENSIONS.includes(ext)) continue;

                        try {
                            if (ext === '.cbr' || ext === '.rar' || ext === '.cb7') {
                                const convertedPath = await convertCbrToCbz(filePath);
                                if (convertedPath) {
                                    filePath = convertedPath;
                                } else {
                                    continue;
                                }
                            }

                            const meta = await parseComicInfo(filePath);

                            if (meta && meta.metadataId && meta.series) {
                                const safePublisher = meta.publisher || "Other";
                                Logger.log(`[Watched Sync Debug] Parsed ComicInfo for ${file}: Series="${meta.series}", Issue="${meta.number}", Publisher="${safePublisher}"`, 'debug');
                                
                                const existingSeries = await prisma.series.findUnique({
                                    where: { 
                                        metadataSource_metadataId: { 
                                            metadataSource: meta.metadataSource, 
                                            metadataId: meta.metadataId.toString() 
                                        } 
                                    }
                                });

                                let isManga = false;
                                if (existingSeries) {
                                    isManga = existingSeries.isManga;
                                } else if (meta.mangaTag === 'No') {
                                    isManga = false;
                                } else {
                                    isManga = meta.isManga || await detectManga({ name: meta.series, publisher: { name: safePublisher }, year: meta.year || 0 }, filePath);
                                }

                                let targetLib = null;
                                if (existingSeries && existingSeries.libraryId) {
                                    targetLib = libraries.find(l => l.id === existingSeries.libraryId);
                                }
                                
                                if (!targetLib) {
                                    targetLib = isManga 
                                        ? libraries.find(l => l.isDefault && l.isManga) || libraries.find(l => l.isManga)
                                        : libraries.find(l => l.isDefault && !l.isManga) || libraries.find(l => !l.isManga);
                                }
                                
                                if (!targetLib) {
                                    targetLib = libraries[0];
                                }

                                const safeSeries = sanitize(meta.series);
                                const safeYear = meta.year ? meta.year.toString() : "";
                                const safePub = sanitize(safePublisher);
                                const universeName = meta.universe || "";

                                const relFolderPath = folderPattern
                                    .replace(/{Publisher}/gi, safePub)
                                    .replace(/{Series}/gi, safeSeries)
                                    .replace(/{Year}/gi, safeYear)
                                    .replace(/{VolumeYear}/gi, safeYear)
                                    .replace(/{UniverseName}/gi, sanitize(universeName))
                                    .replace(/\(\s*\)/g, '')
                                    .replace(/\[\s*\]/g, '')
                                    .replace(/\s+/g, ' ')
                                    .trim();

                                const destFolder = path.join(targetLib.path, ...relFolderPath.split(/[/\\]/).map(p => p.trim()).filter(Boolean));
                                await fs.ensureDir(destFolder);

                                const extractedNum = meta.number || extractIssueNumber(file);
                                const formattedNum = extractedNum.includes('.') || extractedNum.length > 1 ? extractedNum : `0${extractedNum}`;
                                
                                const issueYear = meta.year ? meta.year.toString() : safeYear;
                                const filePatToUse = isManga ? mangaFilePattern : filePattern;
                                
                                const issueTitle = meta.title || "";

                                const newFileName = filePatToUse
                                    .replace(/{Publisher}/gi, safePub)
                                    .replace(/{Series}/gi, safeSeries)
                                    .replace(/{Year}/gi, safeYear)
                                    .replace(/{VolumeYear}/gi, safeYear)
                                    .replace(/{IssueYear}/gi, issueYear)
                                    .replace(/{Issue}/gi, formattedNum)
                                    .replace(/{IssueTitle}/gi, sanitize(issueTitle))
                                    .replace(/{UniverseName}/gi, sanitize(universeName))
                                    .replace(/\(\s*\)/g, '')
                                    .replace(/\[\s*\]/g, '')
                                    .replace(/\s*-\s*-/g, ' - ') // Collapses double hyphens (e.g., " -  - " becomes " - ")
                                    .replace(/(^\s*-\s*|\s*-\s*$)/g, '') // Removes any leading or trailing hyphens
                                    .replace(/\s+/g, ' ')
                                    .trim();

                                const finalDestPath = path.join(destFolder, `${sanitize(newFileName)}.cbz`);
                                const sourceDir = path.dirname(filePath);

                                await fs.move(filePath, finalDestPath, { overwrite: true });

                                try {
                                    const dirsToCheck = [sourceDir];
                                    const parentDir = path.dirname(sourceDir);
                                    
                                    if (parentDir.toLowerCase() !== watchedDir.toLowerCase() && parentDir.toLowerCase().startsWith(watchedDir.toLowerCase())) {
                                        dirsToCheck.push(parentDir);
                                    }

                                    for (const dir of dirsToCheck) {
                                        if (!fs.existsSync(dir)) continue;
                                        
                                        const siblingFiles = await fs.readdir(dir);
                                        for (const sib of siblingFiles) {
                                            if (sib.match(/\.(jpg|jpeg|png|webp)$/i)) {
                                                const sibSrc = path.join(dir, sib);
                                                const sibDest = path.join(destFolder, sib);
                                                
                                                try {
                                                    if (sibSrc.toLowerCase() === sibDest.toLowerCase()) continue;
                                                    
                                                    if (!fs.existsSync(sibDest)) {
                                                        await fs.copy(sibSrc, sibDest);
                                                    }
                                                    await fs.remove(sibSrc);
                                                } catch (imgErr: any) {}
                                            }
                                        }
                                    }
                                } catch(e: any) {}

                                let safeMetaYear = meta.year;
                                if (safeMetaYear && (safeMetaYear < 1900 || safeMetaYear > 2100)) {
                                    safeMetaYear = null; 
                                }

                                const seriesRecord = await prisma.series.upsert({
                                    where: { 
                                        metadataSource_metadataId: { 
                                            metadataSource: meta.metadataSource, 
                                            metadataId: meta.metadataId.toString() 
                                        } 
                                    },
                                    update: { folderPath: destFolder },
                                    create: {
                                        name: safeSeries, 
                                        publisher: safePub, 
                                        year: meta.year || new Date().getFullYear(),
                                        folderPath: destFolder, 
                                        metadataId: meta.metadataId.toString(), 
                                        metadataSource: meta.metadataSource,
                                        matchState: 'MATCHED', 
                                        isManga, 
                                        libraryId: targetLib.id,
                                        universe: universeName
                                    }
                                });

                                syncedSeriesIds.add(seriesRecord.id);

                                await prisma.issue.create({
                                    data: {
                                        seriesId: seriesRecord.id,
                                        metadataId: meta.metadataIssueId ? meta.metadataIssueId.toString() : `unmatched_${Math.random()}`,
                                        metadataSource: meta.metadataIssueId ? meta.metadataSource : 'LOCAL',
                                        matchState: meta.metadataIssueId ? 'MATCHED' : 'UNMATCHED',
                                        number: extractedNum, 
                                        status: 'DOWNLOADED', 
                                        filePath: finalDestPath,
                                        name: meta.title, 
                                        description: meta.summary,
                                        writers: meta.writers?.length ? JSON.stringify(meta.writers) : null,
                                        artists: meta.artists?.length ? JSON.stringify(meta.artists) : null,
                                        characters: meta.characters?.length ? JSON.stringify(meta.characters) : null
                                    }
                                });

                                successCount++;
                            } else {
                                Logger.log(`[Watched Sync Debug] Failed to parse sufficient metadata for ${file}. Moving to unmatched folder.`, 'debug');
                                const finalUnmatchedPath = path.join(unmatchedDir, path.basename(filePath));
                                await fs.move(filePath, finalUnmatchedPath, { overwrite: true });
                                unmatchedCount++;
                            }
                        } catch (err) {
                            Logger.log(`[Watched Sync] Error processing ${path.basename(filePath)}`, 'error');
                        }
                    }

                    async function cleanEmptyFolders(folder: string) {
                        const items = await fs.readdir(folder, { withFileTypes: true });
                        let isEmpty = true;
                        
                        for (const item of items) {
                            const fullPath = path.join(folder, item.name);
                            if (item.isDirectory()) {
                                const isSubEmpty = await cleanEmptyFolders(fullPath);
                                if (!isSubEmpty) {
                                    isEmpty = false;
                                }
                            } else {
                                isEmpty = false;
                            }
                        }
                        
                        if (isEmpty && folder !== watchedDir) {
                            await fs.rmdir(folder).catch(() => {});
                        }
                        return isEmpty;
                    }
                    
                    await cleanEmptyFolders(watchedDir);

                    if (successCount > 0 || unmatchedCount > 0) {
                        if (syncedSeriesIds.size > 0) {
                            await omnibusQueue.add('METADATA_SYNC', { 
                                type: 'METADATA_SYNC', 
                                seriesIds: Array.from(syncedSeriesIds) 
                            }, { 
                                jobId: `METADATA_SYNC_WATCHED_${Date.now()}` 
                            });
                        }

                        await prisma.jobLog.create({
                            data: { 
                                jobType: 'WATCHED_FOLDER_SYNC', 
                                status: 'COMPLETED', 
                                durationMs: Date.now() - startTime, 
                                message: `Processed watched folder. Imported: ${successCount}. Moved to unmatched: ${unmatchedCount}.` 
                            }
                        });
                    }
                    break;
                }
                
                case 'LIBRARY_SCAN': {
                    const { specificPath } = job.data || {};
                    await prisma.systemSetting.upsert({ 
                        where: { key: 'last_library_sync' }, 
                        update: { value: nowStr }, 
                        create: { key: 'last_library_sync', value: nowStr } 
                    });
                    
                    const { LibraryScanner } = await import('@/lib/library-scanner');
                    await LibraryScanner.scan(specificPath);
                    
                    const lastStorageRun = await prisma.systemSetting.findUnique({ 
                        where: { key: 'storage_deep_dive_last_run' } 
                    });
                    
                    const lastRunTime = parseInt(lastStorageRun?.value || "0");
                    const hoursSinceLastRun = (Date.now() - lastRunTime) / (1000 * 60 * 60);

                    let processedCount = 0;
                    let storageMessage = "Skipped heavy storage scan (calculated recently).";

                    if (hoursSinceLastRun >= 24) {
                        processedCount = await runStorageScan();
                        storageMessage = `Storage calculation completed for ${processedCount} series.`;
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
                    
                    const { syncSeriesMetadata } = await import('@/lib/metadata-fetcher');
                    let seriesToSync: any[] = [];
                    
                    if (isTargeted) {
                        seriesToSync = await prisma.series.findMany({ 
                            where: { id: { in: job.data.seriesIds }, metadataId: { not: null } } 
                        });
                    } else {
                        seriesToSync = await prisma.series.findMany({ 
                            where: { metadataId: { not: null } }, 
                            orderBy: { updatedAt: 'asc' }, 
                            take: 15 
                        });
                    }

                    let successCount = 0;
                    let failCount = 0;
                    let details = isTargeted
                        ? `Started Targeted Metadata Sync for ${seriesToSync.length} newly imported series.\n\n`
                        : `Started Background Metadata Sync for ${seriesToSync.length} series (Chunked to prevent API bans).\n\n`;

                    for (const series of seriesToSync) {
                        try {
                            if (!series.metadataId) continue;
                            Logger.log(`[Metadata Sync Debug] Syncing metadata for series: "${series.name}" (${series.metadataSource} ID: ${series.metadataId})`, 'debug');
                            await syncSeriesMetadata(series.metadataId, series.folderPath, series.metadataSource);
                            
                            await prisma.series.update({ 
                                where: { id: series.id }, 
                                data: { updatedAt: new Date() } 
                            });
                            
                            successCount++;
                            details += `[OK] Synced: ${series.name}\n`;
                            await new Promise(r => setTimeout(r, 4000));
                        } catch (e: any) {
                            failCount++;
                            details += `[FAIL] ${series.name} - ${e.message}\n`;
                            
                            await prisma.series.update({ 
                                where: { id: series.id }, 
                                data: { updatedAt: new Date() } 
                            });

                            // --- NEW: Catch the fatal limit and stop the job ---
                            if (e.message === 'FATAL_RATE_LIMIT' || e.message.includes('429')) {
                                details += `\n[HALTED] API rate limit exhausted. Pausing background job to prevent IP ban.\n`;
                                Logger.log(`[Metadata Sync] Halted batch due to rate limits to protect IP.`, 'warn');
                                break; 
                            }
                            
                            await new Promise(r => setTimeout(r, 4000));
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
                    
                    SystemNotifier.sendAlert('job_metadata_sync', { description: `Metadata Sync Finished. Success: ${successCount} | Failed: ${failCount}` }).catch(() => {});
                    break;
                }

                case 'EMBED_METADATA': {
                    await prisma.systemSetting.upsert({
                        where: { key: 'last_embed_sync' },
                        update: { value: nowStr },
                        create: { key: 'last_embed_sync', value: nowStr }
                    });

                    const { writeComicInfo } = await import('@/lib/metadata-writer');
                    const whereClause: any = { filePath: { endsWith: '.cbz' } };

                    if (job.data.seriesId) {
                        whereClause.seriesId = job.data.seriesId;
                    } else if (job.data.issueIds && Array.isArray(job.data.issueIds)) {
                        whereClause.id = { in: job.data.issueIds };
                    } else {
                        whereClause.series = { metadataSource: { in: ['COMICVINE', 'METRON'] } };
                    }

                    const issues = await prisma.issue.findMany({ where: whereClause });

                    let successCount = 0;
                    let failCount = 0;

                    for (const issue of issues) {
                        const success = await writeComicInfo(issue.id);
                        if (success) {
                            successCount++;
                        } else {
                            failCount++;
                        }
                        await new Promise(r => setTimeout(r, 1000));
                    }

                    await prisma.jobLog.create({
                        data: {
                            jobType: 'EMBED_METADATA',
                            status: failCount > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
                            durationMs: Date.now() - startTime,
                            message: `Metadata embedding complete. Updated ${successCount} files. Failed: ${failCount}.`
                        }
                    });

                    // Chain the (now separate) series.json export for the same series scope
                    const exportSetting = await prisma.systemSetting.findUnique({ where: { key: 'export_series_json' } });
                    if (exportSetting?.value === 'true') {
                        const uniqueSeriesIds = Array.from(new Set(issues.map(i => i.seriesId)));
                        if (uniqueSeriesIds.length > 0) {
                            await omnibusQueue.add('EXPORT_SERIES_JSON', {
                                type: 'EXPORT_SERIES_JSON',
                                seriesIds: uniqueSeriesIds
                            }, {
                                jobId: `EXPORT_SJSON_CHAIN_${Date.now()}`,
                                removeOnComplete: true,
                                removeOnFail: true
                            });
                        }
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

                    const { writeSeriesJson } = await import('@/lib/metadata-writer');
                    const seriesWhere: any = { metadataSource: { in: ['COMICVINE', 'METRON'] } };

                    if (job.data.seriesId) {
                        seriesWhere.id = job.data.seriesId;
                    } else if (job.data.seriesIds && Array.isArray(job.data.seriesIds)) {
                        seriesWhere.id = { in: job.data.seriesIds };
                    }

                    const seriesList = await prisma.series.findMany({ where: seriesWhere, select: { id: true } });

                    let exportedCount = 0;
                    for (const s of seriesList) {
                        const wroteJson = await writeSeriesJson(s.id);
                        if (wroteJson) exportedCount++;
                    }

                    await prisma.jobLog.create({
                        data: {
                            jobType: 'EXPORT_SERIES_JSON',
                            status: 'COMPLETED',
                            durationMs: Date.now() - startTime,
                            message: `series.json export complete. Wrote ${exportedCount} of ${seriesList.length} series folders.`
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
                    let skeletonsCreated = 0;
                    let newRequestsFound = 0;
                    let unreleasedUpgraded = 0;

                    const allRequests = await prisma.request.findMany();
                    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
                    const localSeriesList = await prisma.series.findMany({ include: { issues: true } });
                    const normalize = (str?: string | null) => str ? str.toLowerCase().replace(/[^a-z0-9]/g, '') : '';

                    const metronUser = await prisma.systemSetting.findUnique({ where: { key: 'metron_user' } });
                    const metronPass = await prisma.systemSetting.findUnique({ where: { key: 'metron_pass' } });
                    
                    if (metronUser?.value && metronPass?.value) {
                        const todayObj = new Date();
                        const pastStr = new Date(todayObj.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                        const futureStr = new Date(todayObj.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                        
                        try {
                            let nextUrl = `https://metron.cloud/api/issue/?store_date_range_after=${pastStr}&store_date_range_before=${futureStr}`;
                            const metronIssues: any[] = [];
                            
                            while (nextUrl && metronIssues.length < 3000) {
                                try {
                                    const res = await axios.get(nextUrl, {
                                        auth: { username: metronUser.value, password: metronPass.value },
                                        headers: { 'User-Agent': 'Omnibus/1.0' },
                                        timeout: 15000,
                                        validateStatus: (status) => status < 500
                                    });
                                    
                                    if (res.status === 429) {
                                        const retryAfter = parseInt(res.headers['retry-after'] || '60', 10);
                                        await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
                                        continue;
                                    }
                                    
                                    if (res.data && res.data.results) {
                                        metronIssues.push(...res.data.results);
                                    }
                                    
                                    nextUrl = res.data.next;
                                    
                                    const remaining = parseInt(res.headers['x-ratelimit-burst-remaining'] || '20', 10);
                                    if (remaining <= 2) {
                                        const reset = parseInt(res.headers['x-ratelimit-burst-reset'] || '0', 10);
                                        if (reset > 0) {
                                            const sleepMs = Math.max(0, (reset * 1000) - Date.now()) + 500;
                                            if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));
                                        } else {
                                            await new Promise(r => setTimeout(r, 2000));
                                        }
                                    } else if (nextUrl) {
                                        await new Promise(r => setTimeout(r, 500));
                                    }
                                } catch (axiosErr: any) { 
                                    throw axiosErr; 
                                }
                            }
                            
                            details += `[Phase 1] Metron Oracle fetched ${metronIssues.length} global upcoming releases.\n`;
                            
                            for (const mIssue of metronIssues) {
                                const mSeriesId = mIssue.series?.id?.toString(); 
                                const mSeriesName = normalize(mIssue.series?.name);
                                const mPubName = normalize(mIssue.publisher?.name || mIssue.series?.publisher?.name);
                                const mNumStr = mIssue.number || mIssue.issue;
                                const mNum = parseFloat(mNumStr);

                                if (isNaN(mNum)) continue;
                                let matchedSeries = null;

                                if (mSeriesId) {
                                    matchedSeries = localSeriesList.find((s: any) => s.metadataSource === 'METRON' && s.metadataId === mSeriesId);
                                }
                                
                                if (!matchedSeries && mSeriesName) {
                                    matchedSeries = localSeriesList.find((s: any) => normalize(s.name) === mSeriesName && (mPubName ? normalize(s.publisher) === mPubName : true));
                                }
                                
                                if (matchedSeries) {
                                    Logger.log(`[Series Monitor Debug] Upcoming Metron issue "${mIssue.name || mNumStr}" matched to local series "${matchedSeries.name}"`, 'debug');
                                    const issueDate = mIssue.store_date || mIssue.cover_date || null;
                                    const searchName = `${matchedSeries.name} #${mNumStr}`;
                                    const isReleased = isReleasedYet(mIssue.store_date, mIssue.cover_date);
                                    
                                    let skeleton = matchedSeries.issues.find((i: any) => parseFloat(i.number) === mNum);
                                    if (!skeleton) {
                                        skeleton = await prisma.issue.create({
                                            data: {
                                                seriesId: matchedSeries.id, 
                                                metadataId: mIssue.id.toString(), 
                                                metadataSource: 'METRON',
                                                matchState: 'MATCHED', 
                                                number: mNumStr.toString(), 
                                                name: mIssue.name || mIssue.issue_name,
                                                description: mIssue.desc || mIssue.description || null, 
                                                releaseDate: issueDate,
                                                coverUrl: mIssue.image || null, 
                                                status: 'WANTED'
                                            }
                                        }).catch(() => null) as any;
                                        
                                        if (skeleton) { 
                                            matchedSeries.issues.push(skeleton); 
                                            skeletonsCreated++; 
                                        }
                                    } else if (skeleton.releaseDate !== issueDate && issueDate) {
                                         await prisma.issue.update({ 
                                             where: { id: skeleton.id }, 
                                             data: { releaseDate: issueDate } 
                                         }).catch(() => {});
                                         skeleton.releaseDate = issueDate;
                                    }

                                    if (matchedSeries.monitored) {
                                        const alreadyInLibrary = matchedSeries.issues.some((i: any) => isSameIssue(i.number, mNumStr) && i.filePath && i.filePath.length > 0);
                                        if (alreadyInLibrary) {
                                            Logger.log(`[Series Monitor Debug] Issue ${mNumStr} is already downloaded in library. Skipping request.`, 'debug');
                                            continue;
                                        }

                                        const alreadyReq = allRequests.find(r => {
                                            if (r.volumeId !== (matchedSeries.metadataId || matchedSeries.id)) return false;
                                            const match = r.activeDownloadName?.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?[a-zA-Z]?)/i);
                                            const reqNum = match ? match[1] : null;
                                            return reqNum ? isSameIssue(reqNum, mNumStr) : false;
                                        });
                                        
                                        const issueYear = issueDate ? issueDate.split('-')[0] : matchedSeries.year?.toString() || new Date().getFullYear().toString();

                                        if (alreadyReq) {
                                            if (alreadyReq.status === 'UNRELEASED' && isReleased) {
                                                details += `[UPGRADE] ${searchName} released. Triggering search...\n`;
                                                await prisma.request.update({ where: { id: alreadyReq.id }, data: { status: 'PENDING' } });
                                                searchAndDownload(alreadyReq.id, searchName, issueYear, matchedSeries.publisher || "Unknown", matchedSeries.isManga).catch(() => {});
                                                unreleasedUpgraded++;
                                                alreadyReq.status = 'PENDING';
                                            }
                                        } else {
                                            const issueStatus = isReleased ? 'PENDING' : 'UNRELEASED';
                                            details += `[NEW] Queued ${issueStatus}: ${searchName}\n`;
                                            
                                            const newReq = await prisma.request.create({
                                                data: {
                                                    userId: admin?.id || 'system', 
                                                    volumeId: matchedSeries.metadataId || matchedSeries.id,
                                                    metadataSource: matchedSeries.metadataSource,
                                                    status: issueStatus,
                                                    activeDownloadName: searchName, 
                                                    imageUrl: mIssue.image || matchedSeries.coverUrl
                                                }
                                            });
                                            allRequests.push(newReq);
                                            
                                            if (isReleased) {
                                                searchAndDownload(newReq.id, searchName, issueYear, matchedSeries.publisher || "Unknown", matchedSeries.isManga).catch(() => {});
                                                newRequestsFound++;
                                            }
                                        }
                                    }
                                }
                            }
                        } catch (e: any) { 
                            details += `[Phase 1] Metron Oracle failed: ${e.message}\n`; 
                        }
                    }

                    const cvKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
                    const cvApiKey = cvKeySetting?.value;

                    if (cvApiKey) {
                        const cvSeriesToScan = await prisma.series.findMany({
                            where: { monitored: true, metadataSource: 'COMICVINE' },
                            orderBy: { updatedAt: 'asc' }, 
                            take: 25, 
                            include: { issues: true }
                        });

                        for (const seriesRecord of cvSeriesToScan) {
                            const cvId = seriesRecord.metadataId;
                            if (!cvId) continue;
                            
                            try {
                                const cvRes = await axios.get(`https://comicvine.gamespot.com/api/issues/`, {
                                    params: { 
                                        api_key: cvApiKey, 
                                        format: 'json', 
                                        filter: `volume:${cvId}`, 
                                        sort: 'issue_number:desc', 
                                        limit: 30, 
                                        field_list: 'id,name,issue_number,cover_date,store_date,image,deck,description' 
                                    },
                                    headers: { 'User-Agent': 'Omnibus/1.0' }, 
                                    timeout: 10000
                                });
                                
                                const cvIssues = cvRes.data.results || [];
                                
                                for (const cvIssue of cvIssues) {
                                    const cvNumStr = cvIssue.issue_number?.toString();
                                    if (!cvNumStr) continue;
                                    Logger.log(`[Series Monitor Debug] Evaluating ComicVine issue #${cvNumStr} for series "${seriesRecord.name}"`, 'debug');
                                    const alreadyInLibrary = seriesRecord.issues.some((i: any) => isSameIssue(i.number, cvNumStr) && i.filePath && i.filePath.length > 0);
                                    const searchName = `${seriesRecord.name} #${cvIssue.issue_number}`;
                                    
                                    const alreadyReq = allRequests.find(r => {
                                        if (r.volumeId !== seriesRecord.metadataId) return false;
                                        const match = r.activeDownloadName?.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?[a-zA-Z]?)/i);
                                        const reqNum = match ? match[1] : null;
                                        return reqNum ? isSameIssue(reqNum, cvNumStr) : false;
                                    });

                                    let issueDate = cvIssue.store_date || cvIssue.cover_date || null;
                                    if (issueDate) {
                                        if (issueDate.length === 4) issueDate += "-01-01";
                                        else if (issueDate.length === 7) issueDate += "-28"; 
                                    }

                                    const isReleased = isReleasedYet(cvIssue.store_date, cvIssue.cover_date);
                                    const issueYear = issueDate ? issueDate.split('-')[0] : seriesRecord.year?.toString() || new Date().getFullYear().toString();

                                    if (!alreadyInLibrary) {
                                        const existingSkeleton = seriesRecord.issues.find((i: any) => isSameIssue(i.number, cvNumStr));
                                        if (!existingSkeleton) {
                                            await prisma.issue.create({
                                                data: {
                                                    seriesId: seriesRecord.id, 
                                                    metadataId: cvIssue.id.toString(), 
                                                    metadataSource: 'COMICVINE', 
                                                    matchState: 'MATCHED',
                                                    number: cvIssue.issue_number?.toString() || "0", 
                                                    name: cvIssue.name, 
                                                    description: cvIssue.description || cvIssue.deck || null,
                                                    releaseDate: issueDate, 
                                                    coverUrl: cvIssue.image?.medium_url || cvIssue.image?.small_url || null, 
                                                    status: 'WANTED'
                                                }
                                            }).catch(() => {});
                                            skeletonsCreated++;
                                        } else if (existingSkeleton.releaseDate !== issueDate && issueDate) {
                                            await prisma.issue.update({ 
                                                where: { id: existingSkeleton.id }, 
                                                data: { releaseDate: issueDate } 
                                            }).catch(() => {});
                                        }
                                    }

                                    if (alreadyInLibrary) continue;

                                    if (alreadyReq) {
                                        if (alreadyReq.status === 'UNRELEASED' && isReleased) {
                                            details += `[UPGRADE] CV: ${searchName} is now released.\n`;
                                            await prisma.request.update({ where: { id: alreadyReq.id }, data: { status: 'PENDING' } });
                                            searchAndDownload(alreadyReq.id, searchName, issueYear, seriesRecord.publisher || "Unknown", seriesRecord.isManga).catch(() => {});
                                            unreleasedUpgraded++;
                                            alreadyReq.status = 'PENDING';
                                        }
                                        continue; 
                                    }

                                    const issueStatus = isReleased ? 'PENDING' : 'UNRELEASED';
                                    
                                    const newReq = await prisma.request.create({
                                        data: {
                                            userId: admin?.id || 'system', 
                                            volumeId: cvId.toString(),
                                            metadataSource: seriesRecord.metadataSource,
                                            status: issueStatus,
                                            activeDownloadName: searchName, 
                                            imageUrl: cvIssue.image?.medium_url || seriesRecord.coverUrl
                                        }
                                    });

                                    allRequests.push(newReq); 

                                    if (isReleased) {
                                        searchAndDownload(newReq.id, searchName, issueYear, seriesRecord.publisher || "Unknown", seriesRecord.isManga).catch(() => {});
                                        newRequestsFound++;
                                    }
                                }
                                
                                await prisma.series.update({ 
                                    where: { id: seriesRecord.id }, 
                                    data: { updatedAt: new Date() } 
                                }).catch(()=>{});
                                
                                await new Promise(r => setTimeout(r, 2000));
                            } catch (err: any) {}
                        }
                    }

                    const unreleasedRequests = allRequests.filter(r => r.status === 'UNRELEASED');
                    for (const req of unreleasedRequests) {
                        // Remove the inline `const extractNum = (str: string) => { ... }` block entirely
                        // and replace the reqNum assignment with the unified utility:
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
                    await prisma.systemSetting.upsert({ 
                        where: { key: 'last_diagnostics_sync' }, 
                        update: { value: nowStr }, 
                        create: { key: 'last_diagnostics_sync', value: nowStr } 
                    });
                    
                    let details = "Diagnostics Scan Started.\n\n";
                    let issuesFound = 0;
                    
                    const series = await prisma.series.findMany();
                    const ghosts = series.filter(s => !s.folderPath || !fs.existsSync(s.folderPath));
                    
                    if (ghosts.length > 0) {
                        details += `[WARNING] Found ${ghosts.length} ghost series records.\n`;
                        issuesFound += ghosts.length;
                    }

                    const libraries = await prisma.library.findMany();
                    let drivesOnline = true;
                    
                    for (const lib of libraries) {
                        if (!fs.existsSync(lib.path)) { 
                            drivesOnline = false; 
                            details += `[CRITICAL] Drive disconnected: ${lib.path}. Skipping Ghost Issue scan.\n`; 
                        }
                    }

                    if (drivesOnline) {
                        const allIssues = await prisma.issue.findMany({ where: { filePath: { not: null } } });
                        let ghostIssueCount = 0;
                        for (const issue of allIssues) {
                            if (issue.filePath && !fs.existsSync(issue.filePath)) {
                                try {
                                    if (issue.metadataId && !issue.metadataId.startsWith('unmatched')) {
                                        await prisma.issue.update({ 
                                            where: { id: issue.id }, 
                                            data: { filePath: null, status: 'WANTED' } 
                                        });
                                    } else {
                                        await prisma.readProgress.deleteMany({ where: { issueId: issue.id } }).catch(()=>({}));
                                        await prisma.issue.delete({ where: { id: issue.id } });
                                    }
                                    ghostIssueCount++;
                                } catch (delErr: any) {}
                            }
                        }
                        
                        if (ghostIssueCount > 0) { 
                            details += `[WARNING] Found and repaired ${ghostIssueCount} ghost issue files.\n`; 
                            issuesFound += ghostIssueCount; 
                        }
                    }

                    if (issuesFound === 0 && drivesOnline) {
                        details += "Library is in perfect health. 100% Integrity.\n";
                    }

                    await prisma.jobLog.create({ 
                        data: { 
                            jobType: 'DIAGNOSTICS', 
                            status: issuesFound > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED', 
                            durationMs: Date.now() - startTime, 
                            message: details 
                        } 
                    });
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
                    const processedCount = await runStorageScan();
                    Logger.log(`[Background Job] Storage Scan Complete. Processed ${processedCount} series.`, "success");
                    break;
                }

                case 'DISCOVER_SYNC': {
                    const startTime = Date.now();
                    await prisma.systemSetting.upsert({ 
                        where: { key: 'last_popular_sync' }, 
                        update: { value: nowStr }, 
                        create: { key: 'last_popular_sync', value: nowStr } 
                    });
    
                    const allSettings = await prisma.systemSetting.findMany();
                    const config = Object.fromEntries(allSettings.map(s => [s.key, s.value]));
    
                    const primarySource = config.primary_metadata_source || 'COMICVINE';
                    const CV_API_KEY = config.cv_api_key || process.env.CV_API_KEY;

                    if (!CV_API_KEY) throw new Error("Missing ComicVine API Key");

                    const filterEnabled = config.filter_enabled === "true";
                    const blockedPublishers = config.filter_publishers ? config.filter_publishers.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean) : [];
                    const blockedKeywords = config.filter_keywords ? config.filter_keywords.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean) : [];

                    const mangaFilterMode = config.discover_manga_filter_mode || "SHOW_ALL";
                    const allowedMangaPubs = config.discover_manga_allowed_publishers ? config.discover_manga_allowed_publishers.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean) : [];
                    
                    const DEFAULT_MANGA_PUBLISHERS = ["viz media", "kodansha", "yen press", "seven seas", "shueisha", "shogakukan", "tokyopop", "dark horse manga", "vertical", "ghost ship", "denpa", "fakku", "j-novel club", "sublime", "kuma", "ize press", "square enix", "hakusensha", "lezhin", "suiseisha", "nihon bungeisha", "takeshobo", "futabasha", "kadokawa", "akita shoten"];
                    const mangaPublishersList = config.manga_publishers ? config.manga_publishers.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean) : DEFAULT_MANGA_PUBLISHERS;

                    const isValid = (item: any) => {
                            const pubName = (item.volume?.publisher?.name || '').toLowerCase().trim();
                            const volName = (item.volume?.name || '').toLowerCase().trim();
                            const concepts = item.volume?.concepts || [];
                            if (filterEnabled) {
                                if (blockedPublishers.length > 0 && blockedPublishers.some((bp: string) => containsWord(pubName, bp))) {
                                    Logger.log(`[Discover Sync Debug] Filtered out "${volName}" due to blocked publisher: ${pubName}`, 'debug');
                                    return false;
                                }
                                if (blockedKeywords.length > 0 && blockedKeywords.some((bk: string) => containsWord(volName, bk))) {
                                    Logger.log(`[Discover Sync Debug] Filtered out "${volName}" due to blocked keyword`, 'debug');
                                    return false;
                                }
                            }

                        const isMangaPublisher = mangaPublishersList.some((mp: string) => pubName.includes(mp));
                        const hasMangaConcept = concepts.some((c: any) => ['manga', 'shonen', 'seinen', 'shojo', 'josei', 'manhwa', 'manhua', 'webtoon'].includes((c.name || '').toLowerCase()));
                        
                        const isManga = isMangaPublisher || hasMangaConcept;
                        
                        if (isManga) {
                            if (mangaFilterMode === "HIDE_ALL") return false;
                            if (mangaFilterMode === "ALLOWED_ONLY") {
                                const isAllowed = allowedMangaPubs.length > 0 && allowedMangaPubs.some((amp: string) => pubName.includes(amp) || volName.includes(amp));
                                if (!isAllowed) return false;
                            }
                        }
                        return true;
                    };

                    if (primarySource === 'METRON') {
                        const metronUser = config.metron_user;
                        const metronPass = config.metron_pass;
                        if (!metronUser || !metronPass) throw new Error("Metron credentials missing for Discover Sync");

                        const auth = { username: metronUser, password: metronPass };
        
                        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                        let nextUrl: string | null = `https://metron.cloud/api/issue/?store_date_range_after=${thirtyDaysAgo}`;
                        const metronNewReleases: any[] = [];
                        
                        const seriesNameCache = new Map<string, number>();
        
                        while (nextUrl && metronNewReleases.length < 50) {
                            const res: any = await axios.get(nextUrl, { auth, headers: { 'User-Agent': 'Omnibus/1.0' } });
            
                            for (const item of (res.data.results || [])) {
                                let parsedSeriesId: number | null = null;
                                if (item.series && typeof item.series === 'object') {
                                    parsedSeriesId = parseInt(item.series.id);
                                } else if (item.series_id) {
                                    parsedSeriesId = parseInt(item.series_id);
                                }

                                const seriesName = typeof item.series === 'string' ? item.series : (item.series?.name || null);

                                if ((!parsedSeriesId || isNaN(parsedSeriesId)) && seriesName) {
                                    const cleanName = seriesName.replace(/\(\d{4}\)/g, '').trim();
                                    
                                    if (seriesNameCache.has(cleanName)) {
                                        parsedSeriesId = seriesNameCache.get(cleanName) || null;
                                    } else {
                                        try {
                                            const searchRes = await axios.get(`https://metron.cloud/api/series/?name=${encodeURIComponent(cleanName)}`, { 
                                                auth, 
                                                headers: { 'User-Agent': 'Omnibus/1.0' }, 
                                                validateStatus: () => true 
                                            });
                                            
                                            // Ensure we only retry safely
                                            if (searchRes.status === 429) {
                                                await new Promise(r => setTimeout(r, 2000));
                                            } else if (searchRes.status === 200 && searchRes.data?.results?.length > 0) {
                                                const exact = searchRes.data.results.find((s: any) => (s.name || s.series)?.toLowerCase() === cleanName.toLowerCase());
                                                parsedSeriesId = exact ? parseInt(exact.id) : parseInt(searchRes.data.results[0].id);
                                                seriesNameCache.set(cleanName, parsedSeriesId as number);
                                            } else {
                                                // Cache the 'Miss' so we don't spam the API 50 times for a bad string
                                                seriesNameCache.set(cleanName, 0);
                                            }
                                        } catch(e) {}
                                        
                                        await new Promise(r => setTimeout(r, 600)); 
                                    }
                                }

                                const formatted = {
                                    id: item.id,
                                    volumeId: parsedSeriesId || 0,
                                    issueNumber: item.number || '1', 
                                    isReleased: isReleasedYet(item.store_date, item.cover_date), 
                                    name: `${seriesName || 'Unknown'} #${item.number || '1'}`,
                                    year: item.store_date ? item.store_date.split('-')[0] : '????',
                                    publisher: item.publisher?.name || item.series?.publisher?.name || "Metron",
                                    image: item.image,
                                    description: item.desc || "No description available.",
                                    siteUrl: `https://metron.cloud/issue/${item.id}/`,
                                    metadataSource: 'METRON'
                                };
                                metronNewReleases.push(formatted);
                            }
                            nextUrl = res.data.next;
                            await new Promise(r => setTimeout(r, 1000));
                        }

                        await prisma.$transaction([
                            prisma.systemSetting.upsert({ 
                                where: { key: 'discover_cache_new' }, 
                                update: { value: JSON.stringify(metronNewReleases) }, 
                                create: { key: 'discover_cache_new', value: JSON.stringify(metronNewReleases) } 
                            }),
                            prisma.systemSetting.upsert({ 
                                where: { key: 'discover_cache_popular' }, 
                                update: { value: JSON.stringify([]) }, 
                                create: { key: 'discover_cache_popular', value: JSON.stringify([]) } 
                            }),
                        ]);

                    } else {
                    
                        const formatItem = (item: any) => {
                            let desc = item.deck;
                            if (!desc && item.description) {
                               desc = item.description.replace(/(<([^>]+)>)/gi, '');
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
                              id: item.id, 
                              volumeId: item.volume.id, 
                              name: `${item.volume.name} #${item.issue_number}`,
                              issueNumber: item.issue_number, 
                              isReleased: isReleasedYet(item.store_date, item.cover_date), 
                              year: dateStr ? dateStr.split('-')[0] : '????', 
                              publisher: item.volume?.publisher?.name || null,
                              image: item.image?.medium_url, 
                              description: desc || "No description available.", 
                              siteUrl: item.site_detail_url,
                              writers: [...new Set(writers)].slice(0, 3), 
                              artists: [...new Set(artists)].slice(0, 3), 
                              coverArtists: [...new Set(coverArtists)].slice(0, 3),
                              metadataSource: 'COMICVINE'
                            };
                        };

                        const fetchCategory = async (sort: string) => {
                            const validItems: any[] = [];
                            let offset = 0;
                            let apiCallsMade = 0;

                            while (validItems.length < 112 && apiCallsMade < 15) { 
                                const response = await axios.get(`https://comicvine.gamespot.com/api/issues/`, {
                                    params: {
                                        api_key: CV_API_KEY, format: 'json', limit: 100, offset: offset, sort: sort,
                                        field_list: 'id,name,issue_number,store_date,cover_date,image,deck,description,volume,person_credits,site_detail_url'
                                    },
                                    headers: { 'User-Agent': 'Omnibus/1.0' }
                                });
                                apiCallsMade++;

                                const items = response.data.results || [];
                                if (items.length === 0) break;
                                offset += 100;

                                const volIds = [...new Set(items.map((i: any) => i.volume?.id).filter(Boolean))];
                                const volumesMap: Record<number, any> = {};

                                if (volIds.length > 0) {
                                    try {
                                        const chunkedIds = [];
                                        for (let i = 0; i < volIds.length; i += 50) chunkedIds.push(volIds.slice(i, i + 50));

                                        for (const chunk of chunkedIds) {
                                            const volIdString = chunk.join('|');
                                            const volResponse = await axios.get(`https://comicvine.gamespot.com/api/volumes/`, {
                                                params: { api_key: CV_API_KEY, format: 'json', filter: `id:${volIdString}`, field_list: 'id,publisher,concepts' },
                                                headers: { 'User-Agent': 'Omnibus/1.0' }
                                            });
                                            apiCallsMade++;
                                            
                                            if (volResponse.data?.results) {
                                                const resultsArray = Array.isArray(volResponse.data.results) ? volResponse.data.results : [volResponse.data.results];
                                                resultsArray.forEach((v: any) => volumesMap[v.id] = v);
                                            }
                                            await new Promise(r => setTimeout(r, 500)); 
                                        }
                                    } catch (err) {}
                                }

                                for (const item of items) {
                                    if (item.volume && volumesMap[item.volume.id]) {
                                        item.volume.publisher = volumesMap[item.volume.id].publisher;
                                        item.volume.concepts = volumesMap[item.volume.id].concepts;
                                    }
                                    if (isValid(item)) validItems.push(formatItem(item));
                                    if (validItems.length === 112) break;
                                }
                                await new Promise(r => setTimeout(r, 1000));
                            }
                            return validItems;
                        };

                        const [newReleases, popular] = await Promise.all([ 
                            fetchCategory('store_date:desc'), 
                            fetchCategory('cover_date:desc') 
                        ]);

                        await prisma.$transaction([
                            prisma.systemSetting.upsert({ 
                                where: { key: 'discover_cache_new' }, 
                                update: { value: JSON.stringify(newReleases) }, 
                                create: { key: 'discover_cache_new', value: JSON.stringify(newReleases) } 
                            }),
                            prisma.systemSetting.upsert({ 
                                where: { key: 'discover_cache_popular' }, 
                                update: { value: JSON.stringify(popular) }, 
                                create: { key: 'discover_cache_popular', value: JSON.stringify(popular) } 
                            }),
                        ]);

                    }

                    await prisma.jobLog.create({
                        data: { 
                            jobType: 'DISCOVER_SYNC', 
                            status: 'COMPLETED', 
                            durationMs: Date.now() - startTime, 
                            message: `Successfully rebuilt the Discover cache (New & Popular). Filter enabled: ${filterEnabled}. Manga Mode: ${mangaFilterMode}` 
                        }
                    });
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
                                // One INSERT for all rows so a mid-loop failure can't persist a partial set
                                // and re-email the unrecorded issues on the next run (duplicate digest).
                                await prisma.digestHistory.createMany({ data: recordsToSave });
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