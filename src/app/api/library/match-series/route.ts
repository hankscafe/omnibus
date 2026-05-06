// src/app/api/library/match-series/route.ts
import { revalidatePath, revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { detectManga } from '@/lib/manga-detector';
import { DiscordNotifier } from '@/lib/discord'; 
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger'; 
import { MetronProvider } from '@/lib/metadata/providers/metron';
import { AuditLogger } from '@/lib/audit-logger';
import { authOptions } from '@/lib/auth';
import { getServerSession } from 'next-auth';
import { omnibusQueue } from '@/lib/queue';

export async function POST(request: Request) {
  try {
    const req = (await request.json()) as any;
    const { oldFolderPath, cvId, metadataId, metadataSource, name, year, publisher } = req;

    const targetMetaId = metadataId ? metadataId.toString() : (cvId ? cvId.toString() : null);
    const targetSource = metadataSource || 'COMICVINE';

    if (!oldFolderPath || !targetMetaId) {
        return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const libraries = await prisma.library.findMany();
    // Allow access to the unmatched directory in addition to standard libraries
    const unmatchedDir = process.env.OMNIBUS_AWAITING_MATCH_DIR || '/unmatched';
    const authorizedRoots = libraries.map(l => path.normalize(l.path).toLowerCase());
    authorizedRoots.push(path.normalize(unmatchedDir).toLowerCase());
    
    const normalizedOld = path.normalize(oldFolderPath).toLowerCase();
    
    const isAuthorized = authorizedRoots.some(root => normalizedOld.startsWith(root));
    if (!isAuthorized) return NextResponse.json({ error: "Unauthorized path access" }, { status: 403 });
    if (!fs.existsSync(oldFolderPath)) return NextResponse.json({ error: "File/Folder not found." }, { status: 404 });

    let realPublisher = publisher && publisher !== 'Unknown' && publisher !== 'Other' ? publisher : '';
    let realName = name && name !== 'Unknown Series' ? name : '';
    let realYear = year ? parseInt(year) : 0;
    let imageUrl = null;
    let status = 'Ongoing'; 
    
    try {
        if (targetSource === 'METRON') {
            const metron = new MetronProvider();
            const details = await metron.getSeriesDetails(targetMetaId);
            if (!realPublisher) realPublisher = details.publisher;
            if (!realName) realName = details.name;
            if (!realYear) realYear = details.year;
            imageUrl = details.coverUrl;
            status = details.status;
        } else {
            const cvKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
            const cvApiKey = cvKeySetting?.value;
            if (cvApiKey) {
                const cvVolRes = await axios.get(`https://comicvine.gamespot.com/api/volume/4050-${targetMetaId}/`, {
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
            }
        }
    } catch(e: unknown) { }

    if (!realName) realName = path.basename(oldFolderPath).replace(/\s\(\d{4}\)$/, "").trim(); 
    if (!realPublisher) realPublisher = 'Other';

    const safePublisher = realPublisher.replace(/[<>:"/\\|?*]/g, '').trim();
    const safeName = realName.replace(/[<>:"/\\|?*]/g, '').trim();
    const safeYear = realYear > 0 ? realYear.toString() : ''; // Raw year string
    
    const isManga = await detectManga({ name: safeName, publisher: { name: realPublisher }, year: realYear });
    
    let targetLib = isManga 
        ? libraries.find(l => l.isDefault && l.isManga) || libraries.find(l => l.isManga)
        : libraries.find(l => l.isDefault && !l.isManga) || libraries.find(l => !l.isManga);
        
    if (!targetLib) targetLib = libraries[0];
    if (!targetLib) return NextResponse.json({ error: "No libraries configured." }, { status: 400 });

    // --- FIX: Fetch Settings and apply Custom Folder Naming Pattern ---
    const settings = await prisma.systemSetting.findMany();
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
    const folderPattern = config.folder_naming_pattern || "{Publisher}/{Series} ({Year})";

    let relFolderPath = folderPattern
        .replace(/{Publisher}/gi, safePublisher || "Other")
        .replace(/{Series}/gi, safeName || "Unknown Series")
        .replace(/{Year}/gi, safeYear)
        .replace(/{VolumeYear}/gi, safeYear)
        .replace(/\(\s*\)/g, '') 
        .replace(/\[\s*\]/g, '') 
        .replace(/\s+/g, ' ')
        .trim();

    const folderParts = relFolderPath.split(/[/\\]/).map((p:string) => p.trim()).filter(Boolean);
    let newFolderPath = path.join(targetLib.path, ...folderParts).replace(/\\/g, '/');

    const pubDir = path.dirname(newFolderPath);
    if (!fs.existsSync(pubDir)) fs.mkdirSync(pubDir, { recursive: true });

    // --- REBUILT MERGE AND UPDATE LOGIC ---
    let existingRecord = await prisma.series.findUnique({
        where: { 
            metadataSource_metadataId: { 
                metadataSource: targetSource, 
                metadataId: targetMetaId 
            } 
        }
    });

    const unmatchedRecord = await prisma.series.findFirst({
        where: { folderPath: oldFolderPath }
    });

    const updateData = {
        cvId: targetSource === 'COMICVINE' ? parseInt(targetMetaId) : null, 
        metadataId: targetMetaId,
        metadataSource: targetSource,
        matchState: 'MATCHED',
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
        if (unmatchedRecord && unmatchedRecord.id !== existingRecord.id) {
            await prisma.issue.updateMany({
                where: { seriesId: unmatchedRecord.id },
                data: { seriesId: existingRecord.id }
            });
            await prisma.series.delete({ where: { id: unmatchedRecord.id } }).catch(() => {});
        }
        
        existingRecord = await prisma.series.update({
            where: { id: existingRecord.id },
            data: updateData
        });
    } else if (unmatchedRecord) {
        existingRecord = await prisma.series.update({
            where: { id: unmatchedRecord.id },
            data: updateData
        });
    } else {
        existingRecord = await prisma.series.create({ data: updateData });
    }

    DiscordNotifier.sendAlert('metadata_match', { 
        title: safeName, publisher: realPublisher, year: realYear.toString(), imageUrl: imageUrl, user: "Admin" 
    }).catch(() => {});

    // --- NEW: RAW FILE VS FOLDER LOGIC ---
    const oldStat = await fs.promises.stat(oldFolderPath);
    const isFile = oldStat.isFile();

    let activeFolderPath = oldFolderPath;
    if (isFile) {
        // It's a raw file coming from the "unmatched" drop folder
        if (!fs.existsSync(newFolderPath)) {
            await fs.promises.mkdir(newFolderPath, { recursive: true });
        }
        activeFolderPath = newFolderPath; 
        const targetFilePath = path.join(newFolderPath, path.basename(oldFolderPath));
        await fs.promises.rename(oldFolderPath, targetFilePath);
    } else if (path.normalize(oldFolderPath).toLowerCase() !== path.normalize(newFolderPath).toLowerCase()) {
        // It's a directory (standard DB unmatched series)
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
                
                Logger.log(`[Match Series Debug] Evaluating file for rename: "${file}"`, 'debug');
                
                // --- FIX: Priority Waterfall Extraction (Prevents V2023 bug) ---
                const explicitMatch = oldName.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?[a-zA-Z]?)/i);
                if (explicitMatch) {
                    issueNumStr = explicitMatch[1];
                    Logger.log(`[Match Series Debug] Extracted issue '${issueNumStr}' via explicit #/Issue match.`, 'debug');
                } else {
                    // Note the (?!\d) lookahead to ensure it's not grabbing a 4-digit year if it's less than 4 digits
                    const volMatch = oldName.match(/(?:vol(?:ume)?\s*\.?|v\s*\.?)\s*0*(\d{1,3}(?:\.\d+)?[a-zA-Z]?)(?!\d)/i);
                    if (volMatch) {
                        issueNumStr = volMatch[1];
                        Logger.log(`[Match Series Debug] Extracted issue '${issueNumStr}' via Volume/V match.`, 'debug');
                    } else {
                        const cleanName = oldName.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').replace(/\s+of\s+\d+/gi, '').trim();
                        const endMatch = cleanName.match(/(?:issue\s?|-|\s|^)0*(\d+(?:\.\d+)?[a-zA-Z]?)\s*$/i);
                        if (endMatch) {
                            issueNumStr = endMatch[1];
                            Logger.log(`[Match Series Debug] Extracted issue '${issueNumStr}' via fallback end-of-string match.`, 'debug');
                        }
                    }
                }
                
                if (!issueNumStr) {
                    Logger.log(`[Match Series Debug] Failed to extract any issue number from ${oldName}`, 'warn');
                }
                
                if (issueNumStr) {
                    let formattedNum = issueNumStr;
                    if (!issueNumStr.includes('.') && issueNumStr.length === 1) formattedNum = `0${issueNumStr}`;
                    
                    const filePatternToUse = isManga 
                        ? (config.manga_file_naming_pattern || "{Series} Vol. {Issue}")
                        : (config.file_naming_pattern || "{Series} #{Issue}");
                        
                    const issueYear = existingRecord ? (existingRecord.year?.toString() || safeYear) : safeYear;
                        
                    const newFileName = filePatternToUse
                        .replace(/{Publisher}/gi, safePublisher || "Other")
                        .replace(/{Series}/gi, safeName)
                        .replace(/{Year}/gi, safeYear)
                        .replace(/{VolumeYear}/gi, safeYear)
                        .replace(/{IssueYear}/gi, issueYear)
                        .replace(/{Issue}/gi, formattedNum)
                        .replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '').replace(/\s+/g, ' ').trim() + ext;
                    
                    const oldFilePath = path.join(activeFolderPath, file);
                    const newFilePath = path.join(activeFolderPath, newFileName);
                    
                    Logger.log(`[Match Series Debug] Generated new path: [${newFilePath}]`, 'debug');
                    
                    if (oldFilePath !== newFilePath && !fs.existsSync(newFilePath)) {
                        Logger.log(`[Match Series Debug] Executing OS File Rename: ${file} -> ${newFileName}`, 'debug');
                        await fs.promises.rename(oldFilePath, newFilePath);
                        if (existingRecord) {
                            pathUpdates.push(prisma.issue.updateMany({
                                where: { seriesId: existingRecord.id, number: issueNumStr },
                                data: { filePath: newFilePath }
                            }));
                        }
                    } else if (oldFilePath !== newFilePath) {
                        Logger.log(`[Match Series Debug] Skipping rename: Target file already exists at ${newFilePath}`, 'debug');
                    }
                }
            }
        }
        
        if (pathUpdates.length > 0) {
            await prisma.$transaction(pathUpdates).catch(() => {});
        }

        if (imageUrl) {
            try {
                const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 3000, headers: { 'User-Agent': 'Omnibus/1.0' } });
                await fs.promises.writeFile(path.join(activeFolderPath, 'cover.jpg'), Buffer.from(imgRes.data));
            } catch(e) {}
        }
    } catch (err) {}

    try {
        const pendingRequests = await prisma.request.findMany({
            where: { volumeId: targetMetaId, status: { in: ['MANUAL_DDL', 'PENDING', 'DOWNLOADING'] } }
        });

        if (pendingRequests.length > 0) {
            const seriesIssues = await prisma.issue.findMany({ where: { series: { metadataId: targetMetaId } } });
            const requestsToComplete = [];

            for (const dbReq of pendingRequests) {
                const searchStr = (dbReq.activeDownloadName || (dbReq as any).title || (dbReq as any).name || "");
                const numMatch = searchStr.match(/(?:#|issue\s*#?)\s*(\d+(?:\.\d+)?)/i);
                const issueNum = numMatch ? parseFloat(numMatch[1]) : null;
                if (issueNum === null) continue;
                const matchingIssue = seriesIssues.find(i => parseFloat(i.number) === issueNum && i.filePath && i.filePath.length > 0);

                if (matchingIssue) requestsToComplete.push(dbReq.id);
            }

            if (requestsToComplete.length > 0) {
                await prisma.request.updateMany({
                    where: { id: { in: requestsToComplete } },
                    data: { status: 'COMPLETED', progress: 100 }
                });
            }
        }
    } catch (e) {}
    
    // --- Trigger Library Scan and Metadata Sync via BullMQ ---
    try {
        if (isFile) {
            await omnibusQueue.add('LIBRARY_SCAN', { type: 'LIBRARY_SCAN' }, { jobId: `LIBRARY_SCAN_${Date.now()}` });
        }
        
        if (existingRecord?.id) {
            await omnibusQueue.add('METADATA_SYNC', { type: 'METADATA_SYNC', seriesIds: [existingRecord.id] }, { jobId: `METADATA_SYNC_MATCH_${existingRecord.id}_${Date.now()}` });
        }
    } catch (e: any) {
        Logger.log(`[Match Series] Failed to queue jobs: ${e.message}`, 'warn');
    }

    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;
    if (userId) {
        await AuditLogger.log('MATCH_SERIES', { oldPath: oldFolderPath, newPath: activeFolderPath }, userId);
    }
    
    revalidateTag('library'); revalidatePath('/library'); revalidatePath('/library/series');
    return NextResponse.json({ success: true, newPath: activeFolderPath, metadataId: targetMetaId });

  } catch (error: unknown) {
    Logger.log(`[Match Series API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}