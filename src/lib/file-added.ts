// src/lib/file-added.ts
//
// Issue.fileAddedAt — when a row's current file ARRIVED (#206 follow-up). Issue.createdAt is row
// birth: a download that fills a WANTED placeholder keeps the skeleton's old createdAt (the Series
// Monitor makes skeletons up to 90 days before release), so everything that meant "new in your
// library" — Recently Added, the Updates feed, the bell, the weekly digest, stats and the Komga
// facade's "Recently updated series" — missed the most common arrival there is. Every write that
// gives a row a file applies one of three rules; the engine twin is omnibus-engine/src/file_added.rs.
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

type RowFile = { filePath?: string | null; fileAddedAt?: Date | null };

const hasFile = (row: RowFile | null | undefined) => !!(row?.filePath && row.filePath.trim().length > 0);

/**
 * A download landing on a row (new or existing): an arrival — stamped now, unless the row already
 * had a file. A replacement or upgrade is not a new issue, and re-announcing it would be noise.
 * Returns a fragment to spread into the write's `data`.
 */
export function arrivalStamp(existing: RowFile | null, now: Date = new Date()): { fileAddedAt?: Date } {
    return hasFile(existing) ? {} : { fileAddedAt: now };
}

/**
 * A scan pointing a row at a file it found on disk: an existing stamp stands (a file renamed
 * outside Omnibus did not arrive again); without one, a row that had no file takes now, and a
 * file-backed row that predates the column takes its own birth.
 */
export function rescanStamp(existing: RowFile & { createdAt: Date }, now: Date = new Date()): { fileAddedAt?: Date } {
    if (existing.fileAddedAt) return {};
    return { fileAddedAt: hasFile(existing) ? existing.createdAt : now };
}

/**
 * A file re-homed from another row (Smart Matcher accept, issue link): it keeps THAT row's time —
 * it was announced when it first appeared, and matching it later must not announce it again. A
 * file that never had a row is appearing in the library for the first time: now.
 */
export function carriedStamp(source: { fileAddedAt?: Date | null; createdAt: Date } | null, now: Date = new Date()): Date {
    return source?.fileAddedAt ?? source?.createdAt ?? now;
}

/**
 * Startup backfill: every file-backed row without a stamp takes its createdAt, so the column's
 * arrival changes nothing anyone sees — today's order survives, nothing old surfaces as new.
 * Idempotent (runs every start); the one plain statement is valid on SQLite and Postgres alike.
 */
export async function backfillFileAddedAt(): Promise<number> {
    try {
        const n = await prisma.$executeRawUnsafe(
            `UPDATE "Issue" SET "fileAddedAt" = "createdAt" WHERE "fileAddedAt" IS NULL AND "filePath" IS NOT NULL AND "filePath" <> ''`
        );
        if (n > 0) Logger.log(`[DB Init] Backfilled the arrival time of ${n} file-backed issue(s) from their creation time.`, 'info');
        return n;
    } catch (e) {
        Logger.log(`[DB Init] fileAddedAt backfill failed: ${getErrorMessage(e)}`, 'error');
        return 0;
    }
}
