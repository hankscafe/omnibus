// src/app/api/library/follow/route.ts
//
// Per-user follow endpoints (Beta C widened the Beta A toggle). Following is the subscription
// signal for the Updates feed — read-side only, never touches Series.monitored, never downloads.
//
//   GET  → { seriesIds } : every series the current user follows (pages decorate their own items
//                          client-side instead of threading follow state through heavy list APIs).
//   POST { seriesId }                        → toggle (Beta A contract, unchanged)
//   POST { seriesId, follow: boolean }       → explicit set, idempotent
//   POST { seriesIds: [...], follow: bool }  → bulk set for the library selection bar — explicit
//                          semantics on purpose: bulk-toggling a mixed selection would flip each
//                          row somewhere the user isn't looking. Inserts are filter-first (no
//                          skipDuplicates on SQLite) and validated against existing series.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

const BULK_CAP = 1000;

async function resolveUserId(): Promise<string | null> {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    let userId = (session?.user as any)?.id;
    if (!userId && session?.user?.email) {
        const user = await prisma.user.findUnique({ where: { email: session.user.email } });
        userId = user?.id;
    }
    return userId || null;
}

export async function GET() {
  try {
    const userId = await resolveUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const follows = await prisma.seriesFollow.findMany({
        where: { userId },
        select: { seriesId: true },
    });
    return NextResponse.json({ seriesIds: follows.map(f => f.seriesId) });
  } catch (error: unknown) {
    Logger.log(`[Library Follow API] GET error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const userId = await resolveUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();

    // --- Bulk set (library selection bar) ---
    if (Array.isArray(body.seriesIds)) {
        if (typeof body.follow !== 'boolean') return NextResponse.json({ error: "Bulk requires follow: true|false" }, { status: 400 });
        const ids: string[] = body.seriesIds.filter((s: unknown) => typeof s === 'string').slice(0, BULK_CAP);
        if (ids.length === 0) return NextResponse.json({ error: "No series IDs" }, { status: 400 });

        if (body.follow) {
            const existingSeries = await prisma.series.findMany({ where: { id: { in: ids } }, select: { id: true } });
            const validIds = existingSeries.map(s => s.id);
            const already = await prisma.seriesFollow.findMany({
                where: { userId, seriesId: { in: validIds } },
                select: { seriesId: true },
            });
            const have = new Set(already.map(f => f.seriesId));
            const fresh = validIds.filter(id => !have.has(id)).map(seriesId => ({ userId, seriesId }));
            if (fresh.length > 0) await prisma.seriesFollow.createMany({ data: fresh });
            return NextResponse.json({ success: true, followed: fresh.length });
        } else {
            const res = await prisma.seriesFollow.deleteMany({ where: { userId, seriesId: { in: ids } } });
            return NextResponse.json({ success: true, unfollowed: res.count });
        }
    }

    // --- Single series ---
    const { seriesId } = body;
    if (!seriesId) return NextResponse.json({ error: "Missing series ID" }, { status: 400 });

    const existing = await prisma.seriesFollow.findUnique({
        where: { userId_seriesId: { userId, seriesId } }
    });

    // Explicit set (idempotent) when `follow` is present; classic toggle otherwise.
    const wantFollow = typeof body.follow === 'boolean' ? body.follow : !existing;

    if (wantFollow && !existing) {
        await prisma.seriesFollow.create({ data: { userId, seriesId } });
    } else if (!wantFollow && existing) {
        await prisma.seriesFollow.delete({ where: { id: existing.id } });
    }
    return NextResponse.json({ success: true, isFollowing: wantFollow });
  } catch (error: unknown) {
    Logger.log(`[Library Follow API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
