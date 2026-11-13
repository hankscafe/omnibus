// src/types/api/library.ts
//
// The Library page's bulk actions. POST /api/library/rename/preview {seriesIds, patterns} - what
// "Standardize Selected" would rename, one row per downloaded file. The series page's Standardize
// Names dialog previews one series the same way.

/** One file's rename. */
export interface RenamePreviewRow {
    seriesName: string;
    oldPath: string;
    newPath: string;
}

export interface RenamePreviewReply {
    previews?: RenamePreviewRow[];
    error?: string;
}

/** GET /api/library?q=<text>&type=TITLE&limit=<n> - the series whose title matches, as library cards. What
 *  the series page's Move dialog and the Smart Matcher's attach-local dialog read of a card (the Library
 *  page reads the same reply with its own, fuller card type). */
export interface LibrarySeriesHit {
    id: string;
    name: string;
    year: number | null;
}

export interface LibrarySearchReply {
    series?: LibrarySeriesHit[];
    error?: string;
}
