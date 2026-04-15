import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { prisma } from '@/lib/db';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { Logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // --- AUTO-HEAL STUCK JOBS ---
    // If a job has been "IN_PROGRESS" for more than 2 hours, it was likely killed by a server restart.
    // We automatically mark it as FAILED so it stops spinning in the UI forever.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    
    await prisma.jobLog.updateMany({
        where: {
            status: 'IN_PROGRESS',
            createdAt: { lt: twoHoursAgo }
        },
        data: {
            status: 'FAILED',
            message: 'Job timed out or the server restarted before completion.',
            durationMs: 0 // Reset duration since it didn't finish
        }
    });

    const logs = await prisma.jobLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200 // Limit to the last 200 logs to keep the UI fast
    });
    
    return NextResponse.json(logs);
  } catch (error: unknown) {
    Logger.log(`[Job Logs API] Fetch Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;
    const { searchParams } = new URL(request.url);
    const days = searchParams.get('days');

    if (days) {
        // Purge logs older than X days
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - parseInt(days, 10));
        
        const deleted = await prisma.jobLog.deleteMany({
            where: {
                createdAt: {
                    lt: cutoffDate
                }
            }
        });
        if (userId) await AuditLogger.log('CLEARED_JOB_LOGS', { scope: `Older than ${days} days` }, userId);
        return NextResponse.json({ success: true, count: deleted.count });
    } else {
        // Clear ALL historical job logs
        await prisma.jobLog.deleteMany({});
        if (userId) await AuditLogger.log('CLEARED_JOB_LOGS', { scope: 'All logs' }, userId);
        return NextResponse.json({ success: true });
    }
  } catch (error: unknown) {
    Logger.log(`[Job Logs API] Delete Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}