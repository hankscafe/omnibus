import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import crypto from 'crypto';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

export async function POST(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { listId } = await request.json();
    if (!listId) return NextResponse.json({ error: "Missing List ID" }, { status: 400 });

    try {
        const list = await prisma.readingList.findUnique({ where: { id: listId } });
        
        // Safely check for Admin role
        const isAdmin = (session?.user as any)?.role === 'ADMIN';
        
        // Consider it public if it has the new isGlobal flag OR the legacy userId = null
        const isPublic = list?.isGlobal === true || list?.userId === null;

        // Allow anyone to generate a share link if the list is already public
        if (!list || (list.userId !== userId && !isAdmin && !isPublic)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        // Generate a random 8-character string for the URL
        const shareId = crypto.randomBytes(4).toString('hex');

        await prisma.readingList.update({
            where: { id: listId },
            data: { shareId }
        });

        return NextResponse.json({ success: true, shareId });
    } catch (error: unknown) {
        Logger.log(`[Share List API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}