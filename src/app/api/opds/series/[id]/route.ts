// src/app/api/opds/series/[id]/route.ts
import { prisma } from '@/lib/db';
import { validateApiKey } from '@/lib/api-auth';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { getAccessibleLibraryIds, canAccessLibraryId } from '@/lib/library-access';
import { countArchivePages, isPageCountable, countArchivePagesViaEngine, isEngineCountable } from '@/lib/utils/archive-pages';
import { getPublicBaseUrl } from '@/lib/opds-base-url';
import { atomFeed, feedContentType, feedUpdated, issueEntry } from '@/lib/opds-feed';
import { progressByIssueId } from '@/lib/opds-progress';
import { domainRank } from '@/lib/utils/issue-sort';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const auth = await validateApiKey(req);
        if (!auth.valid || !auth.user) {
            return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Omnibus OPDS"' } });
        }

    const baseUrl = getPublicBaseUrl(req);

    const resolvedParams = await params;
    const seriesId = resolvedParams.id;

    const series = await prisma.series.findUnique({
        where: { id: seriesId },
        include: {
            issues: {
                where: { filePath: { not: null } },
                // #255: a Special's title and its place after the run and the annuals.
                include: { attachedVolume: { select: { kind: true, name: true } } },
            }
        }
    });

    if (!series) return new Response('Not Found', { status: 404 });

    // Per-library access: non-admins only see series in libraries they've been granted.
    const accessibleLibs = await getAccessibleLibraryIds(auth.user?.id, auth.user?.role);
    if (!canAccessLibraryId(accessibleLibs, series.libraryId)) {
        return new Response('Forbidden', { status: 403 });
    }

    const sortedIssues = series.issues.sort((a, b) => {
        // #203: annuals shelve AFTER the main run (same order as the series page), then (#255) the
        // Specials, then by number.
        const domain = domainRank({ isAnnual: a.isAnnual, isSpecial: a.attachedVolume?.kind === 'SPECIAL' })
            - domainRank({ isAnnual: b.isAnnual, isSpecial: b.attachedVolume?.kind === 'SPECIAL' });
        if (domain !== 0) return domain;
        // Added the '-' character to the regex to preserve negative numbers
        const numA = parseFloat(a.number.replace(/[^0-9.-]/g, '')) || 0;
        const numB = parseFloat(b.number.replace(/[^0-9.-]/g, '')) || 0;
        return numA - numB;
    });

    // #221: pse:lastRead / pse:lastReadDate, so a page-streaming client resumes where this user
    // stopped — one query for the whole feed rather than one per issue.
    const progress = await progressByIssueId(auth.user.id, sortedIssues.map((i) => i.id));

    const entries = [];
    for (const issue of sortedIssues) {
        // --- MEMORY LEAK FIXED: Pulling directly from DB instead of loading files into RAM ---
        let pageCount = (issue as any).pageCount || 0;
        // Self-heal issues indexed before page counts were persisted: without a real pse:count,
        // OPDS clients (Panels) show "0 pages" and refuse to stream. Zips are counted locally
        // (central directory only — fast); RAR-family goes through the engine's unrar listing
        // (native CBR reading), so unconverted .cbr issues stream too. The result is written back
        // so this runs once per issue.
        if (!pageCount && isPageCountable(issue.filePath)) {
            pageCount = await countArchivePages(issue.filePath);
        } else if (!pageCount && isEngineCountable(issue.filePath)) {
            pageCount = await countArchivePagesViaEngine(issue.filePath);
        }
        if (!((issue as any).pageCount || 0) && pageCount > 0) {
            await prisma.issue.update({ where: { id: issue.id }, data: { pageCount } }).catch(() => {});
        }

        entries.push(issueEntry(baseUrl, series, issue, {
            pageCount,
            progress: progress.get(issue.id) ?? null,
        }));
    }

    const kind = 'application/atom+xml;profile=opds-catalog;kind=navigation';
    const xml = atomFeed({
        id: `urn:omnibus:series:${series.id}`,
        title: series.name,
        updated: feedUpdated(sortedIssues.map(i => i.updatedAt)),
        // A series' own feed is an acquisition feed: its entries are publications.
        links: [
            `<link rel="self" href="${baseUrl}/api/opds/series/${series.id}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>`,
            `<link rel="start" href="${baseUrl}/api/opds" type="${kind}"/>`,
            `<link rel="up" href="${baseUrl}/api/opds/series" type="${kind}"/>`,
        ].join('\n  '),
        entries: entries.join(''),
        namespaces: ' xmlns:pse="http://vaemendis.net/opds-pse/ns" xmlns:dc="http://purl.org/dc/elements/1.1/"',
    });

    return new Response(xml, { headers: { 'Content-Type': feedContentType('acquisition') } });
    } catch (error: unknown) {
        Logger.log(`[OPDS Series Detail API] Error: ${getErrorMessage(error)}`, 'error');
        return new Response('Internal Server Error', { status: 500 });
    }
}
