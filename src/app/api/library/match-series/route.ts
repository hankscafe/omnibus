import { revalidatePath, revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { detectManga } from '@/lib/manga-detector'; 

export async function POST(request: Request) {
  try {
    const { oldFolderPath, cvId, name, year, publisher } = await request.json();

    if (!oldFolderPath || !cvId) {
        return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const settings = await prisma.systemSetting.findMany({
        where: { key: { in: ['library_path', 'manga_library_path'] } }
    });
    const libPath = settings.find(s => s.key === 'library_path')?.value || '';
    const mangaPath = settings.find(s => s.key === 'manga_library_path')?.value || '';

    const normalizedOld = path.normalize(oldFolderPath).toLowerCase();
    const isAuthorized = (libPath && normalizedOld.startsWith(path.normalize(libPath).toLowerCase())) || 
                         (mangaPath && normalizedOld.startsWith(path.normalize(mangaPath).toLowerCase()));

    if (!isAuthorized) return NextResponse.json({ error: "Unauthorized path access" }, { status: 403 });
    if (!fs.existsSync(oldFolderPath)) return NextResponse.json({ error: "Folder not found." }, { status: 404 });

    const cvKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
    const cvApiKey = cvKeySetting?.value;
    if (!cvApiKey) return NextResponse.json({ error: "ComicVine API Key missing" }, { status: 400 });

    let realPublisher = publisher && publisher !== 'Unknown' && publisher !== 'Other' ? publisher : '';
    let realName = name && name !== 'Unknown Series' ? name : '';
    let realYear = year ? parseInt(year) : 0;
    let imageUrl = null;
    
    // FAIL-FAST CV FETCH (Max 2 seconds. If CV rate-limits us, skip it and keep going!)
    try {
        const cvVolRes = await axios.get(`https://comicvine.gamespot.com/api/volume/4050-${cvId}/`, {
            params: { api_key: cvApiKey, format: 'json', field_list: 'publisher,name,start_year,image' },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 2000 
        });
        if (cvVolRes.data?.results) {
            const vol = cvVolRes.data.results;
            if (!realPublisher && vol.publisher?.name) realPublisher = vol.publisher.name;
            if (!realName && vol.name) realName = vol.name;
            if (!realYear && vol.start_year) realYear = parseInt(vol.start_year) || 0;
            imageUrl = vol.image?.medium_url || vol.image?.super_url;
        }
    } catch(e) { 
        console.warn("[Matcher] ComicVine connection throttled or timed out. Using fallback data.");
    }

    if (!realName) realName = path.basename(oldFolderPath).replace(/\s\(\d{4}\)$/, "").trim(); 
    if (!realPublisher) realPublisher = 'Other';

    const safePublisher = realPublisher.replace(/[<>:"/\\|?*]/g, '').trim();
    const safeName = realName.replace(/[<>:"/\\|?*]/g, '').trim();
    const safeYear = realYear > 0 ? ` (${realYear})` : '';
    
    const isManga = await detectManga({ name: safeName, publisher: { name: realPublisher }, year: realYear });
    
    let newFolderPath = (isManga && mangaPath) ? mangaPath : libPath;
    if (safePublisher) newFolderPath = path.join(newFolderPath, safePublisher);
    newFolderPath = path.join(newFolderPath, `${safeName}${safeYear}`);

    const pubDir = path.dirname(newFolderPath);
    if (!fs.existsSync(pubDir)) fs.mkdirSync(pubDir, { recursive: true });

    const targetCvId = parseInt(cvId);
    
    await prisma.series.updateMany({
        where: { cvId: targetCvId },
        data: { cvId: -Math.abs(Math.floor(Math.random() * 1000000000)) }
    }).catch(() => {});

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
        coverUrl: imageUrl ? `/api/library/cover?path=${encodeURIComponent(path.join(newFolderPath, 'cover.jpg'))}` : null
    };

    if (existingRecord) {
        await prisma.issue.deleteMany({
            where: {
                seriesId: existingRecord.id,
                OR: [
                    { filePath: null },
                    { filePath: "" }
                ]
            }
        });
        existingRecord = await prisma.series.update({ where: { id: existingRecord.id }, data: updateData });
    } else {
        existingRecord = await prisma.series.create({ data: updateData });
    }

    let activeFolderPath = oldFolderPath;
    if (path.normalize(oldFolderPath).toLowerCase() !== path.normalize(newFolderPath).toLowerCase()) {
        if (fs.existsSync(newFolderPath)) {
            const files = await fs.promises.readdir(oldFolderPath);
            for (const file of files) {
                await fs.promises.rename(path.join(oldFolderPath, file), path.join(newFolderPath, file));
            }
            try { await fs.promises.rmdir(oldFolderPath); } catch(e) {}
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
        
        if (pathUpdates.length > 0) {
            await prisma.$transaction(pathUpdates).catch(() => {});
        }

        // FAIL-FAST IMAGE DOWNLOAD (Max 3 seconds)
        if (imageUrl) {
            try {
                const imgRes = await axios.get(imageUrl, { 
                    responseType: 'arraybuffer', 
                    timeout: 3000,
                    headers: { 'User-Agent': 'Omnibus/1.0' } 
                });
                await fs.promises.writeFile(path.join(activeFolderPath, 'cover.jpg'), Buffer.from(imgRes.data));
            } catch(e) {
                console.warn("[Matcher] Cover art download skipped due to rate limit.");
            }
        }
        
    } catch (err) { }

    
try {
            const pendingRequests = await prisma.request.findMany({
                where: { 
                    volumeId: targetCvId.toString(),
                    status: { in: ['MANUAL_DDL', 'PENDING', 'DOWNLOADING'] } 
                }
            });

            if (pendingRequests.length > 0) {
                // Grab all issues for this series
                const seriesIssues = await prisma.issue.findMany({
                    where: { series: { cvId: targetCvId } }
                });

                for (const req of pendingRequests) {
                    const searchStr = (req.activeDownloadName || req.title || req.name || "");
                    const numMatch = searchStr.match(/(?:#|issue\s*#?)\s*(\d+(?:\.\d+)?)/i);
                    const issueNum = numMatch ? parseFloat(numMatch[1]) : null;

                    if (issueNum === null) continue;

                    // Bulletproof match: Convert both to numbers (ignores 01 vs 1) AND verify it has a file
                    const matchingIssue = seriesIssues.find(i => 
                        parseFloat(i.number) === issueNum && 
                        i.filePath && i.filePath.length > 0
                    );

                    if (matchingIssue) {
                        await prisma.request.update({
                            where: { id: req.id },
                            data: { status: 'COMPLETED', progress: 100 }
                        });
                    }
                }
            }
        } catch (e) {
            console.error("Match Auto-Healer Error:", e);
        }
        
        revalidateTag('library');
        revalidatePath('/library');
        revalidatePath('/library/series');

        return NextResponse.json({ success: true, newPath: activeFolderPath, cvId: targetCvId });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}