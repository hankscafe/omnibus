import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export async function POST(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { seriesIds, pattern } = await request.json();

    if (!seriesIds || !pattern) return NextResponse.json({ error: "Missing parameters" }, { status: 400 });

    const seriesList = await prisma.series.findMany({
        where: { id: { in: seriesIds } }
    });

    const configSetting = await prisma.systemSetting.findMany();
    const config = Object.fromEntries(configSetting.map(s => [s.key, s.value]));

    let filesRenamed = 0;
    let foldersRenamed = 0;

    function sanitize(str: string) { return str.replace(/[<>:"/\\|?*]/g, '').trim(); }

    for (const s of seriesList) {
        if (!s.folderPath || !fs.existsSync(s.folderPath)) continue;

        const libraryRoot = s.isManga ? config.manga_library_path : config.library_path;
        let currentFolder = s.folderPath;

        // ---------------------------------------------------------
        // 1. STANDARDIZE THE FOLDER PATH FIRST
        // ---------------------------------------------------------
        if (libraryRoot) {
            const safePublisher = s.publisher && s.publisher !== "Unknown" ? sanitize(s.publisher) : "";
            const safeSeries = `${sanitize(s.name || "Unknown")}${s.year ? ` (${s.year})` : ''}`;
            
            const targetFolder = safePublisher 
                ? path.join(libraryRoot, safePublisher, safeSeries)
                : path.join(libraryRoot, safeSeries);

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

        // ---------------------------------------------------------
        // 2. RENAME THE FILES INSIDE THE FOLDER
        // ---------------------------------------------------------
        const issues = await prisma.issue.findMany({ where: { seriesId: s.id } });

        for (const issue of issues) {
            // Re-calculate current path in case the folder was just moved!
            const currentFileName = path.basename(issue.filePath || "");
            const actualFilePath = path.join(currentFolder, currentFileName);

            if (!fs.existsSync(actualFilePath)) continue;

            const ext = path.extname(actualFilePath);
            
            // Format Issue Number (Auto-Pad to 3 digits for beautiful sorting)
            let paddedNum = issue.number;
            if (!paddedNum.includes('.')) {
                paddedNum = paddedNum.padStart(3, '0');
            } else {
                const parts = paddedNum.split('.');
                paddedNum = `${parts[0].padStart(3, '0')}.${parts[1]}`;
            }

            // Construct New File Name from User Template
            let newFileName = pattern
                .replace('{Publisher}', s.publisher || 'Unknown')
                .replace('{Series}', s.name || 'Unknown')
                .replace('{Year}', s.year?.toString() || '0000')
                .replace('{Issue}', paddedNum);
            
            newFileName = sanitize(newFileName) + ext;
            const newFilePath = path.join(currentFolder, newFileName);

            // Execute the Rename!
            if (actualFilePath !== newFilePath) {
                try {
                    if (!fs.existsSync(newFilePath)) {
                        await fs.move(actualFilePath, newFilePath);
                        await prisma.issue.update({
                            where: { id: issue.id },
                            data: { filePath: newFilePath }
                        });
                        filesRenamed++;
                    }
                } catch (e) {
                    console.error(`File Rename Failed: ${actualFilePath}`, e);
                }
            } else if (issue.filePath !== newFilePath) {
                // Fallback: If folder moved but filename is the same, catch the DB up
                 await prisma.issue.update({
                    where: { id: issue.id },
                    data: { filePath: newFilePath }
                });
            }
        }
    }

    return NextResponse.json({ success: true, filesRenamed, foldersRenamed });

  } catch (error: any) {
    console.error("Rename Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}