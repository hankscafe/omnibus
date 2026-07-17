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
    // Defense-in-depth behind the middleware /api/admin/* gate.
    const session = await getServerSession(await getAuthOptions());
    if ((session?.user as any)?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

    // Stuck-job auto-heal lives in the 60s cron tick now (lib/job-heal.ts) — this route is
    // polled every 3 seconds by the admin UI, and a write here contended with the engine's
    // scan-time write bursts for SQLite's single write lock (issue #183). Pure read path.
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
    if ((session?.user as any)?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
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