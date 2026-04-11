// src/app/api/notifications/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';

export async function GET() {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;
    const role = (session?.user as any)?.role;

    if (!session || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // 1. STANDARD USER NOTIFICATIONS
    // We now include DOWNLOADING and MANUAL_DDL to alert them when an admin approves a request
    const activeComics = await prisma.request.findMany({
      where: { userId, status: { in: ['DOWNLOADING', 'MANUAL_DDL', 'IMPORTED', 'COMPLETED'] }, notified: false },
      orderBy: { updatedAt: 'desc' }
    });

    const newTrophies = await prisma.userTrophy.findMany({
      where: { userId, notified: false },
      include: { trophy: true },
      orderBy: { earnedAt: 'desc' }
    });

    const newReports = await prisma.issueReport.findMany({
        where: { userId, status: 'CLOSED', notified: false },
        include: { series: true },
        orderBy: { updatedAt: 'desc' }
    });

    let formatted = [
        ...activeComics.map(c => ({ id: c.id, type: 'comic', status: c.status, title: c.activeDownloadName, imageUrl: c.imageUrl, date: c.updatedAt })),
        ...newTrophies.map(t => ({ id: t.id, type: 'trophy', title: t.trophy.name, description: t.trophy.description, imageUrl: t.trophy.iconUrl, date: t.earnedAt })),
        ...newReports.map(r => ({ id: r.id, type: 'report', title: `Resolved: ${r.series.name}`, description: r.adminComment || 'Your issue has been resolved by an Admin.', imageUrl: null, date: r.updatedAt }))
    ];

    // 2. DYNAMIC ADMIN ALERTS
    // These do not use the 'notified' flag, they simply show up if there is work to be done.
    if (role === 'ADMIN') {
        const pendingReqs = await prisma.request.findMany({
            where: { status: 'PENDING_APPROVAL' },
            include: { user: { select: { username: true } } },
            orderBy: { createdAt: 'desc' }
        });

        const pendingUsers = await prisma.user.findMany({
            where: { isApproved: false },
            orderBy: { createdAt: 'desc' }
        });

        const openReports = await prisma.issueReport.findMany({
            where: { status: 'OPEN' },
            include: { series: { select: { name: true } }, user: { select: { username: true } } },
            orderBy: { createdAt: 'desc' }
        });

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
            }))
        ];
    }

    // Sort all notifications by date descending
    formatted.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return NextResponse.json(formatted);
  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;

    if (!session || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { requestIds, trophyIds, reportIds } = await request.json();

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
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}