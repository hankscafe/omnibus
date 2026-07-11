// src/app/api/opds/page/[issueId]/[pageIndex]/route.ts
import { prisma } from '@/lib/db';
import { validateApiKey } from '@/lib/api-auth';
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { IMAGE_EXT_REGEX } from '@/lib/utils/formats';
import { getAccessibleLibraryIds, canAccessLibraryId } from '@/lib/library-access';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ issueId: string, pageIndex: string }> }) {
    const auth = await validateApiKey(req);
    if (!auth.valid) {
        return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Omnibus OPDS"' } });
    }

    const resolvedParams = await params;
    const issueId = resolvedParams.issueId;
    const pageIndex = parseInt(resolvedParams.pageIndex);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        return new Response('Page Not Found', { status: 404 });
    }

    const issue = await prisma.issue.findUnique({ where: { id: issueId }, include: { series: { select: { libraryId: true } } } });
    if (!issue || !issue.filePath || !fs.existsSync(issue.filePath)) {
        return new Response('Not Found', { status: 404 });
    }

    // Per-library access: the issue's series must be in a library the user has been granted (admins bypass).
    const accessibleLibs = await getAccessibleLibraryIds(auth.user?.id, auth.user?.role);
    if (!canAccessLibraryId(accessibleLibs, issue.series?.libraryId)) {
        return new Response('Forbidden', { status: 403 });
    }

    // --- ENGINE OFFLOAD ---
    // Hand list + sort + extract + resize + WebP encode to the Rust engine (index mode of the same
    // endpoint the web reader uses), keeping the whole-archive AdmZip buffer off the Node event loop.
    // The engine natural-sorts with the same filter as the local path below, so page indexes line up.
    // Output becomes resized WebP instead of the original bytes — PSE clients negotiate off
    // Content-Type, and 1600px WebP is what the web reader already serves. Any engine failure
    // (down, older binary, unreadable page) falls through to the local extraction path.
    try {
        const engineRes = await fetch(ENGINE_URL + '/api/reader/page', {
            method: 'POST',
            headers: engineHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ path: issue.filePath, index: pageIndex, width: 1600, quality: 80 }),
        });
        if (engineRes.ok) {
            const engineBuffer = Buffer.from(await engineRes.arrayBuffer());
            if (engineBuffer.length > 0) {
                Logger.log(`[OPDS Debug] Served page ${pageIndex} of Issue [${issueId}] via engine (${Math.round(engineBuffer.length / 1024)}KB webp)`, 'debug');
                return new Response(engineBuffer as unknown as BodyInit, {
                    headers: {
                        'Content-Type': 'image/webp',
                        'Cache-Control': 'public, max-age=86400, immutable'
                    }
                });
            }
        }
        // Non-OK (including an engine 404 for out-of-bounds) → let the local path decide.
    } catch (e) {
        Logger.log(`[OPDS Page] Engine offload unavailable, using local extraction: ${getErrorMessage(e)}`, 'debug');
    }

    // The engine handles RAR natively (that's how a RAR issue gets a non-zero pse:count at all);
    // AdmZip below can't open one, so don't let a RAR fall through to a misleading extract error.
    if (/\.(cbr|rar)$/i.test(issue.filePath)) {
        return new Response('RAR page extraction requires the engine.', { status: 502 });
    }

    try {
        Logger.log(`[OPDS Debug] Incoming stream request for Issue [${issueId}], Page Index [${pageIndex}]`, 'debug');
        const zip = new AdmZip(issue.filePath);
        
        // We must sort the exact same way we did in the manifest so the indexes match perfectly
        const pages = zip.getEntries()
            .filter(e => !e.isDirectory && !e.entryName.toLowerCase().includes('__macosx') && IMAGE_EXT_REGEX.test(e.entryName))
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