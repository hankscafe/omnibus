// src/app/api/admin/match-prefill/route.ts
//
// #199 round 4 (Beta A): the Smart Matcher's "local evidence" read. Given an unmatched item's
// path, returns everything the library's own files already know — so the dialog pre-fills
// file-first and the id-assist can jump straight to an exact provider lookup.
//   - loose file → its ComicInfo.xml, read on demand (the awaiting-match dir is never scanned;
//     ZIP-family only — a CBR's ComicInfo becomes readable after conversion, same as the scanner)
//   - folder    → the scan-banked Series row (already file-first: unmatched series have never met
//     a provider) + a FRESH series.json read, so a sidecar edited after the last scan counts NOW
// Read-only by design: nothing here writes, locks, or matches — the admin's Accept still decides.
import { NextResponse } from 'next/server';
import fs from 'fs-extra';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { parseComicInfo } from '@/lib/metadata-extractor';
import { UNMATCHED_DIR, isPathWithinRoots } from '@/lib/utils/paths';
import { comicInfoPrefill, folderPrefill, readSeriesJson, prefillHasContent } from '@/lib/utils/match-prefill';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const { searchParams } = new URL(request.url);
        const target = searchParams.get('path');
        if (!target) return NextResponse.json({ error: 'Missing path' }, { status: 400 });

        // Same path discipline as every file-serving endpoint: matcher items only ever live in a
        // library root or the awaiting-match dir — anything else is not ours to read.
        const libraries = await prisma.library.findMany({ select: { path: true } });
        const roots = [...libraries.map(l => (l as any).path).filter(Boolean), UNMATCHED_DIR];
        if (!isPathWithinRoots(target, roots)) {
            return NextResponse.json({ error: 'Path is outside the library roots' }, { status: 400 });
        }

        let stat;
        try { stat = await fs.promises.stat(target); }
        catch { return NextResponse.json({ error: 'Not found' }, { status: 404 }); }

        if (stat.isFile()) {
            const ci = await parseComicInfo(target);
            const prefill = ci ? comicInfoPrefill(ci) : null;
            return NextResponse.json({ hasContent: prefillHasContent(prefill), prefill });
        }

        const [row, sj] = await Promise.all([
            prisma.series.findFirst({ where: { folderPath: target } }),
            readSeriesJson(target),
        ]);
        const prefill = folderPrefill(row, sj);
        return NextResponse.json({ hasContent: prefillHasContent(prefill), prefill });
    } catch (error: unknown) {
        Logger.log(`[Match Prefill API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
