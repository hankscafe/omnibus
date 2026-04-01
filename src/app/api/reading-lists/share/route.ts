import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import crypto from 'crypto';

export async function POST(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { listId } = await request.json();
    if (!listId) return NextResponse.json({ error: "Missing List ID" }, { status: 400 });

    try {
        const list = await prisma.readingList.findUnique({ where: { id: listId } });
        
        // FIX: Add optional chaining to session?.user?.role
        if (!list || (list.userId !== userId && session?.user?.role !== 'ADMIN')) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        // Generate a random 8-character string for the URL
        const shareId = crypto.randomBytes(4).toString('hex');

        await prisma.readingList.update({
            where: { id: listId },
            data: { shareId }
        });

        return NextResponse.json({ success: true, shareId });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}