import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        
        const userId = (session.user as any).id;

        const { cvId, name, image, searchLink } = await request.json();

        // No more guessing! Every field here is confirmed by the Prisma logs.
        const newRequest = await prisma.request.create({
            data: {
                userId, 
                volumeId: cvId ? cvId.toString() : "0", 
                status: 'MANUAL_DDL', 
                imageUrl: image,
                downloadLink: searchLink,
                activeDownloadName: name // Prisma confirmed this column exists, so we store the name here!
            }
        });

        return NextResponse.json({ success: true, request: newRequest });
    } catch (error: any) {
        console.error("Manual Fallback Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}