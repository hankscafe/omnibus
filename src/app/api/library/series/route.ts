export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import fs from 'fs-extra';
import path from 'path';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import AdmZip from 'adm-zip';
import { AuditLogger } from '@/lib/audit-logger';

const safeParse = (str: string | null) => {
    if (!str) return [];
    try { 
        const arr = JSON.parse(str); 
        return Array.isArray(arr) ? arr.filter((item: string) => item !== "NONE") : [];
    } catch { return []; }
}

function extractIssueNumber(filename: string): string {
    let clean = filename.replace(/\.\w+$/, ''); 
    clean = clean.replace(/\[\d{4}(?:-\d{4})?\]/g, '').replace(/\(\d{4}(?:-\d{4})?\)/g, ''); 
    const explicitMatch = clean.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v\s*\.?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
    if (explicitMatch) return parseFloat(explicitMatch[1]).toString();
    const matches = [...clean.matchAll(/(?<=^|[^a-zA-Z0-9])0*(\d+(?:\.\d+)?)(?=[^a-zA-Z0-9]|$)/g)];
    if (matches.length > 0) return parseFloat(matches[matches.length - 1][1]).toString();
    return "1"; 
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const folderPath = searchParams.get('path');
  if (!folderPath) return NextResponse.json({ error: "Missing path parameter" }, { status: 400 });

  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    let userId = (session?.user as any)?.id || null;
    if (!userId && session?.user) {
        const user = await prisma.user.findFirst({ where: { OR: [ ...(session.user.email ? [{ email: session.user.email }] : []), ...(session.user.name ? [{ username: session.user.name }] : []) ] } });
        userId = user?.id || null;
    }

    const libraries = await prisma.library.findMany();
    // HIGH FIX: Resolve symlinks and perform strict case-sensitive prefix check
    const realTarget = fs.realpathSync(folderPath);
    const isAuthorized = libraries.some(lib => {
        const realLibRoot = fs.realpathSync(lib.path);
        return realTarget.startsWith(realLibRoot);
    });

    if (!isAuthorized) return NextResponse.json({ error: "Unauthorized path access" }, { status: 403 });
    if (!fs.existsSync(realTarget)) return NextResponse.json({ error: "The physical folder is missing." }, { status: 404 });

    let seriesRecord = await prisma.series.findFirst({ where: { folderPath: folderPath } });
    let isFavorite = false;
    let progressMap: Record<string, { readProgress: number, isRead: boolean }> = {};
    
    if (userId && seriesRecord) {
        const favorite = await prisma.favorite.findUnique({ where: { userId_seriesId: { userId: userId, seriesId: seriesRecord.id } } });
        if (favorite) isFavorite = true;
        const progresses = await prisma.readProgress.findMany({ where: { userId: userId, issue: { seriesId: seriesRecord.id } }, include: { issue: true } });
        for (const p of progresses) {
            if (p.issue?.filePath) {
                const fileName = path.basename(p.issue.filePath);
                const safeTotal = (p.totalPages && !isNaN(p.totalPages)) ? p.totalPages : 0;
                const safeProgress = (safeTotal > 0) ? (p.currentPage / safeTotal) * 100 : 0;
                progressMap[fileName] = { 
                    isRead: p.isCompleted, 
                    readProgress: safeProgress
                };    
            }
        }
    }

    const files = await fs.promises.readdir(folderPath);
    let coverUrl = null;
    for (const file of files) {
        if (['cover.jpg', 'cover.png', 'folder.jpg', 'poster.jpg'].includes(file.toLowerCase())) {
            const fullFilePath = path.join(folderPath, file);
            coverUrl = `/api/library/cover?path=${encodeURIComponent(fullFilePath)}`;
            break;
        }
    }

    let downloadedIssues: any[] = [];
    let missingIssues: any[] = [];

    if (seriesRecord) {
        let existingIssues = await prisma.issue.findMany({ where: { seriesId: seriesRecord.id } });
        const issuesByNum = new Map<string, any[]>();
        for (const issue of existingIssues) {
            const stdNum = parseFloat(issue.number.replace(/[^0-9.]/g, '') || "0").toString();
            if (!issuesByNum.has(stdNum)) issuesByNum.set(stdNum, []);
            issuesByNum.get(stdNum)!.push(issue);
        }

        const idsToDelete: string[] = [];
        const dbIssueMap = new Map();
        for (const [stdNum, issues] of Array.from(issuesByNum.entries())) {
            issues.sort((a, b) => (parseInt(b.metadataId || "0") - parseInt(a.metadataId || "0"))); 
            dbIssueMap.set(stdNum, issues[0]);
            for (let i = 1; i < issues.length; i++) idsToDelete.push(issues[i].id);
        }

        // HIGH FIX: Surface DB errors instead of silent .catch
        if (idsToDelete.length > 0) {
            await prisma.issue.deleteMany({ where: { id: { in: idsToDelete } } })
                .catch((err) => Logger.log(`[Series API] Deletion failed: ${err.message}`, 'error'));
        }

        const createsToFire: any[] = [];
        const updateOperations: any[] = [];
        const activeFilePaths = new Set();
        const creatingNums = new Set();

        for (const file of files) {
            if (file.toLowerCase().match(/\.(cbz|cbr|cb7|zip|rar|epub)$/)) { 
                const fullPath = path.join(folderPath, file);
                activeFilePaths.add(fullPath);
                const stdNum = extractIssueNumber(file);
                const existingIssue = dbIssueMap.get(stdNum);

                let pageCount = 0;
                if (file.toLowerCase().match(/\.(cbz|zip|epub)$/i)) {
                    try {
                        const zip = new AdmZip(fullPath);
                        pageCount = zip.getEntries().filter((e: any) => !e.isDirectory && !e.entryName.match(/__macosx/i) && e.entryName.match(/\.(jpg|jpeg|png|webp)$/i)).length;
                    } catch(e) {}
                }

                if (existingIssue) {
                    if (existingIssue.filePath !== fullPath || (existingIssue as any).pageCount === 0) {
                        updateOperations.push(prisma.issue.update({ where: { id: existingIssue.id }, data: { filePath: fullPath, pageCount } }));
                    }
                } else if (!creatingNums.has(stdNum)) {
                    createsToFire.push({ seriesId: seriesRecord.id, metadataId: `unmatched_${Math.random()}`, metadataSource: 'LOCAL', number: stdNum, status: "DOWNLOADED", filePath: fullPath, pageCount });
                    creatingNums.add(stdNum); 
                }
            }
        }

        // HIGH FIX: Await and log all background operations
        if (createsToFire.length > 0) {
            await prisma.issue.createMany({ data: createsToFire })
                .catch((err) => Logger.log(`[Series API] Bulk create failed: ${err.message}`, 'error'));
        }
        if (updateOperations.length > 0) {
            // Explicitly typing 'err' as 'any' or 'Error' to satisfy the compiler
            await Promise.all(updateOperations.map(op => op.catch((err: any) => 
                Logger.log(`[Series API] Update failed: ${err.message}`, 'error')
            ))); 
        }

        await prisma.issue.deleteMany({
            where: { seriesId: seriesRecord.id, metadataId: { startsWith: 'unmatched_' }, filePath: { notIn: Array.from(activeFilePaths) as string[] } }
        }).catch((err) => Logger.log(`[Series API] Cleanup failed: ${err.message}`, 'error'));

        existingIssues = await prisma.issue.findMany({ where: { seriesId: seriesRecord.id } });
        for (const issue of existingIssues) {
            const fileName = issue.filePath ? path.basename(issue.filePath) : null;
            const prog = fileName && progressMap[fileName] ? progressMap[fileName] : { readProgress: 0, isRead: false };
            const finalIssueCoverUrl = issue.coverUrl && issue.coverUrl.startsWith('http') ? `/api/library/cover?path=${encodeURIComponent(issue.coverUrl)}` : issue.coverUrl;

            const formatted = {
                id: issue.id, cvId: (issue.metadataId && !issue.metadataId.startsWith('unmatched_')) ? parseInt(issue.metadataId) : null,
                name: issue.name || `${seriesRecord.name} #${issue.number}`, parsedNum: parseFloat(issue.number), fullPath: issue.filePath,
                coverUrl: finalIssueCoverUrl, writers: safeParse(issue.writers), artists: safeParse(issue.artists), characters: safeParse(issue.characters),
                genres: safeParse((issue as any).genres), storyArcs: safeParse((issue as any).storyArcs), isRead: prog.isRead, readProgress: prog.readProgress
            };

            if (issue.filePath && fs.existsSync(issue.filePath)) downloadedIssues.push(formatted);
            else if (issue.metadataId && !issue.metadataId.startsWith('unmatched_')) missingIssues.push(formatted);
        }
    }

    downloadedIssues.sort((a,b) => (a.parsedNum ?? 0) - (b.parsedNum ?? 0));
    missingIssues.sort((a,b) => (a.parsedNum ?? 0) - (b.parsedNum ?? 0));
    const finalSeriesCoverUrl = coverUrl || (seriesRecord?.coverUrl && seriesRecord.coverUrl.startsWith('http') ? `/api/library/cover?path=${encodeURIComponent(seriesRecord.coverUrl)}` : seriesRecord?.coverUrl) || null;

    return NextResponse.json({ 
      id: seriesRecord?.id || null, isFavorite, cvId: (seriesRecord?.metadataId && !seriesRecord.metadataId.startsWith('unmatched_')) ? parseInt(seriesRecord.metadataId) : null,
      seriesName: seriesRecord?.name?.trim() || path.basename(folderPath).replace(/\s\(\d{4}\)$/, ""),
      publisher: seriesRecord?.publisher || null, year: seriesRecord?.year || null, monitored: seriesRecord?.monitored || false,
      path: folderPath, coverUrl: finalSeriesCoverUrl, downloadedIssues, missingIssues
    });
  } catch (error: any) {
    Logger.log(`[Series API] Fatal Error: ${error.message}`, 'error');
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        const { seriesIds, deleteFiles } = await request.json();
        const seriesToDelete = await prisma.series.findMany({ where: { id: { in: seriesIds } } });
        await prisma.issue.deleteMany({ where: { seriesId: { in: seriesIds } } });
        await prisma.series.deleteMany({ where: { id: { in: seriesIds } } });
        if (deleteFiles) {
            for (const series of seriesToDelete) {
                if (series.folderPath && fs.existsSync(series.folderPath)) await fs.remove(series.folderPath);
            }
        }
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        return NextResponse.json({ error: "Deletion failed" }, { status: 500 });
    }
}