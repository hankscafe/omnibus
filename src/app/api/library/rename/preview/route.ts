import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { filePatternForIssue, namingAttachment, seriesTokenForIssue } from '@/lib/utils/file-pattern';
import { retainedKindsForSeries } from '@/lib/retained-attachments';
import path from 'path';
import { getToken } from 'next-auth/jwt';
import { Logger } from '@/lib/logger';
import { issueFileName, issuePaddingFromSetting, issueTitleForName, seriesFolderSegments, type NamingInput } from '@/lib/utils/naming';

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
        const issuePadding = issuePaddingFromSetting(config.issue_number_padding);

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
                // #203 COLLECTED: the preview must know the kind — and, for a LOCAL edition, the
                // source and name — or it promises the wrong name.
                include: { attachedVolume: { select: { kind: true, metadataSource: true, name: true, seriesId: true } } },
            });
            // #239: a series a COLLECTED attachment keeps as its own names its books as collected editions.
            const retainedCollected = (await retainedKindsForSeries(series)).includes('COLLECTED');

            const downloadedIssues = allIssues
                .filter((i: any) => i.filePath && i.filePath.trim() !== '')
                .slice(0, 3); // Grab up to 3 valid, physical files

            Logger.log(`[Rename Preview Debug] Series "${series.name}" has ${downloadedIssues.length} downloaded files queued for preview.`, 'debug');

            if (downloadedIssues.length === 0) continue;

            const lib = libraries.find(l => l.id === series.libraryId) || libraries.find(l => l.isDefault && l.isManga === series.isManga) || libraries[0];
            const libraryRoot = lib?.path || '';

            // The preview promises exactly what the renamers produce: the same pattern resolver and
            // the same naming rules (naming.ts, twinned with the engine renamer).
            const seriesValues: NamingInput = {
                publisher: series.publisher, series: series.name, seriesYear: series.year,
                universe: (series as any).universe, seriesGroup: (series as any).seriesGroup, imprint: (series as any).imprint,
            };
            const folderParts = seriesFolderSegments(folderPattern, seriesValues);
            if (!folderParts) {
                Logger.log(`[Rename Preview Debug] Series "${series.name}": the folder pattern gives no folder inside the library; Standardize will skip it.`, 'debug');
                continue;
            }
            const targetFolderPath = path.join(libraryRoot, ...folderParts).replace(/\\/g, '/');

            for (const issue of downloadedIssues) {
                const ext = path.extname(issue.filePath as string);
                const attachment = namingAttachment(issue);
                const isCollected = attachment?.kind === 'COLLECTED';
                const patternForIssue = filePatternForIssue({
                    isAnnual: (issue as any).isAnnual,
                    isCollected,
                    isRetainedCollected: retainedCollected && !attachment,
                    isManga: series.isManga,
                    filePattern,
                    mangaFilePattern: activeMangaFilePattern,
                    collectedFilePattern: activeCollectedFilePattern,
                });
                // A LOCAL collected edition's books are promised under the edition's name, exactly
                // as both renamers will produce it.
                const seriesToken = seriesTokenForIssue({
                    isCollected,
                    attachmentSource: attachment?.metadataSource,
                    attachmentName: attachment?.name,
                    seriesName: series.name || 'Unknown',
                });
                const stem = issueFileName(patternForIssue, {
                    ...seriesValues,
                    series: seriesToken,
                    issueNumber: issue.number,
                    releaseDate: issue.releaseDate,
                    issueTitle: issueTitleForName(issue.name, series.name, issue.number),
                }, issuePadding);
                if (!stem) continue;

                const targetFilePath = path.join(targetFolderPath, stem + ext).replace(/\\/g, '/');

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
