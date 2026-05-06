// src/app/api/library/rename/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import { getToken } from 'next-auth/jwt';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { Logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const token = await getToken({ req: request });
    if (token?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

    const { seriesIds, folderPattern, filePattern } = await request.json();
    
    if (!seriesIds || !folderPattern || !filePattern) return NextResponse.json({ error: "Missing parameters" }, { status: 400 });

    const seriesList = await prisma.series.findMany({
        where: { id: { in: seriesIds } }
    });

    const libraries = await prisma.library.findMany();
    
    // --- FETCH GLOBAL FOLDER SETTING ---
    const settings = await prisma.systemSetting.findMany();
    const config = Object.fromEntries(settings.map((s: any) => [s.key, s.value]));
    
    // Use passed pattern, fallback to settings
    const activeFolderPattern = folderPattern || config.folder_naming_pattern || "{Publisher}/{Series} ({Year})";
    const activeFilePattern = filePattern || config.file_naming_pattern || "{Series} #{Issue}";
    const activeMangaFilePattern = filePattern || config.manga_file_naming_pattern || "{Series} Vol. {Issue}";

    // --- NEW: LOG ACTIVE PATTERNS ---
    Logger.log(`[Rename Debug] Initiating standardize procedure for ${seriesList.length} series.`, 'debug');
    Logger.log(`[Rename Debug] Active Patterns -> Folder: "${activeFolderPattern}" | File: "${activeFilePattern}" | Manga: "${activeMangaFilePattern}"`, 'debug');

    let filesRenamed = 0;
    let foldersRenamed = 0;

    function sanitize(str: string) { return str.replace(/[<>:"/\\|?*]/g, '').trim(); }

    for (const s of seriesList) {
        if (!s.folderPath || !fs.existsSync(s.folderPath)) {
            Logger.log(`[Rename Debug] Skipping series "${s.name}" - Folder missing: ${s.folderPath}`, 'debug');
            continue;
        }

        Logger.log(`[Rename Debug] Processing Series: "${s.name}" (ID: ${s.id}, isManga: ${s.isManga})`, 'debug');

        const lib = libraries.find(l => l.id === s.libraryId) || libraries.find(l => l.isDefault && l.isManga === s.isManga) || libraries[0];
        if (!lib) continue;

        const libraryRoot = lib.path;
        let currentFolder = s.folderPath;

        if (libraryRoot) {
            const safePublisher = s.publisher && s.publisher !== "Unknown" ? sanitize(s.publisher) : "Other";
            const safeSeries = sanitize(s.name || "Unknown");
            const safeYear = s.year ? s.year.toString() : "";
            
            // FIX: Use activeFolderPattern here
            let relFolderPath = activeFolderPattern
                .replace(/{Publisher}/gi, safePublisher)
                .replace(/{Series}/gi, safeSeries)
                .replace(/{Year}/gi, safeYear)
                .replace(/{VolumeYear}/gi, safeYear)
                .replace(/\(\s*\)/g, '') 
                .replace(/\[\s*\]/g, '') 
                .replace(/\s+/g, ' ')
                .trim();

            const folderParts = relFolderPath.split(/[/\\]/).map((p:string) => p.trim()).filter(Boolean);
            const targetFolder = path.join(libraryRoot, ...folderParts);

            Logger.log(`[Rename Debug] Folder Evaluation: Current=[${currentFolder}] | Target=[${targetFolder}]`, 'debug');

            if (path.normalize(currentFolder).toLowerCase() !== path.normalize(targetFolder).toLowerCase()) {
                await fs.ensureDir(path.dirname(targetFolder));
                await fs.move(currentFolder, targetFolder, { overwrite: true });
                currentFolder = targetFolder;
                
                await prisma.series.update({
                    where: { id: s.id },
                    data: { folderPath: currentFolder }
                });
                foldersRenamed++;
            }
        }

        const issues = await prisma.issue.findMany({ where: { seriesId: s.id } });

        for (const issue of issues) {
            const currentFileName = path.basename(issue.filePath || "");
            const actualFilePath = path.join(currentFolder, currentFileName);

            if (!fs.existsSync(actualFilePath)) {
                Logger.log(`[Rename Debug] Skipping issue "${issue.name}" - File missing: ${actualFilePath}`, 'debug');
                continue;
            }

            const ext = path.extname(actualFilePath);
            let paddedNum = issue.number;
            if (!paddedNum.includes('.')) {
                paddedNum = paddedNum.padStart(3, '0');
            } else {
                const parts = paddedNum.split('.');
                paddedNum = `${parts[0].padStart(3, '0')}.${parts[1]}`;
            }

            // FIX: Determine correct file pattern based on manga status
            const patternToUse = s.isManga ? activeMangaFilePattern : activeFilePattern;

            // USE s.year directly instead of safeYear to avoid the scope error
            const issueYear = issue.releaseDate ? issue.releaseDate.split('-')[0] : (s.year?.toString() || '0000');

            // --- NEW: TRACE ISSUE REPLACEMENT VARIABLES ---
            Logger.log(`[Rename Debug] Issue Formatting Data: Series="${s.name}", Publisher="${s.publisher}", SeriesYear="${s.year}", IssueYear="${issueYear}", IssueNum="${paddedNum}", Ext="${ext}"`, 'debug');

            let newFileName = patternToUse
                .replace(/{Publisher}/gi, s.publisher || 'Unknown')
                .replace(/{Series}/gi, s.name || 'Unknown')
                .replace(/{Year}/gi, s.year?.toString() || '0000')
                .replace(/{VolumeYear}/gi, s.year?.toString() || '0000')
                .replace(/{IssueYear}/gi, issueYear)
                .replace(/{Issue}/gi, paddedNum);
            
            newFileName = sanitize(newFileName) + ext;
            const newFilePath = path.join(currentFolder, newFileName);

            Logger.log(`[Rename Debug] File Evaluation: Current=[${actualFilePath}] | Target=[${newFilePath}]`, 'debug');

            if (actualFilePath !== newFilePath) {
                try {
                    if (!fs.existsSync(newFilePath)) {
                        await fs.move(actualFilePath, newFilePath);
                        await prisma.issue.update({
                            where: { id: issue.id },
                            data: { filePath: newFilePath }
                        });
                        filesRenamed++;
                    } else {
                        Logger.log(`[Rename Debug] Cannot rename: Target file already exists at ${newFilePath}`, 'warn');
                    }
                } catch (e: any) { 
                    Logger.log(`[Rename Debug] File move failed for ${actualFilePath}: ${e.message}`, 'error');
                }
            } else if (issue.filePath !== newFilePath) {
                 // DB Path is out of sync with physical path
                 await prisma.issue.update({
                    where: { id: issue.id },
                    data: { filePath: newFilePath }
                });
            }
        }
    }

    await AuditLogger.log('BULK_RENAME_FILES', { 
        seriesRenamed: foldersRenamed, 
        filesRenamed: filesRenamed,
        folderPattern: activeFolderPattern,
        filePattern: activeFilePattern
    }, (token.id || token.sub) as string);

    return NextResponse.json({ success: true, filesRenamed, foldersRenamed });

  } catch (error: unknown) {
    Logger.log(`[Library Rename API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}