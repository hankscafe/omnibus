// src/app/api/opds/series/[id]/route.ts
import { prisma } from '@/lib/db';
import { validateApiKey } from '@/lib/api-auth';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { escapeXml } from '@/lib/utils/xml';
import { getAccessibleLibraryIds, canAccessLibraryId } from '@/lib/library-access';
import { countArchivePages, isPageCountable } from '@/lib/utils/archive-pages';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const auth = await validateApiKey(req);
        if (!auth.valid || !auth.user) {
            return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Omnibus OPDS"' } });
        }

    const url = new URL(req.url);
    const baseUrl = url.origin;
    
    const resolvedParams = await params;
    const seriesId = resolvedParams.id;

    // Check user permissions
    const canDownload = auth.user.role === 'ADMIN' || auth.user.canDownload === true;

    const series = await prisma.series.findUnique({
        where: { id: seriesId },
        include: {
            issues: {
                where: { filePath: { not: null } }
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
        // Added the '-' character to the regex to preserve negative numbers
        const numA = parseFloat(a.number.replace(/[^0-9.-]/g, '')) || 0;
        const numB = parseFloat(b.number.replace(/[^0-9.-]/g, '')) || 0;
        return numA - numB;
    });

    const entries = [];
    for (const issue of sortedIssues) {
        const rawCover = issue.coverUrl || (series.folderPath ? `/api/library/cover?path=${encodeURIComponent(series.folderPath)}` : '');
        const finalCoverUrl = rawCover.startsWith('http') ? rawCover : (rawCover ? `${baseUrl}${rawCover}` : '');

        // --- MEMORY LEAK FIXED: Pulling directly from DB instead of loading files into RAM ---
        let pageCount = (issue as any).pageCount || 0;
        // Self-heal issues indexed before page counts were persisted: without a real pse:count,
        // OPDS clients (Panels) show "0 pages" and refuse to stream. countArchivePages reads only
        // the zip central directory, so healing a whole series inline stays fast; the result is
        // written back so this runs once per issue.
        if (!pageCount && isPageCountable(issue.filePath)) {
            pageCount = await countArchivePages(issue.filePath);
            if (pageCount > 0) {
                await prisma.issue.update({ where: { id: issue.id }, data: { pageCount } }).catch(() => {});
            }
        }

        // The Official OPDS-PSE Streaming Link with the URI Template
        const pseLink = `<link rel="http://vaemendis.net/opds-pse/stream" type="image/jpeg" href="${baseUrl}/api/opds/page/${issue.id}/{pageNumber}" pse:count="${pageCount}"/>`;
        
        // Full File Download Link (Only injected if they have permission)
        const downloadLink = canDownload && issue.filePath 
            ? `<link rel="http://opds-spec.org/acquisition" href="${baseUrl}/api/opds/download?issueId=${issue.id}" type="application/vnd.comicbook+zip"/>`
            : '';

        entries.push(`
  <entry>
    <title>${escapeXml(issue.name || `${series.name} #${issue.number}`)}</title>
    <id>urn:omnibus:issue:${issue.id}</id>
    <updated>${new Date().toISOString()}</updated>
    <author><name>${escapeXml(series.publisher || 'Unknown')}</name></author>
    <content type="text">${escapeXml(issue.description || 'No synopsis available.')}</content>
    ${finalCoverUrl ? `<link rel="http://opds-spec.org/image" href="${escapeXml(finalCoverUrl)}" type="image/jpeg"/>` : ''}
    ${finalCoverUrl ? `<link rel="http://opds-spec.org/image/thumbnail" href="${escapeXml(finalCoverUrl)}" type="image/jpeg"/>` : ''}
    ${pseLink}
    ${downloadLink}
  </entry>`);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:pse="http://vaemendis.net/opds-pse/ns">
  <id>urn:omnibus:series:${series.id}</id>
  <title>${escapeXml(series.name)}</title>
  <updated>${new Date().toISOString()}</updated>
  <link rel="self" href="${baseUrl}/api/opds/series/${series.id}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="start" href="${baseUrl}/api/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="up" href="${baseUrl}/api/opds/series" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  ${entries.join('')}
</feed>`;

    return new Response(xml, { headers: { 'Content-Type': 'application/atom+xml;profile=opds-catalog; charset=utf-8' } });
    } catch (error: unknown) {
        Logger.log(`[OPDS Series Detail API] Error: ${getErrorMessage(error)}`, 'error');
        return new Response('Internal Server Error', { status: 500 });
    }
}