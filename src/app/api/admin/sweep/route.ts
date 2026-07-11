// src/app/api/admin/sweep/route.ts
//
// Read-side of the unmatched-series retry sweep (discussion #177) for the Smart Matcher UI:
// the engine persists a structured result per run (SystemSetting last_unmatched_sweep_result)
// plus an UNMATCHED_SWEEP JobLog; this endpoint bundles both with the matcher settings so the
// page can show "what the background sweep did" in one fetch. Triggering a run stays on the
// shared /api/admin/jobs/trigger route.
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { prisma } from '@/lib/db';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Defense-in-depth behind the middleware /api/admin/* gate.
    const session = await getServerSession(await getAuthOptions());
    if ((session?.user as any)?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

    const [settings, history] = await Promise.all([
      prisma.systemSetting.findMany({
        where: { key: { in: ['last_unmatched_sweep', 'last_unmatched_sweep_result', 'matcher_mode', 'unmatched_sweep_schedule'] } }
      }),
      prisma.jobLog.findMany({
        where: { jobType: 'UNMATCHED_SWEEP' },
        orderBy: { createdAt: 'desc' },
        take: 10
      })
    ]);
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

    let lastResult: any = null;
    if (config.last_unmatched_sweep_result) {
      try { lastResult = JSON.parse(config.last_unmatched_sweep_result); } catch { /* pre-upgrade or corrupt value — treat as no result */ }
    }

    return NextResponse.json({
      lastTriggered: config.last_unmatched_sweep || null,
      lastResult,
      matcherMode: config.matcher_mode || 'confirm',
      scheduleHours: config.unmatched_sweep_schedule || '1',
      history
    });
  } catch (error: unknown) {
    Logger.log(`[Sweep API] Fetch Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
