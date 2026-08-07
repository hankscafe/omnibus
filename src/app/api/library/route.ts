// src/app/api/library/route.ts
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { ciContains } from '@/lib/utils/db-search';
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
    // Alphabet jump bar (worklist item 6): an absolute offset anchors the window mid-alphabet
    // (letter → first-occurrence index from the names index); when present it overrides page math.
    const offsetParam = searchParams.get('offset');
    const offset = offsetParam !== null ? Math.max(0, parseInt(offsetParam, 10) || 0) : null;
    const skip = offset !== null ? offset : (page - 1) * limit;
    // namesOnly: the light names index powering the jump bar — the exact server order under the
    // current filters, no pagination, none of the heavy includes.
    const namesOnly = searchParams.get('namesOnly') === '1';
    
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
    // Series status filter (discussion #177): lets admins isolate Ongoing/Ended series and combine
    // with select-all + bulk-monitor for one-click mass monitoring.
    const seriesStatus = searchParams.get('status') || 'ALL';
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
    if (seriesStatus === 'Ongoing' || seriesStatus === 'Ended') where.AND.push({ status: seriesStatus });

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
            where.AND.push({ issues: { some: { characters: ciContains(parsedQuery) } } });
        } else if (targetField === 'TEAM') {
            where.AND.push({ issues: { some: { teams: ciContains(parsedQuery) } } });
        } else if (targetField === 'ARC') {
            where.AND.push({ issues: { some: { storyArcs: ciContains(parsedQuery) } } });
        } else if (targetField === 'LOCATION') {
            where.AND.push({ issues: { some: { locations: ciContains(parsedQuery) } } });
        } else if (targetField === 'WRITER') {
            where.AND.push({ issues: { some: { writers: ciContains(parsedQuery) } } });
        } else if (targetField === 'ARTIST') {
            where.AND.push({ issues: { some: { artists: ciContains(parsedQuery) } } });
        } else if (targetField === 'GENRE') {
            where.AND.push({ issues: { some: { genres: ciContains(parsedQuery) } } });
        } else if (targetField === 'TITLE') {
            where.AND.push({ OR: [{ name: ciContains(parsedQuery) }, { publisher: ciContains(parsedQuery) }] });
        } else {
            where.AND.push({
                OR: [
                    { name: ciContains(parsedQuery) }, 
                    { publisher: ciContains(parsedQuery) }, 
                    { issues: { some: { OR: [ 
                        { writers: ciContains(parsedQuery) }, 
                        { artists: ciContains(parsedQuery) },
                        { characters: ciContains(parsedQuery) },
                        { teams: ciContains(parsedQuery) },
                        { storyArcs: ciContains(parsedQuery) }
                    ] } } }
                ]
            });
        }
    }

    // Every sort carries a unique `id` tiebreaker (v1.4.1). OFFSET pagination requires a TOTAL
    // order: PostgreSQL gives rows with equal sort keys no deterministic order between executions,
    // so page windows under a bare `name`/`year` sort could overlap and gap (comic libraries are
    // full of exact-name ties — rebooted volumes share a title). On the live pg profile that
    // starved infinite-scroll appends and made the library visibly jitter between adjacent-letter
    // items while scrolling. The names index below shares this orderBy, so the jump bar's offsets
    // are computed against the same total order the pages realize.
    // The alpha sorts carry a `year` secondary (#201): same-name series are everywhere (rebooted
    // volumes share a title), and without it their order fell to `id` = creation order — which
    // only LOOKED like year order for scan-born series (folders are named "Series (Year)", so an
    // alphabetical scan creates volumes oldest-first). Request/match-born volumes exposed the
    // arbitrariness. Z-A mirrors to year desc so the reversed list is the exact reverse.
    let orderBy: any = {};
    switch (sort) {
        case 'alpha_desc': orderBy = [{ name: 'desc' }, { year: 'desc' }, { id: 'desc' }]; break;
        case 'year_desc': orderBy = [{ year: 'desc' }, { name: 'asc' }, { id: 'asc' }]; break;
        case 'year_asc': orderBy = [{ year: 'asc' }, { name: 'asc' }, { id: 'asc' }]; break;
        case 'count_desc': orderBy = [{ issues: { _count: 'desc' } }, { name: 'asc' }, { id: 'asc' }]; break;
        case 'random': orderBy = { id: 'asc' }; break;
        default: orderBy = [{ name: 'asc' }, { year: 'asc' }, { id: 'asc' }];
    }

    if (namesOnly) {
        const nameRows = await prisma.series.findMany({
            where: (where.AND.length > 0 ? where : {}),
            orderBy,
            select: { name: true },
        });
        return NextResponse.json({ names: nameRows.map(r => r.name) });
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
            favorites: { where: { userId: userId || 'none' }, select: { userId: true } }
        }
    });

    // The card only needs three numbers per series (downloaded count, read count, and a fallback cover) —
    // NOT every issue row. Previously the query include-loaded ALL issues (plus a per-issue read-progress
    // join) for the 24 series on the page just to count them in JS, so a single page could pull thousands of
    // rows for large/manga series. Derive the counts with two grouped aggregates that return one row per
    // series, and look up a fallback cover only for series that lack a series-level one.
    const pageSeriesIds = dbSeries.map(s => s.id);
    const progressUserId = userId || 'none';

    const [downloadedGroups, completedGroups] = pageSeriesIds.length === 0 ? [[], []] : await Promise.all([
        prisma.issue.groupBy({
            by: ['seriesId'],
            where: { seriesId: { in: pageSeriesIds }, filePath: { not: null } },
            _count: { _all: true }
        }),
        prisma.issue.groupBy({
            by: ['seriesId'],
            where: {
                seriesId: { in: pageSeriesIds },
                filePath: { not: null },
                readProgresses: { some: { userId: progressUserId, isCompleted: true } }
            },
            _count: { _all: true }
        })
    ]);

    const downloadedCountBySeries = new Map<string, number>();
    for (const g of downloadedGroups) downloadedCountBySeries.set(g.seriesId, g._count._all);
    const completedCountBySeries = new Map<string, number>();
    for (const g of completedGroups) completedCountBySeries.set(g.seriesId, g._count._all);

    // Fallback cover: only series with no series-level cover need one. distinct picks one downloaded issue
    // cover per series (matching the prior "first downloaded issue with a cover" behavior).
    const seriesNeedingCover = dbSeries.filter(s => !s.coverUrl).map(s => s.id);
    const coverBySeries = new Map<string, string>();
    if (seriesNeedingCover.length > 0) {
        const coverIssues = await prisma.issue.findMany({
            // Exclude null AND empty covers in SQL so `distinct` can't pick an empty-cover issue for a series
            // that has a real cover on another issue (exact parity with the prior `!== null && !== ''` check).
            where: {
                seriesId: { in: seriesNeedingCover },
                filePath: { not: null },
                AND: [{ coverUrl: { not: null } }, { coverUrl: { not: '' } }]
            },
            select: { seriesId: true, coverUrl: true },
            distinct: ['seriesId']
        });
        for (const ci of coverIssues) {
            if (ci.coverUrl) coverBySeries.set(ci.seriesId, ci.coverUrl);
        }
    }

    // The publisher dropdown list is global (independent of filters/pagination) and only changes when series
    // are added/removed. Computing it requires a distinct scan over the whole Series table, so only do it on
    // the first page — infinite-scroll appends (page > 1) reuse the list the client already has.
    let publishersRaw: any[] = [];
    if (page === 1) {
        try {
            const pubs = await prisma.series.findMany({ select: { publisher: true }, distinct: ['publisher'] });
            if (Array.isArray(pubs)) publishersRaw = pubs;
        } catch(e) {}
    }

    const formatted = dbSeries.map(s => {
        const downloadedCount = downloadedCountBySeries.get(s.id) || 0;
        const completedCount = completedCountBySeries.get(s.id) || 0;

        let finalCover = s.coverUrl;

        if (!finalCover) {
            const fallback = coverBySeries.get(s.id);
            if (fallback) finalCover = fallback;
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
            count: downloadedCount,
            unreadCount: downloadedCount - completedCount,
            progressPercentage: downloadedCount > 0
                ? Math.round((completedCount / downloadedCount) * 100)
                : 0,
            cover: finalCover,
            cvId: parseInt(s.metadataId || "") || undefined,
            metadataId: s.metadataId,
            metadataSource: s.metadataSource,
            matchState: s.matchState,
            monitored: s.monitored,
            isManga: s.isManga,
            isPendingReq: downloadedCount === 0,
            status: s.status
        }
    });

    return NextResponse.json({
        series: formatted,
        // Only present on page 1 — the client keeps its existing list on infinite-scroll appends. (Omitted,
        // not [], so the client's `if (data.publishers)` guard doesn't wipe the dropdown on later pages.)
        // A jump-anchored first window (offset > 0) counts as a fresh page 1 for this purpose.
        ...(page === 1 ? { publishers: publishersRaw.map(p => p.publisher).filter(Boolean).sort() } : {}),
        hasMore: finalSkip + limit < totalCount
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
            const currentPage = isCompleted ? 100 : 0;
            // Two bulk statements instead of a per-issue upsert loop in one long lock-holding
            // transaction: update the rows that already exist, then create only the missing ones.
            // No skipDuplicates (unsupported on SQLite) — we explicitly diff against existing rows,
            // so createMany can't collide on the (userId, issueId) unique.
            const issues = await prisma.issue.findMany({ where: { seriesId: { in: seriesIds } }, select: { id: true } });
            const issueIds = issues.map(i => i.id);
            const existing = await prisma.readProgress.findMany({
                where: { userId, issueId: { in: issueIds } },
                select: { issueId: true },
            });
            const have = new Set(existing.map(r => r.issueId));
            const missing = issueIds.filter(id => !have.has(id));
            await prisma.$transaction([
                prisma.readProgress.updateMany({
                    where: { userId, issueId: { in: issueIds } },
                    data: { isCompleted, currentPage, totalPages: 100 },
                }),
                ...(missing.length
                    ? [prisma.readProgress.createMany({
                        data: missing.map(issueId => ({ userId, issueId, isCompleted, currentPage, totalPages: 100 })),
                    })]
                    : []),
            ]);
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