import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export async function POST(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;

    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { collectionId, seriesId, seriesIds, action } = await request.json();

    if (!collectionId || (!seriesId && (!seriesIds || seriesIds.length === 0))) {
        return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
    }

    // Verify ownership of the collection
    const collection = await prisma.collection.findUnique({ where: { id: collectionId } });
    if (!collection || collection.userId !== userId) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const idsToProcess = seriesIds || [seriesId];

    if (action === 'add') {
      const lastItem = await prisma.collectionItem.findFirst({
        where: { collectionId },
        orderBy: { order: 'desc' }
      });
      let nextOrder = lastItem ? lastItem.order + 1 : 0;

      // REFACTOR: Use highly-optimized bulk insert with duplicate skipping
      const result = await prisma.collectionItem.createMany({
          data: idsToProcess.map((sId: string) => ({ 
              collectionId, 
              seriesId: sId, 
              order: nextOrder++ 
          })),
          skipDuplicates: true // Gracefully ignores duplicates
      });

      return NextResponse.json({ success: true, message: `Added ${result.count} items to list.` });

    } else if (action === 'remove') {
      await prisma.collectionItem.deleteMany({
        where: {
          collectionId,
          seriesId: { in: idsToProcess }
        }
      });
      return NextResponse.json({ success: true, message: 'Removed from collection' });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}