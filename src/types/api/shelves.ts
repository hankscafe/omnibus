// src/types/api/shelves.ts
//
// The home page's shelves. GET /api/progress/recent - Continue Reading: the issues the user has started and
// not finished (7, most recently read first). GET /api/library/recent - Recently Added: the 7 series whose
// newest file arrived last. GET /api/recommendations - "Because you read X": up to 7 series sharing a genre
// with a series read lately (another seed each day). Each answers `{ error }` (with a 401/500) instead.

/** A series card on Recently Added and the recommendations shelf. */
export interface ShelfSeriesCard {
    id: string;
    name: string;
    year: number;
    /** The series folder. */
    path: string;
    /** A /api/library/cover URL: the series' own cover, else an issue's, else the folder's (a series always
     *  has a folder). */
    coverUrl: string;
    /** Issues with a file. */
    issueCount: number;
}

export interface RecentSeriesPayload {
    items: ShelfSeriesCard[];
}

export interface RecommendationsPayload {
    series: ShelfSeriesCard[];
    /** The series they were picked for; null when nothing read lately has genres to go on. */
    basedOn: string | null;
}

/** An issue on Continue Reading. */
export interface RecentProgressItem {
    /** The ReadProgress row's id (Mark Unread sends it back). */
    id: string;
    seriesName: string;
    /** The number in the file name ("#12", "issue 12"), else the issue's own. */
    issueNumber: string;
    filePath: string | null;
    /** The series folder. */
    seriesPath: string;
    currentPage: number;
    totalPages: number;
    percentage: number;
    metadataId: string | null;
    metadataSource: string;
    /** A /api/library/cover URL: the series' cover, else the issue's, else the folder's. */
    seriesCoverUrl: string;
}

export interface RecentProgressPayload {
    items: RecentProgressItem[];
}

/** A failed reply: `{ error }`, none of the payload's fields. */
type ErrorReply<T> = { error: string } & { [K in keyof T]?: undefined };

/** What the shelves read: the payload, or `{ error }`. */
export type RecentSeriesReply = RecentSeriesPayload | ErrorReply<RecentSeriesPayload>;
export type RecommendationsReply = RecommendationsPayload | ErrorReply<RecommendationsPayload>;
export type RecentProgressReply = RecentProgressPayload | ErrorReply<RecentProgressPayload>;
