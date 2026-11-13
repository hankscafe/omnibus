// src/types/api/attachments.ts
//
// POST /api/library/series/attachments - attach a volume (annuals, a collected edition, a special) to a series.

/** {seriesId, metadataSource: 'LOCAL', kind: 'COLLECTED', name, sourcePath}: a folder or file the provider has
 *  no volume for (the Smart Matcher's attach-local dialog), attached as a local collected edition - its files
 *  move into the series' folder under their own names. What a successful attach answers. */
export interface LocalCollectedAttached {
    success: true;
    local: true;
    /** Always set once the attach got this far. */
    attachmentId?: string;
    name: string;
    summary: null;
    moved: number;
    absorbed: number;
    claimed: number;
    skeletonsReplaced: number;
    /** Files left where they were: a file of that name was already in the series' folder. */
    conflicts: number;
}
