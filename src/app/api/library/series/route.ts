export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import fs from 'fs-extra';
import path from 'path';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

const safeParse = (str: string | null) => {
    if (!str) return [];
    try { return JSON.parse(str); } catch { return []; }
}

// BULLETPROOF ISSUE NUMBER EXTRACTOR
function extractIssueNumber(filename: string): string {
    let clean = filename.replace(/\.\w+$/, ''); 
    clean = clean.replace(/\[\d{4}\]/g, '').replace(/\(\d{4}\)/g, ''); 
    
    const explicitMatch = clean.match(/(?:#|issue\s*|vol(?:ume)?\s*|v\s*|ch(?:apter)?\s*)0*(\d+(?:\.\d+)?)/i);
    if (explicitMatch) return parseFloat(explicitMatch[1]).toString();
    
    const matches = [...clean.matchAll(/(?:[^a-zA-Z0-9]|^)0*(\d+(?:\.\d+)?)(?:[^a-zA-Z0-9]|$)/g)];
    if (matches.length > 0) {
        return parseFloat(matches[matches.length - 1][1]).toString();
    }
    
    // ONE-SHOT FIX: If the filename has absolutely no numbers, it's a Graphic Novel or One-Shot.
    // ComicVine always catalogs these as Issue #1. 
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
        const user = await prisma.user.findFirst({
            where: { OR: [ ...(session.user.email ? [{ email: session.user.email }] : []), ...(session.user.name ? [{ username: session.user.name }] : []) ] }
        });
        userId = user?.id || null;
    }

    const configSetting = await prisma.systemSetting.findMany({ 
        where: { key: { in: ['library_path', 'manga_library_path'] } } 
    });
    const config = Object.fromEntries(configSetting.map(s => [s.key, s.value]));

    const cleanLib = config.library_path?.trim() ? path.normalize(config.library_path).replace(/\\/g, '/').toLowerCase() : null;
    const cleanManga = config.manga_library_path?.trim() ? path.normalize(config.manga_library_path).replace(/\\/g, '/').toLowerCase() : null;
    const cleanTarget = path.normalize(folderPath).replace(/\\/g, '/').toLowerCase();

    let seriesRecord = await prisma.series.findFirst({ where: { folderPath: folderPath } });

    if (!seriesRecord) {
      const allSeries = await prisma.series.findMany();
      seriesRecord = allSeries.find(s => path.normalize(s.folderPath).replace(/\\/g, '/').toLowerCase() === cleanTarget) || null;
    }

    const isAuthorized = 
        (cleanLib && cleanTarget.startsWith(cleanLib)) || 
        (cleanManga && cleanTarget.startsWith(cleanManga)) ||
        (seriesRecord !== null);

    if (!isAuthorized) return NextResponse.json({ error: "Unauthorized path access" }, { status: 403 });
    if (!fs.existsSync(folderPath)) return NextResponse.json({ error: "Ghost Record: The physical folder is missing from the drive." }, { status: 404 });

    let isFavorite = false;
    let progressMap: Record<string, { readProgress: number, isRead: boolean }> = {};
    
    if (userId && seriesRecord) {
        const favorite = await prisma.favorite.findUnique({
            where: { userId_seriesId: { userId: userId, seriesId: seriesRecord.id } }
        });
        if (favorite) isFavorite = true;

        const progresses = await prisma.readProgress.findMany({
            where: { userId: userId, issue: { seriesId: seriesRecord.id } },
            include: { issue: true }
        });
        
        for (const p of progresses) {
            if (p.issue?.filePath) {
                const fileName = path.basename(p.issue.filePath);
                progressMap[fileName] = { isRead: p.isCompleted, readProgress: p.totalPages > 0 ? (p.currentPage / p.totalPages) * 100 : 0 };
            }
        }
    }

    const files = await fs.promises.readdir(folderPath);
    let coverUrl = null;
    for (const file of files) {
        if (['cover.jpg', 'cover.png', 'folder.jpg', 'poster.jpg'].includes(file.toLowerCase())) {
            const fullFilePath = path.join(folderPath, file);
            try {
                const stat = await fs.promises.stat(fullFilePath);
                coverUrl = `/api/library/cover?path=${encodeURIComponent(fullFilePath)}&cb=${stat.mtimeMs}`;
            } catch(e) {
                coverUrl = `/api/library/cover?path=${encodeURIComponent(fullFilePath)}`;
            }
            break;
        }
    }

    let downloadedIssues: any[] = [];
    let missingIssues: any[] = [];

    if (seriesRecord) {
        let existingIssues = await prisma.issue.findMany({ where: { seriesId: seriesRecord.id } });
        
        const issuesByNum = new Map<string, any[]>();
        for (const issue of existingIssues) {
            const cleanDbNum = issue.number.replace(/[^0-9.]/g, '');
            const stdNum = parseFloat(cleanDbNum || "0").toString();
            
            if (!issuesByNum.has(stdNum)) issuesByNum.set(stdNum, []);
            issuesByNum.get(stdNum)!.push(issue);
        }

        const idsToDelete: string[] = [];
        const dbIssueMap = new Map();

        for (const [stdNum, issues] of Array.from(issuesByNum.entries())) {
            issues.sort((a, b) => b.cvId - a.cvId); 
            const bestIssue = issues[0];
            dbIssueMap.set(stdNum, bestIssue);

            for (let i = 1; i < issues.length; i++) {
                idsToDelete.push(issues[i].id);
            }
        }

        if (idsToDelete.length > 0) {
            await prisma.issue.deleteMany({ where: { id: { in: idsToDelete } } }).catch(() => {});
        }

        const createsToFire: any[] = [];
        const updateOperations: any[] = [];
        const activeFilePaths = new Set();
        const creatingNums = new Set();

        for (const file of files) {
            const lowerFile = file.toLowerCase();
            if (lowerFile.match(/\.(cbz|cbr|cb7|zip|rar|epub)$/)) { 
                const fullPath = path.join(folderPath, file);
                activeFilePaths.add(fullPath);
                
                const stdNum = extractIssueNumber(file);
                const existingIssue = dbIssueMap.get(stdNum);

                if (existingIssue) {
                    if (existingIssue.filePath !== fullPath) {
                        updateOperations.push(prisma.issue.update({ 
                            where: { id: existingIssue.id }, data: { filePath: fullPath } 
                        }));
                        existingIssue.filePath = fullPath; 
                    }
                } else {
                    if (!creatingNums.has(stdNum)) {
                        createsToFire.push({
                            seriesId: seriesRecord.id, cvId: -Math.abs(Math.floor(Math.random() * 1000000000)),
                            number: stdNum, status: "DOWNLOADED", filePath: fullPath
                        });
                        creatingNums.add(stdNum); 
                    }
                }
            }
        }

        if (createsToFire.length > 0) await prisma.issue.createMany({ data: createsToFire }).catch(()=>{});
        if (updateOperations.length > 0) {
            await Promise.all(updateOperations.map(op => op.catch(() => {}))); 
        }

        await prisma.issue.deleteMany({
            where: {
                seriesId: seriesRecord.id,
                cvId: { lt: 0 },
                filePath: { notIn: Array.from(activeFilePaths) as string[] }
            }
        }).catch(()=>{});

        existingIssues = await prisma.issue.findMany({ where: { seriesId: seriesRecord.id } });

        for (const issue of existingIssues) {
            const parsedNum = parseFloat(issue.number);
            const fileName = issue.filePath ? path.basename(issue.filePath) : null;
            const prog = fileName && progressMap[fileName] ? progressMap[fileName] : { readProgress: 0, isRead: false };

            const formatted = {
                id: issue.id, cvId: issue.cvId,
                name: issue.name || `${seriesRecord.name} #${issue.number}`,
                parsedNum: parsedNum,
                fullPath: issue.filePath, fileName: fileName,
                coverUrl: issue.coverUrl,
                description: issue.description, releaseDate: issue.releaseDate,
                writers: safeParse(issue.writers),
                artists: safeParse(issue.artists),
                characters: safeParse(issue.characters),
                isRead: prog.isRead, readProgress: prog.readProgress
            };

            if (issue.filePath && fs.existsSync(issue.filePath)) {
                downloadedIssues.push(formatted);
            } else if (issue.cvId > 0) {
                missingIssues.push(formatted);
            }
        }
    } else {
        for (const file of files) {
            const lowerFile = file.toLowerCase();
            if (lowerFile.match(/\.(cbz|cbr|cb7|zip|rar|epub)$/)) {
                const fullPath = path.join(folderPath, file);
                const prog = progressMap[file] || { readProgress: 0, isRead: false };
                const issueNum = extractIssueNumber(file);
                
                downloadedIssues.push({
                    id: file, name: file.replace(/\.(cbz|cbr|cb7|zip|rar|epub)$/i, ''),
                    parsedNum: parseFloat(issueNum),
                    fileName: file, fullPath: fullPath,
                    isRead: prog.isRead, readProgress: prog.readProgress,
                    writers: [], artists: [], characters: []
                });
            }
        }
    }

    downloadedIssues.sort((a,b) => (a.parsedNum ?? 0) - (b.parsedNum ?? 0));
    missingIssues.sort((a,b) => (a.parsedNum ?? 0) - (b.parsedNum ?? 0));

    const dbName = seriesRecord?.name?.trim();
    const fallbackName = path.basename(folderPath).replace(/\s\(\d{4}\)$/, "");

    return NextResponse.json({ 
      id: seriesRecord?.id || null, isFavorite, 
      cvId: (seriesRecord?.cvId && seriesRecord.cvId > 0) ? seriesRecord.cvId : null,
      seriesName: dbName ? dbName : fallbackName,
      publisher: seriesRecord?.publisher || null, year: seriesRecord?.year || null,
      description: seriesRecord?.description || null, status: seriesRecord?.status || null,
      monitored: seriesRecord?.monitored || false, isManga: (seriesRecord as any)?.isManga || false,
      path: folderPath, coverUrl: coverUrl || seriesRecord?.coverUrl || null, 
      downloadedIssues, missingIssues
    });

  } catch (error: any) {
    return NextResponse.json({ error: "Failed to scan folder" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        const { seriesIds, deleteFiles, folderPath } = await request.json();
        
        if ((!seriesIds || seriesIds.length === 0) && !folderPath) {
            return NextResponse.json({ error: "No series IDs or folder path provided" }, { status: 400 });
        }

        // 1. Delete from Database if it has a DB record
        if (seriesIds && seriesIds.length > 0) {
            const seriesToDelete = await prisma.series.findMany({ where: { id: { in: seriesIds } } });

            await prisma.issue.deleteMany({ where: { seriesId: { in: seriesIds } } });
            await prisma.series.deleteMany({ where: { id: { in: seriesIds } } });

            if (deleteFiles) {
                for (const series of seriesToDelete) {
                    if (series.folderPath && fs.existsSync(series.folderPath)) {
                        try { await fs.remove(series.folderPath); } catch (err) {}
                    }
                }
            }
        } 
        // 2. FALLBACK: Delete the physical folder even if it's an "Unmatched" folder with no DB record
        else if (folderPath && deleteFiles) {
            if (fs.existsSync(folderPath)) {
                try { await fs.remove(folderPath); } catch (err) {}
            }
        }

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}