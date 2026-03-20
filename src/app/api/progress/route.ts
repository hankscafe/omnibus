import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import path from 'path';
import { evaluateTrophies } from '@/lib/trophy-evaluator'; 
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

// --- NEW: DEDICATED EXACT PROGRESS FETCH ---
export async function GET(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);

        let userId = (session?.user as any)?.id;
        if (!userId && session?.user?.email) {
            const user = await prisma.user.findUnique({ where: { email: session.user.email } });
            userId = user?.id;
        }

        if (!userId) return NextResponse.json({ currentPage: 0, isCompleted: false });

        const { searchParams } = new URL(request.url);
        const filePath = searchParams.get('path');
        if (!filePath) return NextResponse.json({ currentPage: 0, isCompleted: false });

        const normalizedTarget = path.normalize(filePath).replace(/\\/g, '/').toLowerCase();
        const fileName = path.basename(filePath);

        // Highly efficient lookup to avoid scanning the entire database
        const possibleIssues = await prisma.issue.findMany({
            where: { filePath: { contains: fileName } }
        });

        const issue = possibleIssues.find(i =>
            i.filePath && path.normalize(i.filePath).replace(/\\/g, '/').toLowerCase() === normalizedTarget
        );

        if (!issue) return NextResponse.json({ currentPage: 0, isCompleted: false });

        const progress = await prisma.readProgress.findUnique({
            where: { userId_issueId: { userId, issueId: issue.id } }
        });

        if (progress) {
            return NextResponse.json({
                currentPage: progress.currentPage,
                isCompleted: progress.isCompleted,
                totalPages: progress.totalPages
            });
        }

        return NextResponse.json({ currentPage: 0, isCompleted: false });
    } catch (error: unknown) {
        return NextResponse.json({ currentPage: 0, isCompleted: false });
    }
}

// --- UPDATED POST WITH PATH NORMALIZATION ---
export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);

        let userId = (session?.user as any)?.id;
        if (!userId && session?.user?.email) {
            const user = await prisma.user.findUnique({ where: { email: session.user.email } });
            userId = user?.id;
        }

        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { filePath, currentPage, totalPages } = await request.json();

        const normalizedTarget = path.normalize(filePath).replace(/\\/g, '/').toLowerCase();
        const fileName = path.basename(filePath);

        const possibleIssues = await prisma.issue.findMany({
            where: { filePath: { contains: fileName } }
        });

        const issue = possibleIssues.find(i =>
            i.filePath && path.normalize(i.filePath).replace(/\\/g, '/').toLowerCase() === normalizedTarget
        );

        if (!issue) return NextResponse.json({ error: "Issue not found" }, { status: 404 });

        const isCompleted = currentPage >= totalPages - 2;

        await prisma.readProgress.upsert({
            where: { userId_issueId: { userId, issueId: issue.id } },
            update: {
                currentPage: parseInt(currentPage),
                totalPages: parseInt(totalPages),
                isCompleted,
                updatedAt: new Date()
            },
            create: {
                userId,
                issueId: issue.id,
                currentPage: parseInt(currentPage),
                totalPages: parseInt(totalPages),
                isCompleted
            }
        });

        evaluateTrophies(userId).catch(console.error);

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}