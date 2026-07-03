// src/app/api/request/retry/route.ts
import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { DownloadService } from '@/lib/download-clients';
import { Logger } from '@/lib/logger';
import { enabledHostersFromSetting, scrapeDeepLinkViaEngine } from '@/lib/getcomics';
import { Importer } from '@/lib/importer';
import { omnibusQueue } from '@/lib/queue';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
    const token = await getToken({ req: request });
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const userId = (token.id || token.sub) as string;
    
    const userExists = await prisma.user.findUnique({ where: { id: userId } });
    if (!userExists) {
        return NextResponse.json({ error: 'Your session is invalid. Please log out and log back in.' }, { status: 401 });
    }

    try {
        const { id } = await request.json();
        const req = await prisma.request.findUnique({ where: { id } });
        if (!req) return NextResponse.json({ error: "Request not found" }, { status: 404 });

        // Ownership gate: only the request's owner (or an admin) may retry it — otherwise any
        // authenticated user could re-trigger downloads on someone else's request by guessing its id.
        if (req.userId !== userId && userExists.role !== 'ADMIN') {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        // --- NEW: PURGE GHOST JOBS ---
        // Find any delayed/waiting automated jobs in BullMQ related to this specific request and obliterate them
        try {
            const existingJobs = await omnibusQueue.getJobs(['waiting', 'delayed', 'active', 'paused']);
            let purged = 0;
            for (const job of existingJobs) {
                if (job.id === `SEARCH_${id}` || job.data?.requestId === id) {
                    await job.remove();
                    purged++;
                }
            }
            if (purged > 0) Logger.log(`[Retry API] Purged ${purged} conflicting ghost jobs from BullMQ for "${req.activeDownloadName || id}"`, 'info');
        } catch (queueErr) {
            Logger.log(`[Retry API] Non-fatal error purging jobs: ${queueErr}`, 'warn');
        }
        // -----------------------------

        const settings = await prisma.systemSetting.findMany();
        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
        const safeTitle = (req.activeDownloadName || "comic").replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();

        let year = "";
        let isManga = false;
        if (req.volumeId && req.volumeId !== "0") {
            const series = await prisma.series.findFirst({ 
                where: { metadataId: req.volumeId, metadataSource: req.metadataSource || 'COMICVINE' } 
            });
            if (series) {
                year = series.year.toString();
                isManga = series.isManga;
            }
        }

        const ddlSetting = await prisma.systemSetting.findUnique({ where: { key: 'ddl_enabled' } });
        const ddlEnabled = ddlSetting?.value !== 'false';

        // Enabled hosters in priority order (migrates the legacy `getcomics` key → direct + main).
        const enabledHosters = enabledHostersFromSetting(config.hoster_priority);
        const hasEnabledHosters = enabledHosters.length > 0;

        // 0. Cloudflare-gated GetComics "main server" link (getcomics.org/dls/…). This is a direct
        // download endpoint, NOT an article page — re-scraping it for hoster buttons is pointless (it
        // returns the file or a Cloudflare challenge, which is the source of the spurious 500 in the
        // logs). Re-stream it straight through the engine, which solves Cloudflare via FlareSolverr.
        // Gated on GetComics being enabled; a failed stream clears the dead link so the next retry runs
        // a fresh recovery search instead of looping on it.
        if (req.downloadLink && /getcomics\.org\/dls\//i.test(req.downloadLink) && enabledHosters.includes('getcomics_main')) {
            Logger.log(`[Retry] Re-streaming GetComics direct download link via engine: ${req.downloadLink}`, 'info');
            await prisma.request.update({
                where: { id },
                data: { status: 'DOWNLOADING', retryCount: 0, progress: 0, failedLinks: "[]" }
            });
            DownloadService.downloadDirectFile(req.downloadLink, safeTitle, config.download_path, req.id, 'getcomics_main')
                .then(async (success) => {
                    if (success) {
                        await new Promise(r => setTimeout(r, 2000));
                        await Importer.importRequest(req.id);
                    }
                })
                .catch(async () => {
                    // The stored /dls/ link failed (expired/blocked) — clear it so the next retry falls
                    // through to a fresh recovery search rather than looping on a dead link.
                    await prisma.request.update({ where: { id }, data: { downloadLink: null } }).catch(() => {});
                });
            return NextResponse.json({ success: true, message: 'Re-streaming GetComics direct download link via engine.' });
        }

        // 1. GetComics Scrape Retry
        if (req.downloadLink && req.downloadLink.includes('getcomics.org') && !req.downloadLink.match(/\.(cbz|cbr|zip)$/i)) {
            Logger.log(`[Retry] Scraping fresh link for: ${req.downloadLink}`, 'info');

            // Section-targeting scrape via the engine: on a multi-pack article it targets the requested
            // issue's archive instead of grabbing an arbitrary one (empty hoster / ambiguous → fall
            // through to the recovery search below).
            const { url, hoster } = await scrapeDeepLinkViaEngine(req.downloadLink, { name: req.activeDownloadName, year });

            // AIRTIGHT CHECK: Strictly check against enabledHosters
            if (enabledHosters.includes(hoster)) {
                await prisma.request.update({
                    where: { id },
                    data: { status: 'DOWNLOADING', retryCount: 0, progress: 0, failedLinks: "[]" }
                });

                DownloadService.downloadDirectFile(url, safeTitle, config.download_path, req.id, hoster)
                    .then(async (success) => {
                        if (success) {
                            await new Promise(r => setTimeout(r, 2000));
                            await Importer.importRequest(req.id);
                        }
                    })
                    .catch(() => {});
                
                return NextResponse.json({ success: true, message: `Fresh link found via ${hoster.startsWith('getcomics') ? 'Direct' : hoster}, download started.` });
            } else {
                Logger.log(`[Retry] Scraped hoster (${hoster}) is disabled in settings. Falling back to recovery search.`, 'info');
            }
        }

        // 2. Standard direct link retry (for non-GetComics links)
        if (req.downloadLink && req.downloadLink.startsWith('http') && !req.downloadLink.includes('getcomics.org')) {
            await prisma.request.update({
                where: { id },
                data: { status: 'DOWNLOADING', retryCount: 0, progress: 0, activeDownloadName: safeTitle, failedLinks: "[]" }
            });
            DownloadService.downloadDirectFile(req.downloadLink, safeTitle, config.download_path, req.id)
                .then(async (success) => {
                    if (success) {
                        await new Promise(r => setTimeout(r, 2000));
                        await Importer.importRequest(req.id);
                    }
                })
                .catch(()=> {});
            return NextResponse.json({ success: true });
        } 
        
        // 3. Recovery Fuzzy Search — fully delegated to the engine's automation search (the last
        // caller of the duplicate Node GetComics search stack, now retired). The engine generates
        // the query ladder itself (acronyms included), searches the configured DDL sources, and
        // returns already-scraped, hoster-ranked links. skip_indexers keeps recovery DDL-only,
        // matching the old GetComics-only behavior.
        if (ddlEnabled && hasEnabledHosters) {
            Logger.log(`[Retry] No direct link found for "${req.activeDownloadName || req.id}", attempting recovery fuzzy search via engine...`, 'info');

            let failedItems: string[] = [];
            try { failedItems = JSON.parse((req as any).failedLinks || "[]"); } catch { failedItems = []; }

            let resultData: any = null;
            try {
                const engineRes = await fetch(ENGINE_URL + '/api/automation/search', {
                    method: 'POST',
                    headers: engineHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        request_id: id,
                        name: req.activeDownloadName || safeTitle,
                        year: year || null,
                        series_year: year || null,
                        allow_packs: true, // the global allow_bulk_packs setting still gates this engine-side
                        is_manga: isManga,
                        skip_indexers: true,
                        failed_links: failedItems
                    })
                });
                if (engineRes.ok) resultData = await engineRes.json();
                else Logger.log(`[Retry] Engine recovery search returned ${engineRes.status}.`, 'warn');
            } catch (e: any) {
                Logger.log(`[Retry] Engine recovery search unavailable: ${e.message}`, 'warn');
            }

            if (resultData?.success && resultData.best_match?.protocol === 'ddl') {
                const best = resultData.best_match;
                const candidates: { url: string, hoster: string }[] =
                    (Array.isArray(resultData.ddl_candidates) && resultData.ddl_candidates.length > 0)
                        ? resultData.ddl_candidates
                        : [{ url: best.downloadUrl, hoster: best.indexer }];

                // AIRTIGHT CHECK: take the first candidate on an enabled hoster (the engine already
                // ranks them by the user's hoster priority).
                const cand = candidates.find(c => enabledHosters.includes(c.hoster));
                if (cand) {
                    const safeSearchTitle = best.title.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();

                    const duplicateDownload = await prisma.request.findFirst({
                        where: {
                            downloadLink: cand.url,
                            status: { in: ['DOWNLOADING', 'IMPORTED', 'COMPLETED'] },
                            id: { not: id }
                        }
                    });

                    if (duplicateDownload) {
                         Logger.log(`[Retry] Batch pack already downloading or downloaded (${cand.url}). Queuing for batch extraction.`, 'info');
                         await prisma.request.update({
                             where: { id },
                             data: { status: 'DOWNLOADING', retryCount: 0, progress: 0, activeDownloadName: safeSearchTitle, downloadLink: cand.url, failedLinks: "[]" }
                         });
                         return NextResponse.json({ success: true, message: `Link recovered via ${cand.hoster.startsWith('getcomics') ? 'Direct' : cand.hoster} and queued for batch extraction.` });
                    }
                    await prisma.request.update({
                        where: { id },
                        data: { status: 'DOWNLOADING', retryCount: 0, progress: 0, downloadLink: cand.url, activeDownloadName: safeSearchTitle, failedLinks: "[]" }
                    });

                    DownloadService.downloadDirectFile(cand.url, safeSearchTitle, config.download_path, req.id, cand.hoster)
                        .then(async (success) => {
                            if (success) {
                                await new Promise(r => setTimeout(r, 2000));
                                await Importer.importRequest(req.id);
                            }
                        })
                        .catch(() => {});
                    return NextResponse.json({ success: true, message: `Link recovered via ${cand.hoster.startsWith('getcomics') ? 'Direct' : cand.hoster} and download started.` });
                } else {
                    Logger.log(`[Retry] Recovered link's hosters are all disabled in settings.`, 'warn');
                }
            } else if (resultData?.manual_ddl?.url) {
                // The engine matched but only on a Cloudflare-gated/disabled hoster — hold the link
                // for one-click manual pickup instead of failing (same seam as the automation queue).
                Logger.log(`[Retry] Recovery found a manual-only link for "${req.activeDownloadName || req.id}". Holding as MANUAL_DDL.`, 'info');
                await prisma.request.update({
                    where: { id },
                    data: { status: 'MANUAL_DDL', downloadLink: resultData.manual_ddl.url, activeDownloadName: resultData.manual_ddl.name || req.activeDownloadName || safeTitle }
                });
                return NextResponse.json({ success: true, message: 'Link recovered but requires a manual download. Check the Active Downloads queue.' });
            }
        } else {
            Logger.log(`[Retry] Direct Downloads disabled in settings. Skipping recovery fuzzy search.`, 'info');
        }

        return NextResponse.json({ error: "Direct download link lost or hosters disabled. Please delete and re-request this comic." }, { status: 400 });
        
    } catch (e: any) {
        Logger.log(`[Retry API] Error: ${e.message}`, 'error');
        return NextResponse.json({ error: "Failed to retry request. Please check server logs." }, { status: 500 });
    }
}