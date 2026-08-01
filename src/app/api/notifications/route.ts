// src/app/api/notifications/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { COMIC_EXT_REGEX } from '@/lib/utils/formats';
import { UNMATCHED_DIR } from '@/lib/utils/paths';
import { getAccessibleLibraryIds } from '@/lib/library-access';

export async function GET() {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;
    const role = (session?.user as any)?.role;

    if (!session || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // 1. STANDARD USER NOTIFICATIONS — independent queries, run in parallel (polled every 60s/session).
    // We include DOWNLOADING and MANUAL_DDL to alert them when an admin approves a request.
    const [activeComics, newTrophies, newReports, me, accessibleLibs] = await Promise.all([
      prisma.request.findMany({
        where: { userId, status: { in: ['DOWNLOADING', 'MANUAL_DDL', 'IMPORTED', 'COMPLETED'] }, notified: false },
        orderBy: { updatedAt: 'desc' }
      }),
      prisma.userTrophy.findMany({
        where: { userId, notified: false },
        include: { trophy: true },
        orderBy: { earnedAt: 'desc' }
      }),
      prisma.issueReport.findMany({
        where: { userId, status: 'CLOSED', notified: false },
        include: { series: true },
        orderBy: { updatedAt: 'desc' }
      }),
      prisma.user.findUnique({ where: { id: userId }, select: { lastSeenUpdatesAt: true } }),
      getAccessibleLibraryIds(userId, role),
    ]);

    let formatted = [
        ...activeComics.map(c => ({ id: c.id, type: 'comic', status: c.status, title: c.activeDownloadName, imageUrl: c.imageUrl, date: c.updatedAt })),
        ...newTrophies.map(t => ({ id: t.id, type: 'trophy', title: t.trophy.name, description: t.trophy.description, imageUrl: t.trophy.iconUrl, date: t.earnedAt })),
        ...newReports.map(r => ({ id: r.id, type: 'report', title: `Resolved: ${r.series.name}`, description: r.adminComment || 'Your issue has been resolved by an Admin.', imageUrl: null, date: r.updatedAt }))
    ];

    // 1b. FOLLOWED-SERIES ARRIVALS — one dynamic SUMMARY entry, never per-issue (a chapter dump
    // must be one bell line, not twelve). Counts file-backed arrivals since the user's
    // lastSeenUpdatesAt marker (bounded by the Updates feed's 30-day window when the marker is
    // absent or ancient); visiting /library/updates or clearing the bell stamps the marker, so
    // the entry self-clears. Requested-series arrivals also notify via the request path above —
    // the summary shape absorbs that overlap instead of double-listing issues.
    try {
        const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const seen = me?.lastSeenUpdatesAt && me.lastSeenUpdatesAt > windowStart ? me.lastSeenUpdatesAt : windowStart;
        const followArrivalWhere = {
            filePath: { not: null },
            createdAt: { gt: seen },
            series: {
                follows: { some: { userId } },
                ...(accessibleLibs === 'ALL' ? {} : { libraryId: { in: accessibleLibs } }),
            },
        };
        const [arrivalCount, newestArrival] = await Promise.all([
            prisma.issue.count({ where: followArrivalWhere }),
            prisma.issue.findFirst({ where: followArrivalWhere, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { createdAt: true } }),
        ]);
        if (arrivalCount > 0) {
            formatted.push({
                id: 'follow_updates_alert',
                type: 'follow_updates',
                title: `${arrivalCount} New Issue${arrivalCount === 1 ? '' : 's'} In Your Follows`,
                description: 'New arrivals in series you follow are waiting in Updates.',
                imageUrl: null,
                date: newestArrival?.createdAt || new Date(),
            } as any);
        }
    } catch (e) {
        Logger.log(`[Notifications API] Follow-arrivals summary failed: ${getErrorMessage(e)}`, 'warn');
    }

    // 2. DYNAMIC ADMIN ALERTS
    // These do not use the 'notified' flag, they simply show up if there is work to be done.
    if (role === 'ADMIN') {
        // All independent — run them (and the loose-file readdir) concurrently.
        const [pendingReqs, pendingUsers, openReports, stalledReqs, unmatchedSeriesCount, looseFilesCount, sweepResultSetting, pageSweepSetting] = await Promise.all([
            prisma.request.findMany({
                where: { status: 'PENDING_APPROVAL' },
                include: { user: { select: { username: true } } },
                orderBy: { createdAt: 'desc' }
            }),
            prisma.user.findMany({
                where: { isApproved: false },
                orderBy: { createdAt: 'desc' }
            }),
            prisma.issueReport.findMany({
                where: { status: 'OPEN' },
                include: { series: { select: { name: true } }, user: { select: { username: true } } },
                orderBy: { createdAt: 'desc' }
            }),
            prisma.request.findMany({
                where: { status: 'STALLED' },
                include: { user: { select: { username: true } } },
                orderBy: { updatedAt: 'desc' }
            }),
            prisma.series.count({ where: { matchState: 'UNMATCHED' } }),
            (async () => {
                try {
                    const fs = await import('fs');
                    const unmatchedDir = UNMATCHED_DIR;
                    if (fs.existsSync(unmatchedDir)) {
                        const files = await fs.promises.readdir(unmatchedDir);
                        return files.filter(f => COMIC_EXT_REGEX.test(f)).length;
                    }
                } catch (e) {}
                return 0;
            })(),
            prisma.systemSetting.findUnique({ where: { key: 'last_unmatched_sweep_result' } }),
            prisma.systemSetting.findUnique({ where: { key: 'last_page_sweep_result' } }),
        ]);

        const totalUnmatched = unmatchedSeriesCount + looseFilesCount;

        formatted = [
            ...formatted,
            ...pendingReqs.map(r => ({
                id: `req_${r.id}`, type: 'admin_req', title: r.activeDownloadName || 'New Request',
                description: `Requested by ${r.user?.username}`, imageUrl: r.imageUrl, date: r.createdAt
            })),
            ...pendingUsers.map(u => ({
                id: `user_${u.id}`, type: 'admin_user', title: 'New User Registration',
                description: `${u.username} (${u.email}) is waiting for approval.`, imageUrl: null, date: u.createdAt
            })),
            ...openReports.map(r => ({
                id: `rep_${r.id}`, type: 'admin_report', title: `Issue Reported: ${r.series?.name}`,
                description: `Reported by ${r.user?.username}`, imageUrl: null, date: r.createdAt
            })),
            ...stalledReqs.map(r => ({
                id: `stalled_${r.id}`, 
                type: 'admin_stalled', 
                title: 'Action Required: Variant / Stalled',
                description: `${r.activeDownloadName || 'A request'} requires manual selection via Interactive Search.`, 
                imageUrl: r.imageUrl, 
                date: r.updatedAt
            })),
        ];

        // Push the unmatched alert if any exist
        if (totalUnmatched > 0) {
            formatted.push({
                id: 'admin_unmatched_alert',
                type: 'admin_unmatched',
                title: 'Unmatched Files Detected',
                description: `There are ${totalUnmatched} loose files/folders waiting in the Smart Matcher.`,
                imageUrl: null,
                date: new Date()
            });
        }

        // Background sweep result (discussion #177) — dynamic like the alerts above: the engine
        // overwrites last_unmatched_sweep_result on every run, so a later run that matched nothing
        // (or a "nothing to do" pass once the queue empties) naturally clears this. The 24h cap
        // keeps a final result from lingering forever if the scheduler/engine goes quiet.
        try {
            const sweep = sweepResultSetting?.value ? JSON.parse(sweepResultSetting.value) : null;
            const sweepMatched = (sweep?.byFile || 0) + (sweep?.bySearch || 0);
            if (sweep?.status === 'COMPLETED' && sweepMatched > 0 && sweep.finishedAt && Date.now() - sweep.finishedAt < 24 * 60 * 60 * 1000) {
                formatted.push({
                    id: 'admin_sweep_alert',
                    type: 'admin_sweep',
                    title: 'Background Sweep Matched Series',
                    description: `The unmatched sweep auto-matched ${sweepMatched} series (${sweep.byFile || 0} from file metadata, ${sweep.bySearch || 0} by search).`,
                    imageUrl: null,
                    date: new Date(sweep.finishedAt)
                });
            }
        } catch (e) { /* pre-upgrade or corrupt value — no alert */ }

        // Series page sweep result (issue #189 Phase 3) — same dynamic pattern: the next sweep
        // overwrites the setting, and the 24h cap keeps a final result from lingering forever.
        try {
            const ps = pageSweepSetting?.value ? JSON.parse(pageSweepSetting.value) : null;
            if (ps && (ps.status === 'COMPLETED' || ps.status === 'CANCELLED') && ps.finishedAt && Date.now() - ps.finishedAt < 24 * 60 * 60 * 1000) {
                formatted.push({
                    id: 'admin_page_sweep_alert',
                    type: 'admin_sweep',
                    title: ps.status === 'COMPLETED' ? 'Page Sweep Finished' : 'Page Sweep Cancelled',
                    description: `"${ps.sourceLabel}": removed ${ps.removed} page(s) across ${ps.processed} file(s)${ps.failedCount ? `, ${ps.failedCount} failed` : ''}.`,
                    imageUrl: null,
                    date: new Date(ps.finishedAt)
                });
            }
        } catch (e) { /* corrupt value — no alert */ }
    }

    // Sort all notifications by date descending
    formatted.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return NextResponse.json(formatted);
  } catch (error: unknown) {
    Logger.log(`[Notifications API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;

    if (!session || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { requestIds, trophyIds, reportIds, followUpdatesSeen } = await request.json();

    // Stamps the followed-arrivals marker (bell Clear button + visiting /library/updates) so the
    // dynamic "N new issues in your follows" entry self-clears on the next poll.
    if (followUpdatesSeen === true) {
        await prisma.user.update({ where: { id: userId }, data: { lastSeenUpdatesAt: new Date() } });
    }

    if (requestIds?.length > 0) {
        await prisma.request.updateMany({ where: { id: { in: requestIds }, userId }, data: { notified: true } });
    }
    
    if (trophyIds?.length > 0) {
        await prisma.userTrophy.updateMany({ where: { id: { in: trophyIds }, userId }, data: { notified: true } });
    }

    if (reportIds?.length > 0) {
        await prisma.issueReport.updateMany({ where: { id: { in: reportIds }, userId }, data: { notified: true } });
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    Logger.log(`[Notifications API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}