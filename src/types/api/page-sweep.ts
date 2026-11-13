// src/types/api/page-sweep.ts
//
// The series page sweep (issue #189 Phase 3, Remove This Page Everywhere): the dialog scans the series in
// batches, then polls the background run it started.
import type { PageSweepResult } from '@/lib/pages/page-sweep';

/** A byte-identical copy of the source page in one of the batch's files. */
export interface PageSweepMatch {
    issueId: string;
    label: string;
    filePath: string;
    entryName: string;
    /** The page's position in its archive (0 = the first page). */
    index: number;
}

/** POST /api/library/issue/pages/sweep/scan {sourceIssueId, sourceEntry, candidateIssueIds} - one batch. */
export interface PageSweepScanPayload {
    matches: PageSweepMatch[];
    /** Files the engine can't rewrite (a real RAR): convert first. */
    skipped: { issueId: string; label: string; reason: string }[];
    errors: { issueId: string; label: string; error: string }[];
    sourceHash?: string;
}

/** A scan reply as the dialog reads it: the route answers `{ error }` (with a 4xx/5xx) instead. */
export type PageSweepScanReply = Partial<PageSweepScanPayload> & { error?: string };

/** GET /api/library/issue/pages/sweep - the latest run's result (null before the first sweep). */
export interface PageSweepStatusPayload {
    result: PageSweepResult | null;
    active: boolean;
}

export type PageSweepStatusReply = Partial<PageSweepStatusPayload> & { error?: string };
