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
    const monitored = searchParams.get('monitored') === 'true';
    const era = searchParams.get('era') || 'ALL';
    const readStatus = searchParams.get('readStatus') || 'ALL';

    if (shouldScanDisk) {
        const scanResult = await LibraryScanner.scan();

        if (scanResult === null) {
            return NextResponse.json({ error: "Library scan already in progress." }, { status: 409 });
        }
    }

    let where: any = { AND: [] };

    if (!monitored && !unmatchedOnly) where.AND.push({ issues: { some: {} } });
    if (libraryFilterParam === 'COMICS') where.AND.push({ isManga: false });
    if (libraryFilterParam === 'MANGA') where.AND.push({ isManga: true });
    if (publisherFilter !== 'ALL') where.AND.push({ publisher: publisherFilter });
    if (favorites) where.AND.push({ favorites: { some: { userId } } });
    if (unmatchedOnly) where.AND.push({ metadataId: { startsWith: 'unmatched_' } });
    if (monitored) where.AND.push({ monitored: true });

    if (era !== 'ALL') {
        if (era === '2020s') where.AND.push({ year: { gte: 2020 } });
        else if (era === '2010s') where.AND.push({ year: { gte: 2010, lt: 2020 } });
        else if (era === '2000s') where.AND.push({ year: { gte: 2000, lt: 2010 } });
        else if (era === '1990s') where.AND.push({ year: { gte: 1990, lt: 2000 } });
        else if (era === '1980s') where.AND.push({ year: { gte: 1980, lt: 1990 } });
        else if (era === 'CLASSIC') where.AND.push({ year: { lt: 1980, gt: 0 } });
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
        where.AND.push({ collections: { some: { collectionId: collectionId } } });
    }

    const type = searchParams.get('type') || 'ALL';

    if (q) {
        let parsedQuery = q.trim();
        let targetField = type.toUpperCase();

        // 1. Detect prefix-based search (e.g., "character: batman")
        const prefixMatch = parsedQuery.match(/^(character|team|arc|location|writer|artist|genre):\s*(.+)$/i);
        if (prefixMatch) {
            targetField = prefixMatch[1].toUpperCase();
            parsedQuery = prefixMatch[2].trim();
        }

        // 2. Strip optional wrapping quotes used for exact phrase matching
        parsedQuery = parsedQuery.replace(/^["']|["']$/g, '');

        // 3. Apply the targeted search
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
            // Broad search fallback
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
                    readProgresses: {
                        where: { userId: userId || 'none' },
                        select: { isCompleted: true }
                    }
                }
            },
            favorites: { where: { userId: userId || 'none' }, select: { userId: true } }
        }
    });

    const publishersRaw = await prisma.series.findMany({ select: { publisher: true }, distinct: ['publisher'] });

    const formatted = dbSeries.map(s => ({
        id: s.id, 
        name: s.name || "Unknown Series", 
        year: s.year, 
        publisher: s.publisher || "Unknown",
        path: s.folderPath, 
        isFavorite: s.favorites.length > 0,
        count: s.issues.length,
        unreadCount: s.issues.filter(i => !i.readProgresses[0]?.isCompleted).length,
        progressPercentage: s.issues.length > 0 
            ? Math.round((s.issues.filter(i => i.readProgresses[0]?.isCompleted).length / s.issues.length) * 100) 
            : 0,
        cover: s.coverUrl?.startsWith('http') ? `/api/library/cover?path=${encodeURIComponent(s.coverUrl)}` : s.coverUrl,
        cvId: parseInt(s.metadataId || "") || undefined,
        monitored: s.monitored,
        isManga: s.isManga
    }));

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

        // ACTION: Mark Read / Unread
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

        // ACTION: Remove from Collection
        if (action === 'bulk-remove-list') {
            const collectionId = status;
            const list = await prisma.readingList.findUnique({ where: { id: collectionId } });

            // Ensure the user owns the list or is an admin
            if (!list || (list.userId !== userId && session?.user?.role !== 'ADMIN')) {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }

            await prisma.collectionItem.deleteMany({
                where: { collectionId, seriesId: { in: seriesIds } }
            });
            return NextResponse.json({ success: true });
        }

        // The following actions physically alter the system and require Admin rights
        if (session?.user?.role !== 'ADMIN') {
            return NextResponse.json({ error: "Unauthorized. Admin required." }, { status: 403 });
        }

        // ACTION: Start / Stop Monitoring
        if (action === 'bulk-monitor') {
            const monitored = status === 'MONITOR';
            await prisma.series.updateMany({
                where: { id: { in: seriesIds } },
                data: { monitored }
            });
            await AuditLogger.log('BULK_UPDATE_MONITOR', { monitored, seriesCount: seriesIds.length }, userId);
            return NextResponse.json({ success: true });
        }

        // ACTION: Change to Manga / Comic
        if (action === 'bulk-manga') {
            const isManga = status === 'MANGA';
            await prisma.series.updateMany({
                where: { id: { in: seriesIds } },
                data: { isManga }
            });
            await AuditLogger.log('BULK_UPDATE_MANGA', { isManga, seriesCount: seriesIds.length }, userId);
            return NextResponse.json({ success: true });
        }

        return NextResponse.json({ error: "Invalid action type specified" }, { status: 400 });

    } catch (error: unknown) {
        Logger.log(`[Library API] Bulk Action Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}