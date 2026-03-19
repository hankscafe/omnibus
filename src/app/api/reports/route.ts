import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;

        if (!session || !userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { seriesId, description } = await request.json();

        if (!seriesId || !description) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }

        const report = await prisma.issueReport.create({
            data: {
                userId,
                seriesId,
                description
            }
        });

        return NextResponse.json({ success: true, report });

    } catch (error: any) {
        Logger.log("Report Creation Error:", error, 'error');
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}