// src/app/api/library/follow/route.ts
//
// Per-user follow toggle (twin of the favorite route). Following is the subscription signal for
// the Updates feed — read-side only, never touches Series.monitored, never downloads anything.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

export async function POST(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);

    let userId = (session?.user as any)?.id;
    if (!userId && session?.user?.email) {
        const user = await prisma.user.findUnique({ where: { email: session.user.email } });
        userId = user?.id;
    }

    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { seriesId } = await request.json();
    if (!seriesId) return NextResponse.json({ error: "Missing series ID" }, { status: 400 });

    const existing = await prisma.seriesFollow.findUnique({
        where: { userId_seriesId: { userId, seriesId } }
    });

    if (existing) {
        await prisma.seriesFollow.delete({ where: { id: existing.id } });
        return NextResponse.json({ success: true, isFollowing: false });
    } else {
        await prisma.seriesFollow.create({
            data: { userId, seriesId }
        });
        return NextResponse.json({ success: true, isFollowing: true });
    }
  } catch (error: unknown) {
    Logger.log(`[Library Follow API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
