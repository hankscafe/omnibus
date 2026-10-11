// src/app/api/request/manual/route.ts
import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import path from 'path';
import { getToken } from 'next-auth/jwt';
import { Logger } from '@/lib/logger';
import { DownloadService } from '@/lib/download-clients';
import { enabledHostersFromSetting, scrapeDeepLinkViaEngine } from '@/lib/getcomics';
import { evaluateTrophies } from '@/lib/trophy-evaluator';
import { Importer } from '@/lib/importer';
import { getErrorMessage } from '@/lib/utils/error';
import { detectManga } from '@/lib/manga-detector';
import { DiscordNotifier } from '@/lib/discord';
import { Mailer } from '@/lib/mailer';
import { seriesFolderSegments } from '@/lib/utils/naming';
import { settleDuplicateOnLink } from '@/lib/request-dedupe';

export const dynamic = 'force-dynamic';

// #240: what to tell the user when a link they picked is already consumed — the three manual paths
// (torrent, GetComics, Anna's Archive) answer alike.
function settledMessage(status: 'COMPLETED' | 'NEEDS_REVIEW'): string {
    return status === 'COMPLETED'
        ? "That issue is already in your library — nothing was downloaded."
        : "That pack was already downloaded and consumed, but the issue never reached the library — the request is marked for review. Nothing was downloaded.";
}

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
    const { cvId, name, year, publisher, image, type, searchResult, source, monitored, requestId, metadataSource } = body;
    const targetMetadataSource = metadataSource || 'COMICVINE';

    // Use strict check since cvId might be 0 during an interactive search override
    if (cvId === undefined || cvId === null || !name) return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });

    Logger.log(`[Manual Request] User ${token.name} initiated request for: ${name}`, 'info');
    Logger.log(`[Manual Request Debug] Payload received: type=${type}, source=${source}, searchResultTitle=${searchResult?.title}`, 'debug');

    // Gate: only users granted the Request permission (or admins) may create requests.
    const requesterIsAdmin = userExists.role === 'ADMIN';
    if (!requesterIsAdmin && !userExists.canRequest) {
      return NextResponse.json({ error: "You don't have permission to make requests. Ask an admin to grant you the Request permission." }, { status: 403 });
    }
    const isAutoApprove = requesterIsAdmin || userExists.autoApproveRequests;
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
                retryCount: 0, // Reset retry count for fresh search
                failedLinks: "[]" // Reset the blocklist for manual override selections
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

            // The name, publisher and year can come straight from the requester (the provider only fills
            // what's missing). The shared naming rules (naming.ts) sanitize each like ComicInfo metadata - a
            // dots-only value becomes "_", a year is only ever a plausible year - and refuse a pattern that
            // would leave the library.
            const settings = await prisma.systemSetting.findMany();
            const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
            const folderPattern = config.folder_naming_pattern || "{Publisher}/{Series} ({Year})";
            const folderParts = seriesFolderSegments(folderPattern, { publisher, series: name, seriesYear: year, imprint: '' });
            const libraryTypeFolder = isManga ? 'Manga' : 'Comics';
            const basePath = targetLib ? targetLib.path : `/${libraryTypeFolder}`;
            if (!folderParts) {
                Logger.log(`[Manual Request] Folder pattern "${folderPattern}" gives no folder inside the library for ${name}. Check Settings > Library & Files.`, 'warn');
                return NextResponse.json({ error: "The folder naming pattern doesn't produce a folder inside the library for this series. Ask an admin to check Settings > Library & Files." }, { status: 400 });
            }
            const folderPath = path.join(basePath, ...folderParts).replace(/\\/g, '/');

            await prisma.series.upsert({
                where: { metadataSource_metadataId: { metadataSource: targetMetadataSource, metadataId: cvId.toString() } },
                update: { monitored: true, coverUrl: image },
                create: { 
                    metadataId: cvId.toString(), 
                    metadataSource: targetMetadataSource,
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

        const skipIndexers = source === 'getcomics' || source === 'annas_archive';

        const newReq = await prisma.request.create({
          data: {
            userId: userId,
            volumeId: cvId.toString(),
            status: initialStatus,
            // #240: an issue request keeps the issue it is for; a pack/series request has no single
            // number, so the column stays null and the name parse remains the fallback.
            issueNumber: type === 'issue' && body.issueNumber ? String(body.issueNumber) : null,
            activeDownloadName: searchResult?.title || searchName,
            imageUrl: image,
            downloadLink: skipIndexers && initialStatus === 'PENDING_APPROVAL' ? 'DIRECT_GETCOMICS' : null,
            metadataSource: targetMetadataSource // <-- ADD THIS TO PRESERVE THE SOURCE!
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
        Logger.log(`[Manual Request Debug] Processing source: ${source}, status: ${initialStatus}`, 'debug');
        
        if (source === 'prowlarr') {
            const clients = await prisma.downloadClient.findMany();
            if (clients.length === 0) throw new Error("No download client configured.");
            
            const protocol = searchResult.protocol || 'torrent';
            // Use optional chaining/fallbacks to protect against undefined test mocks
            const client = clients.find(c => (c.protocol || 'torrent').toLowerCase() === protocol.toLowerCase()) || clients[0];

            if (client) {
                Logger.log(`[Manual Request Debug] Routing download "${searchResult.title}" to client "${client.name}" (Protocol: ${protocol})`, 'debug');
                
                const trackingHash = searchResult.infoHash || searchResult.guid || null;
                
                if (trackingHash) {
                    const duplicateDownload = await settleDuplicateOnLink(trackingHash, targetReqId);

                    if (duplicateDownload.action === 'park') {
                         Logger.log(`[Manual Request] Batch torrent already downloading (${trackingHash}). Queuing for batch extraction.`, 'info');
                         await prisma.request.update({
                             where: { id: targetReqId },
                             data: { status: 'DOWNLOADING', activeDownloadName: searchResult.title, downloadLink: trackingHash, indexer: searchResult.indexer }
                         });
                         return NextResponse.json({ success: true, message: "Added to existing batch download queue." });
                    }
                    if (duplicateDownload.action === 'join') {
                         // #240 PR B: the sibling's pack is already in the watched folder, so its
                         // bytes are gone and its outcome is not known yet — wait with it (the
                         // reconciler closes this request when the sweep reports back).
                         await prisma.request.update({
                             where: { id: targetReqId },
                             data: { status: 'IMPORTING', progress: 100, activeDownloadName: searchResult.title, downloadLink: trackingHash, indexer: searchResult.indexer }
                         });
                         return NextResponse.json({ success: true, message: "This pack is already in the watched folder — the request waits for the import instead of downloading it again." });
                    }
                    if (duplicateDownload.action === 'settle') {
                         return NextResponse.json({ success: true, message: settledMessage(duplicateDownload.status) });
                    }
                }

                // File manga under its own category/label in the client (manga → second configured category).
                const mangaSeries = await prisma.series.findFirst({ where: { metadataId: String(cvId), metadataSource: targetMetadataSource }, select: { isManga: true } });
                await DownloadService.addDownload(client, searchResult.downloadUrl, searchResult.title, searchResult.seedTime || 0, searchResult.seedRatio || 0, mangaSeries?.isManga ?? false);
                await prisma.request.update({
                  where: { id: targetReqId },
                  data: { downloadLink: trackingHash, indexer: searchResult.indexer }
                });
            }
        } 
        else if (source === 'getcomics') {
            if (searchResult && searchResult.downloadUrl) {
                // Section-targeting scrape via the engine (multi-pack articles resolve to the requested
                // issue's archive, not an arbitrary one).
                const { url, hoster } = await scrapeDeepLinkViaEngine(searchResult.downloadUrl, { name: name || searchResult.title, year });

                const hpSetting = await prisma.systemSetting.findUnique({ where: { key: 'hoster_priority' } });
                // Enabled hosters (migrates the legacy `getcomics` key → direct + main).
                const enabledHosters = enabledHostersFromSetting(hpSetting?.value);

                if (enabledHosters.includes(hoster)) {
                    const safeTitle = searchResult.title.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();
                    const settings = await prisma.systemSetting.findMany();
                    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
                    
                    const duplicateDownload = await settleDuplicateOnLink(url, targetReqId);

                    if (duplicateDownload.action === 'park') {
                         Logger.log(`[Manual Request] Batch pack already downloading (${url}). Queuing for batch extraction.`, 'info');
                         await prisma.request.update({
                             where: { id: targetReqId },
                             data: { status: 'DOWNLOADING', activeDownloadName: safeTitle, downloadLink: url }
                         });
                         return NextResponse.json({ success: true, message: "Added to existing batch download queue." });
                    }
                    if (duplicateDownload.action === 'join') {
                         // #240 PR B: the sibling's pack is already in the watched folder, so its
                         // bytes are gone and its outcome is not known yet — wait with it (the
                         // reconciler closes this request when the sweep reports back).
                         await prisma.request.update({
                             where: { id: targetReqId },
                             data: { status: 'IMPORTING', progress: 100, activeDownloadName: safeTitle, downloadLink: url }
                         });
                         return NextResponse.json({ success: true, message: "This pack is already in the watched folder — the request waits for the import instead of downloading it again." });
                    }
                    if (duplicateDownload.action === 'settle') {
                         return NextResponse.json({ success: true, message: settledMessage(duplicateDownload.status) });
                    }

                    await prisma.request.update({
                      where: { id: targetReqId },
                      data: { status: 'DOWNLOADING', activeDownloadName: safeTitle, downloadLink: url }
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
        else if (source === 'annas_archive') {
            // Anna's Archive result: the downloadUrl is already the resolvable /md5/ link, so there's no
            // article to scrape. Stream it via the existing hoster resolver (premium API key); keyless,
            // downloadDirectFile holds it as MANUAL_DDL for in-browser pickup.
            if (searchResult && searchResult.downloadUrl) {
                const url = searchResult.downloadUrl;
                const safeTitle = searchResult.title.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();
                const settings = await prisma.systemSetting.findMany();
                const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

                const duplicateDownload = await settleDuplicateOnLink(url, targetReqId);
                if (duplicateDownload.action === 'park') {
                    Logger.log(`[Manual Request] Anna's Archive file already downloading (${url}). Queuing for batch extraction.`, 'info');
                    await prisma.request.update({
                        where: { id: targetReqId },
                        data: { status: 'DOWNLOADING', activeDownloadName: safeTitle, downloadLink: url }
                    });
                    return NextResponse.json({ success: true, message: "Added to existing batch download queue." });
                }
                if (duplicateDownload.action === 'join') {
                    // #240 PR B: see the torrent branch above — the pack is in the watched folder, so
                    // this request waits for the sweep instead of downloading it again.
                    await prisma.request.update({
                        where: { id: targetReqId },
                        data: { status: 'IMPORTING', progress: 100, activeDownloadName: safeTitle, downloadLink: url }
                    });
                    return NextResponse.json({ success: true, message: "This pack is already in the watched folder — the request waits for the import instead of downloading it again." });
                }
                if (duplicateDownload.action === 'settle') {
                    return NextResponse.json({ success: true, message: settledMessage(duplicateDownload.status) });
                }

                await prisma.request.update({
                    where: { id: targetReqId },
                    data: { status: 'DOWNLOADING', activeDownloadName: safeTitle, downloadLink: url }
                });

                DownloadService.downloadDirectFile(url, safeTitle, config.download_path, targetReqId, 'annas_archive')
                    .then(async (success) => {
                        if (success) {
                            await new Promise(r => setTimeout(r, 2000));
                            await Importer.importRequest(targetReqId);
                        }
                    })
                    .catch(e => Logger.log(getErrorMessage(e), 'error'));
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
