import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export async function GET() {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;

    if (!session || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Fetch imported requests the user hasn't been notified about
    const newComics = await prisma.request.findMany({
      where: { userId, status: 'IMPORTED', notified: false },
      orderBy: { updatedAt: 'desc' }
    });

    // Fetch newly earned trophies the user hasn't been notified about
    const newTrophies = await prisma.userTrophy.findMany({
      where: { userId, notified: false },
      include: { trophy: true },
      orderBy: { earnedAt: 'desc' }
    });

    // NEW: Fetch newly closed issue reports the user hasn't seen
    const newReports = await prisma.issueReport.findMany({
        where: { userId, status: 'CLOSED', notified: false },
        include: { series: true },
        orderBy: { updatedAt: 'desc' }
    });

    // Combine and sort them
    const formatted = [
        ...newComics.map(c => ({ id: c.id, type: 'comic', title: c.activeDownloadName, imageUrl: c.imageUrl, date: c.updatedAt })),
        ...newTrophies.map(t => ({ id: t.id, type: 'trophy', title: t.trophy.name, description: t.trophy.description, imageUrl: t.trophy.iconUrl, date: t.earnedAt })),
        ...newReports.map(r => ({ id: r.id, type: 'report', title: `Resolved: ${r.series.name}`, description: r.adminComment || 'Your issue has been resolved by an Admin.', imageUrl: null, date: r.updatedAt }))
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return NextResponse.json(formatted);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
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
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}