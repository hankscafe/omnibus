// src/lib/queue.ts
import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from './db';
import { Logger } from './logger';
import { DiscordNotifier } from './discord';
import { Mailer } from './mailer';
import crypto from 'crypto';
import axios from 'axios';
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

// 1. Create a global cache object
const globalForMQ = globalThis as unknown as { 
    omnibusQueue: Queue; 
    omnibusWorker: Worker; 
    redisConnection: IORedis;
};

// 2. Cache the Redis connection
const connection = globalForMQ.redisConnection || new IORedis(process.env.OMNIBUS_REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null
});

if (process.env.NODE_ENV !== 'production') globalForMQ.redisConnection = connection;

// 3. Cache the Queue
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

// --- BACKGROUND WORKER PROCESSOR ---
export function initWorker() {
    // 4. Prevent duplicate workers from spawning on Hot Reload
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
                    DiscordNotifier.sendAlert('job_db_backup', { description: `Backup saved successfully to ${fileName}.` }).catch(() => {});
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
                    DiscordNotifier.sendAlert('job_diagnostics', { description: `CBR Conversion Sweep Complete. Converted: ${successCount}, Failed: ${failCount}` }).catch(() => {});
                    break;
                }

                case 'LIBRARY_SCAN': {
                    await prisma.systemSetting.upsert({ where: { key: 'last_library_sync' }, update: { value: nowStr }, create: { key: 'last_library_sync', value: nowStr } });
                    
                    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
                    await axios.get(`${baseUrl}/api/library?refresh=true`, { timeout: 300000 }).catch(() => {});
                    
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
                    DiscordNotifier.sendAlert('job_library_scan', { description: `Library scan complete. ${storageMessage}` }).catch(() => {});
                    break;
                }

                case 'METADATA_SYNC': {
                    await prisma.systemSetting.upsert({ where: { key: 'last_metadata_sync' }, update: { value: nowStr }, create: { key: 'last_metadata_sync', value: nowStr } });
                    const { syncSeriesMetadata } = await import('@/lib/metadata-fetcher');
                    const allSeries = await prisma.series.findMany({ where: { metadataId: { not: null } } });

                    let successCount = 0;
                    let failCount = 0;
                    let details = `Started Manual Metadata Sync for ${allSeries.length} series.\n\n`;

                    for (const series of allSeries) {
                        try {
                            if (!series.metadataId) continue;
                            await syncSeriesMetadata(series.metadataId, series.folderPath, series.metadataSource);
                            successCount++;
                            details += `[OK] Synced: ${series.name}\n`;
                        } catch (e: any) {
                            failCount++;
                            details += `[FAIL] ${series.name} - ${e.message}\n`;
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
                    break;
                }

                case 'EMBED_METADATA': {
                    await prisma.systemSetting.upsert({ where: { key: 'last_embed_sync' }, update: { value: nowStr }, create: { key: 'last_embed_sync', value: nowStr } });
                    const { writeComicInfo } = await import('@/lib/metadata-writer');
                    
                    const issues = await prisma.issue.findMany({
                        where: { filePath: { endsWith: '.cbz' }, series: { metadataSource: 'COMICVINE' } }
                    });

                    let successCount = 0;
                    let failCount = 0;

                    for (const issue of issues) {
                        const success = await writeComicInfo(issue.id);
                        if (success) successCount++;
                        else failCount++;
                        await new Promise(r => setTimeout(r, 100)); 
                    }

                    await prisma.jobLog.create({
                        data: {
                            jobType: 'EMBED_METADATA',
                            status: failCount > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
                            durationMs: Date.now() - startTime,
                            message: `Metadata embedding complete. Updated ${successCount} files. Failed: ${failCount}.`
                        }
                    });
                    break;
                }

                case 'SERIES_MONITOR': {
                    await prisma.systemSetting.upsert({ where: { key: 'last_monitor_sync' }, update: { value: nowStr }, create: { key: 'last_monitor_sync', value: nowStr } });
                    const cvKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
                    const cvApiKey = cvKeySetting?.value;
                    if (!cvApiKey) throw new Error("Missing ComicVine API Key");

                    const monitoredSeries = await prisma.series.findMany({
                        where: { monitored: true }, include: { issues: true }
                    });
                    const monitoredCvIds = monitoredSeries.filter(s => s.metadataSource === 'COMICVINE' && s.metadataId).map(s => parseInt(s.metadataId!));

                    const allRequests = await prisma.request.findMany(); // Fetch all requests to check for duplicates

                    const unreleasedRequests = allRequests.filter(r => r.status === 'UNRELEASED');
                    const unreleasedVolumeIds = unreleasedRequests.map(r => parseInt(r.volumeId)).filter(id => !isNaN(id));

                    const allCvIdsToCheck = [...new Set([...monitoredCvIds, ...unreleasedVolumeIds])];
                    if (allCvIdsToCheck.length === 0) break;

                    let newIssuesFound = 0;
                    let unreleasedUpgraded = 0;
                    let details = `Scanning ${allCvIdsToCheck.length} volumes for new/unreleased issues.\n\n`;

                    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });

                    for (const cvId of allCvIdsToCheck) {
                        try {
                            const seriesRecord = monitoredSeries.find(s => s.metadataId === cvId.toString() && s.metadataSource === 'COMICVINE');
                            const isMonitored = !!seriesRecord;
                            const seriesName = seriesRecord?.name || unreleasedRequests.find(r => parseInt(r.volumeId) === cvId)?.activeDownloadName?.split(' #')[0] || `Volume ${cvId}`;
                            const seriesPublisher = seriesRecord?.publisher || "Unknown";
                            const seriesYear = seriesRecord?.year?.toString() || new Date().getFullYear().toString();
                            const isManga = seriesRecord ? (seriesRecord as any).isManga : false;

                            // Fetch CV Issues for this volume
                            const cvRes = await axios.get(`https://comicvine.gamespot.com/api/issues/`, {
                                params: { 
                                    api_key: cvApiKey, format: 'json', filter: `volume:${cvId}`, 
                                    sort: 'issue_number:desc', limit: 50, 
                                    field_list: 'id,name,issue_number,cover_date,store_date,image' 
                                },
                                headers: { 'User-Agent': 'Omnibus/1.0' }
                            });
                            
                            const allCvIssues = cvRes.data.results || [];

                            for (const cvIssue of allCvIssues) {
                                const cvNum = parseFloat(cvIssue.issue_number);
                                if (isNaN(cvNum)) continue;

                                // 1. DATABASE CHECK: Does this specific number exist in the library?
                                const alreadyInLibrary = seriesRecord?.issues.some(i => 
                                    parseFloat(i.number) === cvNum && i.filePath && i.filePath.length > 0
                                );
                                if (alreadyInLibrary) continue;

                                const searchName = `${seriesName} #${cvIssue.issue_number}`;
                                
                                // 2. REQUEST CHECK: Is there already a request (Pending or Downloading) for this number?
                                const alreadyReq = allRequests.find(r => {
                                    if (r.volumeId !== cvId.toString()) return false;
                                    if (r.activeDownloadName === searchName) return true;
                                    
                                    const reqNumMatch = r.activeDownloadName?.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v\s*\.?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
                                    return reqNumMatch && parseFloat(reqNumMatch[1]) === cvNum;
                                });

                                const isReleased = isReleasedYet(cvIssue.store_date, cvIssue.cover_date);
                                const issueYear = (cvIssue.store_date || cvIssue.cover_date || seriesYear).split('-')[0];

                                if (alreadyReq) {
                                    // If it was UNRELEASED and is now out, upgrade it
                                    if (alreadyReq.status === 'UNRELEASED' && isReleased) {
                                        details += `[UPGRADE] ${searchName} is now released. Triggering search...\n`;
                                        await prisma.request.update({ where: { id: alreadyReq.id }, data: { status: 'PENDING' } });
                                        searchAndDownload(alreadyReq.id, searchName, issueYear, seriesPublisher, isManga).catch(() => {});
                                        unreleasedUpgraded++;
                                    }
                                    continue; 
                                }

                                // 3. MONITOR NEW ISSUE: Only create if definitively not in Library or Requests
                                if (isMonitored) {
                                    const issueStatus = isReleased ? 'PENDING' : 'UNRELEASED';
                                    details += `[NEW] Found ${cvIssue.issue_number} (${issueStatus}): ${searchName}\n`;
                                    
                                    const newReq = await prisma.request.create({
                                        data: {
                                            userId: admin?.id || 'system', 
                                            volumeId: cvId.toString(), 
                                            status: issueStatus,
                                            activeDownloadName: searchName, 
                                            imageUrl: cvIssue.image?.medium_url
                                        }
                                    });

                                    if (isReleased) {
                                        searchAndDownload(newReq.id, searchName, issueYear, seriesPublisher, isManga).catch(() => {});
                                        newIssuesFound++;
                                    }
                                }
                            }
                            await new Promise(r => setTimeout(r, 1000));
                        } catch (err: any) {
                            details += `[ERROR] Failed to scan volume ${cvId}: ${err.message}\n`;
                        }
                    }

                    await prisma.jobLog.create({ 
                        data: { jobType: 'SERIES_MONITOR', status: 'COMPLETED', durationMs: Date.now() - startTime, message: details + `\nSummary: Found ${newIssuesFound} new issues | Upgraded ${unreleasedUpgraded} unreleased issues.` } 
                    });
                    DiscordNotifier.sendAlert('job_issue_monitor', { description: `Monitor Scan Complete. New: ${newIssuesFound}, Upgraded: ${unreleasedUpgraded}` }).catch(() => {});
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
                    DiscordNotifier.sendAlert('job_diagnostics', { description: `Diagnostics Complete. Issues found: ${issuesFound}` }).catch(() => {});
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
                                await DiscordNotifier.sendAlert('update_available', { version: latestVersion });
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
                    await prisma.systemSetting.upsert({ where: { key: 'last_popular_sync' }, update: { value: nowStr }, create: { key: 'last_popular_sync', value: nowStr } });
                    
                    const allSettings = await prisma.systemSetting.findMany();
                    const config = Object.fromEntries(allSettings.map(s => [s.key, s.value]));
                    const CV_API_KEY = config.cv_api_key || process.env.CV_API_KEY;

                    if (!CV_API_KEY) throw new Error("Missing ComicVine API Key");

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
                    break;
                }

                case 'WEEKLY_DIGEST': {
                    await prisma.systemSetting.upsert({ 
                        where: { key: 'last_weekly_digest' }, 
                        update: { value: nowStr }, 
                        create: { key: 'last_weekly_digest', value: nowStr } 
                    });

                    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                    
                    // 1. Fetch potential candidates based on DB creation
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

                    // 2. Relational Database Ledger tracking
                    // Clean up history older than 14 days to prevent infinite table growth
                    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
                    await prisma.digestHistory.deleteMany({
                        where: { sentAt: { lt: fourteenDaysAgo } }
                    });

                    // Purge the old, slow JSON string setting if it exists from the previous implementation
                    await prisma.systemSetting.deleteMany({ where: { key: 'weekly_digest_history' } });

                    // Fetch the remaining ledger
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

                    // Format numbers sequentially and CAP at 15 per series
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

                    // Cap the entire digest to 15 series to avoid Gmail rejecting massive emails
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
                        await Mailer.sendWeeklyDigest(toEmails, finalComics, finalManga);
                        
                        // Save the new items to the database ledger
                        // SQLite doesn't support skipDuplicates in createMany, so we loop and catch collisions
                        if (recordsToSave.length > 0) {
                            for (const record of recordsToSave) {
                                await prisma.digestHistory.create({
                                    data: record
                                }).catch(() => {}); // Safely ignore if it was already inserted
                            }
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

            await job.updateProgress(100);

        } catch (error: any) {
            await prisma.jobLog.create({ 
                data: { jobType: type, status: 'FAILED', message: error.message } 
            });
            throw error; 
        }
    }, { 
        connection,
        concurrency: 2 
    });

    worker.on('completed', (job) => {
        Logger.log(`[BullMQ] Job ${job?.id} (${job?.data.type}) completed successfully.`, "success");
    });

    worker.on('failed', (job, err) => {
        Logger.log(`[BullMQ] Job ${job?.id} (${job?.data.type}) failed: ${err.message}`, "error");
    });

    // 5. Cache the worker
    if (process.env.NODE_ENV !== 'production') {
        globalForMQ.omnibusWorker = worker;
    }
}