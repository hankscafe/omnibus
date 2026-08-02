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
import { comicInfoDefaultsUpdateFragment } from '@/lib/utils/comicinfo-fields';

export async function POST(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    // This route relocates folders, rewrites issue.filePath, mutates the Series record and queues jobs.
    // Middleware only role-gates /api/admin/*, so gate here too — otherwise any authenticated user reaches it.
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    const userId = (session?.user as any)?.id || 'System';

    const body = await request.json();
    const { currentPath, name, year, publisher, cvId, monitored, isManga, status, bookType, seriesGroup,
            description, universe, writeToFile, lockMetadata, clearCustomMetadata } = body;
    // #199 ComicInfo defaults from the series editor's Credits/Story & Tags/Details tabs — the
    // shared fragment (also used by match-series) converts + validates them; absent keys touch
    // nothing, so callers that never send these fields (Edit Info modal, scripts) are unaffected.
    const comicInfoFrag = comicInfoDefaultsUpdateFragment(body);

    // Unlock (issue #194 (f), series side): clears the manual-edits lock so provider syncs may
    // refresh this series' narrative fields again. Mirrors the per-issue unlock; nothing else in
    // the payload is touched on this path.
    if (clearCustomMetadata === true) {
        const record = await prisma.series.findFirst({ where: { folderPath: currentPath } });
        if (!record) return NextResponse.json({ error: "Series not found." }, { status: 404 });
        await prisma.series.update({ where: { id: record.id }, data: { hasCustomMetadata: false } });
        await AuditLogger.log('RESTORE_SERIES_DEFAULTS', { seriesName: record.name, scope: 'lock' }, userId);
        return NextResponse.json({ success: true, unlocked: true });
    }

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

    // A zero-change save must be inert (issue #194 (f), series side): the metadata editor always
    // sends lockMetadata, so an unconditional stamp locked the series against provider syncs on a
    // no-op Save — and the unconditional embed below rewrote EVERY archive's ComicInfo.xml in the
    // series for nothing. Diff first; the lock only engages when a narrative field genuinely
    // changed (that's what the lock protects), and nothing at all is written on a true no-op.
    const norm = (v: unknown) => (v === '' || v === undefined || v === null ? null : v);
    let narrativeChanged = false;
    let identityChanged = false;
    let anyChange = true; // series-create path below always counts as a change

    if (existingRecord) {
        narrativeChanged =
            (description !== undefined && norm(description) !== norm(existingRecord.description)) ||
            (universe !== undefined && norm(universe) !== norm(existingRecord.universe)) ||
            (seriesGroup !== undefined && norm(seriesGroup) !== norm(existingRecord.seriesGroup)) ||
            // #199: a changed ComicInfo default is manual curation too — it engages the lock and
            // defeats the no-op guard. Stored and new values share the same conversion (the shared
            // fragment wrote both), so plain normalized comparison is exact.
            Object.entries(comicInfoFrag).some(([col, v]) => norm(v) !== norm((existingRecord as any)[col]));
        identityChanged =
            cleanName !== existingRecord.name ||
            parsedYear !== existingRecord.year ||
            norm(publisher) !== norm(existingRecord.publisher) ||
            parsedMonitored !== !!existingRecord.monitored ||
            parsedIsManga !== existingRecord.isManga ||
            (status ? status !== existingRecord.status : false) ||
            (parsedBookType ? parsedBookType !== existingRecord.bookType : false) ||
            (parsedCvId !== null && parsedCvId.toString() !== existingRecord.metadataId) ||
            targetLib.id !== existingRecord.libraryId;
        const pathChanged = currentPath.replace(/\\/g, '/').toLowerCase() !== activePath.toLowerCase();
        anyChange = narrativeChanged || identityChanged || pathChanged;
    }

    if (existingRecord && !anyChange) {
        await AuditLogger.log('UPDATE_SERIES_METADATA', {
            seriesName: cleanName, oldPath: currentPath, newPath: activePath, changed: false,
        }, userId);
        return NextResponse.json({ success: true, newPath: activePath, changed: false });
    }

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
                ...comicInfoFrag,
                // Only the rich metadata editor locks the series against auto-sync — and only
                // when a narrative field actually changed; identity-only and no-op saves leave
                // sync behavior unchanged (the basic Edit Info modal never sends lockMetadata).
                ...(lockMetadata && narrativeChanged ? { hasCustomMetadata: true } : {})
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

    return NextResponse.json({ success: true, newPath: activePath, changed: true });

  } catch (error: unknown) {
    Logger.log(`[Library Update API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}