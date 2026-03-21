import { revalidatePath, revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { detectManga } from '@/lib/manga-detector';
import { DiscordNotifier } from '@/lib/discord'; 
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger'; // <-- Added Logger

export async function POST(request: Request) {
  try {
    const req = (await request.json()) as any;
    const { oldFolderPath, cvId, name, year, publisher } = req;

    if (!oldFolderPath || !cvId) {
        return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const libraries = await prisma.library.findMany();
    const authorizedRoots = libraries.map(l => path.normalize(l.path).toLowerCase());
    const normalizedOld = path.normalize(oldFolderPath).toLowerCase();
    
    const isAuthorized = authorizedRoots.some(root => normalizedOld.startsWith(root));

    if (!isAuthorized) return NextResponse.json({ error: "Unauthorized path access" }, { status: 403 });
    if (!fs.existsSync(oldFolderPath)) return NextResponse.json({ error: "Folder not found." }, { status: 404 });

    const cvKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
    const cvApiKey = cvKeySetting?.value;
    if (!cvApiKey) return NextResponse.json({ error: "ComicVine API Key missing" }, { status: 400 });

    let realPublisher = publisher && publisher !== 'Unknown' && publisher !== 'Other' ? publisher : '';
    let realName = name && name !== 'Unknown Series' ? name : '';
    let realYear = year ? parseInt(year) : 0;
    let imageUrl = null;
    let status = 'Ongoing'; 
    
    try {
        const cvVolRes = await axios.get(`https://comicvine.gamespot.com/api/volume/4050-${cvId}/`, {
            params: { api_key: cvApiKey, format: 'json', field_list: 'publisher,name,start_year,image,end_year' },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 2000 
        });
        if (cvVolRes.data?.results) {
            const vol = cvVolRes.data.results;
            if (!realPublisher && vol.publisher?.name) realPublisher = vol.publisher.name;
            if (!realName && vol.name) realName = vol.name;
            if (!realYear && vol.start_year) realYear = parseInt(vol.start_year) || 0;
            imageUrl = vol.image?.medium_url || vol.image?.super_url;
            if (vol.end_year) status = 'Ended'; 
        }
    } catch(e: unknown) { 
        Logger.log(`[Match Series] ComicVine fetch failed or timed out: ${getErrorMessage(e)}`, 'warn');
    }

    if (!realName) realName = path.basename(oldFolderPath).replace(/\s\(\d{4}\)$/, "").trim(); 
    if (!realPublisher) realPublisher = 'Other';

    const safePublisher = realPublisher.replace(/[<>:"/\\|?*]/g, '').trim();
    const safeName = realName.replace(/[<>:"/\\|?*]/g, '').trim();
    const safeYear = realYear > 0 ? ` (${realYear})` : '';
    
    const isManga = await detectManga({ name: safeName, publisher: { name: realPublisher }, year: realYear });
    
    let targetLib = isManga 
        ? libraries.find(l => l.isDefault && l.isManga) || libraries.find(l => l.isManga)
        : libraries.find(l => l.isDefault && !l.isManga) || libraries.find(l => !l.isManga);
        
    if (!targetLib) targetLib = libraries[0];
    if (!targetLib) return NextResponse.json({ error: "No libraries configured." }, { status: 400 });

    let newFolderPath = targetLib.path;
    if (safePublisher) newFolderPath = path.join(newFolderPath, safePublisher);
    newFolderPath = path.join(newFolderPath, `${safeName}${safeYear}`);

    const pubDir = path.dirname(newFolderPath);
    if (!fs.existsSync(pubDir)) fs.mkdirSync(pubDir, { recursive: true });

    const targetCvId = parseInt(cvId);
    
    // --- FIX 4a: Don't silently fail database queries ---
    await prisma.series.updateMany({
        where: { cvId: targetCvId },
        data: { cvId: -Math.abs(Math.floor(Math.random() * 1000000000)) }
    }).catch((err: unknown) => {
        Logger.log(`[Match Series] Failed to reset old cvId: ${getErrorMessage(err)}`, 'warn');
    });

    let existingRecord = await prisma.series.findFirst({
        where: { OR: [ { folderPath: oldFolderPath }, { folderPath: newFolderPath } ] }
    });

    const updateData = {
        cvId: targetCvId,
        name: safeName,
        year: realYear,
        publisher: realPublisher,
        folderPath: newFolderPath,
        isManga: isManga,
        status: status,
        libraryId: targetLib.id, 
        coverUrl: imageUrl ? `/api/library/cover?path=${encodeURIComponent(path.join(newFolderPath, 'cover.jpg'))}` : null
    };

    if (existingRecord) {
        await prisma.issue.deleteMany({
            where: { seriesId: existingRecord.id, OR: [ { filePath: null }, { filePath: "" } ] }
        });
        existingRecord = await prisma.series.update({ where: { id: existingRecord.id }, data: updateData });
    } else {
        existingRecord = await prisma.series.create({ data: updateData });
    }

    DiscordNotifier.sendAlert('metadata_match', { 
        title: safeName, publisher: realPublisher, year: realYear.toString(), imageUrl: imageUrl, user: "Admin" 
    }).catch(() => {}); // Intentional Fire & Forget

    let activeFolderPath = oldFolderPath;
    if (path.normalize(oldFolderPath).toLowerCase() !== path.normalize(newFolderPath).toLowerCase()) {
        if (fs.existsSync(newFolderPath)) {
            const files = await fs.promises.readdir(oldFolderPath);
            for (const file of files) {
                await fs.promises.rename(path.join(oldFolderPath, file), path.join(newFolderPath, file));
            }
            try { 
                await fs.promises.rmdir(oldFolderPath); 
            } catch(e: unknown) {
                Logger.log(`[Match Series] Failed to remove old empty folder: ${getErrorMessage(e)}`, 'warn');
            }
        } else {
            await fs.promises.rename(oldFolderPath, newFolderPath);
        }
        activeFolderPath = newFolderPath;
    }

    try {
        const files = await fs.promises.readdir(activeFolderPath);
        const pathUpdates = [];
        
        for (const file of files) {
            const ext = path.extname(file);
            if (['.cbz', '.cbr', '.cb7', '.pdf', '.epub', '.zip'].includes(ext.toLowerCase())) {
                const oldName = path.basename(file, ext);
                let issueNumStr = "";
                
                const explicitMatch = oldName.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v|ch(?:apter)?\s*\.?)\s*(\d+(?:\.\d+)?)/i);
                if (explicitMatch) issueNumStr = explicitMatch[1];
                else {
                    const cleanName = oldName.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').replace(/\s+of\s+\d+/gi, '').trim();
                    const endMatch = cleanName.match(/(?:issue\s?|-|\s|^)(\d+(?:\.\d+)?)\s*$/i);
                    if (endMatch) issueNumStr = endMatch[1];
                }
                
                if (issueNumStr) {
                    let formattedNum = issueNumStr;
                    if (!issueNumStr.includes('.') && issueNumStr.length === 1) formattedNum = `0${issueNumStr}`;
                    const prefix = isManga ? 'Vol. ' : '#';
                    const newFileName = `${safeName} ${prefix}${formattedNum}${ext}`;
                    
                    const oldFilePath = path.join(activeFolderPath, file);
                    const newFilePath = path.join(activeFolderPath, newFileName);
                    
                    if (oldFilePath !== newFilePath && !fs.existsSync(newFilePath)) {
                        await fs.promises.rename(oldFilePath, newFilePath);
                        if (existingRecord) {
                            pathUpdates.push(prisma.issue.updateMany({
                                where: { seriesId: existingRecord.id, number: issueNumStr },
                                data: { filePath: newFilePath }
                            }));
                        }
                    }
                }
            }
        }
        // --- FIX 4a: Don't silently fail database transactions ---
        if (pathUpdates.length > 0) {
            await prisma.$transaction(pathUpdates).catch((err: unknown) => {
                Logger.log(`[Match Series] Path updates transaction failed: ${getErrorMessage(err)}`, 'error');
            });
        }

        if (imageUrl) {
            try {
                const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 3000, headers: { 'User-Agent': 'Omnibus/1.0' } });
                await fs.promises.writeFile(path.join(activeFolderPath, 'cover.jpg'), Buffer.from(imgRes.data));
            } catch(e: unknown) {
                Logger.log(`[Match Series] Failed to download cover image: ${getErrorMessage(e)}`, 'warn');
            }
        }
    } catch (err: unknown) { 
        Logger.log(`[Match Series] File operations block failed: ${getErrorMessage(err)}`, 'error');
    }

    try {
        const pendingRequests = await prisma.request.findMany({
            where: { volumeId: targetCvId.toString(), status: { in: ['MANUAL_DDL', 'PENDING', 'DOWNLOADING'] } }
        });

        if (pendingRequests.length > 0) {
            const seriesIssues = await prisma.issue.findMany({ where: { series: { cvId: targetCvId } } });
            
            const requestsToComplete = [];

            for (const dbReq of pendingRequests) {
                const searchStr = (dbReq.activeDownloadName || (dbReq as any).title || (dbReq as any).name || "");
                const numMatch = searchStr.match(/(?:#|issue\s*#?)\s*(\d+(?:\.\d+)?)/i);
                const issueNum = numMatch ? parseFloat(numMatch[1]) : null;
                if (issueNum === null) continue;
                const matchingIssue = seriesIssues.find(i => parseFloat(i.number) === issueNum && i.filePath && i.filePath.length > 0);

                if (matchingIssue) {
                    requestsToComplete.push(dbReq.id);
                }
            }

            if (requestsToComplete.length > 0) {
                await prisma.request.updateMany({
                    where: { id: { in: requestsToComplete } },
                    data: { status: 'COMPLETED', progress: 100 }
                });
            }
        }
    } catch (e: unknown) { 
        Logger.log(`[Match Series] Pending requests update failed: ${getErrorMessage(e)}`, 'error');
    }
    
    revalidateTag('library'); revalidatePath('/library'); revalidatePath('/library/series');
    return NextResponse.json({ success: true, newPath: activeFolderPath, cvId: targetCvId });

  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}