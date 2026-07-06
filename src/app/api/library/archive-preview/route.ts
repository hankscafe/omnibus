// src/app/api/library/archive-preview/route.ts
//
// Admin-only, read-only: full page-by-page preview of a comic archive for the Smart Matcher, so an
// admin can flip through a badly-named download and confirm WHICH issue it actually is before
// matching it (release names are notoriously unreliable). Two modes on one route:
//   ?path=<file-or-folder>&info=1  → JSON { file, pageCount } — a folder resolves to its first
//                                    archive (natural sort); page requests then use that file
//   ?path=<file>&page=<N>          → the Nth (0-based, natural-sorted) page image
//
// Same trust model as archive-cover: admin token + locked to library roots and the unmatched dir
// (re-checked on every request — the client echoing the resolved file back cannot escape them).
// Pages come from the engine's index-mode extractor (resized WebP, the same endpoint the OPDS
// streamer uses) with a local AdmZip fallback. CBR/RAR can't be page-listed (zip-only) — the UI
// falls back to the existing single-page archive-cover for those.
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { getToken } from 'next-auth/jwt';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { isPathWithinRoots, UNMATCHED_DIR } from '@/lib/utils/paths';
import { COMIC_EXT_REGEX, IMAGE_EXT_REGEX } from '@/lib/utils/formats';
import { countArchivePages } from '@/lib/utils/archive-pages';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    const token = await getToken({ req });
    if (!token || token.role !== 'ADMIN') {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const url = new URL(req.url);
    const rawPath = url.searchParams.get('path');
    const infoMode = url.searchParams.get('info') === '1';
    const pageIndex = parseInt(url.searchParams.get('page') || '');

    if (!rawPath || !fs.existsSync(rawPath)) {
        return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    try {
        const libraries = await prisma.library.findMany();
        if (!isPathWithinRoots(rawPath, [...libraries.map(l => l.path), UNMATCHED_DIR])) {
            return NextResponse.json({ error: 'Unauthorized path access' }, { status: 403 });
        }

        // A folder item previews its first archive (natural sort — the same pick as the series cover).
        let filePath = path.resolve(rawPath);
        if (fs.statSync(filePath).isDirectory()) {
            const archives = fs.readdirSync(filePath)
                .filter(f => COMIC_EXT_REGEX.test(f))
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
            if (archives.length === 0) {
                return infoMode
                    ? NextResponse.json({ file: null, pageCount: 0 })
                    : new NextResponse('No archive in folder', { status: 404 });
            }
            filePath = path.join(filePath, archives[0]);
        }

        if (infoMode) {
            // pageCount 0 for a RAR-family file — the client shows the archive-cover fallback then.
            return NextResponse.json({ file: filePath, pageCount: await countArchivePages(filePath) });
        }

        if (!Number.isInteger(pageIndex) || pageIndex < 0) {
            return new NextResponse('Page Not Found', { status: 404 });
        }

        // Engine offload: index-mode extract + resize + WebP encode off the Node event loop.
        try {
            const engineRes = await fetch(ENGINE_URL + '/api/reader/page', {
                method: 'POST',
                headers: engineHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ path: filePath, index: pageIndex, width: 1200, quality: 80 }),
            });
            if (engineRes.ok) {
                const engineBuffer = Buffer.from(await engineRes.arrayBuffer());
                if (engineBuffer.length > 0) {
                    return new NextResponse(engineBuffer as unknown as BodyInit, {
                        headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=300' },
                    });
                }
            }
        } catch (e) {
            Logger.log(`[Archive Preview] Engine offload unavailable, using local extraction: ${getErrorMessage(e)}`, 'debug');
        }

        // Local fallback: identical list/filter/sort to the OPDS page route, serving original bytes.
        const zip = new AdmZip(filePath);
        const pages = zip.getEntries()
            .filter(e => !e.isDirectory && !e.entryName.toLowerCase().includes('__macosx') && IMAGE_EXT_REGEX.test(e.entryName))
            .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true, sensitivity: 'base' }));
        if (pageIndex >= pages.length) return new NextResponse('Page Not Found', { status: 404 });

        const buffer = pages[pageIndex].getData();
        const ext = path.extname(pages[pageIndex].entryName).toLowerCase();
        const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
        return new NextResponse(buffer as unknown as BodyInit, {
            headers: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=300' },
        });
    } catch (error: unknown) {
        Logger.log(`[Archive Preview] Failed for ${rawPath}: ${getErrorMessage(error)}`, 'warn');
        return new NextResponse('Failed to read archive', { status: 500 });
    }
}
