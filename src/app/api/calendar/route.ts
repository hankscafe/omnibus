import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getAccessibleLibraryIds } from '@/lib/library-access';
import { isReleasedYet } from '@/lib/utils';
import { issueNumberOf } from '@/lib/request-dedupe';
import { requestedIssueRow } from '@/lib/utils/attachment-name';
import type { CalendarLibraryState, CalendarWeekReply } from '@/types/api/calendar';

export const dynamic = 'force-dynamic';

// UNRELEASED -> RELEASED -> IN_LIBRARY as the date passes and the file lands.
// IMPORTED/COMPLETED covers rows imported before filePath was consistently backfilled.
function libraryState(issue: { releaseDate: string | null; filePath: string | null; status: string | null }): CalendarLibraryState {
    if (issue.filePath || issue.status === 'IMPORTED' || issue.status === 'COMPLETED') return 'IN_LIBRARY';
    return isReleasedYet(issue.releaseDate, null) ? 'RELEASED' : 'UNRELEASED';
}

type WeekRow = {
    id: string;
    seriesId: string;
    number: string;
    attachedVolumeId: string | null;
    attachedVolume: { name: string | null; kind: string } | null;
    series: { name: string; metadataId: string | null } | null;
};

/**
 * Calendar fix C (beta.042): what each week row's request is doing - the field report's "Released" card
 * couldn't say whether anything was fetching the issue. The request is found the way the Series Monitor
 * and the search worker find a request's issue: filed under the series' provider id (or its own id when it
 * has none); its number from the stored column first (#240 - a download renames it to the release's title),
 * else from the name; and among the series' rows of this week, the one requestedIssueRow picks (a Special's
 * request finds the Special's row by name, a run's request never lands on a Special). Annual and
 * collected-edition rows answer nothing: their requests are filed under the lane's own volume. Newest
 * request first, so a row shows the most recently updated one. Cancelled requests are left out.
 */
async function requestStatusesFor(rows: WeekRow[]): Promise<Map<string, string>> {
    const statuses = new Map<string, string>();
    const bySeries = new Map<string, WeekRow[]>();
    for (const r of rows) bySeries.set(r.seriesId, [...(bySeries.get(r.seriesId) ?? []), r]);
    const seriesOfVolume = new Map<string, string>();
    for (const [seriesId, list] of bySeries) {
        seriesOfVolume.set(seriesId, seriesId);
        const providerId = list[0].series?.metadataId;
        if (providerId) seriesOfVolume.set(providerId, seriesId);
    }
    if (seriesOfVolume.size === 0) return statuses;

    const requests = await prisma.request.findMany({
        where: { volumeId: { in: [...seriesOfVolume.keys()] }, status: { not: 'CANCELLED' } },
        select: { volumeId: true, issueNumber: true, activeDownloadName: true, status: true },
        orderBy: { updatedAt: 'desc' },
    });
    for (const req of requests) {
        const seriesId = req.volumeId ? seriesOfVolume.get(req.volumeId) : undefined;
        const number = issueNumberOf(req);
        if (!seriesId || !number) continue;
        const list = bySeries.get(seriesId) ?? [];
        const ownRows = list.filter(r => !r.attachedVolumeId || r.attachedVolume?.kind === 'SPECIAL');
        const row = requestedIssueRow(ownRows, number, req.activeDownloadName || '', list[0]?.series?.name || '');
        if (row && !statuses.has(row.id)) statuses.set(row.id, req.status);
    }
    return statuses;
}

export async function GET(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // Per-library access: non-admins only see calendar entries from libraries they've been granted.
        const userId = session.user.id;
        const accessibleLibs = await getAccessibleLibraryIds(userId, session.user.role);
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
            include: {
                // metadataId and the row's lane let the request behind each row be found (requestStatusesFor).
                series: { select: { name: true, folderPath: true, coverUrl: true, publisher: true, metadataId: true } },
                attachedVolume: { select: { name: true, kind: true } },
            },
            orderBy: { releaseDate: 'asc' }
        });
        const requestStatuses = await requestStatusesFor(upcoming);

        const formatted = upcoming.map(issue => {
            const rawCover = issue.coverUrl || issue.series?.coverUrl;
            let safeCover = rawCover;
            if (rawCover && !rawCover.startsWith('http') && !rawCover.startsWith('/')) {
                safeCover = `/api/library/cover?path=${encodeURIComponent(rawCover)}`;
            }
            return {
                id: issue.id, seriesId: issue.seriesId, seriesName: issue.series?.name || "Unknown Series",
                issueNumber: issue.number, issueName: issue.name, publisher: issue.series?.publisher || "Unknown",
                releaseDate: issue.releaseDate, coverUrl: safeCover ?? null, seriesPath: issue.series?.folderPath ?? null,
                libraryState: libraryState(issue),
                requestStatus: requestStatuses.get(issue.id) ?? null,
            };
        });

        return NextResponse.json({
            startDate: startDateStr,
            endDate: endDateStr,
            releases: formatted
        } satisfies CalendarWeekReply);
    } catch (error) {
        Logger.log(`Calendar API Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: "Failed to fetch calendar data." }, { status: 500 });
    }
}