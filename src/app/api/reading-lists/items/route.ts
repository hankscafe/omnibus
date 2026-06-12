// src/app/api/reading-lists/items/route.ts
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

    const { listId, issueId, seriesId, seriesIds, action } = await request.json();

    if (!listId || (!issueId && !seriesId && (!seriesIds || seriesIds.length === 0))) {
        return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
    }

    // Verify ownership of the list
    const list = await prisma.readingList.findUnique({ where: { id: listId } });
    if (!list || (list.userId !== userId && session?.user?.role !== 'ADMIN')) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (action === 'add') {
      const lastItem = await prisma.readingListItem.findFirst({
        where: { listId },
        orderBy: { order: 'desc' }
      });
      let nextOrder = lastItem ? lastItem.order + 1 : 0;

      if (issueId) {
          await prisma.readingListItem.create({
              data: { listId, issueId, order: nextOrder, title: "" }
          });
          return NextResponse.json({ success: true, message: `Added issue to reading list.` });
      } else {
          // Add all issues from one or more series
          const idsToProcess = seriesIds || [seriesId];
          const issues = await prisma.issue.findMany({
              where: { seriesId: { in: idsToProcess } },
              include: { series: true }
          });

          issues.sort((a, b) => {
              if (a.seriesId !== b.seriesId) return a.series.name.localeCompare(b.series.name);
              // Added '-' to regex to preserve negative values during sort
              return parseFloat(a.number.replace(/[^0-9.-]/g, '')) - parseFloat(b.number.replace(/[^0-9.-]/g, ''));
          });

          const itemsData = issues.map(issue => ({
              listId,
              issueId: issue.id,
              title: `${issue.series.name} #${issue.number}`,
              order: nextOrder++
          }));

          if (itemsData.length > 0) {
              await prisma.readingListItem.createMany({ data: itemsData });
          }

          return NextResponse.json({ success: true, message: `Added ${itemsData.length} issues to reading list.` });
      }

    } else if (action === 'remove') {
      if (issueId) {
          await prisma.readingListItem.deleteMany({
            where: { listId, issueId }
          });
      } else {
          // Remove all issues that belong to one or more series
          const idsToProcess = seriesIds || [seriesId];
          const issues = await prisma.issue.findMany({ where: { seriesId: { in: idsToProcess } }, select: { id: true } });
          const issueIds = issues.map(i => i.id);
          await prisma.readingListItem.deleteMany({
            where: { listId, issueId: { in: issueIds } }
          });
      }
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
        if (!list || (list.userId !== userId && session?.user?.role !== 'ADMIN')) {
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