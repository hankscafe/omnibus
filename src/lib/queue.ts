// src/lib/queue.ts
import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from './db';
import { Logger } from './logger';
import { SystemNotifier } from './notifications'; 
import { Mailer } from './mailer';
import crypto from 'crypto';
// import axios from 'axios';
import { apiClient as axios } from '@/lib/api-client';
import fs from 'fs-extra';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isReleasedYet } from '@/lib/utils';
import { searchAndDownload } from '@/lib/automation';
import packageJson from '../../package.json';
import { getErrorMessage } from '@/lib/utils/error';

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
        } else { return !lIsNum; }
    }
    return false;
}

async function getFolderSize(folderPath: string): Promise<number> {
    try {
        if (!folderPath || !fs.existsSync(folderPath)) return 0;
        if (process.platform !== 'win32') {
            try {
                const { stdout } = await execFileAsync('du', ['-sb', folderPath]);
                const match = stdout.match(/^(\d+)/);
                if (match) return parseInt(match[1], 10);
            } catch (duError) {}
        }
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
    for (const s of seriesList) {
        const size = s.folderPath ? await getFolderSize(s.folderPath) : 0;
        await prisma.series.update({ where: { id: s.id }, data: { size } }).catch(() => {});
        storageData.push({
            id: s.id, name: s.name, publisher: s.publisher || "Unknown",
            isManga: s.isManga, issueCount: s._count.issues,
            path: s.folderPath, sizeBytes: size
        });
    }

    storageData.sort((a, b) => b.sizeBytes - a.sizeBytes);

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
                    'diagnostics_sync_schedule', 'backup_sync_schedule', 'popular_sync_schedule',
                    'weekly_digest_schedule', 'cbr_conversion_schedule', 'embed_metadata_schedule',
                    'cache_cleanup_schedule'
                ]
            }
        }
    });
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

    const repeatableJobs = await omnibusQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
        await omnibusQueue.removeRepeatableByKey(job.key);
    }

    const addJob = async (jobType: string, hoursStr: string | undefined) => {
        // --- CHANGED: Use parseFloat instead of parseInt to support sub-hour intervals ---
        const hours = parseFloat(hoursStr || '0');
        if (hours > 0) {
            await omnibusQueue.add(jobType, { type: jobType }, {
                // Math.round ensures we don't pass weird floating-point milliseconds to BullMQ
                repeat: { every: Math.round(hours * 60 * 60 * 1000) }, 
                jobId: `repeat_${jobType.toLowerCase()}`
            });
        }
    };

    await addJob('LIBRARY_SCAN', config.library_sync_schedule);
    await addJob('METADATA_SYNC', config.metadata_sync_schedule);
    await addJob('SERIES_MONITOR', config.monitor_sync_schedule);
    await addJob('DIAGNOSTICS', config.diagnostics_sync_schedule);
    await addJob('DATABASE_BACKUP', config.backup_sync_schedule);
    await addJob('DISCOVER_SYNC', config.popular_sync_schedule);
    await addJob('WEEKLY_DIGEST', config.weekly_digest_schedule);
    await addJob('CBR_CONVERSION', config.cbr_conversion_schedule);
    await addJob('EMBED_METADATA', config.embed_metadata_schedule);
    await addJob('CACHE_CLEANUP', config.cache_cleanup_schedule);

    await omnibusQueue.add('WATCHED_FOLDER_SYNC', { type: 'WATCHED_FOLDER_SYNC' }, { repeat: { every: 15 * 60 * 1000 }, jobId: 'repeat_watched_sync' });
    await omnibusQueue.add('SYSTEM_HEALTH_CHECK', { type: 'SYSTEM_HEALTH_CHECK' }, { repeat: { every: 15 * 60 * 1000 }, jobId: 'repeat_health_check' });
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
                case 'CACHE_CLEANUP': {
                    const startTime = Date.now();
                    await prisma.systemSetting.upsert({ where: { key: 'last_cache_cleanup' }, update: { value: nowStr }, create: { key: 'last_cache_cleanup', value: nowStr } });
                    
                    let deletedCount = 0;
                    try {
                        const oldCacheSettings = await prisma.systemSetting.findMany({
                            where: { key: { startsWith: 'cv_details_cache_' } }
                        });
                        
                        for (const cache of oldCacheSettings) {
                            try {
                                const parsed = JSON.parse(cache.value);
                                // If cache is older than 24 hours
                                if (Date.now() - parsed.timestamp > 24 * 60 * 60 * 1000) {
                                    await prisma.systemSetting.delete({ where: { key: cache.key } });
                                    deletedCount++;
                                }
                            } catch(e) {}
                        }
                    } catch (e) {}

                    // --- MAKE SURE THIS ELSE BLOCK IS PRESENT ---
                    if (deletedCount > 0) {
                        Logger.log(`[Cache Cleanup] Purged ${deletedCount} expired metadata entries.`, 'success');
                    } else {
                        Logger.log(`[Cache Cleanup] No expired metadata entries found to purge.`, 'info');
                    }

                    await prisma.jobLog.create({
                        data: {
                            jobType: 'CACHE_CLEANUP',
                            status: 'COMPLETED',
                            durationMs: Date.now() - startTime,
                            message: `Cache cleanup finished. Purged ${deletedCount} expired cache entries.`
                        }
                    });

                    SystemNotifier.sendAlert('job_cache_cleanup', { description: `Cache cleanup finished. Purged ${deletedCount} expired cache entries.` }).catch(() => {});
                    
                    break;
                }
                
                case 'DATABASE_BACKUP': {
                    await prisma.systemSetting.upsert({ where: { key: 'last_backup_sync' }, update: { value: nowStr }, create: { key: 'last_backup_sync', value: nowStr } });
                    
                    const algorithm = 'aes-256-cbc';
                    const secret = process.env.NEXTAUTH_SECRET || 'omnibus_default_encryption_key_!@#';
                    const key = crypto.createHash('sha256').update(String(secret)).digest();
                    const iv = crypto.randomBytes(16);
                    
                    const backupDir = process.env.OMNIBUS_BACKUPS_DIR || '/backups';
                    await fs.ensureDir(backupDir);
                    const fileName = `omnibus_backup_${Date.now()}.json`;
                    const filePath = path.join(backupDir, fileName);

                    const writeStream = fs.createWriteStream(filePath);
                    const cipher = crypto.createCipheriv(algorithm, key, iv);

                    writeStream.write(`{\n  "encrypted": true,\n  "version": "2.2",\n  "iv": "${iv.toString('hex')}",\n  "data": "`);
                    cipher.on('data', (chunk) => writeStream.write(chunk.toString('hex')));

                    const streamFinished = new Promise<void>((resolve, reject) => {
                        cipher.on('end', () => { writeStream.write(`"\n}`); writeStream.end(); });
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
                        if (!firstTable) cipher.write(',');
                        firstTable = false;
                        cipher.write(`"${table.name}":[`);
                        let skip = 0;
                        const take = 500;
                        let firstRow = true;
                        
                        while (true) {
                            // @ts-ignore
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
                        for (const file of toDelete) await fs.remove(path.join(backupDir, file));
                    }

                    await prisma.jobLog.create({ data: { jobType: 'DATABASE_BACKUP', status: 'COMPLETED', durationMs: Date.now() - startTime, message: `Backup saved successfully to ${filePath}. Retaining last 5 backups.` } });
                    SystemNotifier.sendAlert('job_db_backup', { description: `Backup saved successfully to ${fileName}.` }).catch(() => {});
                    break;
                }

                case 'SYSTEM_HEALTH_CHECK': {
                    const { runSystemHealthCheck } = await import('@/lib/health-checker');
                    await runSystemHealthCheck();
                    break;
                }

                case 'CBR_CONVERSION': {
                    await prisma.systemSetting.upsert({ where: { key: 'last_converter_sync' }, update: { value: nowStr }, create: { key: 'last_converter_sync', value: nowStr } });
                    const { convertCbrToCbz } = await import('@/lib/converter');
                    const cbrIssues = await prisma.issue.findMany({
                        where: { OR: [ { filePath: { endsWith: '.cbr' } }, { filePath: { endsWith: '.CBR' } }, { filePath: { endsWith: '.rar' } }, { filePath: { endsWith: '.RAR' } } ] }
                    });

                    if (cbrIssues.length === 0) {
                        await prisma.jobLog.create({ data: { jobType: 'CBR_CONVERTER', status: 'COMPLETED', durationMs: Date.now() - startTime, message: "No CBR files found to convert." } });
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
                            data: { jobType: 'REPACK_ARCHIVES', status: 'COMPLETED', durationMs: Date.now() - startTime, message: "No valid files found to repack." }
                        });
                        break;
                    }

                    let currentIdx = 0;
                    for (const issue of issues) {
                        if (issue.filePath) {
                            const ok = await repackArchive(issue.filePath);
                            if (ok) successCount++;
                            else failCount++;
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
                    const watchedDir = process.env.OMNIBUS_WATCHED_DIR || '/watched';
                    const unmatchedDir = process.env.OMNIBUS_AWAITING_MATCH_DIR || '/unmatched';

                    await fs.ensureDir(watchedDir);
                    await fs.ensureDir(unmatchedDir);

                    // --- NEW: RECURSIVE FILE SCANNER ---
                    const filesToProcess: string[] = [];
                    async function scanWatchedDir(currentPath: string) {
                        const items = await fs.readdir(currentPath, { withFileTypes: true });
                        for (const item of items) {
                            const fullPath = path.join(currentPath, item.name);
                            if (item.isDirectory()) {
                                await scanWatchedDir(fullPath);
                            } else {
                                const ext = path.extname(item.name).toLowerCase();
                                // --- FIX: Added .epub to ensure parity with importer.ts ---
                                if (['.cbz', '.cbr', '.zip', '.rar', '.epub'].includes(ext)) {
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
                        const file = path.basename(filePath); // Keep the file name handy for logs and unmatched moves
                        const ext = path.extname(filePath).toLowerCase();
                        // --- FIX: Added .epub check here as well ---
                        if (!['.cbz', '.cbr', '.zip', '.rar', '.epub'].includes(ext)) continue;

                        try {
                            if (ext === '.cbr' || ext === '.rar') {
                                const convertedPath = await convertCbrToCbz(filePath);
                                if (convertedPath) filePath = convertedPath;
                                else continue;
                            }

                            const meta = await parseComicInfo(filePath);

                            // We require a Series Name and ComicVine Volume ID to confidently auto-import
                            if (meta && meta.cvId && meta.series) {
                                const safePublisher = meta.publisher || "Other";
                                
                                // --- FIX 1: Check existing series to preserve isManga & libraryId ---
                                const existingSeries = await prisma.series.findUnique({
                                    where: { metadataSource_metadataId: { metadataSource: 'COMICVINE', metadataId: meta.cvId.toString() } }
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
                                if (!targetLib) targetLib = libraries[0];

                                const sanitize = (str: string) => str.replace(/[<>:"/\\|?*]/g, '').trim();
                                const safeSeries = sanitize(meta.series);
                                const safeYear = meta.year ? meta.year.toString() : "";
                                const safePub = sanitize(safePublisher);

                                let relFolderPath = folderPattern
                                    .replace(/{Publisher}/gi, safePub)
                                    .replace(/{Series}/gi, safeSeries)
                                    .replace(/{Year}/gi, safeYear)
                                    .replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '').replace(/\s+/g, ' ').trim();

                                const destFolder = path.join(targetLib.path, ...relFolderPath.split(/[/\\]/).map(p => p.trim()).filter(Boolean));
                                await fs.ensureDir(destFolder);

                                const extractedNum = meta.number || "1";
                                let formattedNum = extractedNum.includes('.') || extractedNum.length > 1 ? extractedNum : `0${extractedNum}`;
                                
                                const filePatToUse = isManga ? mangaFilePattern : filePattern;
                                const newFileName = filePatToUse
                                    .replace(/{Publisher}/gi, safePub)
                                    .replace(/{Series}/gi, safeSeries)
                                    .replace(/{Year}/gi, safeYear)
                                    .replace(/{Issue}/gi, formattedNum)
                                    .replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '').replace(/\s+/g, ' ').trim();

                                const finalDestPath = path.join(destFolder, `${sanitize(newFileName)}.cbz`);
                                const sourceDir = path.dirname(filePath);

                                await fs.move(filePath, finalDestPath, { overwrite: true });

                                // --- FIX 2: Move left-behind cover art (Upgraded with X-Ray Logs) ---
                                try {
                                    const dirsToCheck = [sourceDir];
                                    const parentDir = path.dirname(sourceDir);
                                    
                                    if (parentDir.toLowerCase() !== watchedDir.toLowerCase() && parentDir.toLowerCase().startsWith(watchedDir.toLowerCase())) {
                                        dirsToCheck.push(parentDir);
                                    }

                                    Logger.log(`[Art Sweep] Scanning directories for leftover art: ${dirsToCheck.join(', ')}`, 'info');

                                    for (const dir of dirsToCheck) {
                                        if (!fs.existsSync(dir)) {
                                            Logger.log(`[Art Sweep] Directory missing, skipping: ${dir}`, 'warn');
                                            continue;
                                        }
                                        
                                        const siblingFiles = await fs.readdir(dir);
                                        for (const sib of siblingFiles) {
                                            if (sib.match(/\.(jpg|jpeg|png|webp)$/i)) {
                                                const sibSrc = path.join(dir, sib);
                                                const sibDest = path.join(destFolder, sib);
                                                
                                                Logger.log(`[Art Sweep] Found image: ${sibSrc}`, 'info');
                                                
                                                try {
                                                    if (sibSrc.toLowerCase() === sibDest.toLowerCase()) {
                                                        Logger.log(`[Art Sweep] Source and Dest are exactly the same, skipping: ${sibSrc}`, 'warn');
                                                        continue;
                                                    }

                                                    if (!fs.existsSync(sibDest)) {
                                                        Logger.log(`[Art Sweep] Copying to library: ${sibDest}`, 'info');
                                                        await fs.copy(sibSrc, sibDest);
                                                    } else {
                                                        Logger.log(`[Art Sweep] Image already exists in library, skipping copy.`, 'info');
                                                    }
                                                    
                                                    Logger.log(`[Art Sweep] Deleting original from watched folder: ${sibSrc}`, 'info');
                                                    await fs.remove(sibSrc);
                                                } catch (imgErr: any) {
                                                    Logger.log(`[Art Sweep] ERROR handling image ${sib}: ${imgErr.message}`, 'error');
                                                }
                                            }
                                        }
                                    }
                                } catch(e: any) {
                                    Logger.log(`[Art Sweep] FATAL ERROR during sweep: ${e.message}`, 'error');
                                }

                                const seriesRecord = await prisma.series.upsert({
                                    where: { metadataSource_metadataId: { metadataSource: 'COMICVINE', metadataId: meta.cvId.toString() } },
                                    update: { folderPath: destFolder },
                                    create: {
                                        name: safeSeries, publisher: safePub, year: meta.year || new Date().getFullYear(),
                                        folderPath: destFolder, metadataId: meta.cvId.toString(), metadataSource: 'COMICVINE',
                                        matchState: 'MATCHED', isManga, libraryId: targetLib.id
                                    }
                                });

                                syncedSeriesIds.add(seriesRecord.id);

                                await prisma.issue.create({
                                    data: {
                                        seriesId: seriesRecord.id,
                                        metadataId: meta.cvIssueId ? meta.cvIssueId.toString() : `unmatched_${Math.random()}`,
                                        metadataSource: meta.cvIssueId ? 'COMICVINE' : 'LOCAL',
                                        matchState: meta.cvIssueId ? 'MATCHED' : 'UNMATCHED',
                                        number: extractedNum, status: 'DOWNLOADED', filePath: finalDestPath,
                                        name: meta.title, description: meta.summary,
                                        writers: meta.writers?.length ? JSON.stringify(meta.writers) : null,
                                        artists: meta.artists?.length ? JSON.stringify(meta.artists) : null,
                                        characters: meta.characters?.length ? JSON.stringify(meta.characters) : null
                                    }
                                });

                                successCount++;
                            } else {
                                // NO MATCH - Throw into Awaiting Match Drop Folder
                                const finalUnmatchedPath = path.join(unmatchedDir, path.basename(filePath));
                                await fs.move(filePath, finalUnmatchedPath, { overwrite: true });
                                unmatchedCount++;
                            }
                        } catch (err) {
                            Logger.log(`[Watched Sync] Error processing ${path.basename(filePath)}`, 'error');
                        }
                    }

                    // --- NEW: CLEAN UP EMPTY FOLDERS LEFT BEHIND ---
                    async function cleanEmptyFolders(folder: string) {
                        const items = await fs.readdir(folder, { withFileTypes: true });
                        let isEmpty = true;
                        for (const item of items) {
                            const fullPath = path.join(folder, item.name);
                            if (item.isDirectory()) {
                                const isSubEmpty = await cleanEmptyFolders(fullPath);
                                if (!isSubEmpty) isEmpty = false;
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
                                seriesIds: Array.from(syncedSeriesIds) // <-- Pass the exact IDs
                            }, {
                                jobId: `METADATA_SYNC_WATCHED_${Date.now()}`
                            });
                        }

                        await prisma.jobLog.create({
                            data: {
                                jobType: 'WATCHED_FOLDER_SYNC', status: 'COMPLETED', durationMs: Date.now() - startTime,
                                message: `Processed watched folder. Imported: ${successCount}. Moved to unmatched: ${unmatchedCount}.`
                            }
                        });
                    }
                    break;
                }
                
                case 'LIBRARY_SCAN': {
                    await prisma.systemSetting.upsert({ where: { key: 'last_library_sync' }, update: { value: nowStr }, create: { key: 'last_library_sync', value: nowStr } });
                    
                    // --- NEW: Use the native scanner instead of a loopback HTTP request ---
                    const { LibraryScanner } = await import('@/lib/library-scanner');
                    await LibraryScanner.scan();
                    
                    const lastStorageRun = await prisma.systemSetting.findUnique({ where: { key: 'storage_deep_dive_last_run' } });
                    const lastRunTime = parseInt(lastStorageRun?.value || "0");
                    const hoursSinceLastRun = (Date.now() - lastRunTime) / (1000 * 60 * 60);

                    let processedCount = 0;
                    let storageMessage = "Skipped heavy storage scan (calculated recently).";

                    if (hoursSinceLastRun >= 24) {
                        processedCount = await runStorageScan();
                        storageMessage = `Storage calculation completed for ${processedCount} series.`;
                    }

                    await prisma.jobLog.create({ 
                        data: { jobType: 'LIBRARY_SCAN', status: 'COMPLETED', durationMs: Date.now() - startTime, message: `Library scan complete. ${storageMessage}` } 
                    });
                    SystemNotifier.sendAlert('job_library_scan', { description: `Library scan complete. ${storageMessage}` }).catch(() => {});
                    break;
                }

                case 'METADATA_SYNC': {
                    const isTargeted = job.data.seriesIds && Array.isArray(job.data.seriesIds) && job.data.seriesIds.length > 0;
                    
                    // Only update the global "last run" heartbeat timestamp if this is a standard background sweep
                    if (!isTargeted) {
                        await prisma.systemSetting.upsert({ where: { key: 'last_metadata_sync' }, update: { value: nowStr }, create: { key: 'last_metadata_sync', value: nowStr } });
                    }
                    
                    const { syncSeriesMetadata } = await import('@/lib/metadata-fetcher');
                    
                    let seriesToSync: any[] = [];
                    
                    if (isTargeted) {
                        // Grab EXACTLY the series that were just imported
                        seriesToSync = await prisma.series.findMany({ 
                            where: { id: { in: job.data.seriesIds }, metadataId: { not: null } }
                        });
                    } else {
                        // --- FIX: Reduced batch size from 50 to 15 to prevent event loop starvation and API bans ---
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
                    await prisma.systemSetting.upsert({ where: { key: 'last_embed_sync' }, update: { value: nowStr }, create: { key: 'last_embed_sync', value: nowStr } });
                    
                    // --- CHANGED: Import the new writeSeriesJson function ---
                    const { writeComicInfo, writeSeriesJson } = await import('@/lib/metadata-writer');
                    
                    const whereClause: any = { 
                        filePath: { endsWith: '.cbz' }
                    };
                    
                    if (job.data.seriesId) {
                        whereClause.seriesId = job.data.seriesId;
                    } else if (job.data.issueIds && Array.isArray(job.data.issueIds)) {
                        whereClause.id = { in: job.data.issueIds };
                    } else {
                        whereClause.series = { metadataSource: { in: ['COMICVINE', 'METRON'] } };
                    }

                    const issues = await prisma.issue.findMany({
                        where: whereClause
                    });

                    let successCount = 0;
                    let failCount = 0;

                    for (const issue of issues) {
                        const success = await writeComicInfo(issue.id);
                        if (success) successCount++;
                        else failCount++;
                        
                        await new Promise(r => setTimeout(r, 1000)); 
                    }

                    // --- NEW: Generate series.json for any series affected by this job ---
                    const uniqueSeriesIds = new Set(issues.map(i => i.seriesId));
                    let seriesJsonCount = 0;
                    for (const sId of uniqueSeriesIds) {
                        const wroteJson = await writeSeriesJson(sId);
                        if (wroteJson) seriesJsonCount++;
                    }

                    await prisma.jobLog.create({
                        data: {
                            jobType: 'EMBED_METADATA',
                            status: failCount > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
                            durationMs: Date.now() - startTime,
                            message: `Metadata embedding complete. Updated ${successCount} files. Failed: ${failCount}. Exported ${seriesJsonCount} series.json files.`
                        }
                    });
                    break;
                }

                // --- THE ULTIMATE HYBRID MONITOR ENGINE ---
                case 'SERIES_MONITOR': {
                    await prisma.systemSetting.upsert({ where: { key: 'last_monitor_sync' }, update: { value: nowStr }, create: { key: 'last_monitor_sync', value: nowStr } });
                    
                    let details = "Hybrid Series Monitor Job Started.\n\n";
                    let skeletonsCreated = 0;
                    let newRequestsFound = 0;
                    let unreleasedUpgraded = 0;

                    const allRequests = await prisma.request.findMany();
                    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
                    const localSeriesList = await prisma.series.findMany({ include: { issues: true } });

                    // Helper to clean strings for fuzzy matching
                    const normalize = (str?: string | null) => str ? str.toLowerCase().replace(/[^a-z0-9]/g, '') : '';

                    // ------------------------------------------------------------------
                    // PHASE 1: THE METRON ORACLE (Global 90-Day Pull for Western Comics)
                    // ------------------------------------------------------------------
                    const metronUser = await prisma.systemSetting.findUnique({ where: { key: 'metron_user' } });
                    const metronPass = await prisma.systemSetting.findUnique({ where: { key: 'metron_pass' } });
                    
                    if (metronUser?.value && metronPass?.value) {
                        Logger.log(`[Phase 1] Metron Oracle initializing forward-looking calendar fetch...`, 'info');
                        const todayObj = new Date();
                        const pastStr = new Date(todayObj.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                        const futureStr = new Date(todayObj.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                        
                        try {
                            let nextUrl = `https://metron.cloud/api/issue/?store_date__gte=${pastStr}&store_date__lte=${futureStr}`;
                            const metronIssues: any[] = [];
                            
                            while (nextUrl && metronIssues.length < 3000) {
                                try {
                                    const res = await axios.get(nextUrl, {
                                        auth: { username: metronUser.value, password: metronPass.value },
                                        headers: { 'User-Agent': 'Omnibus/1.0' },
                                        timeout: 15000
                                    });
                                    
                                    if (res.data && res.data.results) {
                                        metronIssues.push(...res.data.results);
                                    }
                                    nextUrl = res.data.next;
                                    
                                    // Increased standard delay to 2 seconds to keep Metron happy
                                    await new Promise(r => setTimeout(r, 2000)); 
                                    
                                } catch (axiosErr: any) {
                                    // If we hit the rate limit, pause for 15 seconds and try the same URL again
                                    if (axiosErr.response?.status === 429) {
                                        Logger.log(`[Phase 1] Metron API Rate Limit hit (429)! Pausing for 15 seconds to cool down...`, 'warn');
                                        await new Promise(r => setTimeout(r, 15000));
                                        continue; 
                                    } else {
                                        throw axiosErr; // If it's a different error, throw it to the outer catch
                                    }
                                }
                            }
                            
                            details += `[Phase 1] Metron Oracle fetched ${metronIssues.length} global upcoming releases.\n`;
                            Logger.log(`[Phase 1] Fetched ${metronIssues.length} global upcoming releases. Fuzzy matching to local library...`, 'success');
                            
                            for (const mIssue of metronIssues) {
                                const mSeriesId = mIssue.series?.id?.toString(); // Get the exact Metron ID
                                const mSeriesName = normalize(mIssue.series?.name);
                                const mPubName = normalize(mIssue.publisher?.name || mIssue.series?.publisher?.name);
                                const mNumStr = mIssue.number || mIssue.issue;
                                const mNum = parseFloat(mNumStr);
                                
                                if (isNaN(mNum)) continue;
                                
                                let matchedSeries = null;

                                // 1. EXACT ID MATCH (Fastest & 100% Accurate)
                                // If the local series was matched via Metron, their IDs will match perfectly.
                                if (mSeriesId) {
                                    matchedSeries = localSeriesList.find((s: any) => 
                                        s.metadataSource === 'METRON' && s.metadataId === mSeriesId
                                    );
                                }
                                
                                // 2. FUZZY STRING MATCH (Fallback)
                                // If the local series was matched via ComicVine, we must fuzzy map Metron's text to CV's text.
                                if (!matchedSeries && mSeriesName) {
                                    matchedSeries = localSeriesList.find((s: any) => 
                                        normalize(s.name) === mSeriesName && 
                                        (mPubName ? normalize(s.publisher) === mPubName : true)
                                    );
                                }
                                
                                if (matchedSeries) {
                                    let issueDate = mIssue.store_date || mIssue.cover_date || null;
                                    const searchName = `${matchedSeries.name} #${mNumStr}`;
                                    const isReleased = isReleasedYet(mIssue.store_date, mIssue.cover_date);
                                    
                                    // 1. Create Skeleton for the Release Calendar
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

                                    // 2. Request Logic (Only if Monitored)
                                    if (matchedSeries.monitored) {
                                        const alreadyInLibrary = skeleton?.filePath && skeleton.filePath.length > 0;
                                        if (alreadyInLibrary) continue;

                                        const alreadyReq = allRequests.find(r => r.activeDownloadName === searchName);
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
                            Logger.log(`[Phase 1] Metron Oracle failed: ${e.message}`, 'error');
                            details += `[Phase 1] Metron Oracle failed: ${e.message}\n`;
                        }
                    } else {
                        details += `[Phase 1] Skipped Metron Oracle (Credentials not configured in Settings).\n`;
                    }

                    // ------------------------------------------------------------------
                    // PHASE 2: SLOW-DRIP COMICVINE FALLBACK (For Manga / Obscure Indies)
                    // ------------------------------------------------------------------
                    const cvKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
                    const cvApiKey = cvKeySetting?.value;

                    if (cvApiKey) {
                        Logger.log(`[Phase 2] Running targeted CV scan on 25 oldest monitored series...`, 'info');
                        
                        // Grab 25 Monitored series that haven't been checked recently
                        const cvSeriesToScan = await prisma.series.findMany({
                            where: { monitored: true, metadataSource: 'COMICVINE' },
                            orderBy: { updatedAt: 'asc' }, // Prioritizes series checked longest ago
                            take: 25,
                            include: { issues: true }
                        });

                        details += `[Phase 2] Scanning ${cvSeriesToScan.length} targeted CV volumes...\n`;

                        for (const seriesRecord of cvSeriesToScan) {
                            const cvId = seriesRecord.metadataId;
                            if (!cvId) continue;
                            
                            try {
                                const cvRes = await axios.get(`https://comicvine.gamespot.com/api/issues/`, {
                                    params: { 
                                        api_key: cvApiKey, format: 'json', filter: `volume:${cvId}`, 
                                        sort: 'issue_number:desc', limit: 30, 
                                        field_list: 'id,name,issue_number,cover_date,store_date,image,deck,description' 
                                    },
                                    headers: { 'User-Agent': 'Omnibus/1.0' },
                                    timeout: 10000
                                });
                                
                                const cvIssues = cvRes.data.results || [];
                                
                                for (const cvIssue of cvIssues) {
                                    const cvNum = parseFloat(cvIssue.issue_number);
                                    if (isNaN(cvNum)) continue;

                                    const alreadyInLibrary = seriesRecord.issues.some((i: any) => 
                                        parseFloat(i.number) === cvNum && i.filePath && i.filePath.length > 0
                                    );

                                    const searchName = `${seriesRecord.name} #${cvIssue.issue_number}`;
                                    
                                    const alreadyReq = allRequests.find(r => r.activeDownloadName === searchName);

                                    let issueDate = cvIssue.store_date || cvIssue.cover_date || null;
                                    if (issueDate) {
                                        if (issueDate.length === 4) issueDate += "-01-01";
                                        else if (issueDate.length === 7) issueDate += "-28"; 
                                    }

                                    const isReleased = isReleasedYet(cvIssue.store_date, cvIssue.cover_date);
                                    const issueYear = issueDate ? issueDate.split('-')[0] : seriesRecord.year?.toString() || new Date().getFullYear().toString();

                                    // Calendar Skeleton
                                    if (!alreadyInLibrary) {
                                        const existingSkeleton = seriesRecord.issues.find((i: any) => parseFloat(i.number) === cvNum);
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

                                    // CV Request Queuing
                                    const issueStatus = isReleased ? 'PENDING' : 'UNRELEASED';
                                    details += `[NEW] CV queued ${issueStatus}: ${searchName}\n`;
                                    
                                    const newReq = await prisma.request.create({
                                        data: {
                                            userId: admin?.id || 'system', 
                                            volumeId: cvId.toString(), 
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
                                
                                // Cycle the timestamp so it goes to the back of the queue
                                await prisma.series.update({
                                    where: { id: seriesRecord.id },
                                    data: { updatedAt: new Date() }
                                }).catch(()=>{});
                                
                                await new Promise(r => setTimeout(r, 2000));
                            } catch (err: any) {
                                Logger.log(`[Phase 2] Error scanning CV volume ${cvId}: ${err.message}`, 'error');
                            }
                        }
                    }

                    // ------------------------------------------------------------------
                    // 3. Final Sweep (Catch Local Dates passing)
                    // ------------------------------------------------------------------
                    const unreleasedRequests = allRequests.filter(r => r.status === 'UNRELEASED');
                    for (const req of unreleasedRequests) {
                        const reqNumMatch = req.activeDownloadName?.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v\s*\.?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
                        if (reqNumMatch) {
                            const reqNum = parseFloat(reqNumMatch[1]);
                            const matchedSeries = localSeriesList.find(s => s.metadataId === req.volumeId || s.id === req.volumeId);
                            if (matchedSeries) {
                                const skeleton = matchedSeries.issues.find((i: any) => parseFloat(i.number) === reqNum);
                                if (skeleton && skeleton.releaseDate) {
                                    if (isReleasedYet(skeleton.releaseDate, skeleton.releaseDate)) {
                                        details += `[UPGRADE] Sweep: ${req.activeDownloadName} date passed.\n`;
                                        await prisma.request.update({ where: { id: req.id }, data: { status: 'PENDING' } });
                                        searchAndDownload(req.id, req.activeDownloadName || "", skeleton.releaseDate.split('-')[0], matchedSeries.publisher || "Unknown", matchedSeries.isManga).catch(() => {});
                                        unreleasedUpgraded++;
                                    }
                                }
                            }
                        }
                    }

                    Logger.log(`[Monitor Job] Complete! +${skeletonsCreated} calendar entries | +${newRequestsFound} new downloads`, 'success');

                    await prisma.jobLog.create({ 
                        data: { jobType: 'SERIES_MONITOR', status: 'COMPLETED', durationMs: Date.now() - startTime, message: details + `\nFinal Summary: ${skeletonsCreated} calendar entries, ${newRequestsFound} new downloads, ${unreleasedUpgraded} upgrades.` } 
                    });
                    SystemNotifier.sendAlert('job_issue_monitor', { description: `Monitor Scan Complete. Calendar entries added: ${skeletonsCreated}. New: ${newRequestsFound}, Upgraded: ${unreleasedUpgraded}` }).catch(() => {});
                    break;
                }

                case 'DIAGNOSTICS': {
                    await prisma.systemSetting.upsert({ where: { key: 'last_diagnostics_sync' }, update: { value: nowStr }, create: { key: 'last_diagnostics_sync', value: nowStr } });
                    let details = "Diagnostics Scan Started.\n\n";
                    let issuesFound = 0;
                    
                    const series = await prisma.series.findMany();
                    const ghosts = series.filter(s => !s.folderPath || !fs.existsSync(s.folderPath));
                    
                    if (ghosts.length > 0) {
                        details += `[WARNING] Found ${ghosts.length} ghost series records.\n`;
                        issuesFound += ghosts.length;
                    }

                    if (issuesFound === 0) details += "Library is in perfect health. 100% Integrity.\n";

                    await prisma.jobLog.create({ data: { jobType: 'DIAGNOSTICS', status: issuesFound > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED', durationMs: Date.now() - startTime, message: details } });
                    SystemNotifier.sendAlert('job_diagnostics', { description: `Diagnostics Complete. Issues found: ${issuesFound}` }).catch(() => {});
                    break;
                }

                case 'UPDATE_CHECK': {
                    const res = await axios.get('https://api.github.com/repos/hankscafe/omnibus/releases?per_page=1', {
                        headers: { 'User-Agent': 'Omnibus-App', 'Accept': 'application/vnd.github.v3+json' },
                        timeout: 10000
                    });

                    if (res.data && res.data.length > 0) {
                        const latestVersion = res.data[0].tag_name.replace(/^v/, '');
                        const notifiedSetting = await prisma.systemSetting.findUnique({ where: { key: 'last_notified_version' } });
                        const lastNotified = notifiedSetting?.value || "";

                        if (latestVersion !== lastNotified) {
                            const currentVersion = packageJson.version || "1.0.0";
                            if (isNewerVersion(latestVersion, currentVersion)) {
                                await SystemNotifier.sendAlert('update_available', { version: latestVersion });
                                await prisma.systemSetting.upsert({
                                    where: { key: 'last_notified_version' }, update: { value: latestVersion }, create: { key: 'last_notified_version', value: latestVersion }
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
                    await prisma.systemSetting.upsert({ where: { key: 'last_popular_sync' }, update: { value: nowStr }, create: { key: 'last_popular_sync', value: nowStr } });
                    
                    const allSettings = await prisma.systemSetting.findMany();
                    const config = Object.fromEntries(allSettings.map(s => [s.key, s.value]));
                    const CV_API_KEY = config.cv_api_key || process.env.CV_API_KEY;

                    if (!CV_API_KEY) throw new Error("Missing ComicVine API Key");

                    const filterEnabled = config.filter_enabled === "true";
                    const blockedPublishers = config.filter_publishers ? config.filter_publishers.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean) : [];
                    const blockedKeywords = config.filter_keywords ? config.filter_keywords.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean) : [];

                    // Manga Filters
                    const mangaFilterMode = config.discover_manga_filter_mode || "SHOW_ALL";
                    const allowedMangaPubs = config.discover_manga_allowed_publishers ? config.discover_manga_allowed_publishers.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean) : [];
                    
                    // Expanded dictionary of Japanese publishers
                    const DEFAULT_MANGA_PUBLISHERS = [
                        "viz media", "kodansha", "yen press", "seven seas", "shueisha", 
                        "shogakukan", "tokyopop", "dark horse manga", "vertical", 
                        "ghost ship", "denpa", "fakku", "j-novel club", "sublime", 
                        "kuma", "ize press", "square enix", "hakusensha", "lezhin",
                        "suiseisha", "nihon bungeisha", "takeshobo", "futabasha", "kadokawa", "akita shoten"
                    ];
                    const mangaPublishersList = config.manga_publishers ? config.manga_publishers.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean) : DEFAULT_MANGA_PUBLISHERS;

                    const isValid = (item: any) => {
                        const pubName = (item.volume?.publisher?.name || '').toLowerCase().trim();
                        const volName = (item.volume?.name || '').toLowerCase().trim();
                        const concepts = item.volume?.concepts || [];

                        // 1. NSFW / Standard Filtering
                        if (filterEnabled) {
                            if (blockedPublishers.length > 0 && blockedPublishers.some((bp: string) => pubName.includes(bp))) return false;
                            if (blockedKeywords.length > 0 && blockedKeywords.some((bk: string) => volName.includes(bk))) return false;
                        }

                        // 2. Manga Detection
                        const isMangaPublisher = mangaPublishersList.some((mp: string) => pubName.includes(mp));
                        const hasMangaConcept = concepts.some((c: any) => ['manga', 'shonen', 'seinen', 'shojo', 'josei', 'manhwa', 'manhua', 'webtoon'].includes((c.name || '').toLowerCase()));
                        
                        const isManga = isMangaPublisher || hasMangaConcept;
                        
                        if (isManga) {
                            if (mangaFilterMode === "HIDE_ALL") {
                                Logger.log(`[Discover Sync] Filtered out Manga: ${volName}`, 'info');
                                return false;
                            }
                            if (mangaFilterMode === "ALLOWED_ONLY") {
                                const isAllowed = allowedMangaPubs.length > 0 && allowedMangaPubs.some((amp: string) => pubName.includes(amp) || volName.includes(amp));
                                if (!isAllowed) {
                                    Logger.log(`[Discover Sync] Filtered out unallowed Manga: ${volName}`, 'info');
                                    return false;
                                }
                            }
                        }

                        return true;
                    };

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
                          id: item.id, volumeId: item.volume.id, name: `${item.volume.name} #${item.issue_number}`,
                          year: dateStr ? dateStr.split('-')[0] : '????', publisher: item.volume?.publisher?.name || null,
                          image: item.image?.medium_url, description: desc || "No description available.", siteUrl: item.site_detail_url,
                          writers: [...new Set(writers)].slice(0, 3), artists: [...new Set(artists)].slice(0, 3), coverArtists: [...new Set(coverArtists)].slice(0, 3)
                        };
                    };

                    const fetchCategory = async (sort: string) => {
                        let validItems: any[] = [];
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

                            // Bulk Fetch Publishers & Concepts
                            const volIds = [...new Set(items.map((i: any) => i.volume?.id).filter(Boolean))];
                            let volumesMap: Record<number, any> = {};

                            if (volIds.length > 0) {
                                try {
                                    const chunkedIds = [];
                                    for (let i = 0; i < volIds.length; i += 50) {
                                        chunkedIds.push(volIds.slice(i, i + 50));
                                    }

                                    for (const chunk of chunkedIds) {
                                        const volIdString = chunk.join('|');
                                        const volResponse = await axios.get(`https://comicvine.gamespot.com/api/volumes/`, {
                                            params: {
                                                api_key: CV_API_KEY, format: 'json', filter: `id:${volIdString}`,
                                                field_list: 'id,publisher,concepts'
                                            },
                                            headers: { 'User-Agent': 'Omnibus/1.0' }
                                        });
                                        apiCallsMade++;
                                        
                                        if (volResponse.data?.results) {
                                            const resultsArray = Array.isArray(volResponse.data.results) ? volResponse.data.results : [volResponse.data.results];
                                            resultsArray.forEach((v: any) => {
                                                volumesMap[v.id] = v;
                                            });
                                        }
                                        await new Promise(r => setTimeout(r, 500)); 
                                    }
                                } catch (err) {
                                    Logger.log(`[Discover Sync] Failed to fetch volume data chunk. Rate limit possible.`, 'warn');
                                }
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
                        prisma.systemSetting.upsert({ where: { key: 'discover_cache_new' }, update: { value: JSON.stringify(newReleases) }, create: { key: 'discover_cache_new', value: JSON.stringify(newReleases) } }),
                        prisma.systemSetting.upsert({ where: { key: 'discover_cache_popular' }, update: { value: JSON.stringify(popular) }, create: { key: 'discover_cache_popular', value: JSON.stringify(popular) } }),
                    ]);

                    await prisma.jobLog.create({
                        data: { jobType: 'DISCOVER_SYNC', status: 'COMPLETED', durationMs: Date.now() - startTime, message: `Successfully rebuilt the Discover cache (New & Popular). Filter enabled: ${filterEnabled}. Manga Mode: ${mangaFilterMode}` }
                    });
                    SystemNotifier.sendAlert('job_discover_sync', { description: `Successfully rebuilt the Discover cache (New & Popular).` }).catch(() => {});
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
                        include: { series: true },
                        orderBy: { series: { name: 'asc' } }
                    });

                    if (candidateIssues.length === 0) {
                        await prisma.jobLog.create({
                            data: { jobType: 'WEEKLY_DIGEST', status: 'COMPLETED', durationMs: Date.now() - startTime, message: "Skipped: No new issues added in the last 7 days." }
                        });
                        break;
                    }

                    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
                    await prisma.digestHistory.deleteMany({
                        where: { sentAt: { lt: fourteenDaysAgo } }
                    });

                    await prisma.systemSetting.deleteMany({ where: { key: 'weekly_digest_history' } });

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
                            recordsToSave.push({
                                seriesId: issue.seriesId,
                                issueNum: issue.number
                            });
                        }
                    }

                    if (newIssues.length === 0) {
                        await prisma.jobLog.create({
                            data: { jobType: 'WEEKLY_DIGEST', status: 'COMPLETED', durationMs: Date.now() - startTime, message: "Skipped: All recent database entries have already been emailed in previous digests." }
                        });
                        break;
                    }

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

                    for (const s in comicsMap) { comicsMap[s].issues = formatIssueList(comicsMap[s].issues); }
                    for (const s in mangaMap) { mangaMap[s].issues = formatIssueList(mangaMap[s].issues); }

                    const MAX_DIGEST_SERIES = 15;
                    let finalComics = Object.values(comicsMap);
                    let finalManga = Object.values(mangaMap);
                    
                    if (finalComics.length + finalManga.length > MAX_DIGEST_SERIES) {
                        Logger.log(`[Queue] Capping digest to 15 series to prevent email server rejection.`, 'warn');
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
                            Logger.log(`[Queue] Failed to send weekly digest: ${getErrorMessage(mailErr)}`, 'error');
                            throw mailErr; 
                        }
                    }

                    await prisma.jobLog.create({
                        data: { jobType: 'WEEKLY_DIGEST', status: 'COMPLETED', durationMs: Date.now() - startTime, message: `Sent weekly digest to ${toEmails.length} users containing ${newIssues.length} unique new issues.` }
                    });
                    break;
                }

                default:
                    throw new Error(`Unknown job type: ${type}`);
            }

            // --- FIX: Ensure concurrency reduction actually triggers the next queue item cleanly ---
            await job.updateProgress(100);

        } catch (error: any) {
            await prisma.jobLog.create({ 
                data: { jobType: type, status: 'FAILED', message: error.message } 
            });
            throw error; 
        }
    }, { 
        connection,
        // --- FIX: Reduced concurrency from 2 to 1 to prevent Node.js main thread starvation ---
        concurrency: 1 
    });

    worker.on('completed', (job) => {
        Logger.log(`[BullMQ] Job ${job?.id} (${job?.data.type}) completed successfully.`, "success");
    });

    worker.on('failed', (job, err) => {
        Logger.log(`[BullMQ] Job ${job?.id} (${job?.data.type}) failed: ${err.message}`, "error");
    });

    if (process.env.NODE_ENV !== 'production') {
        globalForMQ.omnibusWorker = worker;
    }
}