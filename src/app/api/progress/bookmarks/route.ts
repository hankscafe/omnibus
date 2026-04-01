import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import path from 'path';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

// Helper to reliably map a file path to its database Issue ID
async function getIssueFromPath(filePath: string) {
    const normalizedTarget = path.normalize(filePath).replace(/\\/g, '/').toLowerCase();
    const fileName = path.basename(filePath);
    
    const possibleIssues = await prisma.issue.findMany({
        where: { filePath: { contains: fileName } }
    });
    
    return possibleIssues.find(i =>
        i.filePath && path.normalize(i.filePath).replace(/\\/g, '/').toLowerCase() === normalizedTarget
    );
}

export async function GET(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;

        if (!userId) return NextResponse.json({ bookmarks: [] });

        const { searchParams } = new URL(request.url);
        const filePath = searchParams.get('path');
        if (!filePath) return NextResponse.json({ bookmarks: [] });

        const issue = await getIssueFromPath(filePath);
        if (!issue) return NextResponse.json({ bookmarks: [] });

        const bookmarks = await prisma.bookmark.findMany({
            where: { userId, issueId: issue.id },
            orderBy: { pageIndex: 'asc' }
        });

        return NextResponse.json({ bookmarks });
    } catch (error: unknown) {
        Logger.log(`[Bookmark GET Error]: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ bookmarks: [] });
    }
}

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;

        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { filePath, pageIndex, note } = await request.json();
        if (!filePath || pageIndex === undefined) return NextResponse.json({ error: "Missing parameters" }, { status: 400 });

        const issue = await getIssueFromPath(filePath);
        if (!issue) return NextResponse.json({ error: "Issue not found" }, { status: 404 });

        const bookmark = await prisma.bookmark.upsert({
            where: {
                userId_issueId_pageIndex: {
                    userId,
                    issueId: issue.id,
                    pageIndex: parseInt(pageIndex)
                }
            },
            update: { note },
            create: {
                userId,
                issueId: issue.id,
                pageIndex: parseInt(pageIndex),
                note
            }
        });

        return NextResponse.json({ success: true, bookmark });
    } catch (error: unknown) {
        Logger.log(`[Bookmark POST Error]: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;

        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { filePath, pageIndex } = await request.json();
        if (!filePath || pageIndex === undefined) return NextResponse.json({ error: "Missing parameters" }, { status: 400 });

        const issue = await getIssueFromPath(filePath);
        if (!issue) return NextResponse.json({ error: "Issue not found" }, { status: 404 });

        await prisma.bookmark.deleteMany({
            where: {
                userId,
                issueId: issue.id,
                pageIndex: parseInt(pageIndex)
            }
        });

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        Logger.log(`[Bookmark DELETE Error]: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}