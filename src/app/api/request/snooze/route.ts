// src/app/api/request/snooze/route.ts
// Persist a System Health dismissal for a request. Snoozing a STALLED / AWAITING_RELEASE item hides it
// from the health check and pauses its automatic retry sweep until the snooze expires (issue #175).
import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const token = await getToken({ req: request });
  if (!token || token.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = (token.id || token.sub) as string;

  try {
    const body = await request.json();
    const { requestId, ids, days, clear } = body as {
      requestId?: string; ids?: string[]; days?: number; clear?: boolean;
    };

    // Accept a single id or a batch.
    const targetIds = [...new Set([...(ids || []), ...(requestId ? [requestId] : [])])].filter(Boolean);
    if (targetIds.length === 0) {
      return NextResponse.json({ error: 'Missing requestId or ids' }, { status: 400 });
    }

    // clear:true un-snoozes; otherwise snooze for `days` (default 30, clamped to 1..3650).
    let snoozedUntil: Date | null = null;
    if (!clear) {
      const snoozeDays = Math.min(3650, Math.max(1, Number.isFinite(days) ? Number(days) : 30));
      snoozedUntil = new Date(Date.now() + snoozeDays * 24 * 60 * 60 * 1000);
    }

    const result = await prisma.request.updateMany({
      where: { id: { in: targetIds } },
      data: { snoozedUntil },
    });

    await AuditLogger.log('SNOOZE_REQUEST_HEALTH', {
      requestIds: targetIds,
      count: result.count,
      snoozedUntil: snoozedUntil ? snoozedUntil.toISOString() : null,
      cleared: !!clear,
    }, userId);

    return NextResponse.json({ success: true, updated: result.count, snoozedUntil });
  } catch (error: unknown) {
    Logger.log(`[Request Snooze API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
