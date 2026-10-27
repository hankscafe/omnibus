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
import { ciContains } from '@/lib/utils/db-search';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getAccessibleLibraryIds } from '@/lib/library-access';
import { expandCoverage, isCovered } from '@/lib/utils/coverage';

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
        // Case-insensitive title search. ciContains is provider-aware: Postgres needs
        // `mode: 'insensitive'` (ILIKE), while the sqlite-generated Prisma client REJECTS the
        // `mode` argument at runtime — the hardcoded mode here 500'd every search on the
        // default SQLite deployment (legacy-main leftover; the app no longer "runs on Postgres").
        if (q) where.OR = [{ name: ciContains(q) }, { series: { name: ciContains(q) } }];

        const rows = await prisma.issue.findMany({
            where,
            orderBy: [{ releaseDate: sort }, { id: sort }],
            take: limit + 1, // over-fetch one to derive hasMore without a COUNT
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: {
                id: true, number: true, name: true, coverUrl: true, releaseDate: true, filePath: true,
                // Requesting from this view needs what the series page has in hand: the series'
                // provider identity, and the issue's domain (annual / collected) for the composite.
                isAnnual: true,
                seriesId: true,
                attachedVolumeId: true,
                attachedVolume: { select: { kind: true, name: true } },
                series: { select: { name: true, publisher: true, year: true, folderPath: true, metadataId: true, metadataSource: true } }
            }
        });

        const hasMore = rows.length > limit;
        const pageRowsAll = hasMore ? rows.slice(0, limit) : rows;
        const nextCursor = hasMore ? pageRowsAll[pageRowsAll.length - 1]?.id ?? null : null;

        // #203 COLLECTED coverage: a main-run issue nobody has on disk but an OWNED collected book
        // reprints is not missing — it leaves this list (and so "Request all shown") unless the
        // caller asks for it with includeCovered=1, in which case it carries `coveredBy`. Coverage
        // is an expression, so this is a post-filter on the page: a page can come back shorter than
        // `limit`; the cursor still advances past what was fetched.
        const includeCovered = searchParams.get('includeCovered') === '1';
        const coveredBy = new Map<string, { name: string | null; number: string; collectionName: string | null }>();
        const candidateSeries = Array.from(new Set(
            pageRowsAll.filter((i: any) => !i.filePath && !i.attachedVolumeId && !i.isAnnual).map((i: any) => i.seriesId as string)
        ));
        if (candidateSeries.length > 0) {
            const books = await prisma.issue.findMany({
                where: { seriesId: { in: candidateSeries }, filePath: { not: null }, coversIssues: { not: null }, attachedVolume: { kind: 'COLLECTED' } },
                select: { seriesId: true, number: true, name: true, coversIssues: true, attachedVolume: { select: { name: true } } },
            });
            const bySeries = new Map<string, { set: string[]; book: { name: string | null; number: string; collectionName: string | null } }[]>();
            for (const b of books) {
                const set = expandCoverage(b.coversIssues);
                if (set.length === 0) continue;
                if (!bySeries.has(b.seriesId)) bySeries.set(b.seriesId, []);
                bySeries.get(b.seriesId)!.push({ set, book: { name: b.name, number: b.number, collectionName: b.attachedVolume?.name ?? null } });
            }
            for (const i of pageRowsAll as any[]) {
                if (i.filePath || i.attachedVolumeId || i.isAnnual) continue;
                const hit = (bySeries.get(i.seriesId) || []).find(({ set }) => isCovered(i.number, set));
                if (hit) coveredBy.set(i.id, hit.book);
            }
        }
        const pageRows = includeCovered ? pageRowsAll : pageRowsAll.filter((i: any) => !coveredBy.has(i.id));

        const issues = pageRows.map((i: any) => {
            let cover = i.coverUrl;
            if (cover && !cover.startsWith('/api/')) cover = `/api/library/cover?path=${encodeURIComponent(cover)}`;
            // Local-first ingest (discussion #182): a file-backed issue with no provider cover renders
            // its own archive's first page (the route falls back to the series cover internally).
            else if (!cover && i.filePath) cover = `/api/library/cover?issueId=${encodeURIComponent(i.id)}`;
            else if (!cover && i.series?.folderPath) cover = `/api/library/cover?path=${encodeURIComponent(i.series.folderPath)}`;
            const onDisk = !!(i.filePath && i.filePath.trim().length > 0);
            const seriesMetadataId: string | null = i.series?.metadataId ?? null;
            // A request is filed against the series' provider volume, so a missing issue is only
            // requestable when the series is genuinely matched — a placeholder "unmatched_*" id has
            // nothing to search for and would only produce a request that can never resolve.
            const requestable = !onDisk && !!seriesMetadataId && !seriesMetadataId.startsWith('unmatched_');
            return {
                id: i.id,
                number: i.number,
                name: i.name,
                cover,
                releaseDate: i.releaseDate,
                onDisk,
                seriesName: i.series?.name || 'Unknown Series',
                seriesPath: i.series?.folderPath || null,
                publisher: i.series?.publisher || 'Unknown',
                year: i.series?.year ?? null,
                isAnnual: !!i.isAnnual,
                isCollected: i.attachedVolume?.kind === 'COLLECTED',
                collectionName: i.attachedVolume?.kind === 'COLLECTED' ? (i.attachedVolume?.name ?? null) : null,
                // #255: a Special is requested under its own volume's name, never as the run's "#N".
                isSpecial: i.attachedVolume?.kind === 'SPECIAL',
                specialName: i.attachedVolume?.kind === 'SPECIAL' ? (i.attachedVolume?.name ?? null) : null,
                seriesMetadataId,
                metadataSource: i.series?.metadataSource || 'COMICVINE',
                requestable,
                // Only present when includeCovered=1 kept a covered issue on the page.
                ...(coveredBy.has(i.id) ? { coveredBy: coveredBy.get(i.id) } : {})
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
