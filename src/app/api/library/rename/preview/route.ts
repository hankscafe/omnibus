import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import path from 'path';
import { getToken } from 'next-auth/jwt';

export async function POST(request: NextRequest) {
    try {
        const token = await getToken({ req: request });
        if (token?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        const { seriesIds, folderPattern, filePattern } = await request.json();
        console.log("[Rename Preview] Incoming Series IDs:", seriesIds);

        if (!seriesIds || seriesIds.length === 0) {
            console.log("[Rename Preview] Warning: No series IDs provided.");
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
                console.log(`[Rename Preview] Series ${seriesId} not found in DB.`);
                continue;
            }

            // Fetch ALL issues for this series, then strictly filter for downloaded ones in memory
            const allIssues = await prisma.issue.findMany({
                where: { seriesId: series.id }
            });

            const downloadedIssues = allIssues
                .filter((i: any) => i.filePath && i.filePath.trim() !== '')
                .slice(0, 3); // Grab up to 3 valid, physical files

            console.log(`[Rename Preview] Series "${series.name}" has ${downloadedIssues.length} downloaded files queued for preview.`);

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
                .replace(/\(\s*\)/g, '')
                .replace(/\[\s*\]/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            const folderParts = relFolderPath.split(/[/\\]/).map((p: string) => p.trim()).filter(Boolean);
            const targetFolderPath = path.join(libraryRoot, ...folderParts).replace(/\\/g, '/');

            for (const issue of downloadedIssues) {
                const ext = path.extname(issue.filePath as string);
                
                let formattedNum = String(issue.number || "0");
                if (!formattedNum.includes('.')) {
                    formattedNum = formattedNum.padStart(3, '0');
                } else {
                    const parts = formattedNum.split('.');
                    formattedNum = `${parts[0].padStart(3, '0')}.${parts[1]}`;
                }

                // If Manga, you could swap patterns here, but the preview just uses what the user selects in the dropdown
                const newFileName = filePattern
                    .replace(/{Publisher}/gi, safePublisher)
                    .replace(/{Series}/gi, safeName)
                    .replace(/{Year}/gi, safeYear)
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

        console.log(`[Rename Preview] Successfully returning ${previews.length} rows.`);
        return NextResponse.json({ previews });
        
    } catch (error: any) {
        console.error("[Rename Preview API Fatal Error]:", error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}