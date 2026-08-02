// Issue #183: the stuck-job auto-heal used to run as a WRITE inside the 3s-polled admin
// job-logs GET, contending with the engine's scan-time write bursts for SQLite's single write
// lock. It now runs from the 60s cron tick — and must be READ-ONLY when nothing is stuck.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { healStuckJobs, STUCK_JOB_CUTOFF_MS } from '@/lib/job-heal';

const mocks = vi.hoisted(() => ({
    count: vi.fn(),
    updateMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: { jobLog: { count: mocks.count, updateMany: mocks.updateMany } },
}));

describe('healStuckJobs', () => {

    it('issues NO write when nothing is stuck (the steady state, every 60s)', async () => {
        mocks.count.mockResolvedValue(0);

        const healed = await healStuckJobs();

        expect(healed).toBe(0);
        expect(mocks.updateMany).not.toHaveBeenCalled();
    });

    it('fails jobs stuck IN_PROGRESS beyond the 2h cutoff and reports the count', async () => {
        mocks.count.mockResolvedValue(2);
        mocks.updateMany.mockResolvedValue({ count: 2 });

        const healed = await healStuckJobs();

        expect(healed).toBe(2);
        const args = mocks.updateMany.mock.calls[0][0];
        expect(args.where.status).toBe('IN_PROGRESS');
        // The cutoff is ~2h ago (allow scheduling slack around the Date.now() capture).
        const cutoffAge = Date.now() - args.where.createdAt.lt.getTime();
        expect(Math.abs(cutoffAge - STUCK_JOB_CUTOFF_MS)).toBeLessThan(5000);
        expect(args.data.status).toBe('FAILED');
        expect(args.data.durationMs).toBe(0);
    });

    it('propagates DB errors to the caller (cron swallows them, the heal itself must not lie)', async () => {
        mocks.count.mockRejectedValue(new Error('SQLITE_BUSY'));

        await expect(healStuckJobs()).rejects.toThrow('SQLITE_BUSY');
        expect(mocks.updateMany).not.toHaveBeenCalled();
    });
});
