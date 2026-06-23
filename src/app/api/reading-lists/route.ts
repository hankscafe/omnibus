// src/app/api/reading-lists/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { getAccessibleLibraryIds } from '@/lib/library-access';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;

        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // Per-library access: hide list items whose linked issue is in a library the user can't access.
        // Metadata-only items (no linked issue yet) are kept — they're reading-order placeholders, not content.
        const accessibleLibs = await getAccessibleLibraryIds(userId, (session?.user as any)?.role);
        const itemAccessWhere = accessibleLibs === 'ALL'
            ? {}
            : { OR: [{ issueId: null }, { issue: { series: { libraryId: { in: accessibleLibs } } } }] };

        let lists = await prisma.readingList.findMany({
            where: { OR: [ { userId: userId }, { isGlobal: true }, { userId: null } ] },
            include: {
                user: { select: { username: true } }, // Important for the UI to display the creator of Global lists
                items: {
                    where: itemAccessWhere,
                    orderBy: { order: 'asc' },
                    include: { issue: { include: { series: true } } }
                }
            },
            orderBy: { updatedAt: 'desc' }
        });

        let requiresRefresh = false;
        const missingItemsMeta: { id: string, source: string }[] = [];

        // Auto-link logic: Find items that were imported from a CSV or Auto-builder that have a Metadata ID but no local database linkage yet
        for (const list of lists) {
            for (const item of list.items) {
                if (!item.issueId && item.cvIssueId) {
                    missingItemsMeta.push({ id: item.cvIssueId.toString(), source: item.metadataSource || 'COMICVINE' });
                }
            }
        }

        if (missingItemsMeta.length > 0) {
            const potentialIssues = await prisma.issue.findMany({
                where: { 
                    OR: missingItemsMeta.map(m => ({ metadataId: m.id, metadataSource: m.source }))
                }
            });
            
            const linkUpdates = [];

            for (const list of lists) {
                for (const item of list.items) {
                    if (!item.issueId && item.cvIssueId) {
                        const validIssue = potentialIssues.find(i => i.metadataId === item.cvIssueId!.toString() && i.metadataSource === (item.metadataSource || 'COMICVINE'));
                        
                        if (validIssue) {
                            linkUpdates.push(
                                prisma.readingListItem.update({
                                    where: { id: item.id },
                                    data: { issueId: validIssue.id }
                                })
                            );
                        }
                    }
                }
            }

            if (linkUpdates.length > 0) {
                await prisma.$transaction(linkUpdates);
                requiresRefresh = true;
            }
        }

        if (requiresRefresh) {
            lists = await prisma.readingList.findMany({
                where: { OR: [{ userId: userId }, { isGlobal: true }, { userId: null }] },
                include: {
                    user: { select: { username: true } },
                    items: {
                        where: itemAccessWhere,
                        orderBy: { order: 'asc' },
                        include: { issue: { include: { series: true } } }
                    }
                },
                orderBy: { updatedAt: 'desc' }
            });
        }

        return NextResponse.json(lists);
    } catch (error: unknown) {
        Logger.log(`[Reading Lists API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        
        const userId = (session.user as any).id;
        const { name, description, isGlobal, coverUrl } = await request.json();

        if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

        // Ensure only admins can set the global flag
        const isAdmin = (session.user as any).role === 'ADMIN';

        const canMakeGlobal = (session.user as any).role === 'ADMIN' || (session.user as any).canCreateGlobalLists === true;

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

        if (list.userId !== (session.user as any).id && (session.user as any).role !== 'ADMIN') {
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