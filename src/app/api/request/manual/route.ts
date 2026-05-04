// src/app/api/request/manual/route.ts
import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import path from 'path'; // <-- Added path for safe joining
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
    const { cvId, name, year, publisher, image, type, searchResult, source, monitored, requestId } = body;

    // Use strict check since cvId might be 0 during an interactive search override
    if (cvId === undefined || cvId === null || !name) return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });

    Logger.log(`[Manual Request] User ${token.name} initiated request for: ${name}`, 'info');

    const isAutoApprove = token.role === 'ADMIN' || token.autoApproveRequests;
    let initialStatus = isAutoApprove ? 'DOWNLOADING' : 'PENDING_APPROVAL';

    if (source === 'flag_admin') {
        initialStatus = 'MANUAL_DDL';
    }

    let targetReqId = requestId;

    if (requestId) {
        // --- OVERRIDE EXISTING REQUEST ---
        await prisma.request.update({
            where: { id: requestId },
            data: {
                status: initialStatus,
                activeDownloadName: searchResult?.title || name,
                imageUrl: image || undefined,
                retryCount: 0 // Reset retry count for fresh search
            }
        });
    } else {
        // --- CREATE NEW REQUEST ---
        if (type === 'volume' && monitored) {
            const safePublisher = publisher || "Unknown";
            const isManga = await detectManga({ name, publisher: { name: safePublisher }, year: parseInt(year) });
            
            const libraries = await prisma.library.findMany();
            let targetLib = isManga 
                ? libraries.find(l => l.isDefault && l.isManga) || libraries.find(l => l.isManga)
                : libraries.find(l => l.isDefault && !l.isManga) || libraries.find(l => !l.isManga);
            if (!targetLib) targetLib = libraries[0];

            // --- FIX: Fetch Settings and apply Custom Folder Naming Pattern ---
            const settings = await prisma.systemSetting.findMany();
            const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
            const folderPattern = config.folder_naming_pattern || "{Publisher}/{Series} ({Year})";

            const safeFolderName = name.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();
            const safePubFolder = safePublisher !== "Unknown" ? safePublisher.replace(/[<>:"/\\|?*]/g, '').trim() : "Other";

            let relFolderPath = folderPattern
                .replace(/{Publisher}/gi, safePubFolder)
                .replace(/{Series}/gi, safeFolderName)
                .replace(/{Year}/gi, year ? year.toString() : "")
                .replace(/\(\s*\)/g, '') 
                .replace(/\[\s*\]/g, '') 
                .replace(/\s+/g, ' ')
                .trim();

            const folderParts = relFolderPath.split(/[/\\]/).map((p:string) => p.trim()).filter(Boolean);
            const libraryTypeFolder = isManga ? 'Manga' : 'Comics';
            const basePath = targetLib ? targetLib.path : `/${libraryTypeFolder}`;
            
            const folderPath = path.join(basePath, ...folderParts).replace(/\\/g, '/');

            await prisma.series.upsert({
                where: { metadataSource_metadataId: { metadataSource: 'COMICVINE', metadataId: cvId.toString() } },
                update: { monitored: true, coverUrl: image },
                create: { 
                    metadataId: cvId.toString(), 
                    metadataSource: 'COMICVINE',
                    name, 
                    year: parseInt(year) || new Date().getFullYear(), 
                    publisher: safePublisher, 
                    folderPath, // <-- Applies the dynamic custom path
                    monitored: true,
                    isManga: isManga,
                    libraryId: targetLib?.id,
                    coverUrl: image
                }
            });
        }

        let searchName = name;
        if (type === 'issue' && body.issueNumber && !name.includes(`#${body.issueNumber}`)) {
            searchName = `${name} #${body.issueNumber}`;
        }

        const skipIndexers = source === 'getcomics';

        const newReq = await prisma.request.create({
          data: {
            userId: userId,
            volumeId: cvId.toString(),
            status: initialStatus,
            activeDownloadName: searchResult?.title || searchName,
            imageUrl: image,
            downloadLink: skipIndexers && initialStatus === 'PENDING_APPROVAL' ? 'DIRECT_GETCOMICS' : null
          }
        });
        targetReqId = newReq.id;
    }

    // --- NOTIFICATIONS ---
    if (initialStatus === 'PENDING_APPROVAL' && !requestId) {
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

    // --- AUTOMATION INJECTION ---
    if (isAutoApprove && source !== 'flag_admin') {
        if (source === 'prowlarr') {
            const setting = await prisma.systemSetting.findUnique({ where: { key: 'download_clients_config' } });
            if (!setting?.value) throw new Error("No download client configured.");
            const clients = JSON.parse(setting.value);
            const client = clients.length > 0 ? clients[0] : null;

            if (client) {
                await DownloadService.addDownload(client, searchResult.downloadUrl, searchResult.title, searchResult.seedTime || 0, searchResult.seedRatio || 0);
                await prisma.request.update({
                  where: { id: targetReqId },
                  data: { downloadLink: searchResult.infoHash || searchResult.guid || null }
                });
            }
        } 
        else if (source === 'getcomics') {
            if (searchResult && searchResult.downloadUrl) {
                const { url, hoster } = await GetComicsService.scrapeDeepLink(searchResult.downloadUrl);
                
                const hpSetting = await prisma.systemSetting.findUnique({ where: { key: 'hoster_priority' } });
                let enabledHosters = ['mediafire', 'getcomics', 'mega', 'pixeldrain', 'rootz', 'vikingfile', 'terabox', 'annas_archive'];
                if (hpSetting?.value) {
                    try {
                        const parsed = JSON.parse(hpSetting.value);
                        if (parsed.length > 0) {
                            if (typeof parsed[0] === 'string') {
                                enabledHosters = parsed;
                            } else if (typeof parsed[0] === 'object') {
                                enabledHosters = parsed.filter((p: any) => p.enabled).map((p: any) => p.hoster);
                            }
                        } else {
                            enabledHosters = [];
                        }
                    } catch(e) {}
                }

                if (enabledHosters.includes(hoster)) {
                    const safeTitle = searchResult.title.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();
                    const settings = await prisma.systemSetting.findMany();
                    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
                    
                    await prisma.request.update({
                      where: { id: targetReqId },
                      data: { status: 'DOWNLOADING', activeDownloadName: safeTitle }
                    });

                    DownloadService.downloadDirectFile(url, safeTitle, config.download_path, targetReqId, hoster)
                        .then(async (success) => {
                            if (success) {
                                await new Promise(r => setTimeout(r, 2000));
                                await Importer.importRequest(targetReqId);
                            }
                        })
                        .catch(e => Logger.log(getErrorMessage(e), 'error'));
                } else {
                    Logger.log(`[Manual Request] Best match was an unsupported or disabled hoster (${hoster}). Saved to Manual Queue.`, 'warn');
                    await prisma.request.update({
                      where: { id: targetReqId },
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