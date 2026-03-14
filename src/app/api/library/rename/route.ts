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

    const libraries = await prisma.library.findMany();

    let filesRenamed = 0;
    let foldersRenamed = 0;

    function sanitize(str: string) { return str.replace(/[<>:"/\\|?*]/g, '').trim(); }

    for (const s of seriesList) {
        if (!s.folderPath || !fs.existsSync(s.folderPath)) continue;

        // NATIVE DB FETCH: Find the exact library this series lives in
        const lib = libraries.find(l => l.id === s.libraryId) || libraries.find(l => l.isDefault && l.isManga === s.isManga) || libraries[0];
        if (!lib) continue;

        const libraryRoot = lib.path;
        let currentFolder = s.folderPath;

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

        const issues = await prisma.issue.findMany({ where: { seriesId: s.id } });

        for (const issue of issues) {
            const currentFileName = path.basename(issue.filePath || "");
            const actualFilePath = path.join(currentFolder, currentFileName);

            if (!fs.existsSync(actualFilePath)) continue;

            const ext = path.extname(actualFilePath);
            let paddedNum = issue.number;
            if (!paddedNum.includes('.')) {
                paddedNum = paddedNum.padStart(3, '0');
            } else {
                const parts = paddedNum.split('.');
                paddedNum = `${parts[0].padStart(3, '0')}.${parts[1]}`;
            }

            let newFileName = pattern
                .replace('{Publisher}', s.publisher || 'Unknown')
                .replace('{Series}', s.name || 'Unknown')
                .replace('{Year}', s.year?.toString() || '0000')
                .replace('{Issue}', paddedNum);
            
            newFileName = sanitize(newFileName) + ext;
            const newFilePath = path.join(currentFolder, newFileName);

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
                } catch (e) { }
            } else if (issue.filePath !== newFilePath) {
                 await prisma.issue.update({
                    where: { id: issue.id },
                    data: { filePath: newFilePath }
                });
            }
        }
    }

    return NextResponse.json({ success: true, filesRenamed, foldersRenamed });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}