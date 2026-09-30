// src/lib/metadata/provider.ts
export interface MetadataSeries {
    sourceId: string;
    source: 'COMICVINE' | 'METRON' | 'ANILIST';
    name: string;
    year: number;
    publisher: string;
    universe?: string | null;
    description: string | null;
    coverUrl: string | null;
    /** The cover was asked for but skipped (the provider was busy, or the request failed) - unlike a
     *  null coverUrl on its own, which means the series has no cover. A page carrying one isn't cached. */
    coverPending?: boolean;
    status: 'Ongoing' | 'Ended';
    issueCount?: number;
    bookType?: 'Print' | 'OneShot' | 'TPB' | 'GN' | null;
}

export interface SearchSeriesOptions {
    /** Fetch a cover per result - only for a search someone is looking at (it costs a request each on Metron). */
    covers?: boolean;
}

export interface MetadataIssue {
    sourceId: string;
    issueNumber: string;
    name: string | null;
    releaseDate: string | null;
    coverUrl: string | null;
    description: string | null;
    writers: string[];
    artists: string[];
    characters: string[];
    coverArtists?: string[];
    colorists?: string[];
    letterers?: string[];
    inker?: string[];
    editor?: string[];
    translator?: string[];
    storyArcs?: string[];
    teams?: string[];
    locations?: string[];
    seriesId?: number | null;
    seriesName?: string | null;
    publisher?: string | null;
    /** The RAW story title ("Lifedeath"), when the provider supplied a real one — `name` above
     *  may be a display composite ("X-Men (1991) #154: Lifedeath"). Detail fetches only;
     *  placeholder titles ("Issue 154") are dropped at the provider (#199 round 3). */
    storyTitle?: string | null;
}

export interface IMetadataProvider {
    // --- FIX: Added optional page parameter ---
    searchSeries(query: string, page?: number, opts?: SearchSeriesOptions): Promise<MetadataSeries[]>;
    getSeriesDetails(id: string, lastModified?: Date): Promise<MetadataSeries | null>;
    getSeriesIssues(id: string): Promise<MetadataIssue[]>;
    getIssueDetails(id: string): Promise<MetadataIssue>;
}