// src/types/api/issue-details.ts
//
// GET /api/issue-details?id=<provider id>&type=volume|issue&provider=COMICVINE|METRON - one volume's or one
// issue's details, 24 h cached. These types describe what a SUCCESSFUL reply carries, as the Smart Matcher
// reads it (a volume to match against, an issue for its volumeId). The route's four builders (ComicVine /
// Metron x volume / issue) and its other readers are typed separately.

/** One entry of a volume's `issues` list: ComicVine's volume issue stubs, or the Metron stubs the route maps
 *  to the same {id, issue_number, name} shape (plus the cover Metron's list already carries). */
export interface VolumeIssueStub {
    id: number | string;
    issue_number?: string;
    /** A generic number field some payloads carry instead of issue_number. */
    number?: string;
    name?: string | null;
    /** Metron: the issue's cover URL. ComicVine's volume list carries none; its issue `image` is an object of sizes. */
    image?: string | null | { thumb_url?: string; small_url?: string };
}

/** The details reply as the Smart Matcher reads it. */
export interface IssueDetailsReply {
    /** The volume's (or issue's) own provider id; a reply always carries it or volumeId. */
    id?: number | string;
    /** An issue's volume; a volume's own id again. */
    volumeId?: number | string | null;
    name: string;
    volumeName?: string;
    publisher: string;
    image: string | null;
    /** "2016", or "????" when the provider has none. */
    year: string;
    description: string;
    /** A volume's issue count; "?" when unknown. */
    count?: number | string;
    /** Volumes only. */
    issues?: VolumeIssueStub[];
    siteUrl?: string;
    writers?: string[];
    artists?: string[];
    coverArtists?: string[];
    colorists?: string[];
    letterers?: string[];
    inkers?: string[];
    editors?: string[];
    translators?: string[];
    characters?: string[];
    teams?: string[];
    locations?: string[];
    genres?: string[];
    storyArcs?: string[];
    htmlDescription?: string;
    /** Set instead of the fields above when the lookup failed (with a 4xx/5xx). */
    error?: string;
}

/** POST /api/issue-details/covers {ids, provider} - cover thumbnails by issue id (ComicVine; Metron's
 *  covers come with the volume's issue list, so it answers an empty map). */
export interface IssueCoversReply {
    covers?: Record<string, string>;
    error?: string;
}
