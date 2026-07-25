// src/app/api/library/issue/pages/sweep/route.ts
//
// Series page sweep (issue #189 Phase 3): POST enqueues the background removal run over the
// confirmed matches; GET returns the live result/progress (the UI polls it; safe after the tab
// that started the sweep is long gone). One sweep at a time — a RUNNING result with a fresh
// heartbeat blocks a second enqueue; a stale RUNNING (crash mid-sweep) does not.
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { AuditLogger } from '@/lib/audit-logger';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { omnibusQueue } from '@/lib/queue';
import {
    readSweepResult, sweepIsActive, PageSweepJobData, PageSweepItem,
    PAGE_SWEEP_RESULT_KEY, PAGE_SWEEP_CANCEL_KEY,
} from '@/lib/pages/page-sweep';

const MAX_ITEMS = 2000;

export async function GET() {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        const result = await readSweepResult();
        return NextResponse.json({ result, active: sweepIsActive(result) });
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        const body = await request.json();
        const sourceIssueId: string | undefined = body.sourceIssueId;
        const sourceEntry: string | undefined = body.sourceEntry;
        const rawItems: any[] = Array.isArray(body.items) ? body.items : [];
        if (!sourceIssueId || !sourceEntry) return NextResponse.json({ error: "Missing sweep source." }, { status: 400 });
        if (rawItems.length === 0) return NextResponse.json({ error: "No matches selected." }, { status: 400 });
        if (rawItems.length > MAX_ITEMS) return NextResponse.json({ error: `Too many items (max ${MAX_ITEMS}).` }, { status: 400 });

        const existing = await readSweepResult();
        if (sweepIsActive(existing)) {
            return NextResponse.json({ error: "A page sweep is already running — wait for it to finish or cancel it first." }, { status: 409 });
        }

        // Labels + scope come from the DB, never the client: every item must be a file-backed
        // issue in the SOURCE issue's series.
        const source = await prisma.issue.findUnique({ where: { id: sourceIssueId }, include: { series: true } });
        if (!source) return NextResponse.json({ error: "Source issue not found." }, { status: 404 });
        const ids = [...new Set(rawItems.map(i => String(i?.issueId || '')).filter(Boolean))];
        const issues = await prisma.issue.findMany({
            where: { id: { in: ids }, seriesId: source.seriesId, filePath: { not: null } },
            select: { id: true, number: true },
        });
        const byId = new Map(issues.map(i => [i.id, i]));
        const items: PageSweepItem[] = [];
        for (const raw of rawItems) {
            const issue = byId.get(String(raw?.issueId || ''));
            const entryName = typeof raw?.entryName === 'string' ? raw.entryName : '';
            if (!issue || !entryName) continue;
            items.push({ issueId: issue.id, entryName, label: `${source.series?.name || ''} #${issue.number}` });
        }
        if (items.length === 0) return NextResponse.json({ error: "No valid matches in this series." }, { status: 400 });

        const runId = crypto.randomUUID();
        const sourceLabel = `${source.series?.name || ''} #${source.number} — ${sourceEntry}`;
        const startedAt = Date.now();

        // Reset the cancel flag from any earlier run, then publish the initial RUNNING state
        // BEFORE enqueueing so the guard above can never race a second submit past us.
        await prisma.systemSetting.upsert({
            where: { key: PAGE_SWEEP_CANCEL_KEY }, update: { value: '' }, create: { key: PAGE_SWEEP_CANCEL_KEY, value: '' },
        });
        const initial = {
            runId, status: 'RUNNING', sourceLabel, total: items.length,
            processed: 0, removed: 0, failedCount: 0, failed: [],
            startedAt, heartbeatAt: startedAt,
        };
        await prisma.systemSetting.upsert({
            where: { key: PAGE_SWEEP_RESULT_KEY },
            update: { value: JSON.stringify(initial) },
            create: { key: PAGE_SWEEP_RESULT_KEY, value: JSON.stringify(initial) },
        });

        const data: PageSweepJobData = {
            type: 'PAGE_SWEEP', runId, sourceLabel, actorUserId: (session.user as any).id,
            total: items.length, items, processed: 0, removed: 0, failed: [], startedAt,
        };
        await omnibusQueue.add('PAGE_SWEEP', data, { jobId: `PAGE_SWEEP_${runId}_0` });

        await AuditLogger.log('PAGE_SWEEP_STARTED', {
            source: sourceLabel, matchedFiles: items.length,
        }, (session.user as any).id);
        Logger.log(`[Page Sweep] Queued: "${sourceLabel}" across ${items.length} file(s) (issue #189).`, 'info');

        return NextResponse.json({ success: true, runId, total: items.length });
    } catch (error: unknown) {
        Logger.log(`[Page Sweep] Enqueue failed: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
