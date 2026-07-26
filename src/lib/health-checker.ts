// src/lib/health-checker.ts
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { CACHE_DIR, WATCHED_DIR, UNMATCHED_DIR } from '@/lib/utils/paths';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';
import { findDuplicateGroups } from '@/lib/duplicate-detector';
import { SystemNotifier } from '@/lib/notifications';
import packageJson from '../../package.json';

export interface HealthCheckResult {
    id: string;
    name: string;
    status: 'ok' | 'warning' | 'error';
    message: string;
    actionLink?: string;
    details?: string[];
    // Actionable request rows (id + label) for checks that support per-item snooze/dismiss in the UI
    // (stalled imports, awaiting-availability). Absent on purely informational checks.
    items?: { id: string; name: string }[];
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

    // 1b. Web/Engine version drift (hybrid deploy: the two images are released together, so a
    // mismatch means one container is stale — e.g. only one image got pulled/restarted).
    Logger.log(`[Health Check Debug] Checking Rust engine version for drift...`, 'debug');
    try {
        const webVersion = packageJson.version;
        const engRes = await fetch(`${ENGINE_URL}/health`, { headers: engineHeaders(), signal: AbortSignal.timeout(5000) });
        if (engRes.ok) {
            const eng = await engRes.json();
            const engineVersion = eng.version;
            Logger.log(`[Health Check Debug] Engine version: v${engineVersion} (release=${eng.release}); web: v${webVersion}`, 'debug');
            if (!eng.release) {
                results.push({ id: 'engine_version', name: 'Engine Version', status: 'ok', message: `Engine is a dev build (v${engineVersion}); drift check skipped.` });
            } else if (engineVersion === webVersion) {
                results.push({ id: 'engine_version', name: 'Engine Version', status: 'ok', message: `Web and engine in sync (v${engineVersion})` });
            } else {
                results.push({ id: 'engine_version', name: 'Engine Version', status: 'warning', message: `Version mismatch — web is v${webVersion}, engine is v${engineVersion}. Pull the latest images and restart so both match.`, actionLink: '/admin/updates' });
            }
        } else {
            results.push({ id: 'engine_version', name: 'Engine Version', status: 'warning', message: `Could not read the engine version (HTTP ${engRes.status}).` });
        }
    } catch(e) {
        Logger.log(`[Health Check Debug] Engine version check failed: ${getErrorMessage(e)}`, 'debug');
        // Unreachable is an ERROR, not a warning (issue #187): since v1.2.0 the engine sidecar is
        // REQUIRED — without it scans, conversions, downloads, metadata sync, and search all fail
        // with bare "fetch failed" job errors. The classic cause is a v1.1.x-era compose file with
        // no omnibus-engine service at all, so name that instead of leaving admins to decode
        // generic fetch failures.
        results.push({
            id: 'engine_version',
            name: 'Engine Version',
            status: 'error',
            message: `Engine unreachable at ${ENGINE_URL}. Omnibus v1.2+ requires the omnibus-engine container — scans, conversions, downloads, metadata sync, and search all run there. If you upgraded from v1.1.x, your docker-compose.yml predates the engine: add the omnibus-engine service and OMNIBUS_ENGINE_URL from the current README, giving the engine the same NEXTAUTH_SECRET and volume mounts as the web app.`,
        });
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

    // 5b. Solver responsiveness (issue field-report 2026-07-26): the engine's circuit breaker
    // stamps solver_unresponsive_time when the configured solver stops answering /v1 (a wedged
    // FlareSolverr queues requests forever) — every gated download silently degrades to manual
    // until the container restarts, so surface it loudly. The engine zeroes the flag when the
    // solver answers again; a stale stamp (>30 min) is treated as recovered.
    const solverDownTime = parseInt(config.solver_unresponsive_time || '0');
    if (hasFlare && solverDownTime > Date.now() - (30 * 60 * 1000)) {
        Logger.log(`[Health Check Debug] Cloudflare solver flagged unresponsive within the last 30 minutes.`, 'debug');
        results.push({
            id: 'solver_unresponsive',
            name: 'Cloudflare Solver Unresponsive',
            status: 'warning',
            message: 'The configured solver stopped answering — gated downloads are falling back to manual. Restart the solver container (a wedged FlareSolverr shows climbing "Task queue depth" in its log).',
            actionLink: '/admin/settings'
        });
    } else {
        results.push({ id: 'solver_unresponsive', name: 'Cloudflare Solver Unresponsive', status: 'ok', message: hasFlare ? 'No — the solver is answering' : 'No solver configured' });
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

    // GetComics 429 throttle — flag stamped by the engine's search/scrape backoff. A 429 clears on
    // its own and affected searches park as AWAITING_RELEASE and re-fire on the sweep cadence, so a
    // recent stamp is a warning (searches are degraded right now), never an error.
    const gcLimitTime = parseInt(config.getcomics_rate_limit_time || '0');
    if (gcLimitTime > Date.now() - (60 * 60 * 1000)) {
        results.push({ id: 'gc_limit', name: 'GetComics Rate Limit', status: 'warning', message: 'GetComics returned 429 (rate limited) within the last hour. Searches back off and retry automatically.' });
    } else {
        results.push({ id: 'gc_limit', name: 'GetComics Rate Limit', status: 'ok', message: 'Normal' });
    }

    // 7. DOWNLOAD CLIENT CONFIGURATION CHECK
    const downloadClientCount = await prisma.downloadClient.count();
    if (downloadClientCount === 0) {
        results.push({ id: 'dl_clients_config', name: 'Download Clients', status: 'error', message: 'No external clients (qBit, SABnzbd, etc.) configured. Automated Prowlarr downloading will not work.', actionLink: '/admin/settings' });
    } else {
        results.push({ id: 'dl_clients_config', name: 'Download Clients', status: 'ok', message: `${downloadClientCount} client(s) configured` });
    }

    // 8. External Client Import Errors (GENUINE failures only)
    // A STALLED request is a real problem needing intervention: a download that failed to import, or a
    // search flagged for admin disambiguation. "Searched everywhere, found nothing yet" is NOT here — it
    // lives in AWAITING_RELEASE and is reported as informational below, because that's expected for brand-
    // new / small-press titles and must not drive System Health to Degraded (issue #175). Snoozed items
    // (an admin dismissed the warning) are excluded until their snooze expires.
    const now = new Date();
    const notSnoozed = { OR: [{ snoozedUntil: null }, { snoozedUntil: { lt: now } }] };

    // Global toggle: admins who track niche/indie titles can disable stalled-request flagging entirely.
    const flagStalled = config.flag_stalled_requests !== 'false'; // default ON
    if (flagStalled) {
        const stalledReqs = await prisma.request.findMany({
            where: { status: 'STALLED', retryCount: { gte: 3 }, ...notSnoozed },
            select: { id: true, activeDownloadName: true }
        });
        if (stalledReqs.length > 0) {
            const stalledNames = stalledReqs.map(r => r.activeDownloadName || `Request ID: ${r.id}`);
            results.push({
                id: 'stalled_dls',
                name: 'External Client Import Errors',
                status: 'error',
                message: `${stalledReqs.length} download(s) failed to import or need review. They are stuck in the active queue and require manual intervention (check path mappings, permissions, or run an Interactive Search).`,
                actionLink: '/admin',
                details: stalledNames,
                items: stalledReqs.map(r => ({ id: r.id, name: r.activeDownloadName || `Request ID: ${r.id}` }))
            });
        } else {
            results.push({ id: 'stalled_dls', name: 'External Client Imports', status: 'ok', message: 'All imports successful' });
        }
    } else {
        results.push({ id: 'stalled_dls', name: 'External Client Imports', status: 'ok', message: 'Stalled-request flagging is disabled in settings' });
    }

    // 8b. Awaiting Availability (informational — never an error)
    // Requests that couldn't be found on any source yet. Omnibus keeps retrying on a slow cadence
    // (awaiting_retry_days). This surfaces them without penalising overall health.
    const awaitingReqs = await prisma.request.findMany({
        where: { status: 'AWAITING_RELEASE', ...notSnoozed },
        select: { id: true, activeDownloadName: true }
    });
    if (awaitingReqs.length > 0) {
        results.push({
            id: 'awaiting_release',
            name: 'Awaiting Availability',
            status: 'ok',
            message: `${awaitingReqs.length} request(s) aren't available on any source yet — Omnibus will keep retrying automatically. This is normal for brand-new or small-press titles.`,
            actionLink: '/admin',
            details: awaitingReqs.map(r => r.activeDownloadName || `Request ID: ${r.id}`),
            items: awaitingReqs.map(r => ({ id: r.id, name: r.activeDownloadName || `Request ID: ${r.id}` }))
        });
    }

    // 9. Cache Integrity Check
    const cacheDir = CACHE_DIR;
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

    // 9b. Watched & Unmatched Directory Check
    // Both default to container-root mount points. If neither the env var nor a
    // volume mount is in place, anything written there lands in the container's
    // ephemeral layer and is lost on recreation — surface that before it bites.
    const ingestDirChecks = [
        {
            id: 'watched_dir', name: 'Watched Directory', dir: WATCHED_DIR,
            missingMsg: `Watched directory (${WATCHED_DIR}) does not exist. Watched-folder imports are disabled. Verify the volume mount or OMNIBUS_WATCHED_DIR.`
        },
        {
            id: 'unmatched_dir', name: 'Unmatched Directory', dir: UNMATCHED_DIR,
            missingMsg: `Unmatched directory (${UNMATCHED_DIR}) does not exist. Files sent to UNMATCHED would be written inside the container and lost on recreation. Verify the volume mount or OMNIBUS_AWAITING_MATCH_DIR.`
        }
    ];
    for (const check of ingestDirChecks) {
        if (!fs.existsSync(check.dir)) {
            results.push({ id: check.id, name: check.name, status: 'warning', message: check.missingMsg });
        } else {
            try {
                await fs.promises.access(check.dir, fs.constants.W_OK | fs.constants.R_OK);
                results.push({ id: check.id, name: check.name, status: 'ok', message: `${check.dir} is accessible and writable` });
            } catch (e) {
                results.push({ id: check.id, name: check.name, status: 'warning', message: `${check.dir} exists but lacks Read/Write permissions. Imports through this folder will fail.` });
            }
        }
    }

    // 10. Backup Status
    const lastBackup = parseInt(config.last_backup_sync || '0');
    if (lastBackup === 0 || lastBackup < Date.now() - (7 * 24 * 60 * 60 * 1000)) {
        results.push({ id: 'backup_status', name: 'Database Backup', status: 'warning', message: 'No backup completed in over 7 days.', actionLink: '/admin/jobs' });
    } else {
        results.push({ id: 'backup_status', name: 'Database Backup', status: 'ok', message: 'Recent backup exists' });
    }

    // 11. Duplicate Files (library-wide). The per-series page already flags dupes, but only when an
    // admin opens that specific series — this surfaces every affected series in one dashboard alert,
    // and pushes a notification (Discord/Telegram/etc., for subscribers of the "Duplicate Files Found"
    // event) when NEW duplicates appear since the last run.
    Logger.log(`[Health Check Debug] Scanning for duplicate files across the library...`, 'debug');
    try {
        const dupeGroups = await findDuplicateGroups();
        if (dupeGroups.length > 0) {
            const perSeries = new Map<string, number>();
            for (const g of dupeGroups) perSeries.set(g.seriesName, (perSeries.get(g.seriesName) || 0) + 1);
            const details = Array.from(perSeries.entries())
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([seriesName, count]) => `${seriesName} — ${count} duplicated issue${count > 1 ? 's' : ''}`);
            // Suspected mispairs (issue #196) get a steer toward Refresh Metadata — for those groups
            // the "duplicates" are different comics sharing one DB number, and deletion loses data.
            const mispairs = dupeGroups.filter(g => g.suspectedMispair).length;
            const mispairHint = mispairs > 0
                ? ` ${mispairs} group${mispairs > 1 ? 's' : ''} look${mispairs > 1 ? '' : 's'} like a metadata mispair (different issues sharing one number) — use Refresh Metadata on that series instead of deleting.`
                : '';
            results.push({
                id: 'duplicate_files',
                name: 'Duplicate Files',
                status: 'warning',
                message: `${perSeries.size} series contain duplicate files (${dupeGroups.length} duplicated issue${dupeGroups.length > 1 ? 's' : ''}). Review and clean them up in Diagnostics.${mispairHint}`,
                actionLink: '/admin/diagnostics?tab=duplicates',
                details,
            });

            // Push a notification only when NEW duplicates appear since the last run, so a standing
            // backlog doesn't re-spam every health cycle. Signature = the set of (series, issue) keys.
            const currentKeys = dupeGroups.map(g => `${g.seriesId}_${g.issueNumber}`).sort();
            let previousKeys: string[] = [];
            try { previousKeys = JSON.parse(config.duplicate_alert_signature || '[]'); } catch { previousKeys = []; }
            const prevSet = new Set(previousKeys);
            const newKeys = currentKeys.filter(k => !prevSet.has(k));

            if (newKeys.length > 0) {
                const newSeries = Array.from(new Set(
                    dupeGroups.filter(g => !prevSet.has(`${g.seriesId}_${g.issueNumber}`)).map(g => g.seriesName)
                )).sort();
                const shown = newSeries.slice(0, 10).join(', ');
                const more = newSeries.length > 10 ? ` +${newSeries.length - 10} more` : '';
                Logger.log(`[Health Check] ${newKeys.length} new duplicate(s) detected — sending notification.`, 'info');
                await SystemNotifier.sendAlert('duplicate_files', {
                    title: 'Duplicate Files Found',
                    description: `${perSeries.size} series contain duplicate files (${dupeGroups.length} duplicated issue${dupeGroups.length > 1 ? 's' : ''}). Newly flagged: ${shown}${more}. Review them in Diagnostics → Duplicates.${mispairHint}`,
                }).catch(() => {});
            }

            await prisma.systemSetting.upsert({
                where: { key: 'duplicate_alert_signature' },
                update: { value: JSON.stringify(currentKeys) },
                create: { key: 'duplicate_alert_signature', value: JSON.stringify(currentKeys) },
            });
        } else {
            results.push({ id: 'duplicate_files', name: 'Duplicate Files', status: 'ok', message: 'No duplicate files detected' });
            // Reset the signature so a future re-occurrence notifies again.
            if (config.duplicate_alert_signature && config.duplicate_alert_signature !== '[]') {
                await prisma.systemSetting.upsert({
                    where: { key: 'duplicate_alert_signature' },
                    update: { value: '[]' },
                    create: { key: 'duplicate_alert_signature', value: '[]' },
                });
            }
        }
    } catch (e) {
        Logger.log(`[Health Check Debug] Duplicate file scan failed: ${getErrorMessage(e)}`, 'debug');
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