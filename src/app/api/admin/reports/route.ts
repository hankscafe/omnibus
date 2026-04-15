import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { AuditLogger } from '@/lib/audit-logger';

export async function GET() {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const reports = await prisma.issueReport.findMany({
            include: {
                user: { select: { username: true } },
                series: { select: { name: true, folderPath: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        return NextResponse.json(reports);
    } catch (e: any) {
        // --- SECURITY FIX 1b: Log real error, hide from client ---
        Logger.log(`[Reports API] Fetch Error: ${e.message}`, 'error');
        return NextResponse.json({ error: "Failed to fetch reports. Please check server logs." }, { status: 500 });
    }
}

export async function PATCH(req: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { id, status, adminComment } = await req.json();

        if (!id) return NextResponse.json({ error: "Missing ID" }, { status: 400 });

        const updated = await prisma.issueReport.update({
            where: { id },
            data: { status, adminComment }
        });

        await AuditLogger.log('RESOLVED_ISSUE_REPORT', { reportId: id, status, comment: adminComment }, (session.user as any).id);
        return NextResponse.json(updated);
    } catch (e: any) {
        // --- SECURITY FIX 1b: Log real error, hide from client ---
        Logger.log(`[Reports API] Update Error: ${e.message}`, 'error');
        return NextResponse.json({ error: "Failed to update report. Please check server logs." }, { status: 500 });
    }
}