// src/types/api/request.ts
//
// GET /api/request - the signed-in user's own requests, newest first, each with the series it belongs to
// (when that series is in the library) and a cover a page can show. Read by the Profile page's recent
// activity, the requests page, the request dialogs and the library pages (the "already requested" checks).
import type { Jsonified } from './json';

/** One request, as the route builds it. */
export interface RequestRow {
    id: string;
    userId: string;
    /** The provider's volume / series id the request is for. */
    volumeId: string;
    metadataSource: string;
    /** The series' folder, when the series is in the library. */
    seriesPath: string | null;
    /** What the request is called: the download's name, else "Series #N (year)", else "Volume <id>". */
    seriesName: string;
    activeDownloadName: string | null;
    /** The signed-in user's name (every row is theirs). */
    userName: string;
    createdAt: Date;
    updatedAt: Date;
    status: string;
    progress: number;
    downloadLink: string | null;
    /** The indexer or source that found the download. */
    indexer: string | null;
    /** A /api/library/cover proxy URL for a remote cover; a local one as stored. */
    imageUrl: string | null;
    retryCount: number;
}

/** What a page receives. */
export type RequestListItem = Jsonified<RequestRow>;
