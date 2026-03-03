import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        // PERFECTED QUERY: Since cvId is a required number, we only check for 0 or negative values.
        // No more null checks causing Prisma to crash!
        const unmatched = await prisma.series.findMany({
            where: { 
                cvId: { lte: 0 } 
            },
            orderBy: { name: 'asc' }
        });

        return NextResponse.json(unmatched);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}