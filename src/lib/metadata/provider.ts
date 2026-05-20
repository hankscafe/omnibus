// src/lib/metadata/provider.ts
export interface MetadataSeries {
    sourceId: string;
    source: 'COMICVINE' | 'METRON' | 'ANILIST';
    name: string;
    year: number;
    publisher: string;
    description: string | null;
    coverUrl: string | null;
    status: 'Ongoing' | 'Ended';
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
    storyArcs?: string[];
    teams?: string[];
    locations?: string[];
}

export interface IMetadataProvider {
    searchSeries(query: string): Promise<MetadataSeries[]>;
    getSeriesDetails(id: string, lastModified?: Date): Promise<MetadataSeries | null>;
    getSeriesIssues(id: string): Promise<MetadataIssue[]>;
    getIssueDetails(id: string): Promise<MetadataIssue>;
}