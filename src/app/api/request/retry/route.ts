// src/app/api/request/retry/route.ts
import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { DownloadService } from '@/lib/download-clients';
import { Logger } from '@/lib/logger';
import { GetComicsService } from '@/lib/getcomics';
import { getCustomAcronyms, generateSearchQueries } from '@/lib/search-engine'; 
import { Importer } from '@/lib/importer';

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

        const settings = await prisma.systemSetting.findMany();
        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
        const safeTitle = (req.activeDownloadName || "comic").replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();

        let year = "";
        let isManga = false;
        if (req.volumeId && req.volumeId !== "0") {
            const series = await prisma.series.findFirst({ 
                where: { metadataId: req.volumeId, metadataSource: 'COMICVINE' } 
            });
            if (series) {
                year = series.year.toString();
                isManga = series.isManga;
            }
        }

        // Dynamically load enabled hosters from settings
        let hasEnabledHosters = true;
        let enabledHosters = ['mediafire', 'getcomics', 'mega', 'pixeldrain', 'rootz', 'vikingfile', 'terabox', 'annas_archive'];
        
        if (config.hoster_priority) {
            try {
                const parsed = JSON.parse(config.hoster_priority);
                if (parsed.length > 0) {
                    if (typeof parsed[0] === 'string') {
                        enabledHosters = parsed;
                    } else if (typeof parsed[0] === 'object') {
                        enabledHosters = parsed.filter((p: any) => p.enabled).map((p: any) => p.hoster);
                    }
                    hasEnabledHosters = enabledHosters.length > 0;
                } else {
                    enabledHosters = [];
                    hasEnabledHosters = false;
                }
            } catch(e) {}
        }

        // 1. GetComics Scrape Retry
        if (req.downloadLink && req.downloadLink.includes('getcomics.org') && !req.downloadLink.match(/\.(cbz|cbr|zip)$/i)) {
            Logger.log(`[Retry] Scraping fresh link for: ${req.downloadLink}`, 'info');
            
            const { url, hoster } = await GetComicsService.scrapeDeepLink(req.downloadLink);
            
            // AIRTIGHT CHECK: Strictly check against enabledHosters
            if (enabledHosters.includes(hoster)) {
                await prisma.request.update({
                    where: { id },
                    data: { status: 'DOWNLOADING', retryCount: 0, progress: 0 }
                });

                DownloadService.downloadDirectFile(url, safeTitle, config.download_path, req.id, hoster)
                    .then(async (success) => {
                        if (success) {
                            await new Promise(r => setTimeout(r, 2000));
                            await Importer.importRequest(req.id);
                        }
                    })
                    .catch(() => {});
                
                return NextResponse.json({ success: true, message: `Fresh link found via ${hoster === 'getcomics' ? 'Direct' : hoster}, download started.` });
            } else {
                Logger.log(`[Retry] Scraped hoster (${hoster}) is disabled in settings. Falling back to recovery search.`, 'info');
            }
        }

        // 2. Standard direct link retry (for non-GetComics links)
        if (req.downloadLink && req.downloadLink.startsWith('http') && !req.downloadLink.includes('getcomics.org')) {
            await prisma.request.update({
                where: { id },
                data: { status: 'DOWNLOADING', retryCount: 0, progress: 0, activeDownloadName: safeTitle }
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
        
        // 3. Recovery Fuzzy Search
        if (hasEnabledHosters) {
            Logger.log(`[Retry] No direct link found for ${req.id}, attempting recovery fuzzy search...`, 'info');
            
            const acronyms = await getCustomAcronyms();
            const queries = generateSearchQueries(req.activeDownloadName || "", year, acronyms, isManga); 
            let results: any[] = [];
            
            for (const q of queries) {
                results = await GetComicsService.search(q, false, isManga); 
                if (results.length > 0) break;
            }
            
            if (results.length > 0) {
                const best = results[0];
                const { url, hoster } = await GetComicsService.scrapeDeepLink(best.downloadUrl);
                
                // AIRTIGHT CHECK: Strictly check against enabledHosters
                if (enabledHosters.includes(hoster)) {
                    const safeSearchTitle = best.title.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();

                    await prisma.request.update({
                        where: { id },
                        data: { status: 'DOWNLOADING', retryCount: 0, progress: 0, downloadLink: url, activeDownloadName: safeSearchTitle }
                    });

                    DownloadService.downloadDirectFile(url, safeSearchTitle, config.download_path, req.id, hoster)
                        .then(async (success) => {
                            if (success) {
                                await new Promise(r => setTimeout(r, 2000));
                                await Importer.importRequest(req.id);
                            }
                        })
                        .catch(() => {});
                    return NextResponse.json({ success: true, message: `Link recovered via ${hoster === 'getcomics' ? 'Direct' : hoster} and download started.` });
                } else {
                    Logger.log(`[Retry] Recovered hoster (${hoster}) is disabled in settings.`, 'warn');
                }
            }
        } else {
            Logger.log(`[Retry] All file hosters disabled in settings. Skipping recovery fuzzy search.`, 'info');
        }

        return NextResponse.json({ error: "Direct download link lost or hosters disabled. Please delete and re-request this comic." }, { status: 400 });
        
    } catch (e: any) {
        Logger.log(`[Retry API] Error: ${e.message}`, 'error');
        return NextResponse.json({ error: "Failed to retry request. Please check server logs." }, { status: 500 });
    }
}