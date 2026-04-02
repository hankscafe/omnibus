// src/app/api/admin/audit-logs/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function GET() {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const logs = await prisma.auditLog.findMany({
            orderBy: { createdAt: 'desc' },
            take: 300, // Limit to recent 300 to keep the UI fast
            include: {
                user: {
                    select: { username: true }
                }
            }
        });
        return NextResponse.json(logs);
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { searchParams } = new URL(request.url);
        const days = searchParams.get('days');

        if (days) {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - parseInt(days, 10));
            
            const deleted = await prisma.auditLog.deleteMany({
                where: { createdAt: { lt: cutoffDate } }
            });
            return NextResponse.json({ success: true, count: deleted.count });
        } else {
            await prisma.auditLog.deleteMany({});
            return NextResponse.json({ success: true });
        }
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}