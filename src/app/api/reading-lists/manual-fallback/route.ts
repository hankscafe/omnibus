import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        
        const userId = (session.user as any).id;

        // Flagging an unmatched list item for admin download is still a request — gate it.
        const requester = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, canRequest: true } });
        if (requester?.role !== 'ADMIN' && !requester?.canRequest) {
            return NextResponse.json({ error: "You don't have permission to make requests." }, { status: 403 });
        }

        const { cvId, name, image, searchLink, metadataSource } = await request.json();

        // No more guessing! Every field here is confirmed by the Prisma logs.
        const newRequest = await prisma.request.create({
            data: {
                userId, 
                volumeId: cvId ? cvId.toString() : "0",
                metadataSource: metadataSource || 'COMICVINE', 
                status: 'MANUAL_DDL', 
                imageUrl: image,
                downloadLink: searchLink,
                activeDownloadName: name // Prisma confirmed this column exists, so we store the name here!
            }
        });

        return NextResponse.json({ success: true, request: newRequest });
    } catch (error: unknown) {
        Logger.log(`Manual Fallback Error: ${getErrorMessage(error)}`, 'error');

        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}