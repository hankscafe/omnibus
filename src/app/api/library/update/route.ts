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
import { sanitizeFilename as sanitize } from '@/lib/utils/sanitize';
import { safeRelocateFolder } from '@/lib/utils/safe-fs';

export async function POST(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id || 'System';

    const { currentPath, name, year, publisher, cvId, monitored, isManga, status, bookType, seriesGroup,
            description, universe, writeToFile, lockMetadata } = await request.json();

    // Mylar booktype values — anything else is ignored rather than stored
    const VALID_BOOK_TYPES = ['Print', 'OneShot', 'TPB', 'GN'];
    const parsedBookType = VALID_BOOK_TYPES.includes(bookType) ? bookType : null;

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

    const safePublisher = publisher && publisher !== "Unknown" ? sanitize(publisher) : "Other";
    const safeSeries = sanitize(name || "Unknown Series");
    const safeYear = year ? year.toString() : "";

    // Universe/Series Group aren't edited by the basic modal, so resolve them from the existing
    // series record — otherwise a folder pattern using {UniverseName}/{SeriesGroup} would have
    // those subfolders stripped on a routine name/year/publisher edit. seriesGroup may also be
    // supplied explicitly (the metadata editor) and takes precedence when provided.
    const existingMetaRow = await prisma.series.findFirst({
        where: { folderPath: currentPath },
        select: { universe: true, seriesGroup: true }
    });
    const safeUniverse = existingMetaRow?.universe ? sanitize(existingMetaRow.universe) : "";
    const effectiveSeriesGroup = (seriesGroup !== undefined ? seriesGroup : existingMetaRow?.seriesGroup) || "";
    const safeSeriesGroup = effectiveSeriesGroup ? sanitize(effectiveSeriesGroup) : "";

    const relFolderPath = folderPattern
        .replace(/{Publisher}/gi, safePublisher)
        .replace(/{Series}/gi, safeSeries)
        .replace(/{Year}/gi, safeYear)
        .replace(/{VolumeYear}/gi, safeYear)
        .replace(/{UniverseName}/gi, safeUniverse)
        .replace(/{SeriesGroup}/gi, safeSeriesGroup)
        .replace(/\(\s*\)/g, '')
        .replace(/\[\s*\]/g, '') 
        .replace(/\s+/g, ' ')
        .trim();

    const folderParts = relFolderPath.split(/[/\\]/).map((p:string) => p.trim()).filter(Boolean);
    const newPath = path.join(libraryRoot, ...folderParts).replace(/\\/g, '/');
    let activePath = currentPath.replace(/\\/g, '/');

    if (activePath.toLowerCase() !== newPath.toLowerCase()) {
        if (fs.existsSync(activePath)) {
            // Merge into the destination without overwriting — NEVER delete a pre-existing target folder
            // (fs.move with overwrite:true wipes it wholesale). Conflicting files are left in place.
            const { conflicts } = await safeRelocateFolder(activePath, newPath, libraryRoot);
            if (conflicts > 0) {
                Logger.log(`[Library Update] Folder relocate left ${conflicts} conflicting file(s) un-moved in ${activePath}.`, 'warn');
            }
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
        const newMetadataId = parsedCvId !== null ? parsedCvId.toString() : existingRecord.metadataId;
        const isCv = existingRecord.metadataSource === 'COMICVINE';
        const isMetron = existingRecord.metadataSource === 'METRON';

        await prisma.series.update({
            where: { id: existingRecord.id },
            data: {
                name: cleanName,
                year: parsedYear,
                publisher: publisher || null,
                folderPath: activePath,
                monitored: parsedMonitored,
                isManga: parsedIsManga, 
                metadataId: newMetadataId,
                cvId: parsedCvId !== null && isCv ? parsedCvId : existingRecord.cvId,
                metronId: parsedCvId !== null && isMetron ? parsedCvId : existingRecord.metronId,
                metadataSource: existingRecord.metadataSource || 'COMICVINE',
                libraryId: targetLib.id,
                status: status || existingRecord.status,
                bookType: parsedBookType || existingRecord.bookType,
                ...(seriesGroup !== undefined ? { seriesGroup: seriesGroup || null } : {}),
                ...(description !== undefined ? { description: description || null } : {}),
                ...(universe !== undefined ? { universe: universe || null } : {}),
                // Only the rich metadata editor locks the series against auto-sync; the basic
                // Edit Info modal (name/year/publisher) leaves sync behavior unchanged.
                ...(lockMetadata ? { hasCustomMetadata: true } : {})
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

        // Embed manual changes into the files' ComicInfo.xml — unless the admin chose "keep in
        // Omnibus". The per-edit toggle (writeToFile) wins; otherwise the global default applies.
        let doWrite = writeToFile;
        if (doWrite === undefined) {
            const writeSetting = await prisma.systemSetting.findUnique({ where: { key: 'metadata_write_comicinfo' } });
            doWrite = writeSetting?.value !== 'false'; // default: write
        }
        if (doWrite) {
            try {
                await omnibusQueue.add('EMBED_METADATA', { type: 'EMBED_METADATA', seriesId: existingRecord.id }, {
                    jobId: `EMBED_META_${existingRecord.id}_${Date.now()}`
                });
                Logger.log(`[Metadata] Queued XML injection for manually edited series: ${cleanName}`, 'info');
            } catch (e) {}
        }

    } else if (parsedCvId) {
        await prisma.series.upsert({
            where: { metadataSource_metadataId: { metadataSource: 'COMICVINE', metadataId: parsedCvId.toString() } },
            update: {
                name: cleanName, year: parsedYear, publisher: publisher || null,
                folderPath: activePath, monitored: parsedMonitored, isManga: parsedIsManga, libraryId: targetLib.id,
                status: status || undefined,
                bookType: parsedBookType || undefined
            },
            create: {
                metadataId: parsedCvId.toString(), metadataSource: 'COMICVINE', matchState: 'MATCHED', name: cleanName, year: parsedYear, publisher: publisher || null,
                folderPath: activePath, monitored: parsedMonitored, isManga: parsedIsManga, libraryId: targetLib.id,
                status: status || 'Ongoing',
                bookType: parsedBookType
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