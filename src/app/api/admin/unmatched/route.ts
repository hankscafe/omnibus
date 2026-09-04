// src/app/api/admin/unmatched/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { COMIC_EXT_REGEX } from '@/lib/utils/formats';
import { UNMATCHED_DIR } from '@/lib/utils/paths';
import { AuditLogger } from '@/lib/audit-logger';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        // An IGNORED series is one an admin has curated by hand and told us to stop offering — the
        // provider may have no record of it at all (hand-made TPB collections are the common case).
        // It stays out of this list, and therefore out of the front-page banner's count, until the
        // admin asks to see ignored entries (the restore path).
        const includeIgnored = new URL(request.url).searchParams.get('includeIgnored') === '1';

        // 1. Get Unmatched DB Records
        const unmatched = await prisma.series.findMany({
            where: includeIgnored ? { matchState: { in: ['UNMATCHED', 'IGNORED'] } } : { matchState: 'UNMATCHED' },
            orderBy: { name: 'asc' }
        });

        // 2. Append loose files from the unmatched drop directory
        const unmatchedDir = UNMATCHED_DIR;
        const rawFiles: any[] = [];
        
        try {
            const fs = await import('fs-extra');
            const path = await import('path');
            if (fs.existsSync(unmatchedDir)) {
                const files = await fs.promises.readdir(unmatchedDir);
                for (const file of files) {
                    if (COMIC_EXT_REGEX.test(file)) {
                        rawFiles.push({
                            id: `raw_${Buffer.from(file).toString('base64')}`, // Safe Mock ID
                            name: file.replace(/\.[^/.]+$/, ""), // Strip extension for search guessing
                            folderPath: path.join(unmatchedDir, file),
                            isRawFile: true
                        });
                    }
                }
            }
        } catch (e) {}

        const flagged = unmatched.map(s => ({ ...s, isIgnored: s.matchState === 'IGNORED' }));
        return NextResponse.json([...flagged, ...rawFiles]);
    } catch (error: unknown) {
        Logger.log(`[Unmatched API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

/**
 * Mark unmatchable series as ignored, or restore them to the list.
 *
 * Deliberately NOT overloaded onto hasCustomMetadata: locking a series' metadata and giving up on
 * matching it are different intentions, and a user who curates fields on a series they still want
 * matched would otherwise lose it from the queue silently. The source-state guard in each update
 * means a mistyped id can never turn a MATCHED series into an ignored one.
 */
export async function PATCH(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const body = await request.json().catch(() => ({}));
        const seriesIds: unknown = body?.seriesIds;
        const ignored: boolean = body?.ignored !== false;

        if (!Array.isArray(seriesIds) || seriesIds.length === 0 || seriesIds.some(id => typeof id !== 'string')) {
            return NextResponse.json({ error: 'Missing seriesIds' }, { status: 400 });
        }

        const result = await prisma.series.updateMany({
            where: { id: { in: seriesIds as string[] }, matchState: ignored ? 'UNMATCHED' : 'IGNORED' },
            data: { matchState: ignored ? 'IGNORED' : 'UNMATCHED' },
        });

        await AuditLogger.log(ignored ? 'IGNORE_SERIES' : 'UNIGNORE_SERIES', {
            seriesIds, updated: result.count,
        }, (session.user as any).id);

        Logger.log(`[Unmatched API] ${ignored ? 'Ignored' : 'Restored'} ${result.count} series.`, 'info');
        return NextResponse.json({ success: true, updated: result.count });
    } catch (error: unknown) {
        Logger.log(`[Unmatched API] Ignore update failed: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}