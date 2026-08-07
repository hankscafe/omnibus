// src/app/api/opds/series/route.ts
import { prisma } from '@/lib/db';
import { validateApiKey } from '@/lib/api-auth';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { escapeXml } from '@/lib/utils/xml';
import { getAccessibleLibraryIds, seriesAccessWhere } from '@/lib/library-access';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    try {
        const auth = await validateApiKey(req);
        if (!auth.valid) {
            return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Omnibus OPDS"' } });
        }

    const url = new URL(req.url);
    const baseUrl = url.origin;
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = 50;
    const skip = (page - 1) * limit;

    // Fetch Series with Pagination (per-library access: non-admins only see granted libraries)
    const accessibleLibs = await getAccessibleLibraryIds(auth.user?.id, auth.user?.role);
    const seriesList = await prisma.series.findMany({
        where: seriesAccessWhere(accessibleLibs),
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

    const entries = items.map(s => {
        const rawCover = s.coverUrl || (s.folderPath ? `/api/library/cover?path=${encodeURIComponent(s.folderPath)}` : '');
        // FIX: Check if it's already an external HTTP link
        const finalCoverUrl = rawCover.startsWith('http') ? rawCover : (rawCover ? `${baseUrl}${rawCover}` : '');

        return `
  <entry>
    <title>${escapeXml(s.name)}</title>
    <id>urn:omnibus:series:${s.id}</id>
    <updated>${new Date().toISOString()}</updated>
    <author><name>${escapeXml(s.publisher || 'Unknown')}</name></author>
    <content type="text">${escapeXml(s.description || 'No description available.')}</content>
    ${finalCoverUrl ? `<link rel="http://opds-spec.org/image" href="${escapeXml(finalCoverUrl)}" type="image/jpeg"/>` : ''}
    ${finalCoverUrl ? `<link rel="http://opds-spec.org/image/thumbnail" href="${escapeXml(finalCoverUrl)}" type="image/jpeg"/>` : ''}
    <link rel="subsection" href="${baseUrl}/api/opds/series/${s.id}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  </entry>`;
    }).join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:omnibus:series</id>
  <title>All Series</title>
  <updated>${new Date().toISOString()}</updated>
  <link rel="self" href="${baseUrl}/api/opds/series?page=${page}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="start" href="${baseUrl}/api/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="up" href="${baseUrl}/api/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  ${hasNext ? `<link rel="next" href="${baseUrl}/api/opds/series?page=${page + 1}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>` : ''}
  ${page > 1 ? `<link rel="previous" href="${baseUrl}/api/opds/series?page=${page - 1}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>` : ''}
  ${entries}
</feed>`;

    return new Response(xml, { headers: { 'Content-Type': 'application/atom+xml;profile=opds-catalog; charset=utf-8' } });
    } catch (error: unknown) {
        Logger.log(`[OPDS Series API] Error: ${getErrorMessage(error)}`, 'error');
        return new Response('Internal Server Error', { status: 500 });
    }
}