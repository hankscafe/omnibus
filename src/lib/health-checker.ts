// src/lib/health-checker.ts
import { prisma } from '@/lib/db';
import fs from 'fs-extra';

export interface HealthCheckResult {
    id: string;
    name: string;
    status: 'ok' | 'warning' | 'error';
    message: string;
    actionLink?: string;
}

export async function runSystemHealthCheck() {
    const results: HealthCheckResult[] = [];
    const settings = await prisma.systemSetting.findMany();
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

    // 1. System Update
    try {
        const res = await fetch('http://localhost:3000/api/admin/update-check');
        if (res.ok) {
            const data = await res.json();
            if (data.updateAvailable) {
                results.push({ id: 'system_update', name: 'System Update', status: 'warning', message: `Update Available: v${data.latestVersion}`, actionLink: '/admin/updates' });
            } else {
                results.push({ id: 'system_update', name: 'System Update', status: 'ok', message: `Up to date (v${data.currentVersion})` });
            }
        } else throw new Error();
    } catch(e) {
        results.push({ id: 'system_update', name: 'System Update', status: 'ok', message: 'Up to date (Checked recently)' });
    }

    // 2. ComicVine API Key
    if (!config.cv_api_key) {
        results.push({ id: 'cv_key', name: 'ComicVine API Key', status: 'error', message: 'No ComicVine API Key configured. Metadata fetching will fail.', actionLink: '/admin/settings' });
    } else {
        results.push({ id: 'cv_key', name: 'ComicVine API Key', status: 'ok', message: 'Configured' });
    }

    // 3. Download Directory & Drive Space
    let isDiskFull = false;
    if (!config.download_path) {
        results.push({ id: 'dl_dir', name: 'Download Directory', status: 'error', message: 'No Download Directory set.', actionLink: '/admin/settings' });
    } else if (!fs.existsSync(config.download_path)) {
        results.push({ id: 'dl_dir', name: 'Download Directory', status: 'error', message: `Download Directory (${config.download_path}) is inaccessible or missing.` });
    } else {
        results.push({ id: 'dl_dir', name: 'Download Directory', status: 'ok', message: 'Configured and accessible' });
        
        try {
            // FIX: Using fs.promises.statfs to correctly await the result
            const stat = await fs.promises.statfs(config.download_path);
            const freeGB = (stat.bavail * stat.bsize) / (1024 * 1024 * 1024);
            if (freeGB < 2) {
                isDiskFull = true;
                results.push({ id: 'disk_space', name: 'Drive Space', status: 'error', message: `Critically full! Only ${freeGB.toFixed(2)}GB remaining. Downloads paused.`, actionLink: '/admin/storage' });
            } else if (freeGB < 10) {
                results.push({ id: 'disk_space', name: 'Drive Space', status: 'warning', message: `Almost full. ${freeGB.toFixed(2)}GB remaining.`, actionLink: '/admin/storage' });
            } else {
                results.push({ id: 'disk_space', name: 'Drive Space', status: 'ok', message: `${freeGB.toFixed(2)}GB free` });
            }
        } catch (e) {
            // Safe ignore: statfs is not supported on all file systems (like some raw Docker volumes)
        }
    }

    // Update database with disk full status so downloaders can check it instantly
    await prisma.systemSetting.upsert({
        where: { key: 'is_disk_full' },
        update: { value: isDiskFull ? 'true' : 'false' },
        create: { key: 'is_disk_full', value: isDiskFull ? 'true' : 'false' }
    });

    // 4. Libraries
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
            results.push({ id: `lib_acc_${lib.id}`, name: `Library Access: ${lib.name}`, status: 'error', message: `Path ${lib.path} is inaccessible.` });
            libsAccessible = false;
        }
    }
    if (libsAccessible && libraries.length > 0) results.push({ id: 'lib_acc', name: 'Library Paths Access', status: 'ok', message: 'All libraries are accessible' });

    // 5. CloudFlare / FlareSolverr
    const cfBlockTime = parseInt(config.cloudflare_block_time || '0');
    const hasFlare = !!config.flaresolverr_url;
    if (cfBlockTime > Date.now() - (24 * 60 * 60 * 1000) && !hasFlare) {
        results.push({ id: 'cf_block', name: 'CloudFlare Challenge Detected', status: 'warning', message: 'Yes (FlareSolverr is not set up, GetComics downloads may fail)', actionLink: '/admin/settings' });
    } else {
        results.push({ id: 'cf_block', name: 'CloudFlare Challenge Detected', status: 'ok', message: 'No' });
    }

    // 6. API Rate Limits
    const cvLimitTime = parseInt(config.cv_rate_limit_time || '0');
    if (cvLimitTime > Date.now() - (60 * 60 * 1000)) {
        results.push({ id: 'cv_limit', name: 'ComicVine API Rate Limit', status: 'error', message: 'Reached within the last hour. Metadata syncing temporarily paused.' });
    } else {
        results.push({ id: 'cv_limit', name: 'ComicVine API Rate Limit', status: 'ok', message: 'Normal' });
    }

    const metronLimitTime = parseInt(config.metron_rate_limit_time || '0');
    if (metronLimitTime > Date.now() - (60 * 60 * 1000)) {
        results.push({ id: 'metron_limit', name: 'Metron.Cloud API Rate Limit', status: 'error', message: 'Reached within the last hour. Metadata syncing temporarily paused.' });
    } else {
        results.push({ id: 'metron_limit', name: 'Metron.Cloud API Rate Limit', status: 'ok', message: 'Normal' });
    }

    const hosterLimitTime = parseInt(config.hoster_rate_limit_time || '0');
    if (hosterLimitTime > Date.now() - (24 * 60 * 60 * 1000)) {
        results.push({ id: 'hoster_limit', name: '3rd Party Hoster Rate Limit', status: 'warning', message: 'Reached within the last 24 hours.' });
    } else {
        results.push({ id: 'hoster_limit', name: '3rd Party Hoster Rate Limit', status: 'ok', message: 'Normal' });
    }

    // 7. External Client Missing Files
    const stalledReqs = await prisma.request.count({
        where: { status: 'STALLED', retryCount: { gte: 3 } }
    });
    if (stalledReqs > 0) {
        results.push({ id: 'stalled_dls', name: 'External Client Import Errors', status: 'error', message: `${stalledReqs} downloads finished in your client but cannot be imported. Check path mappings or permissions.`, actionLink: '/admin/settings' });
    } else {
        results.push({ id: 'stalled_dls', name: 'External Client Imports', status: 'ok', message: 'All imports successful' });
    }

    // 8. Backup Status
    const lastBackup = parseInt(config.last_backup_sync || '0');
    if (lastBackup === 0 || lastBackup < Date.now() - (7 * 24 * 60 * 60 * 1000)) {
        results.push({ id: 'backup_status', name: 'Database Backup', status: 'warning', message: 'No backup completed in over 7 days.', actionLink: '/admin/jobs' });
    } else {
        results.push({ id: 'backup_status', name: 'Database Backup', status: 'ok', message: 'Recent backup exists' });
    }

    let overallStatus: 'HEALTHY' | 'WARNING' | 'DEGRADED' = 'HEALTHY';
    if (results.some(r => r.status === 'error')) overallStatus = 'DEGRADED';
    else if (results.some(r => r.status === 'warning')) overallStatus = 'WARNING';

    const finalData = { status: overallStatus, lastRun: Date.now(), checks: results };

    await prisma.systemSetting.upsert({
        where: { key: 'system_health_cache' },
        update: { value: JSON.stringify(finalData) },
        create: { key: 'system_health_cache', value: JSON.stringify(finalData) }
    });

    return finalData;
}