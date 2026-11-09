// src/types/api/series.ts
//
// GET /api/library/series?path=<folder> - one series page: the series' own fields, its issues sorted
// onto shelves (the run, annuals in with it, collected editions, specials - each owned or missing),
// what owned collected editions cover, and folders holding more than one file per number.
import type { Jsonified } from './json';

/** One issue (or book) on a shelf, as the route builds it. */
export interface SeriesIssueRow {
    id: string;
    /** The provider's issue id; null for a file that isn't matched to one. */
    cvId: number | null;
    /** Not matched to a provider issue: no id, or a scan's / an import's `unmatched_…` placeholder. */
    isUnmatched: boolean;
    name: string;
    isAnnual: boolean;
    isSpecial: boolean;
    specialName: string | null;
    /** The attached volume this row belongs to (an annual's lane); null = the run itself. */
    attachedVolumeId: string | null;
    attachmentName: string | null;
    releaseDate: string | null;
    isCollected: boolean;
    collectionName: string | null;
    /** Which run issues a collected book reprints ("1-6, 8"); books only. */
    coversIssues: string | null;
    /** The number as a float for sorting (NaN serializes to null). */
    parsedNum: number;
    number: string;
    fullPath: string | null;
    coverUrl: string | null;
    writers: string[];
    artists: string[];
    characters: string[];
    genres: string[];
    storyArcs: string[];
    isRead: boolean;
    readProgress: number;
    /** A book of a collected edition / special kept as its own series: the series it lives in. */
    retainedSeries?: { id: string; name: string; folderPath: string };
}

/** A row on an owned shelf (downloaded, collected, specials): its file is on disk. */
export type OwnedSeriesIssueRow = SeriesIssueRow & { fullPath: string };

/** A missing run issue an owned collected edition reprints. */
export interface CoveredIssueRow extends SeriesIssueRow {
    coveredBy: { id: string; number: string; name: string; collectionName: string | null };
}

/** A number with more than one file in the folder. */
export interface DuplicateGroup {
    issueNumber: string;
    isAnnual: boolean;
    files: string[];
}

/** ComicInfo defaults for the series editor. */
export interface SeriesComicInfo {
    imprint: string | null;
    format: string | null;
    languageISO: string | null;
    ageRating: string | null;
    communityRating: number | null;
    blackAndWhite: boolean | null;
    gtin: string | null;
    notes: string | null;
    scanInformation: string | null;
    review: string | null;
    mainCharacterOrTeam: string | null;
    alternateSeries: string | null;
    alternateNumber: string | null;
    alternateCount: number | null;
    storyArcNumber: string | null;
    genres: string[];
    writers: string[];
    artists: string[];
    coverArtists: string[];
    colorists: string[];
    letterers: string[];
    characters: string[];
    teams: string[];
    locations: string[];
    storyArcs: string[];
    inker: string[];
    editor: string[];
    translator: string[];
    tags: string[];
}

/** What the route builds. */
export interface SeriesPayload {
    id: string | null;
    isFavorite: boolean;
    isFollowing: boolean;
    cvId: number | null;
    metadataId: string | null;
    metadataSource: string;
    seriesName: string;
    publisher: string | null;
    year: number | null;
    status: string | null;
    bookType: string | null;
    bookTypeSource: string | null;
    monitored: boolean;
    isManga: boolean;
    description: string | null;
    universe: string | null;
    genres: string[];
    seriesGroup: string | null;
    matchState: string;
    path: string;
    coverUrl: string | null;
    hasCustomCover: boolean;
    hasCustomMetadata: boolean;
    comicInfo: SeriesComicInfo;
    downloadedIssues: OwnedSeriesIssueRow[];
    missingIssues: SeriesIssueRow[];
    coveredIssues: CoveredIssueRow[];
    collectedEditions: OwnedSeriesIssueRow[];
    missingCollectedEditions: SeriesIssueRow[];
    specials: OwnedSeriesIssueRow[];
    missingSpecials: SeriesIssueRow[];
    duplicates: DuplicateGroup[];
}

/** What a page receives. */
export type SeriesResponse = Jsonified<SeriesPayload>;
/** A reply as a page reads it: the route answers `{ error }` (with a 4xx/5xx) instead, so readers check `error` first. */
export type SeriesReply = SeriesResponse & { error?: string };
export type SeriesIssue = Jsonified<SeriesIssueRow>;
export type OwnedSeriesIssue = Jsonified<OwnedSeriesIssueRow>;
export type CoveredIssue = Jsonified<CoveredIssueRow>;
