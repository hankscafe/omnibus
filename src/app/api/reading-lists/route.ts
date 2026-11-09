// src/app/api/reading-lists/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { getAccessibleLibraryIds } from '@/lib/library-access';
import type { Prisma } from '@prisma/client';

export const dynamic = 'force-dynamic';

// The lists a user can see: their own, global ones, and ownerless ones.
const visibleListsWhere = (userId: string) => ({ OR: [{ userId }, { isGlobal: true }, { userId: null }] });

// What the page shows about a list (the creator's name labels a global list).
const LIST_FIELDS = {
    id: true, name: true, description: true, coverUrl: true, isGlobal: true, userId: true, shareId: true, updatedAt: true,
    user: { select: { username: true } },
} as const;

// "Owned" is an issue with a file: a linked placeholder (a WANTED row) has nothing to read yet.
const OWNED_ISSUE = { AND: [{ filePath: { not: null } }, { filePath: { not: '' } }] };

/**
 * GET /api/reading-lists      every visible list, with counts {total, owned, read} and no items
 * GET /api/reading-lists?id=  one visible list with its items, each with the caller's progress
 *
 * #252: this used to load every visible list with every item and its full issue and series rows,
 * and relink every unlinked item across all lists, on every page load - unusable with a few hundred
 * imported CBL lists. The overview costs four queries however many lists there are, and the
 * relink runs for the list being opened.
 */
export async function GET(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = session?.user?.id;

        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // Per-library access: hide list items whose linked issue is in a library the user can't access.
        // Metadata-only items (no linked issue yet) are kept — they're reading-order placeholders, not content.
        const accessibleLibs = await getAccessibleLibraryIds(userId, session?.user?.role);
        const itemAccessWhere: Prisma.ReadingListItemWhereInput = accessibleLibs === 'ALL'
            ? {}
            : { OR: [{ issueId: null }, { issue: { series: { libraryId: { in: accessibleLibs } } } }] };

        const id = new URL(request.url).searchParams.get('id');
        if (id) return await getOneList(id, userId, itemAccessWhere);

        const lists = await prisma.readingList.findMany({
            where: visibleListsWhere(userId),
            select: LIST_FIELDS,
            orderBy: { updatedAt: 'desc' }
        });

        // Per-list counts in three grouped queries, each over the same visible lists and items.
        const visibleItems: Prisma.ReadingListItemWhereInput = { list: visibleListsWhere(userId), ...itemAccessWhere };
        const countBy = async (extra: Prisma.ReadingListItemWhereInput) => {
            const rows = await prisma.readingListItem.groupBy({
                by: ['listId'],
                where: { AND: [visibleItems, extra] },
                _count: { _all: true },
            });
            return new Map(rows.map(r => [r.listId, r._count._all]));
        };
        const [total, owned, read] = await Promise.all([
            countBy({}),
            countBy({ issue: OWNED_ISSUE }),
            // #253: the caller's own finished issues.
            countBy({ issue: { readProgresses: { some: { userId, isCompleted: true } } } }),
        ]);

        return NextResponse.json(lists.map(list => ({
            ...list,
            counts: { total: total.get(list.id) ?? 0, owned: owned.get(list.id) ?? 0, read: read.get(list.id) ?? 0 },
        })));
    } catch (error: unknown) {
        Logger.log(`[Reading Lists API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

/** One visible list with its items in reading order, each carrying the caller's progress. */
async function getOneList(id: string, userId: string, itemAccessWhere: Prisma.ReadingListItemWhereInput) {
    const list = await prisma.readingList.findFirst({ where: { id, ...visibleListsWhere(userId) }, select: LIST_FIELDS });
    if (!list) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Auto-link: items imported or auto-built with a provider issue id but no local issue yet get
    // linked once that issue is in the library. Only this list's items - opening one list no longer
    // pays for every other list.
    const unlinked = await prisma.readingListItem.findMany({
        where: { listId: id, issueId: null, cvIssueId: { not: null } },
        select: { id: true, cvIssueId: true, metadataSource: true },
    });
    if (unlinked.length > 0) {
        const idsBySource = new Map<string, string[]>();
        for (const item of unlinked) {
            const source = item.metadataSource || 'COMICVINE';
            idsBySource.set(source, [...(idsBySource.get(source) ?? []), String(item.cvIssueId)]);
        }
        const matches = await prisma.issue.findMany({
            where: { OR: Array.from(idsBySource, ([metadataSource, ids]) => ({ metadataSource, metadataId: { in: ids } })) },
            select: { id: true, metadataId: true, metadataSource: true },
        });
        const links = unlinked.flatMap(item => {
            const match = matches.find(i => i.metadataId === String(item.cvIssueId) && i.metadataSource === (item.metadataSource || 'COMICVINE'));
            return match ? [prisma.readingListItem.update({ where: { id: item.id }, data: { issueId: match.id } })] : [];
        });
        if (links.length > 0) await prisma.$transaction(links);
    }

    // Only the fields the page uses: whole Series rows (descriptions, credits) made up most of the payload.
    const items = await prisma.readingListItem.findMany({
        where: { listId: id, ...itemAccessWhere },
        orderBy: { order: 'asc' },
        select: {
            id: true, order: true, title: true, cvIssueId: true, metadataSource: true, issueId: true,
            issue: {
                select: {
                    id: true, number: true, name: true, filePath: true, coverUrl: true, metadataSource: true,
                    series: { select: { id: true, name: true, folderPath: true, metadataId: true, metadataSource: true } },
                },
            },
        },
    });

    // #253: the caller's progress, in the series page's shape (isRead, readProgress as a percentage).
    const issueIds = items.flatMap(item => (item.issueId ? [item.issueId] : []));
    const progress = issueIds.length === 0 ? [] : await prisma.readProgress.findMany({
        where: { userId, issueId: { in: issueIds } },
        select: { issueId: true, currentPage: true, totalPages: true, isCompleted: true },
    });
    const progressByIssue = new Map(progress.map(p => [p.issueId, {
        isRead: p.isCompleted,
        readProgress: p.totalPages > 0 ? (p.currentPage / p.totalPages) * 100 : 0,
    }]));

    return NextResponse.json({
        ...list,
        items: items.map(item => ({ ...item, progress: (item.issueId && progressByIssue.get(item.issueId)) || null })),
    });
}

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        
        const userId = session.user.id;
        const { name, description, isGlobal, coverUrl } = await request.json();

        if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

        // Only admins and users granted global lists can set the global flag
        const canMakeGlobal = session.user.role === 'ADMIN' || session.user.canCreateGlobalLists === true;

        const newList = await prisma.readingList.create({
            data: {
                name,
                description,
                coverUrl,
                isGlobal: isGlobal === true && canMakeGlobal,
                userId: userId // Always preserve the creator's ID
            }
        });

        // Provide both id and listId for unified compatibility with the Library page creation flow
        return NextResponse.json({ success: true, id: newList.id, listId: newList.id, list: newList });
    } catch (error: unknown) {
        Logger.log(`[Reading Lists API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');

        if (!id) return NextResponse.json({ error: "Missing ID" }, { status: 400 });

        const list = await prisma.readingList.findUnique({ where: { id } });
        if (!list) return NextResponse.json({ error: "Not found" }, { status: 404 });

        if (list.userId !== session.user.id && session.user.role !== 'ADMIN') {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        // Clean up items before deleting the list
        await prisma.readingListItem.deleteMany({ where: { listId: id } });
        await prisma.readingList.delete({ where: { id } });
        
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        Logger.log(`[Reading Lists API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}