// src/app/api/opds/page/[issueId]/[pageIndex]/route.ts
import { prisma } from '@/lib/db';
import { validateApiKey } from '@/lib/api-auth';
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ issueId: string, pageIndex: string }> }) {
    const auth = await validateApiKey(req);
    if (!auth.valid) {
        return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Omnibus OPDS"' } });
    }

    const resolvedParams = await params;
    const issueId = resolvedParams.issueId;
    const pageIndex = parseInt(resolvedParams.pageIndex);

    const issue = await prisma.issue.findUnique({ where: { id: issueId } });
    if (!issue || !issue.filePath || !fs.existsSync(issue.filePath)) {
        return new Response('Not Found', { status: 404 });
    }

    try {
        const zip = new AdmZip(issue.filePath);
        
        // We must sort the exact same way we did in the manifest so the indexes match perfectly
        const pages = zip.getEntries()
            .filter(e => !e.isDirectory && !e.entryName.toLowerCase().includes('__macosx') && e.entryName.match(/\.(jpg|jpeg|png|webp)$/i))
            .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true, sensitivity: 'base' }));

        if (pageIndex < 0 || pageIndex >= pages.length) {
            return new Response('Page Not Found', { status: 404 });
        }

        const pageEntry = pages[pageIndex];
        const buffer = pageEntry.getData();

        const ext = path.extname(pageEntry.entryName).toLowerCase();
        let contentType = 'image/jpeg';
        if (ext === '.png') contentType = 'image/png';
        if (ext === '.webp') contentType = 'image/webp';

        return new Response(buffer, {
            headers: {
                'Content-Type': contentType,
                // Cache heavily since comic pages are immutable
                'Cache-Control': 'public, max-age=86400, immutable'
            }
        });
    } catch (error) {
        return new Response('Error extracting image', { status: 500 });
    }
}