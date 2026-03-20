import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';

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
    
    // --- FETCH GLOBAL FOLDER SETTING ---
    const settings = await prisma.systemSetting.findMany();
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
    const folderPattern = config.folder_naming_pattern || "{Publisher}/{Series} ({Year})";

    let filesRenamed = 0;
    let foldersRenamed = 0;

    function sanitize(str: string) { return str.replace(/[<>:"/\\|?*]/g, '').trim(); }

    for (const s of seriesList) {
        if (!s.folderPath || !fs.existsSync(s.folderPath)) continue;

        const lib = libraries.find(l => l.id === s.libraryId) || libraries.find(l => l.isDefault && l.isManga === s.isManga) || libraries[0];
        if (!lib) continue;

        const libraryRoot = lib.path;
        let currentFolder = s.folderPath;

        if (libraryRoot) {
            const safePublisher = s.publisher && s.publisher !== "Unknown" ? sanitize(s.publisher) : "Other";
            const safeSeries = sanitize(s.name || "Unknown");
            const safeYear = s.year ? s.year.toString() : "";
            
            // Generate dynamic folder name
            let relFolderPath = folderPattern
                .replace(/{Publisher}/gi, safePublisher)
                .replace(/{Series}/gi, safeSeries)
                .replace(/{Year}/gi, safeYear)
                .replace(/\(\s*\)/g, '') 
                .replace(/\[\s*\]/g, '') 
                .replace(/\s+/g, ' ')
                .trim();

            const folderParts = relFolderPath.split(/[/\\]/).map((p:string) => p.trim()).filter(Boolean);
            const targetFolder = path.join(libraryRoot, ...folderParts);

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
                .replace(/{Publisher}/gi, s.publisher || 'Unknown')
                .replace(/{Series}/gi, s.name || 'Unknown')
                .replace(/{Year}/gi, s.year?.toString() || '0000')
                .replace(/{Issue}/gi, paddedNum);
            
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

  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}