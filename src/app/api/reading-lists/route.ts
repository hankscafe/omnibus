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
        const userId = (session?.user as any)?.id;

        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        let lists = await prisma.readingList.findMany({
            where: { OR: [ { userId: userId }, { userId: null } ] },
            include: {
                items: {
                    orderBy: { order: 'asc' },
                    include: { issue: { include: { series: true } } }
                }
            },
            orderBy: { updatedAt: 'desc' }
        });

        let requiresRefresh = false;
        const unlinkIds: string[] = [];
        const missingCvIssueIds: number[] = [];

        for (const list of lists) {
            for (const item of list.items) {
                if (item.issueId && (!item.issue || !item.issue.filePath || item.issue.filePath.length === 0)) {
                    unlinkIds.push(item.id);
                }
                else if (!item.issueId && item.cvIssueId) {
                    missingCvIssueIds.push(item.cvIssueId);
                }
            }
        }

        if (unlinkIds.length > 0) {
            await prisma.readingListItem.updateMany({
                where: { id: { in: unlinkIds } },
                data: { issueId: null }
            });
            requiresRefresh = true;
        }

        if (missingCvIssueIds.length > 0) {
            const potentialIssues = await prisma.issue.findMany({
                where: { 
                    metadataId: { in: missingCvIssueIds.map(String) },
                    metadataSource: 'COMICVINE',
                    filePath: { not: null } 
                }
            });
            
            const linkUpdates = [];

            for (const list of lists) {
                for (const item of list.items) {
                    if (!item.issueId && item.cvIssueId) {
                        const validIssue = potentialIssues.find(i => i.metadataId === item.cvIssueId!.toString() && i.filePath && i.filePath.length > 0);
                        
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
                where: { OR: [{ userId: userId }, { userId: null }] },
                include: {
                    items: {
                        orderBy: { order: 'asc' },
                        include: { issue: { include: { series: true } } }
                    }
                },
                orderBy: { updatedAt: 'desc' }
            });
        }

        return NextResponse.json(lists);
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        
        const userId = (session.user as any).id;
        const { name, description, isGlobal } = await request.json();

        if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

        const newList = await prisma.readingList.create({
            data: {
                name,
                description,
                userId: isGlobal && session.user.role === 'ADMIN' ? null : userId 
            }
        });

        return NextResponse.json(newList);
    } catch (error: unknown) {
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

        if (list.userId !== (session.user as any).id && session.user.role !== 'ADMIN') {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        await prisma.readingList.delete({ where: { id } });
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}