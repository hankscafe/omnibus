// src/app/api/library/issue/pages/sweep/cancel/route.ts
//
// Cooperative sweep cancel (issue #189 Phase 3): sets the cancel flag the chunk worker reads
// between files. BullMQ can't hard-kill an active job — and doesn't need to here: every file is
// atomic, so the run stops cleanly on the next file boundary (worst case a couple of seconds).
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { AuditLogger } from '@/lib/audit-logger';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { PAGE_SWEEP_CANCEL_KEY, readSweepResult } from '@/lib/pages/page-sweep';

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        const body = await request.json().catch(() => ({}));
        const runId: string | undefined = body.runId;
        const current = await readSweepResult();
        if (!runId || current?.runId !== runId || current?.status !== 'RUNNING') {
            return NextResponse.json({ error: "No matching sweep is running." }, { status: 409 });
        }

        await prisma.systemSetting.upsert({
            where: { key: PAGE_SWEEP_CANCEL_KEY },
            update: { value: runId },
            create: { key: PAGE_SWEEP_CANCEL_KEY, value: runId },
        });
        await AuditLogger.log('PAGE_SWEEP_CANCELLED', { runId, processedAtRequest: current.processed }, (session.user as any).id);
        Logger.log(`[Page Sweep] Cancel requested for run ${runId} (stops on the next file boundary).`, 'warn');
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
