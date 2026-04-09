import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        // FIX: Ensure records with a valid cvId are NOT considered unmatched
        const unmatched = await prisma.series.findMany({
            where: { 
                AND: [
                    { cvId: null },
                    { matchState: 'UNMATCHED' },
                    {
                        OR: [
                            { metadataId: null },
                            { metadataId: { startsWith: 'unmatched_' } }
                        ]
                    }
                ]
            },
            orderBy: { name: 'asc' }
        });

        return NextResponse.json(unmatched);
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}