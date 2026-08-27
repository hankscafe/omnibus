// src/app/api/library/rename/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import { getToken } from 'next-auth/jwt';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { Logger } from '@/lib/logger';
import { sanitizeFilename as sanitize } from '@/lib/utils/sanitize';
import { cleanupEmptyDirs } from '@/lib/utils/safe-fs';
import { ENGINE_URL, engineHeaders, engineFetchLong } from '@/lib/engine';

export async function POST(request: NextRequest) {
  try {
    const token = await getToken({ req: request });
    if (token?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

    const { seriesIds, folderPattern, filePattern, mangaFilePattern } = await request.json();

    if (!seriesIds || !folderPattern || !filePattern) return NextResponse.json({ error: "Missing parameters" }, { status: 400 });

    // Resolve the manga pattern up front so BOTH the engine offload and the local fallback use it.
    // The old code computed `filePattern || config.manga_file_naming_pattern` — the client always
    // sends filePattern, so the manga pattern was permanently shadowed (2026-07-25 worklist item 8).
    const earlySettings = await prisma.systemSetting.findMany();
    const earlyConfig = Object.fromEntries(earlySettings.map((s: any) => [s.key, s.value]));
    const activeMangaFilePattern = mangaFilePattern || earlyConfig.manga_file_naming_pattern || "{Series} Vol. {Issue}";

    // --- ENGINE OFFLOAD ---
    // The engine runs the identical standardize pipeline (per-file relocation, conflict guard,
    // empty-dir cleanup, Issue/Series DB updates) without holding the Node event loop for what can
    // be hundreds of moves. Synchronous by design: the UI needs the summary + newPath from the
    // response. engineFetchLong disables undici's idle timeouts for large jobs. Any failure falls
    // through to the identical local loop below.
    try {
        const engineRes = await engineFetchLong(ENGINE_URL + '/api/library/rename', {
            method: 'POST',
            headers: engineHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ series_ids: seriesIds, folder_pattern: folderPattern, file_pattern: filePattern, manga_file_pattern: activeMangaFilePattern }),
        });
        if (engineRes.ok) {
            const data = await engineRes.json();
            await AuditLogger.log('BULK_RENAME_FILES', {
                seriesRenamed: data.foldersRenamed,
                filesRenamed: data.filesRenamed,
                conflicts: data.conflicts,
                folderPattern,
                filePattern,
                mangaFilePattern: activeMangaFilePattern
            }, (token.id || token.sub) as string);
            return NextResponse.json({
                success: true,
                filesRenamed: data.filesRenamed,
                foldersRenamed: data.foldersRenamed,
                conflicts: data.conflicts,
                newPath: data.newPath
            });
        }
        Logger.log(`[Library Rename API] Engine returned ${engineRes.status}, using local rename loop.`, 'warn');
    } catch (e) {
        Logger.log(`[Library Rename API] Engine offload unavailable, using local rename loop: ${getErrorMessage(e)}`, 'debug');
    }

    const seriesList = await prisma.series.findMany({
        where: { id: { in: seriesIds } }
    });

    const libraries = await prisma.library.findMany();

    // --- GLOBAL PATTERN SETTINGS (fetched once, before the engine offload) ---
    const config = earlyConfig;

    // Use passed pattern, fallback to settings. The manga pattern was resolved before the engine
    // offload (activeMangaFilePattern above) — a distinct field, never shadowed by filePattern.
    const activeFolderPattern = folderPattern || config.folder_naming_pattern || "{Publisher}/{Series} ({Year})";
    const activeFilePattern = filePattern || config.file_naming_pattern || "{Series} #{Issue}";

    Logger.log(`[Rename Debug] Initiating standardize procedure for ${seriesList.length} series.`, 'debug');
    Logger.log(`[Rename Debug] Active Patterns -> Folder: "${activeFolderPattern}" | File: "${activeFilePattern}" | Manga: "${activeMangaFilePattern}"`, 'debug');

    let filesRenamed = 0;
    let foldersRenamed = 0;
    let conflicts = 0;
    let lastProcessedPath = "";

    for (const s of seriesList) {
        const lib = libraries.find(l => l.id === s.libraryId) || libraries.find(l => l.isDefault && l.isManga === s.isManga) || libraries[0];
        if (!lib || !lib.path) {
            Logger.log(`[Rename Debug] Skipping series "${s.name}" - no library root resolved.`, 'debug');
            continue;
        }
        const libraryRoot = lib.path;
        const currentFolder = s.folderPath || "";

        Logger.log(`[Rename Debug] Processing Series: "${s.name}" (ID: ${s.id}, isManga: ${s.isManga})`, 'debug');

        // --- Shared substitution values (used for both folder + file patterns) ---
        const safePublisher = s.publisher && s.publisher !== "Unknown" ? sanitize(s.publisher) : "Other";
        const safeSeries = sanitize(s.name || "Unknown");
        const safeYear = s.year ? s.year.toString() : "";
        const safeUniverse = (s as any).universe ? sanitize((s as any).universe) : "";
        const safeSeriesGroup = (s as any).seriesGroup ? sanitize((s as any).seriesGroup) : "";

        // --- Compute the target folder from the active pattern ---
        const relFolderPath = activeFolderPattern
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

        const folderParts = relFolderPath.split(/[/\\]/).map((p: string) => p.trim()).filter(Boolean);
        if (folderParts.length === 0) {
            Logger.log(`[Rename Debug] Skipping series "${s.name}" - naming pattern produced an empty folder path.`, 'warn');
            continue;
        }
        const targetFolder = path.join(libraryRoot, ...folderParts);
        const folderChanged = !currentFolder || path.normalize(currentFolder).toLowerCase() !== path.normalize(targetFolder).toLowerCase();

        Logger.log(`[Rename Debug] Folder Evaluation: Current=[${currentFolder}] | Target=[${targetFolder}]`, 'debug');

        const issues = await prisma.issue.findMany({ where: { seriesId: s.id } });

        // Only act if at least one real file exists (the recorded folder, or any issue file wherever it
        // lives). This handles series whose files are split across {SeriesGroup} subfolders, and avoids
        // creating an empty target folder for a series with nothing on disk.
        const hasAnyFile = (currentFolder && fs.existsSync(currentFolder))
            || issues.some(i => i.filePath && fs.existsSync(i.filePath));
        if (!hasAnyFile) {
            Logger.log(`[Rename Debug] Skipping series "${s.name}" - no files found on disk.`, 'debug');
            continue;
        }

        // Create the destination. We NEVER move a whole folder with overwrite (fs-extra deletes a
        // pre-existing target + everything in it). Files are relocated one-by-one + guarded below.
        try {
            await fs.ensureDir(targetFolder);
        } catch (e: any) {
            Logger.log(`[Rename Debug] Could not create target folder ${targetFolder}: ${getErrorMessage(e)}`, 'error');
            continue;
        }

        // Track the directories we move files out of, so we can clean up the emptied ones afterward.
        const sourceDirs = new Set<string>();
        if (currentFolder) sourceDirs.add(path.normalize(currentFolder));

        for (const issue of issues) {
            // Resolve the REAL source file: the issue's recorded path first (so files scattered across
            // {SeriesGroup} subfolders are found + consolidated), else the series folder by basename.
            const baseName = path.basename(issue.filePath || "");
            let sourcePath = "";
            if (issue.filePath && fs.existsSync(issue.filePath)) {
                sourcePath = issue.filePath;
            } else if (baseName && currentFolder) {
                const fallback = path.join(currentFolder, baseName);
                if (fs.existsSync(fallback)) sourcePath = fallback;
            }
            if (!sourcePath) {
                Logger.log(`[Rename Debug] Skipping issue "${issue.name}" - file not found (db path: ${issue.filePath}).`, 'debug');
                continue;
            }

            const ext = path.extname(sourcePath);

            let paddedNum = String(issue.number || "0");
            const isNegative = paddedNum.startsWith('-');
            if (isNegative) paddedNum = paddedNum.substring(1);
            if (!paddedNum.includes('.')) {
                paddedNum = paddedNum.padStart(3, '0');
            } else {
                const parts = paddedNum.split('.');
                paddedNum = `${parts[0].padStart(3, '0')}.${parts[1]}`;
            }
            if (isNegative) paddedNum = '-' + paddedNum;

            // #203 Phase 1: annuals get the Mylar-shaped name they exist to interoperate with —
            // "Batman Annual #001 (2012)", the year being the annual's own. Fixed in v1 (engine
            // parity: renamer.rs), because the point is matching what Mylar/Komga expect beside the
            // main run; the tokens still flow through the same substitution + sanitize chain.
            const patternToUse = (issue as any).isAnnual
                ? "{Series} Annual #{Issue} ({IssueYear})"
                : (s.isManga ? activeMangaFilePattern : activeFilePattern);
            const issueYear = issue.releaseDate ? issue.releaseDate.split('-')[0] : (s.year?.toString() || '0000');

            let cleanIssueName = issue.name || "";
            if (s.name && cleanIssueName.startsWith(`${s.name} #${issue.number}: `)) {
                cleanIssueName = cleanIssueName.replace(`${s.name} #${issue.number}: `, '');
            } else if (s.name && cleanIssueName === `${s.name} #${issue.number}`) {
                cleanIssueName = "";
            }

            let newFileName = patternToUse
                .replace(/{Publisher}/gi, s.publisher || 'Unknown')
                .replace(/{Series}/gi, s.name || 'Unknown')
                .replace(/{Year}/gi, s.year?.toString() || '0000')
                .replace(/{VolumeYear}/gi, s.year?.toString() || '0000')
                .replace(/{IssueYear}/gi, issueYear)
                .replace(/{Issue}/gi, paddedNum)
                .replace(/{IssueTitle}/gi, sanitize(cleanIssueName))
                .replace(/{UniverseName}/gi, safeUniverse)
                .replace(/{SeriesGroup}/gi, safeSeriesGroup)
                .replace(/\(\s*\)/g, '')
                .replace(/\[\s*\]/g, '')
                .replace(/\s*-\s*-/g, ' - ')
                .replace(/(^\s*-\s*|\s*-\s*$)/g, '')
                .replace(/\s+/g, ' ');

            newFileName = sanitize(newFileName) + ext;
            const newFilePath = path.join(targetFolder, newFileName);

            Logger.log(`[Rename Debug] File Evaluation: Source=[${sourcePath}] | Target=[${newFilePath}]`, 'debug');

            // Already at the correct path + name (case-insensitive) → just keep the DB in sync.
            if (path.normalize(sourcePath).toLowerCase() === path.normalize(newFilePath).toLowerCase()) {
                if (issue.filePath !== newFilePath) {
                    await prisma.issue.update({ where: { id: issue.id }, data: { filePath: newFilePath } });
                }
                continue;
            }

            // GUARD: never overwrite a different existing file. Leave the source untouched and log the
            // conflict so the worst case is "nothing moved" rather than data loss.
            if (fs.existsSync(newFilePath)) {
                Logger.log(`[Rename Debug] Conflict: a different file already exists at the target, leaving source in place: ${newFilePath}`, 'warn');
                conflicts++;
                continue;
            }

            try {
                await fs.move(sourcePath, newFilePath); // overwrite defaults to false — and we guarded above
                sourceDirs.add(path.normalize(path.dirname(sourcePath)));
                await prisma.issue.update({
                    where: { id: issue.id },
                    data: { filePath: newFilePath }
                });
                filesRenamed++;
            } catch (e: any) {
                Logger.log(`[Rename Debug] File move failed for ${sourcePath}: ${getErrorMessage(e)}`, 'error');
            }
        }

        // Point the series at the (now-populated) target folder.
        if (s.folderPath !== targetFolder) {
            await prisma.series.update({
                where: { id: s.id },
                data: { folderPath: targetFolder }
            });
            if (folderChanged) foldersRenamed++;
        }

        // Clean up emptied source folders ONLY — never the target, never a folder that still has files.
        for (const dir of sourceDirs) {
            if (dir.toLowerCase() !== path.normalize(targetFolder).toLowerCase()) {
                await cleanupEmptyDirs(dir, libraryRoot);
            }
        }

        lastProcessedPath = targetFolder;
    }

    await AuditLogger.log('BULK_RENAME_FILES', {
        seriesRenamed: foldersRenamed,
        filesRenamed: filesRenamed,
        conflicts: conflicts,
        folderPattern: activeFolderPattern,
        filePattern: activeFilePattern
    }, (token.id || token.sub) as string);

    return NextResponse.json({ success: true, filesRenamed, foldersRenamed, conflicts, newPath: lastProcessedPath });

  } catch (error: unknown) {
    Logger.log(`[Library Rename API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
