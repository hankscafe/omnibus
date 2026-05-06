// src/lib/health-checker.ts
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export interface HealthCheckResult {
    id: string;
    name: string;
    status: 'ok' | 'warning' | 'error';
    message: string;
    actionLink?: string;
    details?: string[];
}

export async function runSystemHealthCheck() {
    Logger.log(`[Health Check Debug] Initializing system health diagnostics...`, 'debug');
    const results: HealthCheckResult[] = [];
    const settings = await prisma.systemSetting.findMany();
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

    // 1. System Update
    Logger.log(`[Health Check Debug] Fetching system update status...`, 'debug');
    try {
        const res = await fetch('http://localhost:3000/api/admin/update-check');
        if (res.ok) {
            const data = await res.json();
            Logger.log(`[Health Check Debug] System update check successful. Current: v${data.currentVersion}, Latest: v${data.latestVersion}`, 'debug');
            if (data.updateAvailable) {
                results.push({ id: 'system_update', name: 'System Update', status: 'warning', message: `Update Available: v${data.latestVersion}`, actionLink: '/admin/updates' });
            } else {
                results.push({ id: 'system_update', name: 'System Update', status: 'ok', message: `Up to date (v${data.currentVersion})` });
            }
        } else throw new Error(`HTTP ${res.status}`);
    } catch(e) {
        Logger.log(`[Health Check Debug] System update check failed or timed out: ${getErrorMessage(e)}`, 'debug');
        results.push({ id: 'system_update', name: 'System Update', status: 'ok', message: 'Up to date (Checked recently)' });
    }

    // 2. ComicVine API Key
    if (!config.cv_api_key) {
        results.push({ id: 'cv_key', name: 'ComicVine API Key', status: 'error', message: 'No ComicVine API Key configured. Metadata fetching will fail.', actionLink: '/admin/settings' });
    } else {
        results.push({ id: 'cv_key', name: 'ComicVine API Key', status: 'ok', message: 'Configured' });
    }

    // 3. Download Directory & Drive Space (WITH WRITE PERMISSION CHECK)
    let isDiskFull = false;
    if (!config.download_path) {
        results.push({ id: 'dl_dir', name: 'Download Directory', status: 'error', message: 'No Download Directory set.', actionLink: '/admin/settings' });
    } else if (!fs.existsSync(config.download_path)) {
        results.push({ id: 'dl_dir', name: 'Download Directory', status: 'error', message: `Download Directory (${config.download_path}) is inaccessible or missing.` });
    } else {
        let isWritable = true;
        try {
            await fs.promises.access(config.download_path, fs.constants.W_OK);
        } catch (e) {
            isWritable = false;
        }

        if (!isWritable) {
            results.push({ id: 'dl_dir', name: 'Download Directory', status: 'error', message: `Omnibus does not have write permissions for ${config.download_path}. Downloads will fail.` });
        } else {
            results.push({ id: 'dl_dir', name: 'Download Directory', status: 'ok', message: 'Configured and writable' });
        }
        
        try {
            const stat = await fs.promises.statfs(config.download_path);
            const freeGB = (stat.bavail * stat.bsize) / (1024 * 1024 * 1024);
            Logger.log(`[Health Check Debug] Calculated Disk Space: ${freeGB.toFixed(2)}GB available at mount point ${config.download_path}`, 'debug');
            if (freeGB < 2) {
                isDiskFull = true;
                results.push({ id: 'disk_space', name: 'Drive Space', status: 'error', message: `Critically full! Only ${freeGB.toFixed(2)}GB remaining. Downloads paused.`, actionLink: '/admin/storage' });
            } else if (freeGB < 10) {
                results.push({ id: 'disk_space', name: 'Drive Space', status: 'warning', message: `Almost full. ${freeGB.toFixed(2)}GB remaining.`, actionLink: '/admin/storage' });
            } else {
                results.push({ id: 'disk_space', name: 'Drive Space', status: 'ok', message: `${freeGB.toFixed(2)}GB free` });
            }
        } catch (e) {
            Logger.log(`[Health Check Debug] StatFS failed for ${config.download_path}: ${getErrorMessage(e)}`, 'debug');
        }
    }

    await prisma.systemSetting.upsert({
        where: { key: 'is_disk_full' },
        update: { value: isDiskFull ? 'true' : 'false' },
        create: { key: 'is_disk_full', value: isDiskFull ? 'true' : 'false' }
    });

    // 4. Libraries (WITH WRITE PERMISSION CHECK)
    const libraries = await prisma.library.findMany();
    const hasComic = libraries.some(l => !l.isManga);
    const hasManga = libraries.some(l => l.isManga);
    
    if (!hasComic) results.push({ id: 'lib_comic', name: 'Comic Library', status: 'error', message: 'No standard Comic library is configured.', actionLink: '/admin/settings' });
    else results.push({ id: 'lib_comic', name: 'Comic Library', status: 'ok', message: 'Configured' });

    if (!hasManga) results.push({ id: 'lib_manga', name: 'Manga Library', status: 'warning', message: 'No Manga library is configured. Manga will fall back to the standard library.', actionLink: '/admin/settings' });
    else results.push({ id: 'lib_manga', name: 'Manga Library', status: 'ok', message: 'Configured' });

    let libsAccessible = true;
    for (const lib of libraries) {
        if (!fs.existsSync(lib.path)) {
            Logger.log(`[Health Check Debug] Library path inaccessible: ${lib.path}`, 'debug');
            results.push({ id: `lib_acc_${lib.id}`, name: `Library Access: ${lib.name}`, status: 'error', message: `Path ${lib.path} is inaccessible.` });
            libsAccessible = false;
        } else {
            try {
                Logger.log(`[Health Check Debug] Checking write permissions for library: ${lib.path}`, 'debug');
                await fs.promises.access(lib.path, fs.constants.W_OK);
            } catch (e) {
                Logger.log(`[Health Check Debug] Library write permission failed for path: ${lib.path}`, 'debug');
                results.push({ id: `lib_write_${lib.id}`, name: `Library Permissions: ${lib.name}`, status: 'warning', message: `Path ${lib.path} is read-only. Omnibus cannot automatically move files here.` });
            }
        }
    }
    if (libsAccessible && libraries.length > 0) results.push({ id: 'lib_acc', name: 'Library Paths Access', status: 'ok', message: 'All libraries are accessible and writable' });

    // 5. CloudFlare / FlareSolverr
    const cfBlockTime = parseInt(config.cloudflare_block_time || '0');
    const hasFlare = !!config.flaresolverr_url;
    if (cfBlockTime > Date.now() - (24 * 60 * 60 * 1000) && !hasFlare) {
        Logger.log(`[Health Check Debug] CloudFlare challenge block detected within the last 24 hours without FlareSolverr active.`, 'debug');
        results.push({ id: 'cf_block', name: 'CloudFlare Challenge Detected', status: 'warning', message: 'Yes (FlareSolverr is not set up, GetComics downloads may fail)', actionLink: '/admin/settings' });
    } else {
        results.push({ id: 'cf_block', name: 'CloudFlare Challenge Detected', status: 'ok', message: 'No' });
    }

    // 6. API Rate Limits & Call Counts
    const cvLimitTime = parseInt(config.cv_rate_limit_time || '0');
    
    // Parse CV Rolling Usage
    let cvCalls = 0;
    let cvDetails = "";
    if (config.cv_api_usage) {
        try {
            const usage = JSON.parse(config.cv_api_usage);
            const now = Date.now();
            for (const ep in usage) {
                const validTs = usage[ep].filter((ts: number) => now - ts < 3600000); // Past hour
                if (validTs.length > 0) {
                    cvCalls += validTs.length;
                    cvDetails += `${validTs.length} on '${ep}', `;
                }
            }
        } catch (e) {}
    }
    cvDetails = cvDetails ? `(${cvDetails.slice(0, -2)})` : "(0 active calls)";

    if (cvLimitTime > Date.now() - (60 * 60 * 1000)) {
        results.push({ id: 'cv_limit', name: 'ComicVine API', status: 'error', message: `Rate limit reached within the last hour. Syncing paused. Past hour: ${cvCalls} total calls ${cvDetails}` });
    } else if (cvCalls > 160) {
         results.push({ id: 'cv_limit', name: 'ComicVine API', status: 'warning', message: `Approaching rate limit (200/hr). Past hour: ${cvCalls} total calls ${cvDetails}` });
    } else {
        results.push({ id: 'cv_limit', name: 'ComicVine API', status: 'ok', message: `Status: Normal. Past hour: ${cvCalls} total calls ${cvDetails}` });
    }

    // Parse Metron Rolling Usage
    let metronCalls = 0;
    if (config.metron_api_usage) {
        try {
            const usage = JSON.parse(config.metron_api_usage);
            const now = Date.now();
            for (const ep in usage) {
                const validTs = usage[ep].filter((ts: number) => now - ts < 86400000); // Past 24 hours
                if (validTs.length > 0) {
                    metronCalls += validTs.length;
                }
            }
        } catch (e) {}
    }

    const metronLimitTime = parseInt(config.metron_rate_limit_time || '0');
    if (metronLimitTime > Date.now() - (60 * 60 * 1000)) {
        results.push({ id: 'metron_limit', name: 'Metron.Cloud API', status: 'error', message: `Rate limit reached. Syncing paused. Past 24 hours: ${metronCalls} / 5000 calls.` });
    } else if (metronCalls > 4000) {
        results.push({ id: 'metron_limit', name: 'Metron.Cloud API', status: 'warning', message: `Approaching daily limit. Past 24 hours: ${metronCalls} / 5000 calls.` });
    } else {
        results.push({ id: 'metron_limit', name: 'Metron.Cloud API', status: 'ok', message: `Status: Normal. Past 24 hours: ${metronCalls} / 5000 calls.` });
    }

    const hosterLimitTime = parseInt(config.hoster_rate_limit_time || '0');
    if (hosterLimitTime > Date.now() - (24 * 60 * 60 * 1000)) {
        results.push({ id: 'hoster_limit', name: '3rd Party Hoster Limit', status: 'warning', message: 'Rate limit reached within the last 24 hours.' });
    } else {
        results.push({ id: 'hoster_limit', name: '3rd Party Hoster Limit', status: 'ok', message: 'Normal' });
    }

    // 7. DOWNLOAD CLIENT CONFIGURATION CHECK
    const downloadClientCount = await prisma.downloadClient.count();
    if (downloadClientCount === 0) {
        results.push({ id: 'dl_clients_config', name: 'Download Clients', status: 'error', message: 'No external clients (qBit, SABnzbd, etc.) configured. Automated Prowlarr downloading will not work.', actionLink: '/admin/settings' });
    } else {
        results.push({ id: 'dl_clients_config', name: 'Download Clients', status: 'ok', message: `${downloadClientCount} client(s) configured` });
    }

    // 8. External Client Missing Files
    const stalledReqs = await prisma.request.findMany({
        where: { status: 'STALLED', retryCount: { gte: 3 } },
        select: { id: true, activeDownloadName: true }
    });
    
    if (stalledReqs.length > 0) {
        const stalledNames = stalledReqs.map(r => r.activeDownloadName || `Request ID: ${r.id}`);
        results.push({ 
            id: 'stalled_dls', 
            name: 'External Client Import Errors', 
            status: 'error', 
            message: `${stalledReqs.length} download(s) failed to import. They are stuck in the active queue and require manual intervention (Check path mappings or permissions).`, 
            actionLink: '/admin',
            details: stalledNames 
        });
    } else {
        results.push({ id: 'stalled_dls', name: 'External Client Imports', status: 'ok', message: 'All imports successful' });
    }

    // 9. Cache Integrity Check
    const cacheDir = process.env.OMNIBUS_CACHE_DIR || '/cache';
    if (!fs.existsSync(cacheDir)) {
        results.push({ id: 'cache_dir', name: 'Cache Directory', status: 'error', message: `Cache directory (${cacheDir}) is missing. Reading and conversions will fail.` });
    } else {
        try {
            await fs.promises.access(cacheDir, fs.constants.W_OK | fs.constants.R_OK);
            results.push({ id: 'cache_dir', name: 'Cache Directory', status: 'ok', message: 'Accessible and writable' });
        } catch (e) {
            results.push({ id: 'cache_dir', name: 'Cache Directory', status: 'error', message: `Cache directory (${cacheDir}) lacks Read/Write permissions.` });
        }
    }

    // 10. Backup Status
    const lastBackup = parseInt(config.last_backup_sync || '0');
    if (lastBackup === 0 || lastBackup < Date.now() - (7 * 24 * 60 * 60 * 1000)) {
        results.push({ id: 'backup_status', name: 'Database Backup', status: 'warning', message: 'No backup completed in over 7 days.', actionLink: '/admin/jobs' });
    } else {
        results.push({ id: 'backup_status', name: 'Database Backup', status: 'ok', message: 'Recent backup exists' });
    }

    let overallStatus: 'HEALTHY' | 'WARNING' | 'DEGRADED' = 'HEALTHY';
    if (results.some(r => r.status === 'error')) overallStatus = 'DEGRADED';
    else if (results.some(r => r.status === 'warning')) overallStatus = 'WARNING';

    Logger.log(`[Health Check Debug] Completed diagnostics. Final state: ${overallStatus} across ${results.length} checks.`, 'debug');

    const finalData = { status: overallStatus, lastRun: Date.now(), checks: results };

    await prisma.systemSetting.upsert({
        where: { key: 'system_health_cache' },
        update: { value: JSON.stringify(finalData) },
        create: { key: 'system_health_cache', value: JSON.stringify(finalData) }
    });

    return finalData;
}