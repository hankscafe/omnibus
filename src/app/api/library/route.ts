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

async function withScanLock<T>(fn: () => Promise<T>): Promise<T | null> {
    const lockId = 'LIBRARY_SCAN_ACTIVE';
    const timeoutLimit = new Date(Date.now() - 10 * 60 * 1000); 
    
    const existingLock = await prisma.jobLock.findUnique({ where: { id: lockId } });
    if (existingLock && existingLock.lockedAt > timeoutLimit) {
        return null; 
    }

    await prisma.jobLock.upsert({
        where: { id: lockId },
        update: { lockedAt: new Date() },
        create: { id: lockId, lockedAt: new Date() }
    });

    try {
        return await fn();
    } finally {
        await prisma.jobLock.delete({ where: { id: lockId } }).catch(() => {});
    }
}

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
        const scanResult = await withScanLock(async () => {
            const libraries = await prisma.library.findMany();
            for (const lib of libraries) {
                if (!fs.existsSync(lib.path)) {
                    throw new Error(`Drive disconnected: ${lib.path}`);
                }
            }

            const allSeries = await prisma.series.findMany({ select: { id: true, folderPath: true } });
            const badIds: string[] = allSeries
                .filter(s => !s.folderPath || !fs.existsSync(s.folderPath))
                .map(s => s.id);

            if (badIds.length > 0) {
                await prisma.issue.deleteMany({ where: { seriesId: { in: badIds } } });
                await prisma.series.deleteMany({ where: { id: { in: badIds } } });
                Logger.log(`[Scan] Purged ${badIds.length} ghost series records.`, 'info');
            }

            const existingFolders = new Set(allSeries.map(s => path.normalize(s.folderPath).toLowerCase()));

            const findSeriesFolders = async (dir: string, baseRoot: string, libId: string, libIsManga: boolean) => {
                const folderName = path.basename(dir);
                if (folderName.startsWith('.')) return;

                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                const files = entries.filter(e => !e.isDirectory()).map(e => e.name);
                const bookFiles = files.filter(f => f.toLowerCase().match(/\.(cbz|cbr|zip)$/));

                if (bookFiles.length > 0) {
                    const normDir = path.normalize(dir).toLowerCase();
                    if (!existingFolders.has(normDir)) {
                        try {
                            const firstArchive = path.join(dir, bookFiles[0]);
                            const embeddedMeta = await parseComicInfo(firstArchive);

                            const cleanedName = embeddedMeta?.series || folderName.replace(/\s\(\d{4}\)$/, "").trim() || "Unknown Series";
                            const year = embeddedMeta?.year || parseInt(folderName.match(/\((\d{4})\)/)?.[1] || "0");
                            
                            await prisma.series.create({
                                data: {
                                    folderPath: dir.replace(/\\/g, '/'),
                                    name: cleanedName,
                                    year: year,
                                    publisher: embeddedMeta?.publisher || "Other",
                                    metadataId: embeddedMeta?.cvId?.toString() || `unmatched_${Math.random()}`,
                                    metadataSource: embeddedMeta?.cvId ? 'COMICVINE' : 'LOCAL',
                                    matchState: embeddedMeta?.cvId ? 'MATCHED' : 'UNMATCHED',
                                    cvId: embeddedMeta?.cvId || null,
                                    isManga: embeddedMeta?.isManga || libIsManga || await detectManga({ name: cleanedName }, firstArchive),
                                    libraryId: libId
                                }
                            });
                        } catch(e) {}
                    }
                }
                
                const subDirs = entries.filter(e => e.isDirectory());
                for (const d of subDirs) {
                    await findSeriesFolders(path.join(dir, d.name), baseRoot, libId, libIsManga);
                }
            };

            for (const lib of libraries) {
                await findSeriesFolders(lib.path, lib.path, lib.id, lib.isManga);
            }
            return true;
        });

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

    if (q) {
        where.AND.push({
            OR: [
                { name: { contains: q } }, 
                { publisher: { contains: q } }, 
                { issues: { some: { OR: [ { writers: { contains: q } }, { artists: { contains: q } } ] } } }
            ]
        });
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