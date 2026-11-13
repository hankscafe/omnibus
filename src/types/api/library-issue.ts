// src/types/api/library-issue.ts
//
// GET /api/library/issue?id=<issue row id> - one issue's credits, story descriptors and description: the
// series page's detail panel tops the selected issue up from it, and the issue metadata editor loads its
// form from it. A matched issue's first view deep-fetches ComicVine or Metron (and stores what came
// back); every later view reads the row. The route answers one of three shapes - Metron's deep fetch
// carries less than the other two - so the fields only some of them carry are optional.

/** A successful reply. */
export interface LibraryIssueDetail {
    number: string;
    name: string | null;
    releaseDate: string | null;
    universe: string | null;
    writers: string[];
    artists: string[];
    coverArtists: string[];
    colorists: string[];
    letterers: string[];
    /** Not on the Metron deep-fetch reply. */
    inker?: string[];
    editor?: string[];
    translator?: string[];
    characters: string[];
    genres: string[];
    storyArcs: string[];
    teams: string[];
    locations: string[];
    /** Sanitized HTML ("" when there's none) - the series page renders it as HTML. */
    description: string;
    // The per-issue ComicInfo remainder: not on the Metron deep-fetch reply.
    tags?: string[];
    mainCharacterOrTeam?: string | null;
    alternateSeries?: string | null;
    alternateNumber?: string | null;
    alternateCount?: number | null;
    storyArcNumber?: string | null;
    gtin?: string | null;
    notes?: string | null;
    scanInformation?: string | null;
    review?: string | null;
    /** true = Yes, false = No, null = Unknown. */
    blackAndWhite?: boolean | null;
    communityRating?: number | null;
    /** The manual-edits lock; not on the Metron deep-fetch reply. */
    hasCustomMetadata?: boolean;
}

/** A reply as a page reads it: the route answers `{ error }` (with a 4xx/5xx) instead, so readers check `error` first. */
export type LibraryIssueDetailReply = LibraryIssueDetail & { error?: string };
