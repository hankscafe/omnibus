import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

export async function POST(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;

    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { listId, issueId, action } = await request.json();

    if (!listId || !issueId) {
        return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
    }

    // Verify ownership of the list
    const list = await prisma.readingList.findUnique({ where: { id: listId } });
    if (!list || list.userId !== userId) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (action === 'add') {
      // Find the current highest order number so we append to the end of the list
      const lastItem = await prisma.readingListItem.findFirst({
        where: { listId },
        orderBy: { order: 'desc' }
      });
      const nextOrder = lastItem ? lastItem.order + 1 : 0;

      await prisma.readingListItem.create({
          data: { list: { connect: { id: listId } }, issue: { connect: { id: issueId } }, order: nextOrder, title: "" }
      });

      return NextResponse.json({ success: true, message: `Added issue to reading list.` });

    } else if (action === 'remove') {
      await prisma.readingListItem.deleteMany({
        where: { listId, issueId }
      });
      return NextResponse.json({ success: true, message: 'Removed from reading list' });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

  } catch (error: unknown) {
    Logger.log(`[List Items API] Add/Remove Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;
  
        if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  
        const { listId, items } = await request.json(); // Expects array of { id, order }
  
        // Verify ownership
        const list = await prisma.readingList.findUnique({ where: { id: listId } });
        if (!list || list.userId !== userId) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
  
        // Update all orders efficiently in a single transaction
        await prisma.$transaction(
            items.map((item: any) =>
                prisma.readingListItem.update({
                    where: { id: item.id },
                    data: { order: item.order }
                })
            )
        );
  
        return NextResponse.json({ success: true, message: 'List reordered successfully' });
  
    } catch (error: unknown) {
        Logger.log(`[List Items API] Update Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}