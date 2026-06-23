// src/app/api/library/route.ts
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs-extra'; 
import path from 'path';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { detectManga } from '@/lib/manga-detector';
import { parseComicInfo } from '@/lib/metadata-extractor';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { LibraryScanner } from '@/lib/library-scanner';
import { getAccessibleLibraryIds } from '@/lib/library-access';

export async function GET(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id || null;

    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.max(1, parseInt(searchParams.get('limit') || '24', 10));
    const skip = (page - 1) * limit;
    
    const shouldScanDisk = searchParams.get('refresh') === 'true';
    const q = searchParams.get('q') || '';
    const libraryFilterParam = searchParams.get('library') || 'ALL';
    const publisherFilter = searchParams.get('publisher') || 'ALL';
    const sort = searchParams.get('sort') || 'alpha_asc';
    const collectionId = searchParams.get('collection') || 'ALL';
    
    const favorites = searchParams.get('favorites') === 'true';
    const unmatchedOnly = searchParams.get('unmatched') === 'true';
    const pendingOnly = searchParams.get('pending') === 'true';
    const monitored = searchParams.get('monitored') === 'true';
    const era = searchParams.get('era') || 'ALL';
    const bookTypeFilter = searchParams.get('bookType') || 'ALL';
    const readStatus = searchParams.get('readStatus') || 'ALL';

    if (shouldScanDisk) {
        const scanResult = await LibraryScanner.scan();

        if (scanResult === null) {
            return NextResponse.json({ error: "Library scan already in progress." }, { status: 409 });
        }
    }

    let pendingRequests: any[] = [];
    try {
        const reqs = await prisma.request.findMany({
            where: { status: { notIn: ['COMPLETED', 'IMPORTED', 'CANCELLED'] } },
            select: { volumeId: true }
        });
        if (Array.isArray(reqs)) pendingRequests = reqs;
    } catch (e) {}
    
    const pendingVolIdsList = pendingRequests.map(r => r.volumeId);
    const pendingVolIds = new Set<string>(pendingVolIdsList);

    const where: any = { AND: [] };

    // Per-library access: non-admins only see series in their granted libraries (admins bypass).
    const accessibleLibs = await getAccessibleLibraryIds(userId, (session?.user as any)?.role);
    if (accessibleLibs !== 'ALL') where.AND.push({ libraryId: { in: accessibleLibs } });

    if (libraryFilterParam === 'COMICS') where.AND.push({ isManga: false });
    if (libraryFilterParam === 'MANGA') where.AND.push({ isManga: true });
    if (publisherFilter !== 'ALL') where.AND.push({ publisher: publisherFilter });
    if (favorites) where.AND.push({ favorites: { some: { userId } } });
    if (unmatchedOnly) where.AND.push({ matchState: 'UNMATCHED' });
    if (monitored) where.AND.push({ monitored: true });

    if (pendingOnly) {
        where.AND.push({
            metadataId: { in: pendingVolIdsList },
            issues: { none: { filePath: { not: null } } }
        });
    }

    if (era !== 'ALL') {
        if (era === '2020s') where.AND.push({ year: { gte: 2020 } });
        else if (era === '2010s') where.AND.push({ year: { gte: 2010, lt: 2020 } });
        else if (era === '2000s') where.AND.push({ year: { gte: 2000, lt: 2010 } });
        else if (era === '1990s') where.AND.push({ year: { gte: 1990, lt: 2000 } });
        else if (era === '1980s') where.AND.push({ year: { gte: 1980, lt: 1990 } });
        else if (era === 'CLASSIC') where.AND.push({ year: { lt: 1980, gt: 0 } });
    }

    if (['Print', 'OneShot', 'TPB', 'GN'].includes(bookTypeFilter)) {
        if (bookTypeFilter === 'Print') {
            // Uncategorized series are standard print series until told otherwise
            where.AND.push({ OR: [{ bookType: 'Print' }, { bookType: null }] });
        } else {
            where.AND.push({ bookType: bookTypeFilter });
        }
    }

    if (readStatus !== 'ALL') {
        if (readStatus === 'COMPLETED') {
            where.AND.push({ issues: { none: { readProgresses: { none: { userId, isCompleted: true } } } } });
        } else if (readStatus === 'UNREAD') {
            where.AND.push({ issues: { none: { readProgresses: { some: { userId, isCompleted: true } } } } });
        } else if (readStatus === 'IN_PROGRESS') {
            where.AND.push({ issues: { some: { readProgresses: { some: { userId, isCompleted: true } } } } });
            where.AND.push({ issues: { some: { readProgresses: { none: { userId, isCompleted: true } } } } });
        }
    }

    if (collectionId !== 'ALL') {
        const listItems = await prisma.readingListItem.findMany({
            where: { listId: collectionId, issueId: { not: null } },
            select: { issueId: true }
        });
        const issueIds = listItems.map(i => i.issueId).filter(Boolean) as string[];
        where.AND.push({ issues: { some: { id: { in: issueIds } } } });
    }

    const type = searchParams.get('type') || 'ALL';

    if (q) {
        let parsedQuery = q.trim();
        let targetField = type.toUpperCase();

        const prefixMatch = parsedQuery.match(/^(character|team|arc|location|writer|artist|genre):\s*(.+)$/i);
        if (prefixMatch) {
            targetField = prefixMatch[1].toUpperCase();
            parsedQuery = prefixMatch[2].trim();
        }

        parsedQuery = parsedQuery.replace(/^["']|["']$/g, '');

        if (targetField === 'CHARACTER') {
            where.AND.push({ issues: { some: { characters: { contains: parsedQuery } } } });
        } else if (targetField === 'TEAM') {
            where.AND.push({ issues: { some: { teams: { contains: parsedQuery } } } });
        } else if (targetField === 'ARC') {
            where.AND.push({ issues: { some: { storyArcs: { contains: parsedQuery } } } });
        } else if (targetField === 'LOCATION') {
            where.AND.push({ issues: { some: { locations: { contains: parsedQuery } } } });
        } else if (targetField === 'WRITER') {
            where.AND.push({ issues: { some: { writers: { contains: parsedQuery } } } });
        } else if (targetField === 'ARTIST') {
            where.AND.push({ issues: { some: { artists: { contains: parsedQuery } } } });
        } else if (targetField === 'GENRE') {
            where.AND.push({ issues: { some: { genres: { contains: parsedQuery } } } });
        } else if (targetField === 'TITLE') {
            where.AND.push({ OR: [{ name: { contains: parsedQuery } }, { publisher: { contains: parsedQuery } }] });
        } else {
            where.AND.push({
                OR: [
                    { name: { contains: parsedQuery } }, 
                    { publisher: { contains: parsedQuery } }, 
                    { issues: { some: { OR: [ 
                        { writers: { contains: parsedQuery } }, 
                        { artists: { contains: parsedQuery } },
                        { characters: { contains: parsedQuery } },
                        { teams: { contains: parsedQuery } },
                        { storyArcs: { contains: parsedQuery } }
                    ] } } }
                ]
            });
        }
    }

    let orderBy: any = {};
    switch (sort) {
        case 'alpha_desc': orderBy = { name: 'desc' }; break;
        case 'year_desc': orderBy = { year: 'desc' }; break;
        case 'year_asc': orderBy = { year: 'asc' }; break;
        case 'count_desc': orderBy = { issues: { _count: 'desc' } }; break;
        case 'random': orderBy = { id: 'asc' }; break; 
        default: orderBy = { name: 'asc' };
    }

    const totalCount = await prisma.series.count({ where: (where.AND.length > 0 ? where : {}) });

    let finalSkip = skip;
    if (sort === 'random' && totalCount > limit) {
        finalSkip = Math.floor(Math.random() * (totalCount - limit));
    }

    const dbSeries = await prisma.series.findMany({
        where: (where.AND.length > 0 ? where : {}),
        skip: finalSkip,
        take: limit,
        orderBy,
        include: {
            issues: {
                select: {
                    id: true,
                    coverUrl: true,
                    filePath: true,
                    readProgresses: {
                        where: { userId: userId || 'none' },
                        select: { isCompleted: true }
                    }
                }
            },
            favorites: { where: { userId: userId || 'none' }, select: { userId: true } }
        }
    });

    let publishersRaw: any[] = [];
    try {
        const pubs = await prisma.series.findMany({ select: { publisher: true }, distinct: ['publisher'] });
        if (Array.isArray(pubs)) publishersRaw = pubs;
    } catch(e) {}

    const formatted = dbSeries.map(s => {
        const downloadedIssues = s.issues?.filter((i: any) => i.filePath && i.filePath.trim().length > 0) || [];
        
        let finalCover = s.coverUrl;
        
        if (!finalCover && downloadedIssues.length > 0) {
            const issueWithCover = downloadedIssues.find((i: any) => i.coverUrl !== null && i.coverUrl !== '');
            if (issueWithCover) {
                finalCover = issueWithCover.coverUrl;
            }
        }

        if (finalCover && !finalCover.startsWith('/api/')) {
            finalCover = `/api/library/cover?path=${encodeURIComponent(finalCover)}`;
        } else if (!finalCover && s.folderPath) {
            finalCover = `/api/library/cover?path=${encodeURIComponent(s.folderPath)}`;
        }

        // --- NEW: Inject metadataId and metadataSource to fully support Metron bulk actions ---
        return {
            id: s.id, 
            name: s.name || "Unknown Series", 
            year: s.year, 
            publisher: s.publisher || "Unknown",
            path: s.folderPath, 
            isFavorite: s.favorites?.length > 0,
            count: downloadedIssues.length,
            unreadCount: downloadedIssues.filter((i: any) => !i.readProgresses[0]?.isCompleted).length,
            progressPercentage: downloadedIssues.length > 0 
                ? Math.round((downloadedIssues.filter((i: any) => i.readProgresses[0]?.isCompleted).length / downloadedIssues.length) * 100) 
                : 0,
            cover: finalCover,
            cvId: parseInt(s.metadataId || "") || undefined,
            metadataId: s.metadataId,
            metadataSource: s.metadataSource,
            matchState: s.matchState,
            monitored: s.monitored,
            isManga: s.isManga,
            isPendingReq: downloadedIssues.length === 0,
            status: s.status
        }
    });

    return NextResponse.json({ 
        series: formatted, 
        publishers: publishersRaw.map(p => p.publisher).filter(Boolean).sort(), 
        hasMore: skip + limit < totalCount 
    });

  } catch (error: unknown) {
    Logger.log(`Library API Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: "Failed to load library." }, { status: 500 });
  }
}

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const body = await request.json();
        const { seriesIds, action, status } = body;

        if (!seriesIds || !Array.isArray(seriesIds) || seriesIds.length === 0) {
            return NextResponse.json({ error: "Missing series IDs" }, { status: 400 });
        }

        if (action === 'bulk-progress') {
            const isCompleted = status === 'READ';
            const issues = await prisma.issue.findMany({ where: { seriesId: { in: seriesIds } } });
            
            const updates = issues.map(issue => 
                prisma.readProgress.upsert({
                    where: { userId_issueId: { userId, issueId: issue.id } },
                    update: { isCompleted, currentPage: isCompleted ? 100 : 0, totalPages: 100 },
                    create: { userId, issueId: issue.id, isCompleted, currentPage: isCompleted ? 100 : 0, totalPages: 100 }
                })
            );
            await prisma.$transaction(updates);
            return NextResponse.json({ success: true });
        }

        if (action === 'bulk-remove-list') {
            const listId = status;
            const list = await prisma.readingList.findUnique({ where: { id: listId } });

            if (!list || (list.userId !== userId && session?.user?.role !== 'ADMIN')) {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }

            const issues = await prisma.issue.findMany({ where: { seriesId: { in: seriesIds } }, select: { id: true } });
            const issueIds = issues.map(i => i.id);

            await prisma.readingListItem.deleteMany({
                where: { listId, issueId: { in: issueIds } }
            });
            return NextResponse.json({ success: true });
        }

        if (session?.user?.role !== 'ADMIN') {
            return NextResponse.json({ error: "Unauthorized. Admin required." }, { status: 403 });
        }

        if (action === 'bulk-monitor') {
            const monitored = status === 'MONITOR';
            await prisma.series.updateMany({
                where: { id: { in: seriesIds } },
                data: { monitored }
            });
            await AuditLogger.log('BULK_UPDATE_MONITOR', { monitored, seriesCount: seriesIds.length }, userId);
            return NextResponse.json({ success: true });
        }

        if (action === 'bulk-manga') {
            const isManga = status === 'MANGA';
            await prisma.series.updateMany({
                where: { id: { in: seriesIds } },
                data: { isManga }
            });
            await AuditLogger.log('BULK_UPDATE_MANGA', { isManga, seriesCount: seriesIds.length }, userId);
            return NextResponse.json({ success: true });
        }

        if (action === 'bulk-status') {
            await prisma.series.updateMany({
                where: { id: { in: seriesIds } },
                data: { status: status } // status will be 'Ongoing' or 'Ended' from the frontend
            });
            await AuditLogger.log('BULK_UPDATE_STATUS', { status, seriesCount: seriesIds.length }, userId);
            return NextResponse.json({ success: true });
        }

        return NextResponse.json({ error: "Invalid action type specified" }, { status: 400 });

    } catch (error: unknown) {
        Logger.log(`[Library API] Bulk Action Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;
        
        if (session?.user?.role !== 'ADMIN') {
            return NextResponse.json({ error: "Unauthorized. Admin required." }, { status: 403 });
        }

        const body = await request.json();
        const { seriesIds, deleteFiles } = body;

        if (!seriesIds || !Array.isArray(seriesIds) || seriesIds.length === 0) {
            return NextResponse.json({ error: "Missing series IDs" }, { status: 400 });
        }

        const seriesToDelete = await prisma.series.findMany({
            where: { id: { in: seriesIds } }
        });

        const deletedPaths: string[] = [];

        if (deleteFiles) {
            for (const series of seriesToDelete) {
                if (series.folderPath && fs.existsSync(series.folderPath)) {
                    await fs.remove(series.folderPath);
                    deletedPaths.push(series.folderPath);
                }
            }
        }

        await prisma.issue.deleteMany({ where: { seriesId: { in: seriesIds } } });
        await prisma.series.deleteMany({ where: { id: { in: seriesIds } } });

        await AuditLogger.log('DELETE_SERIES_BULK', {
            seriesCount: seriesIds.length,
            deletedPhysicalFiles: deleteFiles,
            deletedPaths
        }, userId);

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        Logger.log(`[Library Series API] Delete Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: "Deletion failed" }, { status: 500 });
    }
}