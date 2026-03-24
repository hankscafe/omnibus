import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { DownloadService } from '@/lib/download-clients';
import { Logger } from '@/lib/logger';
import { GetComicsService } from '@/lib/getcomics';
import { getCustomAcronyms, generateSearchQueries } from '@/lib/search-engine'; 
import { Importer } from '@/lib/importer';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    try {
        const { id } = await request.json();
        const req = await prisma.request.findUnique({ where: { id } });
        if (!req) return NextResponse.json({ error: "Request not found" }, { status: 404 });

        Logger.log(`[Retry] Manually restarting download for request: ${req.activeDownloadName || req.id}`, 'info');

        const settings = await prisma.systemSetting.findMany();
        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

        let year = "";
        let isManga = false; // <-- ADDED
        if (req.volumeId) {
            const series = await prisma.series.findUnique({ where: { cvId: parseInt(req.volumeId) } });
            if (series) {
                year = series.year.toString();
                isManga = series.isManga; // <-- Fetched
            }
        }

        if (req.downloadLink && req.downloadLink.startsWith('http')) {
            const safeTitle = (req.activeDownloadName || "comic").replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();
            
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
        
        Logger.log(`[Retry] No link found for ${req.id}, attempting recovery fuzzy search...`, 'info');
        
        const acronyms = await getCustomAcronyms();
        // Passed isManga down
        const queries = generateSearchQueries(req.activeDownloadName || "", year, acronyms, isManga); 
        let results: any[] = [];
        
        for (const q of queries) {
            results = await GetComicsService.search(q, false, isManga); // Passed isManga down
            if (results.length > 0) break;
        }
        
        if (results.length > 0) {
            const best = results[0];
            const { url, isDirect } = await GetComicsService.scrapeDeepLink(best.downloadUrl);
            
            if (isDirect) {
                const safeTitle = best.title.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();

                await prisma.request.update({
                    where: { id },
                    data: { status: 'DOWNLOADING', retryCount: 0, progress: 0, downloadLink: url, activeDownloadName: safeTitle }
                });

                DownloadService.downloadDirectFile(url, safeTitle, config.download_path, req.id)
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