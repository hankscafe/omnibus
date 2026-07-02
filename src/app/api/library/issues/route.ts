// src/app/api/library/issues/route.ts
//
// Library-wide INDIVIDUAL-ISSUE browse, ordered by release date, with cursor (keyset) pagination. The
// Issue table can hold hundreds of thousands of rows, so this avoids offset paging (O(offset) per page on
// SQLite) and a per-page COUNT(*): it orders by [releaseDate, id], over-fetches one row to derive hasMore,
// and pages forward by the last row's id. Series-level filters (publisher / era / library / access) are
// applied through the `series` relation; only issues with a known release date are returned.
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getAccessibleLibraryIds } from '@/lib/library-access';

// Map an era label to a Series.year range (mirrors the series library route).
function eraToYear(era: string): { gte?: number; lt?: number; gt?: number } | null {
    switch (era) {
        case '2020s': return { gte: 2020 };
        case '2010s': return { gte: 2010, lt: 2020 };
        case '2000s': return { gte: 2000, lt: 2010 };
        case '1990s': return { gte: 1990, lt: 2000 };
        case '1980s': return { gte: 1980, lt: 1990 };
        case 'CLASSIC': return { lt: 1980, gt: 0 };
        default: return null;
    }
}

export async function GET(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id || null;
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { searchParams } = new URL(request.url);
        const limit = Math.min(96, Math.max(1, parseInt(searchParams.get('limit') || '48', 10)));
        const cursor = searchParams.get('cursor') || null;
        const sort = searchParams.get('sort') === 'release_asc' ? 'asc' : 'desc'; // default newest-first
        const publisher = searchParams.get('publisher') || 'ALL';
        const era = searchParams.get('era') || 'ALL';
        const library = searchParams.get('library') || 'ALL';
        const status = searchParams.get('status') || 'ALL';
        const q = (searchParams.get('q') || '').trim();

        // Series-level constraints (publisher / era / library + per-library access) traverse the relation.
        const seriesWhere: any = {};
        const accessibleLibs = await getAccessibleLibraryIds(userId, (session?.user as any)?.role);
        if (accessibleLibs !== 'ALL') seriesWhere.libraryId = { in: accessibleLibs };
        if (library === 'COMICS') seriesWhere.isManga = false;
        else if (library === 'MANGA') seriesWhere.isManga = true;
        if (publisher !== 'ALL') seriesWhere.publisher = publisher;
        const eraRange = eraToYear(era);
        if (eraRange) seriesWhere.year = eraRange;

        // Exclude not-yet-released issues (future-dated monitor skeletons); only list what's actually out.
        // releaseDate is ISO YYYY-MM-DD, so a lexical <= today is a chronological "already released" test.
        const todayISO = new Date().toISOString().slice(0, 10);
        const where: any = { releaseDate: { not: null, lte: todayISO } };
        if (Object.keys(seriesWhere).length > 0) where.series = seriesWhere;
        if (status === 'DOWNLOADED') where.filePath = { not: null };
        else if (status === 'WANTED') where.filePath = null;
        // Case-insensitive title search. `mode: 'insensitive'` → Postgres ILIKE (the app runs on Postgres);
        // node main relies on SQLite's LIKE being case-insensitive by default, so it omits the mode.
        if (q) where.OR = [{ name: { contains: q, mode: 'insensitive' } }, { series: { name: { contains: q, mode: 'insensitive' } } }];

        const rows = await prisma.issue.findMany({
            where,
            orderBy: [{ releaseDate: sort }, { id: sort }],
            take: limit + 1, // over-fetch one to derive hasMore without a COUNT
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: {
                id: true, number: true, name: true, coverUrl: true, releaseDate: true, filePath: true,
                series: { select: { name: true, publisher: true, year: true, folderPath: true } }
            }
        });

        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        const nextCursor = hasMore ? pageRows[pageRows.length - 1]?.id ?? null : null;

        const issues = pageRows.map((i: any) => {
            let cover = i.coverUrl;
            if (cover && !cover.startsWith('/api/')) cover = `/api/library/cover?path=${encodeURIComponent(cover)}`;
            else if (!cover && i.series?.folderPath) cover = `/api/library/cover?path=${encodeURIComponent(i.series.folderPath)}`;
            return {
                id: i.id,
                number: i.number,
                name: i.name,
                cover,
                releaseDate: i.releaseDate,
                onDisk: !!(i.filePath && i.filePath.trim().length > 0),
                seriesName: i.series?.name || 'Unknown Series',
                seriesPath: i.series?.folderPath || null,
                publisher: i.series?.publisher || 'Unknown',
                year: i.series?.year ?? null
            };
        });

        // Publisher list for the filter dropdown — only on the first page, to avoid the distinct scan per page.
        let publishers: string[] | undefined;
        if (!cursor) {
            try {
                const pubs = await prisma.series.findMany({ select: { publisher: true }, distinct: ['publisher'] });
                publishers = pubs.map(p => p.publisher).filter(Boolean).sort() as string[];
            } catch { /* best effort */ }
        }

        return NextResponse.json({ issues, nextCursor, hasMore, ...(publishers ? { publishers } : {}) });
    } catch (error: unknown) {
        Logger.log(`[Library Issues API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: "Failed to load issues." }, { status: 500 });
    }
}
