// src/types/api/library.ts
//
// The Library page's bulk actions. POST /api/library/rename/preview {seriesIds, patterns} - what
// "Standardize Selected" would rename, one row per downloaded file.

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
