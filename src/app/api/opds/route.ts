import { prisma } from '@/lib/db';
import { validateApiKey } from '@/lib/api-auth';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getPublicBaseUrl } from '@/lib/opds-base-url';
import { escapeXml } from '@/lib/utils/xml';
import { getAccessibleLibraryIds, seriesAccessWhere } from '@/lib/library-access';
import { feedContentType, feedUpdated, searchLink } from '@/lib/opds-feed';
import { opdsFlavourFor } from '@/lib/opds-flavour';

export const dynamic = 'force-dynamic';

/** One of the root's entries: a route a client can browse into. */
function navEntry(
    title: string,
    id: string,
    content: string,
    href: string,
    updated: string,
    kind: 'navigation' | 'acquisition' = 'navigation',
): string {
    return `
  <entry>
    <title>${escapeXml(title)}</title>
    <id>${id}</id>
    <updated>${updated}</updated>
    <content type="text">${escapeXml(content)}</content>
    <link rel="subsection" href="${href}" type="application/atom+xml;profile=opds-catalog;kind=${kind}"/>
  </entry>`;
}

export async function GET(req: Request) {
    try {
        const auth = await validateApiKey(req);
        if (!auth.valid) {
            return new Response('Unauthorized', { 
                status: 401, 
                headers: { 'WWW-Authenticate': 'Basic realm="Omnibus OPDS"' } 
            });
        }

        const baseUrl = getPublicBaseUrl(req);
        // #262: the same catalog at /komga/opds/v1.2/catalog, shaped like Komga's.
        const flavour = opdsFlavourFor(req);
        const feeds = `${baseUrl}${flavour.base}`;

        // #218: the feed's <updated> is a real, stable timestamp rather than "now" — the newest series
        // the caller may see (which is what the "All Series" entry leads to). A client can then tell
        // whether the catalog changed; `new Date()` moved on every request and told it nothing.
        const accessibleLibs = await getAccessibleLibraryIds(auth.user?.id, auth.user?.role);
        const [newestSeries, libraryCount] = await Promise.all([
            prisma.series.findFirst({
                where: seriesAccessWhere(accessibleLibs),
                orderBy: { updatedAt: 'desc' },
                select: { updatedAt: true },
            }),
            accessibleLibs === 'ALL' ? prisma.library.count() : Promise.resolve(accessibleLibs.length),
        ]);
        const updated = feedUpdated([newestSeries?.updatedAt]);

        // #221 point 2: the sections a client puts on its home screen, next to "All Series". Continue
        // Reading, Recently Added and On Deck lead to *acquisition* feeds — their entries are
        // publications — so their subsection link says `kind=acquisition`; Libraries is another
        // navigation feed. "Libraries" is only worth showing when there is more than one to choose
        // between.
        const entries = [
            navEntry('All Series', 'urn:omnibus:series:all', 'Browse all comic and manga series in your library.', `${feeds}/series`, updated),
            navEntry('Continue Reading', 'urn:omnibus:continue', 'Pick up where you left off.', `${feeds}/sections/continue`, updated, 'acquisition'),
            navEntry('Recently Added', 'urn:omnibus:recent', 'The newest arrivals in your library.', `${feeds}/sections/recent`, updated, 'acquisition'),
            navEntry('On Deck', 'urn:omnibus:ondeck', 'The next issue after the one you finished.', `${feeds}/sections/ondeck`, updated, 'acquisition'),
            libraryCount > 1
                ? navEntry('Libraries', 'urn:omnibus:libraries', 'Browse one library at a time.', `${feeds}/sections/libraries`, updated)
                : '',
        ].join('');

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>${flavour.rootId}</id>
  <title>Omnibus Catalog</title>
  <updated>${updated}</updated>
  ${flavour.author}
  <link rel="self" href="${baseUrl}${flavour.root}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="start" href="${baseUrl}${flavour.root}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  ${searchLink(baseUrl, flavour)}
  ${entries}
</feed>`;

        return new Response(xml, {
            headers: { 'Content-Type': feedContentType('navigation') }
        });
    } catch (error: unknown) {
        Logger.log(`[OPDS Root API] Error: ${getErrorMessage(error)}`, 'error');
        return new Response('Internal Server Error', { status: 500 });
    }
}
