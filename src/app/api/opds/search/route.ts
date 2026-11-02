// src/app/api/opds/search/route.ts
//
// The search feed (#221 point 1), the target of the OpenSearch template the root advertises.
// Matching series come first as navigation entries, then matching issues as acquisition entries.
import { validateApiKey } from '@/lib/api-auth';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { getAccessibleLibraryIds } from '@/lib/library-access';
import { getPublicBaseUrl } from '@/lib/opds-base-url';
import { atomFeed, feedContentType, feedUpdated, issueEntry, searchLink, seriesEntry } from '@/lib/opds-feed';
import { opdsFlavourFor } from '@/lib/opds-flavour';
import { searchIssueRows, searchSeriesRows, issuesInReadingOrder } from '@/lib/opds-search';
import { progressByIssueId } from '@/lib/opds-progress';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    try {
        const auth = await validateApiKey(req);
        if (!auth.valid || !auth.user) {
            return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Omnibus OPDS"' } });
        }

        const url = new URL(req.url);
        const baseUrl = getPublicBaseUrl(req);
        const flavour = opdsFlavourFor(req);
        const terms = (url.searchParams.get('q') || '').trim();

        let seriesEntries = '';
        let issueEntries = '';
        let stamps: Array<Date | null> = [];

        // An empty search is an empty feed, not an error: clients probe the template before the user
        // has typed anything.
        if (terms) {
            const libs = await getAccessibleLibraryIds(auth.user.id, auth.user.role);
            const [series, matchedIssues] = await Promise.all([
                searchSeriesRows(libs, terms),
                searchIssueRows(libs, terms),
            ]);
            // Reading order, and the caller's own position in each result — the same two things the
            // other issue feeds carry.
            const issues = issuesInReadingOrder(matchedIssues);
            const progress = await progressByIssueId(auth.user.id, issues.map((i) => i.id));
            seriesEntries = series.map((s) => seriesEntry(baseUrl, s, flavour)).join('');
            issueEntries = issues
                .map((i) => issueEntry(baseUrl, i.series, i, {
                    pageCount: i.pageCount ?? 0,
                    progress: progress.get(i.id) ?? null,
                    flavour,
                }))
                .join('');
            stamps = [...series.map((s) => s.updatedAt), ...issues.map((i) => i.updatedAt)];
        }

        const navType = 'application/atom+xml;profile=opds-catalog;kind=navigation';
        const acqType = 'application/atom+xml;profile=opds-catalog;kind=acquisition';
        const xml = atomFeed({
            id: 'urn:omnibus:search',
            title: terms ? `Search: ${terms}` : 'Search',
            updated: feedUpdated(stamps),
            links: [
                `<link rel="self" href="${baseUrl}${flavour.base}/search?q=${encodeURIComponent(terms)}" type="${acqType}"/>`,
                `<link rel="start" href="${baseUrl}${flavour.root}" type="${navType}"/>`,
                `<link rel="up" href="${baseUrl}${flavour.root}" type="${navType}"/>`,
                searchLink(baseUrl, flavour),
            ].join('\n  '),
            entries: seriesEntries + issueEntries,
            namespaces: ' xmlns:pse="http://vaemendis.net/opds-pse/ns" xmlns:dc="http://purl.org/dc/elements/1.1/"',
            flavour,
        });

        return new Response(xml, { headers: { 'Content-Type': feedContentType('acquisition') } });
    } catch (error: unknown) {
        Logger.log(`[OPDS Search API] Error: ${getErrorMessage(error)}`, 'error');
        return new Response('Internal Server Error', { status: 500 });
    }
}
