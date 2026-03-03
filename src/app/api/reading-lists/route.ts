import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

// Forces Next.js to never cache this route so newly built and healed lists appear instantly!
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;

        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // Fetch lists that belong to the user OR are global
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

        for (const list of lists) {
            for (const item of list.items) {
                // 1. GHOST BUSTER: Un-link issues that don't actually have a physical file!
                if (item.issueId && (!item.issue || !item.issue.filePath || item.issue.filePath.length === 0)) {
                    await prisma.readingListItem.update({
                        where: { id: item.id },
                        data: { issueId: null }
                    });
                    requiresRefresh = true;
                }
                // 2. AUTO-LINKER: Only link issues if they possess a physical file!
                else if (!item.issueId && item.cvIssueId) {
                    const potentialIssues = await prisma.issue.findMany({
                        where: { cvId: item.cvIssueId }
                    });
                    
                    const validIssue = potentialIssues.find(i => i.filePath && i.filePath.length > 0);
                    
                    if (validIssue) {
                        await prisma.readingListItem.update({
                            where: { id: item.id },
                            data: { issueId: validIssue.id }
                        });
                        requiresRefresh = true;
                    }
                }
            }
        }

        // If we healed or busted any ghosts, refetch the clean data so the UI updates instantly
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
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
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
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
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
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}