// src/types/api/interactive-search.ts
//
// GET /api/search/interactive?q=<text>[&year=<yyyy>][&isManga=true] - the Interactive Search dialog's live
// release search. The route forwards it to the engine's /api/search/interactive and passes the engine's
// reply through as it is.

/** One release, as the engine serializes it (ProwlarrResult in omnibus-engine/src/prowlarr.rs - Prowlarr's
 *  hits, GetComics' and Anna's Archive's downloads all share it). */
export interface InteractiveSearchResult {
    guid: string;
    title: string;
    /** Bytes; 0 when unknown. */
    size: number;
    indexer: string;
    seeders: number;
    peers: number;
    infoUrl: string;
    downloadUrl: string;
    /** 'torrent' or 'usenet' from Prowlarr; 'ddl' for GetComics and Anna's Archive. */
    protocol: string;
    /** "N/A" for a GetComics or Anna's Archive download. */
    publishDate: string;
    infoHash: string | null;
    /** Prowlarr only: the query of the search ladder that found it, and its rung (0 = the exact term). */
    matchedQuery?: string;
    queryRung?: number;
    /** The dialog reads these two, but the engine sends neither: the Age cell of every GetComics or Anna's
     *  Archive row is blank, and every Usenet row reads "Grabs: 0". */
    age?: string;
    grabs?: number;
}

/** The reply, or `{ error }` (with a 4xx/5xx). */
export interface InteractiveSearchReply {
    prowlarr?: InteractiveSearchResult[];
    getcomics?: InteractiveSearchResult[];
    /** Empty unless Anna's Archive is switched on for interactive search. */
    annas_archive?: InteractiveSearchResult[];
    error?: string;
}
