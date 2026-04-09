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

        // --- FIX: Fetch series context to define 'year' and 'isManga' for fuzzy search ---
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

        // 1. GetComics Scrape Retry
        if (req.downloadLink && req.downloadLink.includes('getcomics.org') && !req.downloadLink.match(/\.(cbz|cbr|zip)$/i)) {
            Logger.log(`[Retry] Scraping fresh link for: ${req.downloadLink}`, 'info');
            
            const { url, isDirect } = await GetComicsService.scrapeDeepLink(req.downloadLink);
            
            if (isDirect) {
                await prisma.request.update({
                    where: { id },
                    data: { status: 'DOWNLOADING', retryCount: 0, progress: 0 }
                });

                DownloadService.downloadDirectFile(url, safeTitle, config.download_path, req.id)
                    .then(async (success) => {
                        if (success) {
                            await new Promise(r => setTimeout(r, 2000));
                            await Importer.importRequest(req.id);
                        }
                    })
                    .catch(() => {});
                
                return NextResponse.json({ success: true, message: "Fresh link found, download started." });
            }
        }

        // 2. Standard direct link retry (for non-GetComics links)
        if (req.downloadLink && req.downloadLink.startsWith('http')) {
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
        
        // 3. Recovery Fuzzy Search (Uses the variables defined above)
        Logger.log(`[Retry] No link found for ${req.id}, attempting recovery fuzzy search...`, 'info');
        
        const acronyms = await getCustomAcronyms();
        const queries = generateSearchQueries(req.activeDownloadName || "", year, acronyms, isManga); 
        let results: any[] = [];
        
        for (const q of queries) {
            results = await GetComicsService.search(q, false, isManga); 
            if (results.length > 0) break;
        }
        
        if (results.length > 0) {
            const best = results[0];
            const { url, isDirect } = await GetComicsService.scrapeDeepLink(best.downloadUrl);
            
            if (isDirect) {
                // Variable is declared correctly here
                const safeSearchTitle = best.title.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();

                await prisma.request.update({
                    where: { id },
                    // FIX: Changed safeSearchSearchTitle to safeSearchTitle
                    data: { status: 'DOWNLOADING', retryCount: 0, progress: 0, downloadLink: url, activeDownloadName: safeSearchTitle }
                });

                // FIX: Changed safeSearchSearchTitle to safeSearchTitle
                DownloadService.downloadDirectFile(url, safeSearchTitle, config.download_path, req.id)
                    .then(async (success) => {
                        if (success) {
                            await new Promise(r => setTimeout(r, 2000));
                            await Importer.importRequest(req.id);
                        }
                    })
                    .catch(() => {});
                return NextResponse.json({ success: true, message: "Link recovered and download started." });
            }
        }

        return NextResponse.json({ error: "Direct download link lost. Please delete and re-request this comic." }, { status: 400 });
        
    } catch (e: any) {
        Logger.log(`[Retry API] Error: ${e.message}`, 'error');
        return NextResponse.json({ error: "Failed to retry request. Please check server logs." }, { status: 500 });
    }
}