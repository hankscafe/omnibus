import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

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

    const existing = await prisma.favorite.findUnique({
        where: { userId_seriesId: { userId, seriesId } }
    });

    if (existing) {
        await prisma.favorite.delete({ where: { id: existing.id } });
        return NextResponse.json({ success: true, isFavorite: false });
    } else {
        await prisma.favorite.create({
            data: { userId, seriesId }
        });
        return NextResponse.json({ success: true, isFavorite: true });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}