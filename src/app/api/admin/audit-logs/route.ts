// src/app/api/admin/audit-logs/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { AuditLogger } from '@/lib/audit-logger';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

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
        Logger.log(`[Audit Logs API] Error: ${getErrorMessage(error)}`, 'error');
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
        const currentUserId = (session?.user as any)?.id;

        if (days) {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - parseInt(days, 10));
            
            const deleted = await prisma.auditLog.deleteMany({
                where: { createdAt: { lt: cutoffDate } }
            });
            
            // Log the action BEFORE returning
            await AuditLogger.log('CLEARED_AUDIT_LOGS', { scope: `Older than ${days} days` }, currentUserId);
            
            return NextResponse.json({ success: true, count: deleted.count });
        } else {
            await prisma.auditLog.deleteMany({});
            
            // Log the action BEFORE returning
            await AuditLogger.log('CLEARED_AUDIT_LOGS', { scope: 'ALL' }, currentUserId);
            
            return NextResponse.json({ success: true });
        }
        
    } catch (error: unknown) {
        Logger.log(`[Audit Logs API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}