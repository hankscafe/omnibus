// src/lib/job-heal.ts
import { prisma } from './db';

// Auto-heal jobs stuck IN_PROGRESS for over 2 hours — they were almost certainly killed by a
// server restart and would otherwise spin in the UI forever. This used to run inside the admin
// job-logs GET, i.e. a WRITE on a 3-second-polled read path, which fought the engine's scan-time
// write bursts for SQLite's single write lock (issue #183). It now runs from the 60s cron tick,
// with a read-only fast path so the quiet steady state issues no write at all.
export const STUCK_JOB_CUTOFF_MS = 2 * 60 * 60 * 1000;

export async function healStuckJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_JOB_CUTOFF_MS);
  const where = { status: 'IN_PROGRESS', createdAt: { lt: cutoff } } as const;

  const stuck = await prisma.jobLog.count({ where });
  if (stuck === 0) return 0;

  const res = await prisma.jobLog.updateMany({
    where,
    data: {
      status: 'FAILED',
      message: 'Job timed out or the server restarted before completion.',
      durationMs: 0, // Reset duration since it didn't finish
    },
  });
  return res.count;
}
