import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { Logger } from '@/lib/logger';
import { DownloadService } from '@/lib/download-clients';
import { GetComicsService } from '@/lib/getcomics';
import { checkTrophies } from '@/lib/trophies'; 
import { getCustomAcronyms, generateSearchQueries } from '@/lib/search-engine'; 
import { Importer } from '@/lib/importer';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const token = await getToken({ req: request });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const { cvId, name, year, publisher, image, type, searchResult, source } = body;

    if (!cvId || !name) return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });

    Logger.log(`[Manual Request] User ${token.name} initiated request for: ${name}`, 'info');

    const newReq = await prisma.request.create({
      data: {
        userId: token.id as string,
        volumeId: cvId.toString(),
        status: 'DOWNLOADING',
        activeDownloadName: searchResult?.title || name,
        imageUrl: image
      }
    });

    if (source === 'prowlarr') {
        const setting = await prisma.systemSetting.findUnique({ where: { key: 'download_clients_config' } });
        if (!setting?.value) throw new Error("No download client configured.");
        const clients = JSON.parse(setting.value);
        const client = clients.length > 0 ? clients[0] : null;

        if (client) {
            await DownloadService.addDownload(client, searchResult.downloadUrl, searchResult.title, searchResult.seedTime || 0, searchResult.seedRatio || 0);
            
            await prisma.request.update({
              where: { id: newReq.id },
              data: { downloadLink: searchResult.infoHash || searchResult.guid || null }
            });
        }
    } else if (source === 'getcomics') {

        if (searchResult && searchResult.downloadUrl) {
            Logger.log(`[Manual Request] Using user-selected GetComics link for: ${searchResult.title}`, 'info');
            const { url, isDirect } = await GetComicsService.scrapeDeepLink(searchResult.downloadUrl);
            
            if (isDirect) {
                const safeTitle = searchResult.title.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();
                const settings = await prisma.systemSetting.findMany();
                const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
                
                await prisma.request.update({
                  where: { id: newReq.id },
                  data: { status: 'DOWNLOADING', activeDownloadName: safeTitle }
                });

                DownloadService.downloadDirectFile(url, safeTitle, config.download_path, newReq.id)
                    .then(async (success) => {
                        if (success) {
                            await new Promise(r => setTimeout(r, 2000));
                            await Importer.importRequest(newReq.id);
                        }
                    })
                    .catch(e => console.error(e));
            } else {
                await prisma.request.update({
                  where: { id: newReq.id },
                  data: { status: 'MANUAL_DDL', downloadLink: url, activeDownloadName: searchResult.title }
                });
            }
        } else {
            Logger.log(`[Manual Request] No specific result passed. Triggering fuzzy search for: ${name} ${year}`, 'info');
            
            const acronyms = await getCustomAcronyms();
            const queries = generateSearchQueries(name, year, acronyms);
            let getComicsResults: any[] = [];
            
            for (const q of queries) {
                getComicsResults = await GetComicsService.search(q);
                if (getComicsResults.length > 0) break;
            }
            
            if (getComicsResults.length > 0) {
              const best = getComicsResults[0];
              const { url, isDirect } = await GetComicsService.scrapeDeepLink(best.downloadUrl);
              
              if (isDirect) {
                const safeTitle = best.title.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();
                const settings = await prisma.systemSetting.findMany();
                const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

                await prisma.request.update({
                  where: { id: newReq.id },
                  data: { status: 'DOWNLOADING', activeDownloadName: safeTitle }
                });

                DownloadService.downloadDirectFile(url, safeTitle, config.download_path, newReq.id)
                    .then(async (success) => {
                        if (success) {
                            await new Promise(r => setTimeout(r, 2000));
                            await Importer.importRequest(newReq.id);
                        }
                    })
                    .catch(e => console.error(e));
              } else {
                await prisma.request.update({
                  where: { id: newReq.id },
                  data: { status: 'MANUAL_DDL', downloadLink: url, activeDownloadName: best.title }
                });
              }
            } else {
                await prisma.request.update({
                  where: { id: newReq.id },
                  data: { status: 'STALLED' }
                });
                return NextResponse.json({ error: 'No results found on GetComics for this query.' }, { status: 404 });
            }
        }
    }

    checkTrophies(token.id as string, 'REQUEST').catch(console.error);

    return NextResponse.json({ success: true, message: "Download started." });
  } catch (error: any) {
    Logger.log(`[Manual Request Error] ${error.message}`, 'error');
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}