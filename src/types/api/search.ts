// src/types/api/search.ts
//
// GET /api/search?q=<name>&provider=COMICVINE|METRON[&page=][&covers=none] - provider volumes (ComicVine)
// or series (Metron) by name, 12 h cached per query and page. The Smart Matcher's auto-scan and Search
// Match read it; so do the request dialog, the series page's Fix Match and the attached-volumes manager.

/** One result, as the route builds it for either provider. */
export interface SearchResultRow {
    /** ComicVine's volume id (a number) or Metron's series id (a string). */
    id: number | string;
    name: string;
    /** ComicVine's start_year (text, or null); Metron's year (a number). */
    year: string | number | null;
    /** 'Unknown' when ComicVine has none. */
    publisher: string;
    count: number;
    /** A /api/library/cover?path=… proxy URL; null when the provider has no cover (or it was skipped). */
    image: string | null;
    description: string;
    /** Metron only: the series page on metron.cloud. */
    siteUrl?: string;
    metadataSource: 'COMICVINE' | 'METRON';
}

/** What the route builds. */
export interface SearchPayload {
    results: SearchResultRow[];
    hasMore: boolean;
}

/** What a page receives (no Dates inside, so the same shape). */
export type SearchResponse = SearchPayload;
/** A reply as a page reads it: the route answers `{ error }` (with a 4xx/5xx) instead. */
export type SearchReply = Partial<SearchResponse> & { error?: string };
export type SearchResult = SearchResultRow;
