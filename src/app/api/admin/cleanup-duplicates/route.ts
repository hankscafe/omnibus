import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const goodSeries = await prisma.series.findMany({
        where: { metadataSource: 'COMICVINE' }
    });

    const goodPaths = new Set(goodSeries.map(s => s.folderPath?.toLowerCase()));

    const badSeries = await prisma.series.findMany({
        where: { metadataSource: 'LOCAL' }
    });

    const duplicatesToDelete = badSeries.filter(bad => 
        bad.folderPath && goodPaths.has(bad.folderPath.toLowerCase())
    );

    const idsToDelete = duplicatesToDelete.map(s => s.id);

    if (idsToDelete.length > 0) {
        await prisma.series.deleteMany({
            where: { id: { in: idsToDelete } }
        });
    }

    return NextResponse.json({
        success: true,
        message: `Successfully cleaned up ${idsToDelete.length} bad duplicate series!`,
        deletedSeries: duplicatesToDelete.map(s => s.name)
    });

  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}