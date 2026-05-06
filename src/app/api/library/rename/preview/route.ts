import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import path from 'path';
import { getToken } from 'next-auth/jwt';
import { Logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
    try {
        const token = await getToken({ req: request });
        if (token?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        const { seriesIds, folderPattern, filePattern } = await request.json();
        Logger.log(`[Rename Preview Debug] Incoming Request - Series Count: ${seriesIds?.length}, FolderPattern: "${folderPattern}", FilePattern: "${filePattern}"`, 'debug');

        if (!seriesIds || seriesIds.length === 0) {
            Logger.log("[Rename Preview Debug] Warning: No series IDs provided.", 'warn');
            return NextResponse.json({ previews: [] });
        }

        const previews = [];
        const libraries = await prisma.library.findMany();

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
                where: { seriesId: series.id }
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

            let relFolderPath = folderPattern
                .replace(/{Publisher}/gi, safePublisher)
                .replace(/{Series}/gi, safeName)
                .replace(/{Year}/gi, safeYear)
                .replace(/{VolumeYear}/gi, safeYear)
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
                if (!formattedNum.includes('.')) {
                    formattedNum = formattedNum.padStart(3, '0');
                } else {
                    const parts = formattedNum.split('.');
                    formattedNum = `${parts[0].padStart(3, '0')}.${parts[1]}`;
                }

                const newFileName = filePattern
                    .replace(/{Publisher}/gi, safePublisher)
                    .replace(/{Series}/gi, safeName)
                    .replace(/{Year}/gi, safeYear)
                    .replace(/{VolumeYear}/gi, safeYear)
                    .replace(/{IssueYear}/gi, issueYear)
                    .replace(/{Issue}/gi, formattedNum || "")
                    .replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '').replace(/\s+/g, ' ').trim() + ext;

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