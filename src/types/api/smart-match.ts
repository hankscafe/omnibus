// src/types/api/smart-match.ts
//
// The Smart Matcher's own routes: the unmatched list it works through, the background sweep's status,
// an item's local evidence (match-prefill), the page-preview info, and what an Accept answers.
import type { JobLog, Series } from '@prisma/client';
import type { MatchPrefill } from '@/lib/utils/match-prefill';
import type { Jsonified } from './json';

// --- GET /api/admin/unmatched[?includeIgnored=1] ---------------------------------------------------

/** An UNMATCHED (or, with includeIgnored=1, IGNORED) series row. */
export type UnmatchedSeriesRow = Series & { isIgnored: boolean };

/** A comic file sitting loose in the awaiting-match folder: no database row yet. */
export interface UnmatchedRawFileRow {
    /** `raw_<base64 of the file name>` - stable for the page, never a database id. */
    id: string;
    /** The file name without its extension (the search guess starts from it). */
    name: string;
    /** The file's full path. */
    folderPath: string;
    isRawFile: true;
}

/** What the route builds: the series rows (by name), then the loose files. */
export type UnmatchedPayload = (UnmatchedSeriesRow | UnmatchedRawFileRow)[];

/** A series card as the page holds it. */
export type UnmatchedSeries = Jsonified<UnmatchedSeriesRow> & { isRawFile?: undefined };
/** A loose-file card as the page holds it: the series-only fields the page reads are absent. */
export type UnmatchedRawFile = Jsonified<UnmatchedRawFileRow> & { year?: undefined; imprint?: undefined; isIgnored?: boolean };
/** One Smart Matcher card. */
export type UnmatchedItem = UnmatchedSeries | UnmatchedRawFile;

// --- GET /api/admin/sweep ---------------------------------------------------------------------------

/** The engine's record of its latest unmatched sweep (SystemSetting last_unmatched_sweep_result, written by
 *  matcher.rs / main.rs): COMPLETED carries the counts, SKIPPED the mode, FAILED the error. */
export interface SweepResult {
    status: 'COMPLETED' | 'SKIPPED' | 'FAILED';
    /** Epoch milliseconds. */
    finishedAt: number;
    mode?: string;
    total?: number;
    byFile?: number;
    bySearch?: number;
    forAdmin?: number;
    deferred?: number;
    searches?: number;
    error?: string;
}

/** What the route builds. */
export interface SweepPayload {
    /** When a sweep was last queued: epoch milliseconds, as the setting's text. */
    lastTriggered: string | null;
    lastResult: SweepResult | null;
    matcherMode: string;
    scheduleHours: string;
    /** The last 10 UNMATCHED_SWEEP job logs, newest first. */
    history: JobLog[];
}

/** What a page receives. */
export type SweepInfo = Jsonified<SweepPayload>;

// --- GET /api/admin/match-prefill?path= -------------------------------------------------------------

/** An item's local evidence (ComicInfo.xml / series.json / the scan-banked row). `hasContent` is true exactly
 *  when `prefill` carries something (prefillHasContent); a failed read answers `{ error }`. */
export type PrefillReply =
    | { hasContent: true; prefill: MatchPrefill }
    | { hasContent: false; prefill: MatchPrefill | null }
    | { hasContent?: undefined; prefill?: undefined; error: string };

// --- GET /api/library/archive-preview?path=&info=1 --------------------------------------------------

/** The archive a preview shows (a folder's first by natural sort) and its page count (0 = unreadable). */
export interface ArchivePreviewInfo {
    file: string | null;
    pageCount: number;
}

// --- POST /api/library/match-series (+ /bulk) -------------------------------------------------------

/** The series already filed in the folder a match would take (409 from match-series). */
export interface FolderCollision {
    seriesId: string;
    seriesName: string;
    year: number | null;
    publisher?: string | null;
    metadataSource?: string;
    metadataId?: string | null;
    folderPath: string;
    suggestedFolderName: string;
    volumeName: string;
    volumeYear?: number | null;
}

/** A match that went through. An attach-as-collected answer (the collision's usual resolution) also
 *  says where the volume went and what moved. */
export interface MatchSeriesOk {
    success: true;
    newPath: string;
    metadataId: string;
    conflicts: number;
    /** Open requests the match closed (plain accepts). */
    requestsClosed?: number;
    attachedTo?: { id: string; name: string; folderPath: string };
    attachmentId?: string;
    moved?: number;
    absorbed?: number;
    claimed?: number;
    skeletonsReplaced?: number;
}

/** A match that didn't: 4xx/5xx with the reason; a 409 also names the folder's owner. */
export interface MatchSeriesFailure {
    error: string;
    collision?: FolderCollision;
    attachmentId?: string;
}

/** One item's outcome in a bulk accept, in request order. */
export interface BulkMatchResult {
    ok: boolean;
    conflicts?: number;
    requestsClosed?: number;
    error?: string;
}

export interface BulkMatchReply {
    results?: BulkMatchResult[];
    error?: string;
}
