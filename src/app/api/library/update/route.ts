import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import { revalidatePath, revalidateTag } from 'next/cache';

export async function POST(request: Request) {
  try {
    const { currentPath, name, year, publisher, cvId, monitored, isManga } = await request.json();

    const parsedIsManga = isManga === true || isManga === 'true' || isManga === 'on' || isManga === 1;
    const parsedMonitored = monitored === true || monitored === 'true' || monitored === 'on' || monitored === 1;

    // NATIVE DB FETCH: Find the best target library
    const libraries = await prisma.library.findMany();
    let targetLib = parsedIsManga 
        ? libraries.find(l => l.isDefault && l.isManga) || libraries.find(l => l.isManga)
        : libraries.find(l => l.isDefault && !l.isManga) || libraries.find(l => !l.isManga);
        
    if (!targetLib) targetLib = libraries[0];
    if (!targetLib) return NextResponse.json({ error: "No libraries configured in Settings." }, { status: 400 });

    const libraryRoot = targetLib.path;

    function sanitize(str: string) { return str.replace(/[<>:"/\\|?*]/g, '').trim(); }
    
    const safePublisher = publisher && publisher !== "Unknown" ? sanitize(publisher) : "";
    const safeSeries = `${sanitize(name)}${year ? ` (${year})` : ''}`;
    
    let newPath = safePublisher 
        ? path.join(libraryRoot, safePublisher, safeSeries)
        : path.join(libraryRoot, safeSeries);

    newPath = newPath.replace(/\\/g, '/');
    let activePath = currentPath.replace(/\\/g, '/');

    if (activePath.toLowerCase() !== newPath.toLowerCase()) {
        if (fs.existsSync(activePath)) {
            await fs.ensureDir(path.dirname(newPath));
            await fs.move(activePath, newPath, { overwrite: true });
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

    if (existingRecord) {
        await prisma.series.update({
            where: { id: existingRecord.id },
            data: {
                name: cleanName,
                year: parsedYear,
                publisher: publisher || null,
                folderPath: activePath,
                monitored: parsedMonitored,
                isManga: parsedIsManga, 
                cvId: parsedCvId !== null ? parsedCvId : existingRecord.cvId,
                libraryId: targetLib.id
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
            if (pathUpdates.length > 0) await prisma.$transaction(pathUpdates).catch(() => {});
        }

    } else if (parsedCvId) {
        await prisma.series.upsert({
            where: { cvId: parsedCvId },
            update: {
                name: cleanName, year: parsedYear, publisher: publisher || null,
                folderPath: activePath, monitored: parsedMonitored, isManga: parsedIsManga, libraryId: targetLib.id
            },
            create: {
                cvId: parsedCvId, name: cleanName, year: parsedYear, publisher: publisher || null,
                folderPath: activePath, monitored: parsedMonitored, isManga: parsedIsManga, libraryId: targetLib.id
            }
        });
    }

    revalidateTag('library');
    revalidatePath('/library');
    revalidatePath('/library/series');

    return NextResponse.json({ success: true, newPath: activePath });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}