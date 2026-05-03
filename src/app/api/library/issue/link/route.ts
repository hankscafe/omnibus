import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { AuditLogger } from '@/lib/audit-logger';

export async function POST(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

    try {
        const { unmatchedId, targetId } = await request.json();
        
        const unmatched = await prisma.issue.findUnique({ where: { id: unmatchedId } });
        const target = await prisma.issue.findUnique({ where: { id: targetId } });

        if (!unmatched || !target) return NextResponse.json({ error: "Issue not found" }, { status: 404 });

        // 1. Move the physical file mapping to the official target record
        await prisma.issue.update({
            where: { id: target.id },
            data: { 
                filePath: unmatched.filePath, 
                status: 'DOWNLOADED',
                pageCount: unmatched.pageCount // Carry over the page count
            }
        });

        // 2. Delete the temporary unmatched skeleton
        await prisma.issue.delete({ where: { id: unmatched.id } });

        await AuditLogger.log('LINKED_UNMATCHED_ISSUE', { targetName: target.name, file: unmatched.filePath }, (session.user as any).id);

        return NextResponse.json({ success: true });
    } catch (error: any) {
        Logger.log(`[Issue Link API] Error: ${error.message}`, 'error');
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}