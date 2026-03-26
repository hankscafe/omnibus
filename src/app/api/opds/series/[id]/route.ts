// src/app/api/opds/series/[id]/route.ts
import { prisma } from '@/lib/db';
import { validateApiKey } from '@/lib/api-auth';
import AdmZip from 'adm-zip';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const escapeXml = (unsafe: string | null | undefined) => {
    if (!unsafe) return '';
    return unsafe.replace(/[<>&'"]/g, (c) => {
        switch (c) {
            case '<': return '&lt;'; case '>': return '&gt;'; case '&': return '&amp;';
            case '\'': return '&apos;'; case '"': return '&quot;'; default: return c;
        }
    });
};

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

    const sortedIssues = series.issues.sort((a, b) => {
        const numA = parseFloat(a.number.replace(/[^0-9.]/g, '')) || 0;
        const numB = parseFloat(b.number.replace(/[^0-9.]/g, '')) || 0;
        return numA - numB;
    });

    let entries = sortedIssues.map(issue => {
        const rawCover = issue.coverUrl || (series.folderPath ? `/api/library/cover?path=${encodeURIComponent(series.folderPath)}` : '');
        const finalCoverUrl = rawCover.startsWith('http') ? rawCover : (rawCover ? `${baseUrl}${rawCover}` : '');
        
        // OPDS-PSE requires the server to tell the app exactly how many pages exist.
        // AdmZip only reads the tiny directory header at the end of the ZIP, so this is virtually instantaneous.
        let pageCount = 0;
        if (issue.filePath && fs.existsSync(issue.filePath)) {
            try {
                const zip = new AdmZip(issue.filePath);
                pageCount = zip.getEntries().filter(e => !e.isDirectory && !e.entryName.toLowerCase().includes('__macosx') && e.entryName.match(/\.(jpg|jpeg|png|webp)$/i)).length;
            } catch (e) {}
        }
        
        // The Official OPDS-PSE Streaming Link with the URI Template
        const pseLink = `<link rel="http://vaemendis.net/opds-pse/stream" type="image/jpeg" href="${baseUrl}/api/opds/page/${issue.id}/{pageNumber}" pse:count="${pageCount}"/>`;
        
        // Full File Download Link (Only injected if they have permission)
        const downloadLink = canDownload && issue.filePath 
            ? `<link rel="http://opds-spec.org/acquisition" href="${baseUrl}/api/opds/download?issueId=${issue.id}" type="application/vnd.comicbook+zip"/>`
            : '';

        return `
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
  </entry>`;
    }).join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:pse="http://vaemendis.net/opds-pse/ns">
  <id>urn:omnibus:series:${series.id}</id>
  <title>${escapeXml(series.name)}</title>
  <updated>${new Date().toISOString()}</updated>
  <link rel="self" href="${baseUrl}/api/opds/series/${series.id}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="start" href="${baseUrl}/api/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="up" href="${baseUrl}/api/opds/series" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  ${entries}
</feed>`;

    return new Response(xml, { headers: { 'Content-Type': 'application/atom+xml;profile=opds-catalog; charset=utf-8' } });
}