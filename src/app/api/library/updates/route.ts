// src/app/api/library/updates/route.ts
//
// The Updates feed (Beta B of the follow model): recent ARRIVALS — file-backed issues, newest
// first — in series the CURRENT USER follows. Following-only by design (Adam's call 2026-07-31):
// the whole-library arrivals view is the home page's Recently Added shelf; this feed is strictly
// the per-user subscription slice. Bounded to a 30-day window and a hard cap rather than OFFSET
// pagination — and the orderBy carries the id tiebreaker regardless (v1.4.1 total-order rule).
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getAccessibleLibraryIds } from '@/lib/library-access';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

const WINDOW_DAYS = 30;
const MAX_ITEMS = 500;

export async function GET() {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const accessibleLibs = await getAccessibleLibraryIds(userId, (session?.user as any)?.role);
    const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const issues = await prisma.issue.findMany({
        where: {
            filePath: { not: null },
            createdAt: { gte: cutoff },
            series: {
                follows: { some: { userId } },
                ...(accessibleLibs === 'ALL' ? {} : { libraryId: { in: accessibleLibs } }),
            },
        },
        include: { series: { select: { id: true, name: true, folderPath: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_ITEMS,
    });

    const readRows = issues.length > 0 ? await prisma.readProgress.findMany({
        where: { userId, issueId: { in: issues.map(i => i.id) } },
        select: { issueId: true, isCompleted: true },
    }) : [];
    const readByIssue = new Map(readRows.map(r => [r.issueId, r.isCompleted]));

    const items = issues.map(i => {
        // Cover precedence mirrors the issues-browse route: provider art → the issue's own
        // first-page render (file-backed) → the series folder cover.
        let cover = i.coverUrl;
        if (cover && !cover.startsWith('/api/')) cover = `/api/library/cover?path=${encodeURIComponent(cover)}`;
        else if (!cover && i.filePath) cover = `/api/library/cover?issueId=${encodeURIComponent(i.id)}`;
        else if (!cover && i.series?.folderPath) cover = `/api/library/cover?path=${encodeURIComponent(i.series.folderPath)}`;

        return {
            id: i.id,
            seriesId: i.series?.id || '',
            seriesName: i.series?.name || 'Unknown Series',
            seriesPath: i.series?.folderPath || '',
            number: i.number,
            name: i.name || null,
            filePath: i.filePath,
            coverUrl: cover,
            createdAt: i.createdAt,
            isRead: readByIssue.get(i.id) === true,
        };
    });

    return NextResponse.json({ items, windowDays: WINDOW_DAYS, capped: issues.length === MAX_ITEMS });
  } catch (error: unknown) {
    Logger.log(`[Updates API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
