import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { filePatternForIssue } from '@/lib/utils/file-pattern';
import path from 'path';
import { getToken } from 'next-auth/jwt';
import { Logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
    try {
        const token = await getToken({ req: request });
        if (token?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        const { seriesIds, folderPattern, filePattern, mangaFilePattern, collectedFilePattern } = await request.json();
        Logger.log(`[Rename Preview Debug] Incoming Request - Series Count: ${seriesIds?.length}, FolderPattern: "${folderPattern}", FilePattern: "${filePattern}", MangaFilePattern: "${mangaFilePattern || ''}"`, 'debug');

        if (!seriesIds || seriesIds.length === 0) {
            Logger.log("[Rename Preview Debug] Warning: No series IDs provided.", 'warn');
            return NextResponse.json({ previews: [] });
        }

        const previews = [];
        const libraries = await prisma.library.findMany();

        // Per-series pattern selection mirrors the rename route (worklist item 8) — the preview
        // previously ran every series through the single filePattern, so it LIED about what the
        // standardize would do to manga.
        const settings = await prisma.systemSetting.findMany();
        const config = Object.fromEntries(settings.map((s: any) => [s.key, s.value]));
        const activeMangaFilePattern = mangaFilePattern || config.manga_file_naming_pattern || "{Series} Vol. {Issue}";
        const activeCollectedFilePattern = collectedFilePattern || config.collected_file_naming_pattern || null;

        // Loop through each selected series individually to prevent massive DB joins
        for (const seriesId of seriesIds) {
            const series = await prisma.series.findUnique({
                where: { id: seriesId }
            });

            if (!series) {
                Logger.log(`[Rename Preview Debug] Series ${seriesId} not found in DB.`, 'debug');
                continue;
            }

            // Fetch ALL issues for this series, then strictly filter for downloaded ones in memory
            const allIssues = await prisma.issue.findMany({
                where: { seriesId: series.id },
                // #203 COLLECTED: the preview must know the kind, or it promises the wrong name.
                include: { attachedVolume: { select: { kind: true } } },
            });

            const downloadedIssues = allIssues
                .filter((i: any) => i.filePath && i.filePath.trim() !== '')
                .slice(0, 3); // Grab up to 3 valid, physical files

            Logger.log(`[Rename Preview Debug] Series "${series.name}" has ${downloadedIssues.length} downloaded files queued for preview.`, 'debug');

            if (downloadedIssues.length === 0) continue;

            const lib = libraries.find(l => l.id === series.libraryId) || libraries.find(l => l.isDefault && l.isManga === series.isManga) || libraries[0];
            const libraryRoot = lib?.path || '';

            const safePublisher = series.publisher ? series.publisher.replace(/[<>:"/\\|?*]/g, '').trim() : "Other";
            const safeName = series.name ? series.name.replace(/[<>:"/\\|?*]/g, '').trim() : "Unknown Series";
            const safeYear = series.year ? series.year.toString() : "";
            const safeUniverse = (series as any).universe ? (series as any).universe.replace(/[<>:"/\\|?*]/g, '').trim() : "";
            const safeSeriesGroup = (series as any).seriesGroup ? (series as any).seriesGroup.replace(/[<>:"/\\|?*]/g, '').trim() : "";

            const relFolderPath = folderPattern
                .replace(/{Publisher}/gi, safePublisher)
                .replace(/{Series}/gi, safeName)
                .replace(/{Year}/gi, safeYear)
                .replace(/{VolumeYear}/gi, safeYear)
                .replace(/{UniverseName}/gi, safeUniverse)
                .replace(/{SeriesGroup}/gi, safeSeriesGroup)
                .replace(/\(\s*\)/g, '')
                .replace(/\[\s*\]/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            const folderParts = relFolderPath.split(/[/\\]/).map((p: string) => p.trim()).filter(Boolean);
            const targetFolderPath = path.join(libraryRoot, ...folderParts).replace(/\\/g, '/');

            for (const issue of downloadedIssues) {
                const ext = path.extname(issue.filePath as string);
                const issueYear = issue.releaseDate ? issue.releaseDate.split('-')[0] : safeYear;
                
                let formattedNum = String(issue.number || "0");
                
                // 1. Check for and temporarily remove the negative sign
                const isNegative = formattedNum.startsWith('-');
                if (isNegative) formattedNum = formattedNum.substring(1);

                // 2. Safely apply zero-padding
                if (!formattedNum.includes('.')) {
                    formattedNum = formattedNum.padStart(3, '0');
                } else {
                    const parts = formattedNum.split('.');
                    formattedNum = `${parts[0].padStart(3, '0')}.${parts[1]}`;
                }
                
                // 3. Re-attach the negative sign
                if (isNegative) formattedNum = '-' + formattedNum;

                // --- NEW: Add Issue Title extraction & cleanup ---
                let cleanIssueName = issue.name || "";
                if (safeName && cleanIssueName.startsWith(`${safeName} #${issue.number}: `)) {
                    cleanIssueName = cleanIssueName.replace(`${safeName} #${issue.number}: `, '');
                } else if (safeName && cleanIssueName === `${safeName} #${issue.number}`) {
                    cleanIssueName = "";
                }

                // The preview has to promise what the renamer will actually do, so it resolves
                // the template through the same shared helper both renamers use.
                const patternForIssue = filePatternForIssue({
                    isAnnual: (issue as any).isAnnual,
                    isCollected: (issue as any).attachedVolume?.kind === 'COLLECTED',
                    isManga: series.isManga,
                    filePattern,
                    mangaFilePattern: activeMangaFilePattern,
                    collectedFilePattern: activeCollectedFilePattern,
                });

                const newFileName = patternForIssue
                    .replace(/{Publisher}/gi, safePublisher)
                    .replace(/{Series}/gi, safeName)
                    .replace(/{Year}/gi, safeYear)
                    .replace(/{VolumeYear}/gi, safeYear)
                    .replace(/{IssueYear}/gi, issueYear)
                    .replace(/{Issue}/gi, formattedNum || "")
                    .replace(/{IssueTitle}/gi, cleanIssueName.replace(/[<>:"/\\|?*]/g, '').trim()) // <-- ADD THIS
                    .replace(/{UniverseName}/gi, safeUniverse) // <-- ADD THIS
                    .replace(/{SeriesGroup}/gi, safeSeriesGroup)
                    .replace(/\(\s*\)/g, '')
                    .replace(/\[\s*\]/g, '')
                    .replace(/\s*-\s*-/g, ' - ') // <-- ADD THIS
                    .replace(/(^\s*-\s*|\s*-\s*$)/g, '') // <-- ADD THIS
                    .replace(/\s+/g, ' ')
                    .trim() + ext;

                const targetFilePath = path.join(targetFolderPath, newFileName).replace(/\\/g, '/');

                previews.push({
                    seriesName: series.name,
                    oldPath: issue.filePath,
                    newPath: targetFilePath
                });
            }
        }

        Logger.log(`[Rename Preview Debug] Successfully returning ${previews.length} rows.`, 'debug');
        return NextResponse.json({ previews });
        
    } catch (error: any) {
        Logger.log(`[Rename Preview API Fatal Error]: ${error.message}`, 'error');
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}