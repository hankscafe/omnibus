// src/app/api/opds/page/[issueId]/[pageIndex]/route.ts
import { prisma } from '@/lib/db';
import { validateApiKey } from '@/lib/api-auth';
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

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
        Logger.log(`[OPDS Debug] Incoming stream request for Issue [${issueId}], Page Index [${pageIndex}]`, 'debug');
        const zip = new AdmZip(issue.filePath);
        
        // We must sort the exact same way we did in the manifest so the indexes match perfectly
        const pages = zip.getEntries()
            .filter(e => !e.isDirectory && !e.entryName.toLowerCase().includes('__macosx') && e.entryName.match(/\.(jpg|jpeg|png|webp)$/i))
            .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true, sensitivity: 'base' }));

        Logger.log(`[OPDS Debug] Extracted ${pages.length} valid images from archive.`, 'debug');

        if (pageIndex < 0 || pageIndex >= pages.length) {
            Logger.log(`[OPDS Debug] Request REJECTED: Page index ${pageIndex} is out of bounds (Max: ${pages.length - 1})`, 'debug');
            return new Response('Page Not Found', { status: 404 });
        }

        const pageEntry = pages[pageIndex];
        const buffer = pageEntry.getData();

        const ext = path.extname(pageEntry.entryName).toLowerCase();
        let contentType = 'image/jpeg';
        if (ext === '.png') contentType = 'image/png';
        if (ext === '.webp') contentType = 'image/webp';

        Logger.log(`[OPDS Debug] Serving file "${pageEntry.entryName}" as ${contentType} (${Math.round(buffer.length/1024)}KB)`, 'debug');

        // Fix: Cast the Node.js Buffer to BodyInit to satisfy TypeScript
        return new Response(buffer as unknown as BodyInit, {
            headers: {
                'Content-Type': contentType,
                // Cache heavily since comic pages are immutable
                'Cache-Control': 'public, max-age=86400, immutable'
            }
        });
    } catch (error) {
        Logger.log(`[OPDS Page Extract] Error: ${getErrorMessage(error)}`, 'error');
        return new Response('Error extracting image', { status: 500 });
    }
}