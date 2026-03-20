import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    // 1. Ensure only you (the Admin) can run this
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2. Get all "Good" series (Restored from your JSON, with proper ComicVine IDs)
    const goodSeries = await prisma.series.findMany({
        where: { cvId: { gt: 0 } }
    });

    // Create a Set of valid folder paths (lowercased for safe matching)
    const goodPaths = new Set(goodSeries.map(s => s.folderPath?.toLowerCase()));

    // 3. Get all "Bad" series (Auto-generated during the glitch, with negative IDs)
    const badSeries = await prisma.series.findMany({
        where: { cvId: { lt: 0 } }
    });

    // 4. Find bad series that are squatting on the same folder path as a good series
    const duplicatesToDelete = badSeries.filter(bad => 
        bad.folderPath && goodPaths.has(bad.folderPath.toLowerCase())
    );

    const idsToDelete = duplicatesToDelete.map(s => s.id);

    // 5. Safely purge them from the database
    if (idsToDelete.length > 0) {
        // Because of 'onDelete: Cascade' in your schema, this also wipes the bad/duplicate Issue rows!
        // This DOES NOT delete physical files.
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