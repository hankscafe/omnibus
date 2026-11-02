// src/app/api/opds/sections/[name]/route.ts
//
// The catalog root's sections (#221 point 2): continue | recent | ondeck | libraries. Each answers
// its own feed, which is what the root's entries link to.
import { validateApiKey } from '@/lib/api-auth';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { getAccessibleLibraryIds } from '@/lib/library-access';
import { getPublicBaseUrl } from '@/lib/opds-base-url';
import { atomFeed, feedContentType, feedUpdated } from '@/lib/opds-feed';
import { opdsFlavourFor } from '@/lib/opds-flavour';
import { isSectionName, loadIssueSection, loadLibrariesSection, loadRecentSection } from '@/lib/opds-sections';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
    try {
        const auth = await validateApiKey(req);
        if (!auth.valid || !auth.user) {
            return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Omnibus OPDS"' } });
        }

        const { name } = await params;
        if (!isSectionName(name)) return new Response('Not Found', { status: 404 });

        const baseUrl = getPublicBaseUrl(req);
        const flavour = opdsFlavourFor(req);
        const libs = await getAccessibleLibraryIds(auth.user.id, auth.user.role);
        const section = name === 'libraries'
            ? await loadLibrariesSection(libs, baseUrl, flavour)
            : name === 'recent'
                ? await loadRecentSection(auth.user.id, libs, baseUrl, flavour)
                : await loadIssueSection(name, auth.user.id, libs, baseUrl, flavour);

        const navType = 'application/atom+xml;profile=opds-catalog;kind=navigation';
        const acqType = 'application/atom+xml;profile=opds-catalog;kind=acquisition';
        const xml = atomFeed({
            id: section.id,
            title: section.title,
            updated: feedUpdated(section.stamps),
            links: [
                `<link rel="self" href="${baseUrl}${flavour.base}/sections/${name}" type="${section.kind === 'navigation' ? navType : acqType}"/>`,
                `<link rel="start" href="${baseUrl}${flavour.root}" type="${navType}"/>`,
                `<link rel="up" href="${baseUrl}${flavour.root}" type="${navType}"/>`,
            ].join('\n  '),
            entries: section.entries,
            namespaces: ' xmlns:pse="http://vaemendis.net/opds-pse/ns" xmlns:dc="http://purl.org/dc/elements/1.1/"',
            flavour,
        });

        return new Response(xml, { headers: { 'Content-Type': feedContentType(section.kind) } });
    } catch (error: unknown) {
        Logger.log(`[OPDS Section API] Error: ${getErrorMessage(error)}`, 'error');
        return new Response('Internal Server Error', { status: 500 });
    }
}
