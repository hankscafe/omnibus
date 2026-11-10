// src/types/api/series-issues.ts
//
// GET /api/series-issues?volumeId=&provider= - a provider volume's (ComicVine) or series' (Metron) issues
// in number order, for the request dialogs, the requests pages and the Profile page's synopsis.

/** One issue, as the route builds it for either provider. */
export interface SeriesIssueResult {
    id: number;
    volumeId: number;
    /** "Series #N", plus ": Title" when the issue has its own. */
    name: string;
    issueNumber: string;
    /** The same number again, under the provider's own spelling (older readers use it). */
    issue_number: string;
    /** "2016", or "????" when the provider has no date. */
    year: string;
    isReleased: boolean;
    publisher: string | null;
    /** A /api/library/cover proxy URL; null when the provider has no cover. */
    image: string | null;
    description: string;
    siteUrl: string;
    writers: string[];
    artists: string[];
    coverArtists: string[];
    metadataSource?: string;
}

/** The reply; `results` is empty when the provider answered nothing, `error` set on a 5xx. */
export interface SeriesIssuesReply {
    results?: SeriesIssueResult[];
    error?: string;
}
