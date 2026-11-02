// src/app/api/opds/series/route.ts
import { prisma } from '@/lib/db';
import { validateApiKey } from '@/lib/api-auth';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { getAccessibleLibraryIds, canAccessLibraryId, seriesAccessWhere } from '@/lib/library-access';
import { getPublicBaseUrl } from '@/lib/opds-base-url';
import { escapeXml } from '@/lib/utils/xml';
import { atomFeed, feedContentType, feedUpdated, seriesEntry } from '@/lib/opds-feed';
import { opdsFlavourFor } from '@/lib/opds-flavour';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    try {
        const auth = await validateApiKey(req);
        if (!auth.valid) {
            return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Omnibus OPDS"' } });
        }

    const url = new URL(req.url);
    const baseUrl = getPublicBaseUrl(req);
    const flavour = opdsFlavourFor(req);
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = 50;
    const skip = (page - 1) * limit;

    // Fetch Series with Pagination (per-library access: non-admins only see granted libraries).
    // `?library=<id>` — what a root "Libraries" entry links to — narrows it further, but as a clause
    // ANDed inside the grants, so it can only ever narrow what the caller may already see.
    const accessibleLibs = await getAccessibleLibraryIds(auth.user?.id, auth.user?.role);
    const libraryId = url.searchParams.get('library');
    // A single library's list is titled with the library's own name (#221): "All Series" is what the
    // whole catalog says. The name is only read for a library the caller may already see — the id
    // comes from the request, and an inaccessible one must not leak its name back.
    const library = libraryId && canAccessLibraryId(accessibleLibs, libraryId)
        ? await prisma.library.findUnique({ where: { id: libraryId }, select: { name: true } })
        : null;
    const seriesList = await prisma.series.findMany({
        where: libraryId
            ? { AND: [seriesAccessWhere(accessibleLibs), { libraryId }] }
            : seriesAccessWhere(accessibleLibs),
        skip,
        take: limit + 1,
        // `id` tiebreaker (v1.4.1): OFFSET pagination needs a total order — on PostgreSQL, bare
        // name-sorted pages could overlap/gap on exact-name ties, duplicating or dropping series
        // across OPDS catalog pages (same defect as the library browse fix). `year` secondary
        // (#201): same-name volumes read oldest-first instead of creation-order, matching the
        // library browse.
        orderBy: [{ name: 'asc' }, { year: 'asc' }, { id: 'asc' }]
    });

    const hasNext = seriesList.length > limit;
    const items = hasNext ? seriesList.slice(0, limit) : seriesList;

    const entries = items.map(s => seriesEntry(baseUrl, s, flavour)).join('');

    const scope = libraryId ? `library=${encodeURIComponent(libraryId)}` : '';
    const pageHref = (p: number) => `${baseUrl}${flavour.base}/series?page=${p}${scope ? `&${scope}` : ''}`;
    const kind = 'application/atom+xml;profile=opds-catalog;kind=navigation';
    const links = [
        `<link rel="self" href="${escapeXml(pageHref(page))}" type="${kind}"/>`,
        `<link rel="start" href="${baseUrl}${flavour.root}" type="${kind}"/>`,
        `<link rel="up" href="${baseUrl}${flavour.root}" type="${kind}"/>`,
        hasNext ? `<link rel="next" href="${escapeXml(pageHref(page + 1))}" type="${kind}"/>` : '',
        page > 1 ? `<link rel="previous" href="${escapeXml(pageHref(page - 1))}" type="${kind}"/>` : '',
    ].filter(Boolean).join('\n  ');

    const xml = atomFeed({
        // A single library's list is its own feed, not page 1 of the whole catalog.
        id: libraryId ? `urn:omnibus:series:library:${escapeXml(libraryId)}` : 'urn:omnibus:series',
        title: library?.name ?? 'All Series',
        updated: feedUpdated(items.map(s => s.updatedAt)),
        links,
        entries,
        namespaces: ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
        flavour,
    });

    return new Response(xml, { headers: { 'Content-Type': feedContentType('navigation') } });
    } catch (error: unknown) {
        Logger.log(`[OPDS Series API] Error: ${getErrorMessage(error)}`, 'error');
        return new Response('Internal Server Error', { status: 500 });
    }
}
