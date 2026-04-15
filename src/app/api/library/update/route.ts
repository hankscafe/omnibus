// src/app/api/library/update/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import { revalidatePath, revalidateTag } from 'next/cache';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { omnibusQueue } from '@/lib/queue';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { AuditLogger } from '@/lib/audit-logger';

export async function POST(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id || 'System';

    const { currentPath, name, year, publisher, cvId, monitored, isManga } = await request.json();

    const parsedIsManga = isManga === true || isManga === 'true' || isManga === 'on' || isManga === 1;
    const parsedMonitored = monitored === true || monitored === 'true' || monitored === 'on' || monitored === 1;

    const libraries = await prisma.library.findMany();
    let targetLib = parsedIsManga 
        ? libraries.find(l => l.isDefault && l.isManga) || libraries.find(l => l.isManga)
        : libraries.find(l => l.isDefault && !l.isManga) || libraries.find(l => !l.isManga);
        
    if (!targetLib) targetLib = libraries[0];
    if (!targetLib) return NextResponse.json({ error: "No libraries configured in Settings." }, { status: 400 });

    const libraryRoot = targetLib.path;

    const settings = await prisma.systemSetting.findMany();
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
    const folderPattern = config.folder_naming_pattern || "{Publisher}/{Series} ({Year})";

    function sanitize(str: string) { return str.replace(/[<>:"/\\|?*]/g, '').trim(); }
    
    const safePublisher = publisher && publisher !== "Unknown" ? sanitize(publisher) : "Other";
    const safeSeries = sanitize(name || "Unknown Series");
    const safeYear = year ? year.toString() : "";
    
    let relFolderPath = folderPattern
        .replace(/{Publisher}/gi, safePublisher)
        .replace(/{Series}/gi, safeSeries)
        .replace(/{Year}/gi, safeYear)
        .replace(/\(\s*\)/g, '') 
        .replace(/\[\s*\]/g, '') 
        .replace(/\s+/g, ' ')
        .trim();

    const folderParts = relFolderPath.split(/[/\\]/).map((p:string) => p.trim()).filter(Boolean);
    let newPath = path.join(libraryRoot, ...folderParts).replace(/\\/g, '/');
    let activePath = currentPath.replace(/\\/g, '/');

    if (activePath.toLowerCase() !== newPath.toLowerCase()) {
        if (fs.existsSync(activePath)) {
            await fs.ensureDir(path.dirname(newPath));
            await fs.move(activePath, newPath, { overwrite: true });
            activePath = newPath;
        } else {
            activePath = newPath;
        }
    }

    const parsedCvId = cvId ? parseInt(cvId) : null;
    const parsedYear = parseInt(year) || new Date().getFullYear();
    const cleanName = name ? name.trim() : "Unknown Series";

    const existingRecord = await prisma.series.findFirst({
        where: { folderPath: currentPath } 
    });

    if (existingRecord) {
        await prisma.series.update({
            where: { id: existingRecord.id },
            data: {
                name: cleanName,
                year: parsedYear,
                publisher: publisher || null,
                folderPath: activePath,
                monitored: parsedMonitored,
                isManga: parsedIsManga, 
                metadataId: parsedCvId !== null ? parsedCvId.toString() : existingRecord.metadataId,
                metadataSource: 'COMICVINE',
                libraryId: targetLib.id
            }
        });

        if (currentPath.replace(/\\/g, '/').toLowerCase() !== activePath.toLowerCase()) {
            const issues = await prisma.issue.findMany({ where: { seriesId: existingRecord.id } });
            const pathUpdates = [];
            for (const issue of issues) {
                if (issue.filePath) {
                    const fileName = path.basename(issue.filePath);
                    const updatedFilePath = path.join(activePath, fileName).replace(/\\/g, '/');
                    pathUpdates.push(prisma.issue.update({
                        where: { id: issue.id },
                        data: { filePath: updatedFilePath }
                    }));
                }
            }
            if (pathUpdates.length > 0) {
                await prisma.$transaction(pathUpdates).catch((err) => {
                    Logger.log(`Path updates transaction failed: ${getErrorMessage(err)}`, 'error');
                });
            }
        }

        // --- NEW: Trigger instant XML embedding to reflect these manual changes ---
        try {
            await omnibusQueue.add('EMBED_METADATA', { type: 'EMBED_METADATA', seriesId: existingRecord.id }, {
                jobId: `EMBED_META_${existingRecord.id}_${Date.now()}`
            });
            Logger.log(`[Metadata] Queued XML injection for manually edited series: ${cleanName}`, 'info');
        } catch (e) {}

    } else if (parsedCvId) {
        await prisma.series.upsert({
            where: { metadataSource_metadataId: { metadataSource: 'COMICVINE', metadataId: parsedCvId.toString() } },
            update: {
                name: cleanName, year: parsedYear, publisher: publisher || null,
                folderPath: activePath, monitored: parsedMonitored, isManga: parsedIsManga, libraryId: targetLib.id
            },
            create: {
                metadataId: parsedCvId.toString(), metadataSource: 'COMICVINE', matchState: 'MATCHED', name: cleanName, year: parsedYear, publisher: publisher || null,
                folderPath: activePath, monitored: parsedMonitored, isManga: parsedIsManga, libraryId: targetLib.id
            }
        });
    }

    revalidateTag('library');
    revalidatePath('/library');
    revalidatePath('/library/series');

    await AuditLogger.log('UPDATE_SERIES_METADATA', { 
        seriesName: cleanName, 
        oldPath: currentPath,
        newPath: activePath
    }, userId);

    return NextResponse.json({ success: true, newPath: activePath });

  } catch (error: unknown) {
    Logger.log(`[Library Update API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}