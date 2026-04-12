// src/app/api/request/manual/route.ts
import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { Logger } from '@/lib/logger';
import { DownloadService } from '@/lib/download-clients';
import { GetComicsService } from '@/lib/getcomics';
import { evaluateTrophies } from '@/lib/trophy-evaluator';
import { Importer } from '@/lib/importer';
import { getErrorMessage } from '@/lib/utils/error';
import { detectManga } from '@/lib/manga-detector';
import { DiscordNotifier } from '@/lib/discord';
import { Mailer } from '@/lib/mailer';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const token = await getToken({ req: request });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = (token.id || token.sub) as string;
  if (!userId) return NextResponse.json({ error: 'Invalid user token' }, { status: 401 });

  const userExists = await prisma.user.findUnique({ where: { id: userId } });
  if (!userExists) {
      return NextResponse.json({ error: 'Your session is invalid. Please log out and log back in.' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { cvId, name, year, publisher, image, type, searchResult, source, monitored } = body;

    if (!cvId || !name) return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });

    Logger.log(`[Manual Request] User ${token.name} initiated request for: ${name}`, 'info');

    const isAutoApprove = token.role === 'ADMIN' || token.autoApproveRequests;
    let initialStatus = isAutoApprove ? 'DOWNLOADING' : 'PENDING_APPROVAL';

    if (source === 'flag_admin') {
        initialStatus = 'MANUAL_DDL';
    }

    if (type === 'volume' && monitored) {
        const safePublisher = publisher || "Unknown";
        const isManga = await detectManga({ name, publisher: { name: safePublisher }, year: parseInt(year) });
        
        const libraries = await prisma.library.findMany();
        let targetLib = isManga 
            ? libraries.find(l => l.isDefault && l.isManga) || libraries.find(l => l.isManga)
            : libraries.find(l => l.isDefault && !l.isManga) || libraries.find(l => !l.isManga);
        if (!targetLib) targetLib = libraries[0];

        const safeFolderName = name.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();
        const safePubFolder = safePublisher.replace(/[<>:"/\\|?*]/g, '').trim();

        await prisma.series.upsert({
            where: { metadataSource_metadataId: { metadataSource: 'COMICVINE', metadataId: cvId.toString() } },
            update: { monitored: true, coverUrl: image },
            create: { 
                metadataId: cvId.toString(), 
                metadataSource: 'COMICVINE',
                name, 
                year: parseInt(year) || new Date().getFullYear(), 
                publisher: safePublisher, 
                folderPath: targetLib ? `${targetLib.path}/${safePubFolder}/${safeFolderName}` : `/Comics/${safePubFolder}/${safeFolderName}`, 
                monitored: true,
                isManga: isManga,
                libraryId: targetLib?.id,
                coverUrl: image
            }
        });
    }

    const newReq = await prisma.request.create({
      data: {
        userId: userId,
        volumeId: cvId.toString(),
        status: initialStatus,
        activeDownloadName: searchResult?.title || name,
        imageUrl: image
      }
    });

    if (initialStatus === 'PENDING_APPROVAL') {
        DiscordNotifier.sendAlert('pending_request', {
            title: name,
            imageUrl: image,
            user: token.name as string,
            description: undefined,
            publisher: publisher || "Unknown",
            year: year
        }).catch(() => {});
        
        Mailer.sendAlert('pending_request', { 
            user: token.name as string, 
            title: name,
            imageUrl: image,
            description: body.description || undefined,
            date: new Date().toLocaleString()
        }).catch(() => {});
    }

    if (isAutoApprove && source !== 'flag_admin') {
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
        } 
        else if (source === 'getcomics') {
            if (searchResult && searchResult.downloadUrl) {
                // --- HOSTER UPDATE: Pull hoster and pass it to Downloader ---
                const { url, isDirect, hoster } = await GetComicsService.scrapeDeepLink(searchResult.downloadUrl);
                
                if (isDirect || ['mediafire', 'mega', 'pixeldrain', 'rootz', 'vikingfile', 'terabox'].includes(hoster)) {
                    const safeTitle = searchResult.title.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();
                    const settings = await prisma.systemSetting.findMany();
                    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
                    
                    await prisma.request.update({
                      where: { id: newReq.id },
                      data: { status: 'DOWNLOADING', activeDownloadName: safeTitle }
                    });

                    // Passes the 'hoster' variable dynamically
                    DownloadService.downloadDirectFile(url, safeTitle, config.download_path, newReq.id, hoster)
                        .then(async (success) => {
                            if (success) {
                                await new Promise(r => setTimeout(r, 2000));
                                await Importer.importRequest(newReq.id);
                            }
                        })
                        .catch(e => Logger.log(getErrorMessage(e), 'error'));
                } else {
                    Logger.log(`[Manual Request] Best match was an unsupported hoster (${hoster}). Saved to Manual Queue.`, 'warn');
                    await prisma.request.update({
                      where: { id: newReq.id },
                      data: { status: 'MANUAL_DDL', downloadLink: url, activeDownloadName: searchResult.title }
                    });
                }
            }
        }
    }

    evaluateTrophies(userId).catch(err => {
        Logger.log(`Trophy evaluation failed: ${getErrorMessage(err)}`, 'error');
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    Logger.log(`[Manual Request Error] ${error.message}`, 'error');
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}