// src/lib/pages/page-sweep.ts
//
// Series page sweep, removal phase (issue #189 Phase 3): a BullMQ-driven background run that
// removes every confirmed byte-identical copy of a flagged page across a series. Design points:
//   * SELF-CHAINING CHUNKS: the single BullMQ worker must never be blocked for minutes, so each
//     job invocation processes up to CHUNK files and re-enqueues itself with the remainder —
//     other jobs (metadata syncs, imports) interleave between chunks.
//   * Each file goes through removePagesFromIssue — the exact per-issue core (engine verify +
//     rewrite + fixups + audit), so a sweep can never do anything a manual removal couldn't.
//   * COOPERATIVE CANCEL: a SystemSetting flag is checked before every file; the file in flight
//     always completes atomically, so cancellation can never leave a half-modified archive.
//   * Progress lives in the last_page_sweep_result SystemSetting (the beta.084 sweep pattern):
//     the UI polls it, the admin bell reads it, and a heartbeat lets a stale RUNNING state be
//     recognized after a crash. Per-file outcomes land in JobLog (the beta.004 Tier-2 pattern).
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { SystemNotifier } from '@/lib/notifications';
import { removePagesFromIssue, RemovePagesOutcome } from '@/lib/pages/remove-pages-core';

export const PAGE_SWEEP_RESULT_KEY = 'last_page_sweep_result';
export const PAGE_SWEEP_CANCEL_KEY = 'page_sweep_cancel';
export const PAGE_SWEEP_CHUNK = 5;
/** A RUNNING result whose heartbeat is older than this is treated as dead (crashed mid-sweep). */
export const PAGE_SWEEP_STALE_MS = 5 * 60 * 1000;

export interface PageSweepItem {
    issueId: string;
    entryName: string;
    label: string;
}

export interface PageSweepJobData {
    type: 'PAGE_SWEEP';
    runId: string;
    sourceLabel: string;
    actorUserId: string;
    total: number;
    items: PageSweepItem[];
    processed: number;
    removed: number;
    failed: { label: string; error: string }[];
    startedAt: number;
}

export interface PageSweepResult {
    runId: string;
    status: 'RUNNING' | 'COMPLETED' | 'CANCELLED';
    sourceLabel: string;
    total: number;
    processed: number;
    removed: number;
    failedCount: number;
    failed: { label: string; error: string }[];
    startedAt: number;
    heartbeatAt: number;
    finishedAt?: number;
}

const FAILED_CAP = 50;

async function writeResult(result: PageSweepResult) {
    const value = JSON.stringify(result);
    await prisma.systemSetting.upsert({
        where: { key: PAGE_SWEEP_RESULT_KEY },
        update: { value },
        create: { key: PAGE_SWEEP_RESULT_KEY, value },
    });
}

export async function readSweepResult(): Promise<PageSweepResult | null> {
    const row = await prisma.systemSetting.findUnique({ where: { key: PAGE_SWEEP_RESULT_KEY } });
    if (!row?.value) return null;
    try { return JSON.parse(row.value); } catch { return null; }
}

/** True when a sweep is genuinely in flight (RUNNING + fresh heartbeat) — the one-at-a-time gate. */
export function sweepIsActive(result: PageSweepResult | null, now = Date.now()): boolean {
    return !!result && result.status === 'RUNNING' && now - result.heartbeatAt < PAGE_SWEEP_STALE_MS;
}

async function cancelRequested(runId: string): Promise<boolean> {
    const row = await prisma.systemSetting.findUnique({ where: { key: PAGE_SWEEP_CANCEL_KEY } });
    return row?.value === runId;
}

/**
 * Processes one chunk of a sweep run. `enqueueNext` re-queues the remainder (injected by the
 * queue worker so this module never imports the queue — no cycle, and tests drive it directly).
 */
export async function processPageSweepChunk(
    data: PageSweepJobData,
    enqueueNext: (data: PageSweepJobData) => Promise<unknown>,
    removeFn: typeof removePagesFromIssue = removePagesFromIssue,
): Promise<void> {
    let { items, processed, removed } = data;
    const failed = [...data.failed];

    const finalize = async (status: 'COMPLETED' | 'CANCELLED') => {
        await writeResult({
            runId: data.runId, status, sourceLabel: data.sourceLabel,
            total: data.total, processed, removed,
            failedCount: failed.length, failed: failed.slice(0, FAILED_CAP),
            startedAt: data.startedAt, heartbeatAt: Date.now(), finishedAt: Date.now(),
        });
        await prisma.jobLog.create({
            data: {
                jobType: 'PAGE_SWEEP',
                status: status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
                durationMs: Date.now() - data.startedAt,
                relatedItem: data.sourceLabel,
                message: status === 'COMPLETED'
                    ? `Series page sweep finished: removed ${removed} of ${data.total} matched page(s)${failed.length ? `, ${failed.length} file(s) failed` : ''}.`
                    : `Series page sweep cancelled after ${processed} of ${data.total} file(s) (${removed} removed). Already-removed pages stay removed.`,
            },
        }).catch(() => {});
        SystemNotifier.sendAlert('job_page_sweep', {
            title: status === 'COMPLETED' ? 'Page Sweep Finished' : 'Page Sweep Cancelled',
            description: `"${data.sourceLabel}": ${removed} page(s) removed across ${processed} file(s)${failed.length ? `, ${failed.length} failed` : ''}.`,
        }).catch(() => {});
        Logger.log(`[Page Sweep] ${status} — ${removed}/${data.total} removed for ${data.sourceLabel}.`, status === 'COMPLETED' ? 'success' : 'warn');
    };

    if (await cancelRequested(data.runId)) {
        await finalize('CANCELLED');
        return;
    }

    const chunk = items.slice(0, PAGE_SWEEP_CHUNK);
    for (const item of chunk) {
        // The flag is re-read before every file so a cancel lands within seconds, and always on
        // a file boundary — the file in flight is atomic either way.
        if (await cancelRequested(data.runId)) {
            await finalize('CANCELLED');
            return;
        }
        let outcome: RemovePagesOutcome;
        try {
            outcome = await removeFn(item.issueId, [item.entryName], data.actorUserId, 'sweep');
        } catch (e: any) {
            outcome = { ok: false, status: 500, error: e?.message || 'Unexpected error' };
        }
        processed += 1;
        if (outcome.ok) {
            removed += 1;
            await prisma.jobLog.create({
                data: {
                    jobType: 'PAGE_SWEEP', status: 'COMPLETED',
                    relatedItem: item.label,
                    message: `Removed "${item.entryName}" — ${outcome.newPageCount} page(s) remain${outcome.convertedToCbz ? ' (repacked as CBZ)' : ''}.`,
                },
            }).catch(() => {});
        } else {
            if (failed.length < FAILED_CAP) failed.push({ label: item.label, error: outcome.error });
            await prisma.jobLog.create({
                data: {
                    jobType: 'PAGE_SWEEP', status: 'FAILED',
                    relatedItem: item.label,
                    message: outcome.error,
                },
            }).catch(() => {});
        }
    }

    const remaining = items.slice(chunk.length);
    await writeResult({
        runId: data.runId, status: 'RUNNING', sourceLabel: data.sourceLabel,
        total: data.total, processed, removed,
        failedCount: failed.length, failed: failed.slice(0, FAILED_CAP),
        startedAt: data.startedAt, heartbeatAt: Date.now(),
    });

    if (remaining.length === 0) {
        await finalize('COMPLETED');
        return;
    }
    await enqueueNext({ ...data, items: remaining, processed, removed, failed });
}
