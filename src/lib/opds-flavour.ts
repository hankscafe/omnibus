// src/lib/opds-flavour.ts
//
// The OPDS catalog is served in two shapes by the same handlers (#262):
//
// - /api/opds is Omnibus's own feed, unchanged for the clients that already read it.
// - /komga/opds/v1.2 is the same catalog shaped like Komga's (its author, its root id, bare
//   series/book ids, its `books/{id}/file/{filename}` download link). Panels writes reading progress
//   only to a server whose feed looks like Komga's, through Komga's REST API at the server address
//   minus `/opds/v1.2/catalog`, plus `/api/v1` — under /komga, that is the facade (#206).
//
// A handler picks the shape from the path it was called on. Covers and page streams carry neither
// ids nor an author, so both shapes link to the same /api/opds/cover and /api/opds/page routes.
import path from 'path';

export interface OpdsFlavour {
    /** Where this shape's feeds live (`${base}/series`, `${base}/search`, …), after the origin. */
    base: string;
    /** The catalog root's own path. */
    root: string;
    /** The catalog root's `<id>`. */
    rootId: string;
    /** The feeds' `<author>`. */
    author: string;
    /** The `<id>` of a series or an issue. */
    entryId(kind: 'series' | 'issue', id: string): string;
    /** An issue's acquisition (download) link. */
    acquisitionHref(baseUrl: string, issue: { id: string; filePath: string }): string;
}

export const OMNIBUS_OPDS: OpdsFlavour = {
    base: '/api/opds',
    root: '/api/opds',
    rootId: 'urn:omnibus:root',
    author: '<author><name>Omnibus</name></author>',
    entryId: (kind, id) => `urn:omnibus:${kind}:${id}`,
    acquisitionHref: (baseUrl, issue) => `${baseUrl}/api/opds/download?issueId=${issue.id}`,
};

/** Komga's own feed, as gotson/komga's OpdsController writes it. */
export const KOMGA_OPDS: OpdsFlavour = {
    base: '/komga/opds/v1.2',
    root: '/komga/opds/v1.2/catalog',
    rootId: 'root',
    author: '<author><name>Komga</name><uri>https://github.com/gotson/komga</uri></author>',
    entryId: (_kind, id) => id,
    // Panels ties a downloaded file to its book through this link; with /api/opds/download?issueId=
    // it kept no progress for a downloaded book at all, not even on the device.
    acquisitionHref: (baseUrl, issue) =>
        `${baseUrl}/komga/opds/v1.2/books/${issue.id}/file/${encodeURIComponent(path.basename(issue.filePath))}`,
};

/** The shape a request asked for, by the path it came in on. */
export function opdsFlavourFor(req: Request): OpdsFlavour {
    return new URL(req.url).pathname.startsWith(`${KOMGA_OPDS.base}/`) ? KOMGA_OPDS : OMNIBUS_OPDS;
}
