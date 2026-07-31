import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getAccessibleLibraryIds } from '@/lib/library-access';
import { isReleasedYet } from '@/lib/utils';

export const dynamic = 'force-dynamic';

// UNRELEASED -> RELEASED -> IN_LIBRARY as the date passes and the file lands.
// IMPORTED/COMPLETED covers rows imported before filePath was consistently backfilled.
function libraryState(issue: { releaseDate: string | null; filePath: string | null; status: string | null }) {
    if (issue.filePath || issue.status === 'IMPORTED' || issue.status === 'COMPLETED') return 'IN_LIBRARY';
    return isReleasedYet(issue.releaseDate, null) ? 'RELEASED' : 'UNRELEASED';
}

export async function GET(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // Per-library access: non-admins only see calendar entries from libraries they've been granted.
        const userId = (session.user as any).id;
        const accessibleLibs = await getAccessibleLibraryIds(userId, (session.user as any).role);
        const seriesAccess = accessibleLibs !== 'ALL' ? { libraryId: { in: accessibleLibs } } : {};

        const { searchParams } = new URL(request.url);
        const weekOffsetParam = searchParams.get('weekOffset');

        // scope=followed → the personal "My Pull List": releases in series the CURRENT USER follows
        // (regardless of the global monitored flag). Default stays the tracked view (monitored
        // series), so dashboards/widgets and the existing tab are byte-compatible. Note the honest
        // semantic: a followed-but-unmonitored series shows the future issues its last metadata
        // sync knew about; monitored series stay fresher via SERIES_MONITOR.
        const seriesScope = searchParams.get('scope') === 'followed'
            ? { follows: { some: { userId } } }
            : { monitored: true };

        // --- BACKWARDS COMPATIBILITY MODE (For Dashboards/Widgets) ---
        if (weekOffsetParam === null) {
            const today = new Date().toISOString().split('T')[0];
            const upcoming = await prisma.issue.findMany({
                where: { releaseDate: { gte: today }, series: seriesScope },
                include: { series: { select: { name: true, folderPath: true, coverUrl: true, publisher: true } } },
                orderBy: { releaseDate: 'asc' },
                take: 200
            });

            const formatted = upcoming.map((issue: any) => {
                const rawCover = issue.coverUrl || issue.series?.coverUrl;
                let safeCover = rawCover;
                if (rawCover && !rawCover.startsWith('http') && !rawCover.startsWith('/')) {
                    safeCover = `/api/library/cover?path=${encodeURIComponent(rawCover)}`;
                }
                return {
                    id: issue.id, seriesId: issue.seriesId, seriesName: issue.series?.name || "Unknown Series",
                    issueNumber: issue.number, issueName: issue.name, publisher: issue.series?.publisher || "Unknown",
                    releaseDate: issue.releaseDate, coverUrl: safeCover, seriesPath: issue.series?.folderPath
                };
            });
            return NextResponse.json(formatted);
        }

        // --- FIX: Align week to strictly Sunday -> Saturday ---
        const weekOffset = parseInt(weekOffsetParam, 10);
        const todayObj = new Date();
        const currentDayOfWeek = todayObj.getUTCDay(); 
        
        const start = new Date(Date.UTC(todayObj.getUTCFullYear(), todayObj.getUTCMonth(), todayObj.getUTCDate()));
        start.setUTCDate(start.getUTCDate() - currentDayOfWeek + (weekOffset * 7));

        const end = new Date(start);
        end.setUTCDate(start.getUTCDate() + 6); 

        const startDateStr = start.toISOString().split('T')[0];
        const endDateStr = end.toISOString().split('T')[0];

        const upcoming = await prisma.issue.findMany({
            where: {
                releaseDate: { gte: startDateStr, lte: endDateStr },
                series: { ...seriesScope, ...seriesAccess }
            },
            include: { series: { select: { name: true, folderPath: true, coverUrl: true, publisher: true } } },
            orderBy: { releaseDate: 'asc' }
        });

        const formatted = upcoming.map((issue: any) => {
            const rawCover = issue.coverUrl || issue.series?.coverUrl;
            let safeCover = rawCover;
            if (rawCover && !rawCover.startsWith('http') && !rawCover.startsWith('/')) {
                safeCover = `/api/library/cover?path=${encodeURIComponent(rawCover)}`;
            }
            return {
                id: issue.id, seriesId: issue.seriesId, seriesName: issue.series?.name || "Unknown Series",
                issueNumber: issue.number, issueName: issue.name, publisher: issue.series?.publisher || "Unknown",
                releaseDate: issue.releaseDate, coverUrl: safeCover, seriesPath: issue.series?.folderPath,
                libraryState: libraryState(issue)
            };
        });

        return NextResponse.json({
            startDate: startDateStr,
            endDate: endDateStr,
            releases: formatted
        });
    } catch (error) {
        Logger.log(`Calendar API Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: "Failed to fetch calendar data." }, { status: 500 });
    }
}