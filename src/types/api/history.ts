// src/types/api/history.ts
//
// GET /api/progress/history - every issue the user has opened, most recently read first, for the
// Reading History page.
import type { Jsonified } from './json';

/** One issue, as the route builds it. */
export interface HistoryEntryRow {
    /** The progress row's id. */
    id: string;
    seriesName: string;
    issueNumber: string;
    /** null when the issue's file has gone since. */
    filePath: string | null;
    seriesPath: string;
    /** 0-100. */
    percentage: number;
    isCompleted: boolean;
    updatedAt: Date;
    metadataId: string | null;
    metadataSource: string;
    /** A /api/library/cover URL (series art, the issue's cover, or the series folder's); null when none. */
    seriesCoverUrl: string | null;
}

/** What a page receives. */
export type HistoryEntry = Jsonified<HistoryEntryRow>;
