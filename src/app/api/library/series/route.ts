// src/app/api/library/series/route.ts

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
    
    // 1. Resolve Auth
    if (!userId && session?.user) {
        const user = await prisma.user.findFirst({ where: { OR: [ ...(session.user.email ? [{ email: session.user.email }] : []), ...(session.user.name ? [{ username: session.user.name }] : []) ] } });
        userId = user?.id || null;
    }

    // 2. Validate Path and Authorization
    const libraries = await prisma.library.findMany();
    const realTarget = fs.realpathSync(folderPath);
    const normalizedTarget = realTarget.replace(/\\/g, '/').toLowerCase();

    const isAuthorized = libraries.some(lib => {
        const realLibRoot = fs.realpathSync(lib.path);
        return realTarget.toLowerCase().startsWith(realLibRoot.toLowerCase());
    });

    if (!isAuthorized) return NextResponse.json({ error: "Unauthorized path access" }, { status: 403 });
    if (!fs.existsSync(realTarget)) return NextResponse.json({ error: "The physical folder is missing." }, { status: 404 });

    // 3. Series Lookup
    let seriesRecord = await prisma.series.findFirst({ 
        where: { folderPath: folderPath } 
    });

    if (!seriesRecord) {
        const allSeries = await prisma.series.findMany({ select: { id: true, folderPath: true } });
        const matched = allSeries.find(s => 
            s.folderPath.replace(/\\/g, '/').toLowerCase() === normalizedTarget
        );
        if (matched) {
            seriesRecord = await prisma.series.findUnique({ where: { id: matched.id } });
        }
    }

    if (!seriesRecord) {
        const folderName = path.basename(realTarget);
        seriesRecord = await prisma.series.findFirst({
            where: { name: folderName }
        });
    }

    // 4. Load Metadata and Progress
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
                progressMap[fileName] = { isRead: p.isCompleted, readProgress: safeProgress };    
            }
        }
    }

    // 5. Scan Folder for Issues and Cover
    const files = await fs.promises.readdir(folderPath);
    let physicalCover = null;
    
    const coverFile = files.find(f => 
        ['cover.jpg', 'cover.png', 'folder.jpg', 'poster.jpg'].includes(f.toLowerCase())
    );

    if (coverFile) {
        const fullCoverPath = path.join(folderPath, coverFile);
        physicalCover = `/api/library/cover?path=${encodeURIComponent(fullCoverPath)}`;
    }

    let downloadedIssues: any[] = [];
    let missingIssues: any[] = [];

    if (seriesRecord) {
        let existingIssues = await prisma.issue.findMany({ where: { seriesId: seriesRecord.id } });
        const dbIssueMap = new Map();
        const idsToDelete: string[] = [];
        
        const issuesByNum = new Map<string, any[]>();
        for (const issue of existingIssues) {
            const stdNum = parseFloat(issue.number.replace(/[^0-9.]/g, '') || "0").toString();
            if (!issuesByNum.has(stdNum)) issuesByNum.set(stdNum, []);
            issuesByNum.get(stdNum)!.push(issue);
        }

        for (const [stdNum, issues] of Array.from(issuesByNum.entries())) {
            issues.sort((a, b) => (parseInt(b.metadataId || "0") - parseInt(a.metadataId || "0"))); 
            dbIssueMap.set(stdNum, issues[0]);
            for (let i = 1; i < issues.length; i++) idsToDelete.push(issues[i].id);
        }

        if (idsToDelete.length > 0) {
            await prisma.issue.deleteMany({ where: { id: { in: idsToDelete } } }).catch(() => {});
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

                if (existingIssue) {
                    if (existingIssue.filePath !== fullPath) {
                        updateOperations.push(prisma.issue.update({ 
                            where: { id: existingIssue.id }, 
                            data: { filePath: fullPath, status: "DOWNLOADED" } 
                        }));
                    }
                } else if (!creatingNums.has(stdNum)) {
                    createsToFire.push({ 
                        seriesId: seriesRecord.id, 
                        metadataId: `unmatched_${Math.random()}`, 
                        metadataSource: 'LOCAL', 
                        matchState: 'UNMATCHED',
                        number: stdNum, 
                        status: "DOWNLOADED", 
                        filePath: fullPath
                    });
                    creatingNums.add(stdNum); 
                }
            }
        }

        if (createsToFire.length > 0) await prisma.issue.createMany({ data: createsToFire });
        if (updateOperations.length > 0) await Promise.all(updateOperations);

        await prisma.issue.deleteMany({
            where: {
                seriesId: seriesRecord.id,
                metadataId: { startsWith: 'unmatched_' },
                filePath: { notIn: Array.from(activeFilePaths) as string[] }
            }
        }).catch(() => {});

        existingIssues = await prisma.issue.findMany({ where: { seriesId: seriesRecord.id } });
        for (const issue of existingIssues) {
            const fileName = issue.filePath ? path.basename(issue.filePath) : null;
            const prog = fileName && progressMap[fileName] ? progressMap[fileName] : { readProgress: 0, isRead: false };
            const finalIssueCoverUrl = issue.coverUrl && issue.coverUrl.startsWith('http') ? `/api/library/cover?path=${encodeURIComponent(issue.coverUrl)}` : issue.coverUrl;

            const formatted = {
                id: issue.id, 
                cvId: (issue.metadataId && !issue.metadataId.startsWith('unmatched_')) ? parseInt(issue.metadataId) : null,
                name: issue.name || `${seriesRecord.name} #${issue.number}`, 
                parsedNum: parseFloat(issue.number), 
                fullPath: issue.filePath,
                coverUrl: finalIssueCoverUrl, 
                writers: safeParse(issue.writers), 
                artists: safeParse(issue.artists), 
                characters: safeParse(issue.characters),
                genres: safeParse((issue as any).genres), 
                storyArcs: safeParse((issue as any).storyArcs), 
                isRead: prog.isRead, 
                readProgress: prog.readProgress
            };

            if (issue.filePath && fs.existsSync(issue.filePath)) downloadedIssues.push(formatted);
            else if (issue.metadataId && !issue.metadataId.startsWith('unmatched_')) missingIssues.push(formatted);
        }
    }

    downloadedIssues.sort((a,b) => (a.parsedNum ?? 0) - (b.parsedNum ?? 0));
    missingIssues.sort((a,b) => (a.parsedNum ?? 0) - (b.parsedNum ?? 0));
    const finalSeriesCoverUrl = physicalCover || 
        (seriesRecord?.coverUrl && seriesRecord.coverUrl.startsWith('http') 
            ? `/api/library/cover?path=${encodeURIComponent(seriesRecord.coverUrl)}` 
            : seriesRecord?.coverUrl) || null;

    return NextResponse.json({ 
      id: seriesRecord?.id || null, 
      isFavorite, 
      cvId: (seriesRecord?.metadataId && !seriesRecord.metadataId.startsWith('unmatched_')) ? parseInt(seriesRecord.metadataId) : null,
      seriesName: seriesRecord?.name?.trim() || path.basename(folderPath).replace(/\s\(\d{4}\)$/, ""),
      publisher: seriesRecord?.publisher || null, 
      year: seriesRecord?.year || null, 
      monitored: seriesRecord?.monitored || false,
      path: folderPath, 
      coverUrl: finalSeriesCoverUrl, 
      downloadedIssues, 
      missingIssues
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
        
        const deletedPaths = [];
        if (deleteFiles) {
            for (const series of seriesToDelete) {
                if (series.folderPath && fs.existsSync(series.folderPath)) {
                    await fs.remove(series.folderPath);
                    deletedPaths.push(series.folderPath);
                }
            }
        }

        // --- NEW: LOG SERIES DELETIONS ---
        await AuditLogger.log('DELETE_SERIES', {
            seriesIds,
            seriesNames: seriesToDelete.map(s => s.name),
            deletedPhysicalFiles: deleteFiles,
            deletedPaths
        }, (session.user as any).id);

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        return NextResponse.json({ error: "Deletion failed" }, { status: 500 });
    }
}