import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { prisma } from '@/lib/db';
import { readRateStatus } from '@/lib/metron/client';
import { metronCalls24h } from '@/lib/metron/health';

export const dynamic = 'force-dynamic';

// The Health modal's live Metron limits: what Metron last reported (the Node app and the engine both
// keep it in SystemSetting `metron_rate_status`), when a long 429 last hit, and our own 24h count.
// A database read only - it never asks Metron. `nowMs` lets the modal's countdowns use this clock.
export async function GET() {
    const session = await getServerSession(await getAuthOptions());
    if ((session?.user as { role?: string } | undefined)?.role !== 'ADMIN') {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const rows = await prisma.systemSetting.findMany({ where: { key: { in: ['metron_rate_limit_time', 'metron_api_usage'] } } });
    const value = (key: string) => rows.find((r: { key: string; value: string }) => r.key === key)?.value;
    const nowMs = Date.now();
    return NextResponse.json({
        status: await readRateStatus(),
        rateLimitFlagMs: parseInt(value('metron_rate_limit_time') || '0', 10) || 0,
        localCalls24h: metronCalls24h(value('metron_api_usage'), nowMs),
        nowMs,
    });
}
