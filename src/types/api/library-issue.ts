// src/types/api/library-issue.ts
//
// GET /api/library/issue?id=<issue row id> - one issue's credits, story descriptors and description: the
// series page's detail panel tops the selected issue up from it, and the issue metadata editor loads its
// form from it. A matched issue's first view deep-fetches ComicVine or Metron (and stores what came
// back); every later view reads the row. The route answers from one of three places (the Metron fetch, the
// ComicVine fetch, the row) and every field is REQUIRED on all three: the editor and the reader's tagging
// send what they loaded back through PATCH, so a field missing from one reply is saved as cleared. (Until
// beta.039 the Metron reply carried no inker/editor/translator/tags/ComicInfo fields, and wiped them.)

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
    inker: string[];
    editor: string[];
    translator: string[];
    characters: string[];
    genres: string[];
    storyArcs: string[];
    teams: string[];
    locations: string[];
    /** Sanitized HTML ("" when there's none) - the series page renders it as HTML. */
    description: string;
    // The per-issue ComicInfo remainder: files, embeds and admins set these, never a provider.
    tags: string[];
    mainCharacterOrTeam: string | null;
    alternateSeries: string | null;
    alternateNumber: string | null;
    alternateCount: number | null;
    storyArcNumber: string | null;
    gtin: string | null;
    notes: string | null;
    scanInformation: string | null;
    review: string | null;
    /** true = Yes, false = No, null = Unknown. */
    blackAndWhite: boolean | null;
    communityRating: number | null;
    /** The manual-edits lock. */
    hasCustomMetadata: boolean;
}

/** A reply as a page reads it: the route answers `{ error }` (with a 4xx/5xx) instead, so readers check `error` first. */
export type LibraryIssueDetailReply = LibraryIssueDetail & { error?: string };
