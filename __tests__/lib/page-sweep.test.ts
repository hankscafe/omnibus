// __tests__/lib/page-sweep.test.ts
//
// Issue #189 Phase 3: the sweep's chunked BullMQ processor. Pins the contract: chunks of
// PAGE_SWEEP_CHUNK files per invocation with the remainder re-enqueued (the single worker is
// never blocked for a whole sweep), per-file outcomes recorded in JobLog, progress + heartbeat
// written to the result setting, cooperative cancel on a file boundary, and a completion that
// finalizes the result + summary + notification.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    settingFindUnique: vi.fn(),
    settingUpsert: vi.fn(),
    jobLogCreate: vi.fn(),
    sendAlert: vi.fn(),
    log: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findUnique: mocks.settingFindUnique, upsert: mocks.settingUpsert },
        jobLog: { create: mocks.jobLogCreate },
    }
}));
vi.mock('@/lib/pages/remove-pages-core', () => ({ removePagesFromIssue: vi.fn() }));

import { processPageSweepChunk, PageSweepJobData, PAGE_SWEEP_CHUNK, sweepIsActive, PAGE_SWEEP_STALE_MS } from '@/lib/pages/page-sweep';
import { notifierSendAlert } from '../helpers/setup-global';

const item = (n: number) => ({ issueId: `i${n}`, entryName: 'credits.jpg', label: `Series #${n}` });

const jobData = (count: number, overrides: Partial<PageSweepJobData> = {}): PageSweepJobData => ({
    type: 'PAGE_SWEEP', runId: 'run-1', sourceLabel: 'Series #1 — credits.jpg', actorUserId: 'admin1',
    total: count, items: Array.from({ length: count }, (_, i) => item(i + 1)),
    processed: 0, removed: 0, failed: [], startedAt: 1000,
    ...overrides,
});

const lastResultWrite = () => {
    const call = mocks.settingUpsert.mock.calls.filter(c => c[0].where.key === 'last_page_sweep_result').at(-1);
    return call ? JSON.parse(call[0].update.value) : null;
};

beforeEach(() => {
    mocks.settingFindUnique.mockResolvedValue(null); // no cancel flag
    mocks.settingUpsert.mockResolvedValue({});
    mocks.jobLogCreate.mockResolvedValue({});
    notifierSendAlert.mockResolvedValue(undefined);
});

describe('processPageSweepChunk (issue #189 Phase 3)', () => {
    it('processes one chunk, records outcomes, and re-enqueues the remainder', async () => {
        const removeFn = vi.fn().mockResolvedValue({ ok: true, newPageCount: 9, removed: 1, convertedToCbz: false, issueName: 'x' });
        const enqueueNext = vi.fn().mockResolvedValue({});

        await processPageSweepChunk(jobData(8), enqueueNext, removeFn as any);

        expect(removeFn).toHaveBeenCalledTimes(PAGE_SWEEP_CHUNK);
        expect(removeFn).toHaveBeenCalledWith('i1', ['credits.jpg'], 'admin1', 'sweep');
        const next = enqueueNext.mock.calls[0][0];
        expect(next.items).toHaveLength(8 - PAGE_SWEEP_CHUNK);
        expect(next.processed).toBe(PAGE_SWEEP_CHUNK);
        expect(next.removed).toBe(PAGE_SWEEP_CHUNK);
        const result = lastResultWrite();
        expect(result.status).toBe('RUNNING');
        expect(result.processed).toBe(PAGE_SWEEP_CHUNK);
        expect(result.heartbeatAt).toBeGreaterThan(0);
        // Per-file JobLog rows, all COMPLETED.
        const logs = mocks.jobLogCreate.mock.calls.map(c => c[0].data);
        expect(logs.filter(l => l.status === 'COMPLETED' && l.jobType === 'PAGE_SWEEP')).toHaveLength(PAGE_SWEEP_CHUNK);
    });

    it('finalizes COMPLETED with summary + notification when the last chunk drains', async () => {
        const removeFn = vi.fn().mockResolvedValue({ ok: true, newPageCount: 5, removed: 1, convertedToCbz: false, issueName: 'x' });
        const enqueueNext = vi.fn();

        await processPageSweepChunk(jobData(2, { processed: 6, removed: 5, total: 8 }), enqueueNext, removeFn as any);

        expect(enqueueNext).not.toHaveBeenCalled();
        const result = lastResultWrite();
        expect(result.status).toBe('COMPLETED');
        expect(result.processed).toBe(8);
        expect(result.removed).toBe(7);
        expect(result.finishedAt).toBeGreaterThan(0);
        const summary = mocks.jobLogCreate.mock.calls.map(c => c[0].data).find(l => l.message?.includes('sweep finished'));
        expect(summary).toBeTruthy();
        expect(notifierSendAlert).toHaveBeenCalledWith('job_page_sweep', expect.objectContaining({ title: 'Page Sweep Finished' }));
    });

    it('collects failures without stopping the run', async () => {
        const removeFn = vi.fn()
            .mockResolvedValueOnce({ ok: false, status: 400, error: 'At least one page must remain.' })
            .mockResolvedValue({ ok: true, newPageCount: 5, removed: 1, convertedToCbz: false, issueName: 'x' });
        const enqueueNext = vi.fn();

        await processPageSweepChunk(jobData(3), enqueueNext, removeFn as any);

        const result = lastResultWrite();
        expect(result.status).toBe('COMPLETED');
        expect(result.removed).toBe(2);
        expect(result.failedCount).toBe(1);
        expect(result.failed[0]).toMatchObject({ label: 'Series #1', error: expect.stringContaining('one page must remain') });
        const failedLog = mocks.jobLogCreate.mock.calls.map(c => c[0].data).find(l => l.status === 'FAILED' && l.relatedItem === 'Series #1');
        expect(failedLog).toBeTruthy();
    });

    it('cancels cooperatively on the file boundary and finalizes CANCELLED', async () => {
        // Cancel flag appears after the first file is processed.
        let processedOne = false;
        mocks.settingFindUnique.mockImplementation(async ({ where }: any) => {
            if (where.key === 'page_sweep_cancel') return processedOne ? { value: 'run-1' } : null;
            return null;
        });
        const removeFn = vi.fn().mockImplementation(async () => {
            processedOne = true;
            return { ok: true, newPageCount: 5, removed: 1, convertedToCbz: false, issueName: 'x' };
        });
        const enqueueNext = vi.fn();

        await processPageSweepChunk(jobData(5), enqueueNext, removeFn as any);

        expect(removeFn).toHaveBeenCalledTimes(1);
        expect(enqueueNext).not.toHaveBeenCalled();
        const result = lastResultWrite();
        expect(result.status).toBe('CANCELLED');
        expect(notifierSendAlert).toHaveBeenCalledWith('job_page_sweep', expect.objectContaining({ title: 'Page Sweep Cancelled' }));
    });

    it("a cancel flag for a DIFFERENT run doesn't stop this one", async () => {
        mocks.settingFindUnique.mockResolvedValue({ value: 'someone-elses-run' });
        const removeFn = vi.fn().mockResolvedValue({ ok: true, newPageCount: 5, removed: 1, convertedToCbz: false, issueName: 'x' });

        await processPageSweepChunk(jobData(2), vi.fn(), removeFn as any);

        expect(removeFn).toHaveBeenCalledTimes(2);
        expect(lastResultWrite().status).toBe('COMPLETED');
    });
});

describe('sweepIsActive', () => {
    const base = { runId: 'r', sourceLabel: 's', total: 1, processed: 0, removed: 0, failedCount: 0, failed: [], startedAt: 0 } as any;
    it('is active only for RUNNING with a fresh heartbeat', () => {
        const now = 1_000_000_000;
        expect(sweepIsActive({ ...base, status: 'RUNNING', heartbeatAt: now - 1000 }, now)).toBe(true);
        expect(sweepIsActive({ ...base, status: 'RUNNING', heartbeatAt: now - PAGE_SWEEP_STALE_MS - 1 }, now)).toBe(false);
        expect(sweepIsActive({ ...base, status: 'COMPLETED', heartbeatAt: now }, now)).toBe(false);
        expect(sweepIsActive(null, now)).toBe(false);
    });
});
