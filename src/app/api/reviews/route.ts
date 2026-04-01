import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const seriesId = searchParams.get('seriesId');
    if (!seriesId) return NextResponse.json({ error: "Series ID required" }, { status: 400 });

    try {
        const reviews = await prisma.review.findMany({
            where: { seriesId },
            include: { user: { select: { username: true, avatar: true } } },
            orderBy: { updatedAt: 'desc' }
        });

        const avgRating = reviews.length > 0 
            ? reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length 
            : 0;

        return NextResponse.json({ reviews, avgRating: avgRating.toFixed(1), total: reviews.length });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { seriesId, rating, text } = await request.json();
    if (!seriesId || !rating) return NextResponse.json({ error: "Missing fields" }, { status: 400 });

    try {
        const review = await prisma.review.upsert({
            where: { userId_seriesId: { userId, seriesId } },
            update: { rating, text },
            create: { userId, seriesId, rating, text }
        });
        return NextResponse.json({ success: true, review });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}