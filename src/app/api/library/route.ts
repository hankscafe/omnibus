export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs-extra'; 
import path from 'path';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { detectManga } from '@/lib/manga-detector';

// --- POST HANDLER FOR BULK ACTIONS ---
export async function POST(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;

    if (!session || !userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { seriesIds, action, status } = await request.json();

    if (action === 'bulk-progress') {
      const issues = await prisma.issue.findMany({
        where: { seriesId: { in: seriesIds } },
        select: { id: true }
      });

      const issueIds = issues.map(i => i.id);

      if (status === 'READ') {
        await prisma.$transaction(
          issueIds.map(id => 
            prisma.readProgress.upsert({
              where: { userId_issueId: { userId, issueId: id } },
              update: { isCompleted: true, currentPage: 1, totalPages: 1 },
              create: { userId, issueId: id, isCompleted: true, currentPage: 1, totalPages: 1 }
            })
          )
        );
        return NextResponse.json({ success: true, message: `Marked ${seriesIds.length} series as read.` });
      } 
      
      if (status === 'UNREAD') {
        await prisma.readProgress.deleteMany({
          where: { userId, issueId: { in: issueIds } }
        });
        return NextResponse.json({ success: true, message: `Marked ${seriesIds.length} series as unread.` });
      }
    }

    if (action === 'bulk-monitor') {
        await prisma.series.updateMany({
            where: { id: { in: seriesIds } },
            data: { monitored: status === 'MONITOR' }
        });
        return NextResponse.json({ success: true, message: `Monitoring status updated for ${seriesIds.length} series.` });
    }

    if (action === 'bulk-manga') {
        const isManga = status === 'MANGA';
        const seriesList = await prisma.series.findMany({ where: { id: { in: seriesIds } } });
        
        const libraries = await prisma.library.findMany();
        let targetLib = isManga 
            ? libraries.find(l => l.isDefault && l.isManga) || libraries.find(l => l.isManga)
            : libraries.find(l => l.isDefault && !l.isManga) || libraries.find(l => !l.isManga);
            
        if (!targetLib) targetLib = libraries[0];
        if (!targetLib) return NextResponse.json({ error: "No libraries configured in Settings." }, { status: 400 });

        const targetRoot = targetLib.path;

        for (const s of seriesList) {
            if (!s.folderPath || !fs.existsSync(s.folderPath)) {
                await prisma.series.update({ where: { id: s.id }, data: { isManga, libraryId: targetLib.id } });
                continue;
            }
            
            const oldPath = s.folderPath;
            function sanitize(str: string) { return str.replace(/[<>:"/\\|?*]/g, '').trim(); }
            const safePublisher = s.publisher && s.publisher !== "Unknown" ? sanitize(s.publisher) : "";
            const safeSeries = `${sanitize(s.name || "Unknown")}${s.year ? ` (${s.year})` : ''}`;
            
            const newPath = safePublisher 
                ? path.join(targetRoot, safePublisher, safeSeries)
                : path.join(targetRoot, safeSeries);

            let activePath = oldPath;

            if (path.normalize(oldPath).toLowerCase() !== path.normalize(newPath).toLowerCase()) {
                await fs.ensureDir(path.dirname(newPath));
                await fs.move(oldPath, newPath, { overwrite: true });
                activePath = newPath;
            }

            await prisma.series.update({
                where: { id: s.id },
                data: { isManga, folderPath: activePath.replace(/\\/g, '/'), libraryId: targetLib.id }
            });

            if (activePath !== oldPath) {
                const issues = await prisma.issue.findMany({ where: { seriesId: s.id } });
                const pathUpdates = [];
                for (const issue of issues) {
                   if (issue.filePath) {
                       const fileName = path.basename(issue.filePath);
                       pathUpdates.push(prisma.issue.update({
                           where: { id: issue.id },
                           data: { filePath: path.join(activePath, fileName).replace(/\\/g, '/') }
                       }));
                   }
                }
                if (pathUpdates.length > 0) await prisma.$transaction(pathUpdates).catch(()=>{});
            }
        }
        return NextResponse.json({ success: true, message: `Moved ${seriesIds.length} series.` });
    }

    if (action === 'bulk-remove-list') {
        await prisma.collectionItem.deleteMany({
            where: {
                collectionId: status, 
                seriesId: { in: seriesIds }
            }
        });
        return NextResponse.json({ success: true, message: `Removed ${seriesIds.length} series from list.` });
    }

    return NextResponse.json({ error: "Invalid action or status" }, { status: 400 });
  } catch (error: any) {
    console.error("Bulk Processing Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// --- GET HANDLER (PRO SERVER-SIDE FILTERING) ---
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '24');
    const skip = (page - 1) * limit;
    
    const shouldScanDisk = searchParams.get('refresh') === 'true';

    const q = searchParams.get('q') || '';
    const type = searchParams.get('type') || 'ALL';
    const libraryFilterParam = searchParams.get('library') || 'ALL';
    const publisherFilter = searchParams.get('publisher') || 'ALL';
    const favorites = searchParams.get('favorites') === 'true';
    const collectionId = searchParams.get('collection') || 'ALL';
    const sort = searchParams.get('sort') || 'alpha_asc';

    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id || null;

    if (shouldScanDisk) {
        // NATIVE DB FETCH: Get all configured libraries
        const libraries = await prisma.library.findMany();
        let allOnline = true;
        
        for (const lib of libraries) {
            if (!fs.existsSync(lib.path)) {
                allOnline = false;
                break;
            }
        }

        if (!allOnline && libraries.length > 0) {
            return NextResponse.json({ 
                error: "One or more Network Drives Disconnected. Scan aborted to protect database.", 
                series: [], 
                hasMore: false 
            }, { status: 503 });
        }

        try {
            const allSeries = await prisma.series.findMany({ select: { id: true, name: true, folderPath: true } });
            const badIds: string[] = [];

            for (const s of allSeries) {
                if (!s.name || s.name.trim() === '') {
                    badIds.push(s.id);
                    continue;
                }
                if (s.folderPath) {
                    try { if (!fs.existsSync(s.folderPath)) badIds.push(s.id); } catch(e) { badIds.push(s.id); }
                } else {
                    badIds.push(s.id); 
                }
            }

            if (badIds.length > 0) {
                await prisma.issue.deleteMany({ where: { seriesId: { in: badIds } } });
                await prisma.series.deleteMany({ where: { id: { in: badIds } } });
            }
        } catch(e) { }

        // OPTIMIZATION: Semi-Parallel Disk Scanning across ALL libraries
        if (libraries.length > 0) {
            const existingSeries = await prisma.series.findMany({
                select: { id: true, folderPath: true }
            });

            const findSeriesFolders = async (dir: string, baseRoot: string, libId: string, libIsManga: boolean) => {
                const folderName = path.basename(dir);
                if (folderName.startsWith('.')) return;

                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                const files = entries.filter(e => !e.isDirectory()).map(e => e.name);
                const bookFiles = files.filter(f => f.toLowerCase().match(/\.(cbz|cbr|zip)$/));

                if (bookFiles.length > 0) {
                    const relative = path.relative(baseRoot, dir);
                    const publisher = relative.split(path.sep).length > 1 ? relative.split(path.sep)[0] : "Other";
                    const normDir = path.normalize(dir).toLowerCase();
                    const existing = existingSeries.find(s => path.normalize(s.folderPath).toLowerCase() === normDir);

                    if (!existing) {
                        try {
                            let cleanedName = folderName.replace(/\s\(\d{4}\)$/, "").trim();
                            if (!cleanedName) cleanedName = "Unknown Series";

                            const firstArchive = bookFiles.find(f => f.toLowerCase().endsWith('.cbz') || f.toLowerCase().endsWith('.zip'));
                            const firstArchivePath = firstArchive ? path.join(dir, firstArchive) : null;

                            const isMangaDetect = await detectManga(
                                { name: cleanedName, publisher: { name: publisher }, year: parseInt(folderName.match(/\((\d{4})\)/)?.[1] || "0") },
                                firstArchivePath
                            );

                            const newSeries = await prisma.series.create({
                                data: {
                                    folderPath: dir.replace(/\\/g, '/'),
                                    name: cleanedName,
                                    year: parseInt(folderName.match(/\((\d{4})\)/)?.[1] || "0"),
                                    publisher: publisher,
                                    cvId: -Math.abs(Math.floor(Math.random() * 1000000000)), 
                                    isManga: libIsManga || isMangaDetect,
                                    libraryId: libId
                                }
                            });
                            existingSeries.push({ id: newSeries.id, folderPath: newSeries.folderPath });
                        } catch(e: any) {}
                    }
                }
                
                const subDirs = entries.filter(e => e.isDirectory());
                while (subDirs.length > 0) {
                    const batch = subDirs.splice(0, 5);
                    await Promise.all(batch.map(dirent => findSeriesFolders(path.join(dir, dirent.name), baseRoot, libId, libIsManga)));
                }
            };

            for (const lib of libraries) {
                if (fs.existsSync(lib.path)) {
                    await findSeriesFolders(lib.path, lib.path, lib.id, lib.isManga);
                }
            }
            
            // OPTIMIZATION: BLAZING FAST AUTO-HEALER (N+1 Query Fixed)
            try {
                const pendingRequests = await prisma.request.findMany({
                    where: { status: { in: ['MANUAL_DDL', 'PENDING', 'DOWNLOADING'] } }
                });

                if (pendingRequests.length > 0) {
                    const reqCvIds = [...new Set(pendingRequests.map(r => r.cvId || (r as any).volumeId).filter(Boolean).map(id => parseInt(id.toString())))];
                    
                    const allRelevantIssues = await prisma.issue.findMany({
                        where: { series: { cvId: { in: reqCvIds } } },
                        select: { filePath: true, number: true, name: true, series: { select: { cvId: true } } }
                    });

                    const issuesByCvId = new Map();
                    for (const issue of allRelevantIssues) {
                        const sCvId = issue.series?.cvId;
                        if (!sCvId) continue;
                        if (!issuesByCvId.has(sCvId)) issuesByCvId.set(sCvId, []);
                        issuesByCvId.get(sCvId).push(issue);
                    }

                    const requestsToComplete = [];

                    for (const req of pendingRequests) {
                        const reqCvId = req.cvId || (req as any).volumeId;
                        if (!reqCvId) continue;

                        const searchStr = (req.activeDownloadName || req.title || req.name || "").toLowerCase().trim();
                        const numMatch = searchStr.match(/(?:#|issue\s*#?)\s*(\d+(?:\.\d+)?)/i);
                        const issueNum = numMatch ? parseFloat(numMatch[1]) : null;

                        const seriesIssues = issuesByCvId.get(parseInt(reqCvId.toString())) || [];

                        const matchingIssue = seriesIssues.find((i: any) => {
                            if (!i.filePath || i.filePath.length === 0) return false;
                            if (issueNum !== null && parseFloat(i.number) === issueNum) return true;
                            if (i.name && i.name.toLowerCase().trim() === searchStr) return true;
                            const fileName = path.basename(i.filePath).toLowerCase();
                            if (fileName.includes(searchStr)) return true;
                            return false;
                        });

                        if (matchingIssue) {
                            requestsToComplete.push(req.id);
                        }
                    }

                    if (requestsToComplete.length > 0) {
                        await prisma.request.updateMany({
                            where: { id: { in: requestsToComplete } },
                            data: { status: 'COMPLETED', progress: 100 }
                        });
                    }
                }
            } catch (e) {
                console.error("Auto-Healer Error:", e);
            }
        }
    }

    let where: any = {};
    if (libraryFilterParam === 'COMICS') where.isManga = false;
    if (libraryFilterParam === 'MANGA') where.isManga = true;
    if (publisherFilter !== 'ALL') where.publisher = publisherFilter;
    if (favorites && userId) where.favorites = { some: { userId } };

    if (q) {
        if (type === 'TITLE') {
            where.OR = [ { name: { contains: q } }, { publisher: { contains: q } } ];
        } else if (type === 'WRITER') {
            where.issues = { some: { writers: { contains: q } } };
        } else if (type === 'ARTIST') {
            where.issues = { some: { artists: { contains: q } } };
        } else if (type === 'CHARACTER') {
            where.issues = { some: { characters: { contains: q } } };
        } else {
            where.OR = [
                { name: { contains: q } },
                { publisher: { contains: q } },
                { issues: { some: { OR: [ { writers: { contains: q } }, { artists: { contains: q } }, { characters: { contains: q } } ] } } }
            ];
        }
    }

    let orderBy: any = { name: 'asc' };
    if (sort === 'alpha_desc') orderBy = { name: 'desc' };
    else if (sort === 'year_desc') orderBy = { year: 'desc' };
    else if (sort === 'year_asc') orderBy = { year: 'asc' };
    else if (sort === 'count_desc') orderBy = { issues: { _count: 'desc' } };

    let totalCount = 0;
    let dbSeries = [];

    if (collectionId !== 'ALL' && sort === 'alpha_asc') {
        const cItems = await prisma.collectionItem.findMany({
            where: { collectionId },
            orderBy: { order: 'asc' }
        });
        const cSeriesIds = cItems.map(i => i.seriesId);

        let filteredIds = cSeriesIds;
        if (q || publisherFilter !== 'ALL' || libraryFilterParam !== 'ALL' || favorites) {
             const matchingSeries = await prisma.series.findMany({
                 where: { ...where, id: { in: cSeriesIds } },
                 select: { id: true }
             });
             const matchingSet = new Set(matchingSeries.map(s => s.id));
             filteredIds = cSeriesIds.filter(id => matchingSet.has(id));
        }

        totalCount = filteredIds.length;
        const paginatedIds = filteredIds.slice(skip, skip + limit);

        const dbSeriesUnsorted = await prisma.series.findMany({
            where: { id: { in: paginatedIds } },
            include: {
                issues: {
                    select: {
                        id: true, writers: true, artists: true, characters: true,
                        readProgresses: {
                            where: { userId: userId || 'none' },
                            select: { isCompleted: true, currentPage: true, totalPages: true }
                        }
                    }
                },
                favorites: { where: { userId: userId || 'none' }, select: { userId: true } }
            }
        });

        for (const id of paginatedIds) {
            const found = dbSeriesUnsorted.find(s => s.id === id);
            if (found) dbSeries.push(found);
        }
    } else {
        if (collectionId !== 'ALL') {
            const cItems = await prisma.collectionItem.findMany({ where: { collectionId } });
            where.id = { in: cItems.map(i => i.seriesId) };
        }
        
        totalCount = await prisma.series.count({ where });
        dbSeries = await prisma.series.findMany({
            where, skip, take: limit, orderBy,
            include: {
                issues: {
                    select: {
                        id: true, writers: true, artists: true, characters: true,
                        readProgresses: {
                            where: { userId: userId || 'none' },
                            select: { isCompleted: true, currentPage: true, totalPages: true }
                        }
                    }
                },
                favorites: { where: { userId: userId || 'none' }, select: { userId: true } }
            }
        });
    }

    const publishersRaw = await prisma.series.findMany({ select: { publisher: true }, distinct: ['publisher'] });
    const globalPublishers = Array.from(new Set(publishersRaw.map(p => p.publisher || 'Other'))).sort();

    const formatted = dbSeries.map(s => {
        const issueCount = s.issues.length;
        let completedCount = 0;
        let totalProgressSum = 0;

        const writers = new Set<string>();
        const artists = new Set<string>();
        const characters = new Set<string>();

        s.issues.forEach(issue => {
            const prog = issue.readProgresses?.[0]; 
            if (prog) {
                if (prog.isCompleted) {
                    completedCount++;
                    totalProgressSum += 100;
                } else if (prog.totalPages > 0) {
                    totalProgressSum += (prog.currentPage / prog.totalPages) * 100;
                }
            }

            if (issue.writers) { try { JSON.parse(issue.writers).forEach((w: string) => writers.add(w)); } catch(e){} }
            if (issue.artists) { try { JSON.parse(issue.artists).forEach((a: string) => artists.add(a)); } catch(e){} }
            if (issue.characters) { try { JSON.parse(issue.characters).forEach((c: string) => characters.add(c)); } catch(e){} }
        });

        let coverUrl = (s as any).coverUrl || null;
        if (!coverUrl && s.folderPath) {
            coverUrl = `/api/library/cover?path=${encodeURIComponent(s.folderPath)}`;
        }

        return {
            id: s.id, name: s.name || "Unknown Series", year: s.year, publisher: s.publisher || "Unknown",
            path: s.folderPath, cvId: (s.cvId !== null && s.cvId > 0) ? s.cvId : null,
            isFavorite: s.favorites.length > 0, count: issueCount, unreadCount: Math.max(0, issueCount - completedCount),
            progressPercentage: issueCount > 0 ? Math.round(totalProgressSum / issueCount) : 0, cover: coverUrl,
            monitored: s.monitored || false, isManga: (s as any).isManga || false,
            writers: Array.from(writers), artists: Array.from(artists), characters: Array.from(characters)
        };
    });

    return NextResponse.json({ series: formatted, publishers: globalPublishers, hasMore: skip + limit < totalCount });

  } catch (error: any) {
    return NextResponse.json({ error: error.message, series: [], hasMore: false }, { status: 500 });
  }
}