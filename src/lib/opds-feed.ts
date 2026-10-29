// src/lib/opds-feed.ts
//
// The pieces all the OPDS feeds share (#218, #221): the Atom `<updated>` values, the `<author>` list
// built from a row's creators, the issue entry title, the entry builders themselves, and the feed
// envelope. Kept in one module so the rules live in a single place and the feeds cannot drift apart.
import { escapeXml } from '@/lib/utils/xml';
import { authorsFromRows, parseJsonList, seriesAuthors, type KomgaAuthor } from '@/lib/komga/dto';
import { opdsCoverLinks } from '@/lib/opds-covers';
import { mediaTypeForFile } from '@/lib/file-download';

/** An Atom `<updated>` is required even for an empty feed; 1970 is the only honest "no content" value. */
export const OPDS_EPOCH = new Date(0).toISOString();

/** The response media type: `navigation` feeds list routes, `acquisition` feeds list publications. */
export function feedContentType(kind: 'navigation' | 'acquisition'): string {
    return `application/atom+xml;profile=opds-catalog;kind=${kind}; charset=utf-8`;
}

function toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    const time = date.getTime();
    return Number.isFinite(time) ? date.toISOString() : null;
}

/** An entry's `<updated>`, from its own `updatedAt`. */
export function entryUpdated(value: Date | string | null | undefined): string {
    return toIso(value) ?? OPDS_EPOCH;
}

/** A feed's own `<updated>`: the newest of its entries. */
export function feedUpdated(values: Array<Date | string | null | undefined>): string {
    let newest = 0;
    for (const value of values) {
        const iso = toIso(value);
        if (iso) newest = Math.max(newest, new Date(iso).getTime());
    }
    return new Date(newest).toISOString();
}

/**
 * Each creator as its own `<author>` element (#218 §5.1.1). An entry whose creators are unknown
 * emits none — the feed carries its own `<author>`, which keeps the document valid Atom.
 */
export function authorElements(authors: KomgaAuthor[]): string {
    return authors.map((a) => `<author><name>${escapeXml(a.name)}</name></author>`).join('\n    ');
}

/** The publisher element, moved out of `<author>` (#218). Emitted only when the publisher is known. */
export function publisherElement(publisher: string | null | undefined): string {
    return publisher ? `<dc:publisher>${escapeXml(publisher)}</dc:publisher>` : '';
}

/**
 * An issue's creators: its own `writers`/`artists`, falling back per field to the series' (#218).
 * "Absent" means the column parses to no names, not just that it is null: a credit refresh that
 * finds nothing writes `JSON.stringify([])`, and with `??` alone such an entry carried no `<author>`
 * even when the series has writers.
 */
export function issueCreators(
    issue: { writers?: string | null; artists?: string | null },
    series: { writers?: string | null; artists?: string | null },
): KomgaAuthor[] {
    return authorsFromRows([{
        writers: creditsOrSeries(issue.writers, series.writers),
        artists: creditsOrSeries(issue.artists, series.artists),
    }]);
}

/** The issue's own credit column when it holds at least one name, the series' column otherwise. */
function creditsOrSeries(own: string | null | undefined, seriesColumn: string | null | undefined): string | null | undefined {
    return parseJsonList(own).length > 0 ? own : seriesColumn;
}

/**
 * The issue entry's title (#218): `Series #N - Title`, reduced to `Series #N` when there is no story
 * title or the title only repeats the series and the number. An annual says so, matching the series page; a
 * Special (#255) is titled after its own volume.
 */
export function issueEntryTitle(
    seriesName: string,
    issue: { number: string; name?: string | null; isAnnual?: boolean | null; attachedVolume?: { kind?: string | null; name?: string | null } | null },
): string {
    const num = String(issue.number ?? '').trim();
    // #255: a Special is titled after its own volume ("Absolute Batman: Ark-M #1"), never the run's "#1".
    const special = issue.attachedVolume?.kind === 'SPECIAL' ? (issue.attachedVolume.name ?? '').trim() : '';
    const base = special ? `${special} #${num}` : `${seriesName}${issue.isAnnual ? ' Annual' : ''} #${num}`;
    const name = (issue.name ?? '').trim();
    if (!name) return base;
    if (name.toLowerCase() === seriesName.trim().toLowerCase()) return base;
    if (name === `#${num}` || name === base) return base;
    return `${base} - ${name}`;
}

// ---------------------------------------------------------------------------------------------
// Entry builders
// ---------------------------------------------------------------------------------------------

export interface SeriesFeedRow {
    id: string;
    name: string;
    publisher?: string | null;
    description?: string | null;
    coverUrl?: string | null;
    folderPath?: string | null;
    writers?: string | null;
    artists?: string | null;
    updatedAt: Date | string | null;
}

export interface IssueFeedRow {
    id: string;
    number: string;
    name?: string | null;
    isAnnual?: boolean | null;
    attachedVolume?: { kind?: string | null; name?: string | null } | null;
    description?: string | null;
    filePath?: string | null;
    writers?: string | null;
    artists?: string | null;
    updatedAt: Date | string | null;
}

/** The caller's reading progress for an issue — what `pse:lastRead` is built from. */
export interface IssueProgress {
    /** 0-based index, as the app's own reader stores it. */
    currentPage: number;
    /**
     * A finished issue stores the page count itself as its position (KOReader's finished sync and the
     * Komga mark-read both write it that way), which as a 1-based page would sit one past the end.
     */
    isCompleted?: boolean;
    updatedAt: Date | string;
}

type SeriesRef = { id: string; name: string; publisher?: string | null; writers?: string | null; artists?: string | null };

/** A series as a navigation entry: a subsection link to its own (acquisition) feed. */
export function seriesEntry(baseUrl: string, series: SeriesFeedRow): string {
    // Covers go through the OPDS-key cover route (lib/opds-covers.ts): the library cover route needs
    // a web session, which an OPDS client never has.
    const coverLinks = series.coverUrl || series.folderPath ? opdsCoverLinks(baseUrl, 'series', series.id) : '';

    return `
  <entry>
    <title>${escapeXml(series.name)}</title>
    <id>urn:omnibus:series:${series.id}</id>
    <updated>${entryUpdated(series.updatedAt)}</updated>
    ${authorElements(seriesAuthors(series))}
    ${publisherElement(series.publisher)}
    <content type="text">${escapeXml(series.description || 'No description available.')}</content>
    ${coverLinks}
    <link rel="subsection" href="${baseUrl}/api/opds/series/${series.id}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  </entry>`;
}

/**
 * `pse:lastRead` / `pse:lastReadDate` — the 1-based page OPDS-PSE expects, from the stored 0-based
 * `currentPage`. A finished issue reports the last page rather than `currentPage + 1`: its stored
 * position is the page count itself (KOReader's finished sync and the Komga mark-read both write it
 * that way), which would otherwise read as one page past the end. Nothing is emitted for an issue the
 * caller has not started, and the page is clamped so a stale position can never exceed the count.
 */
function lastReadAttributes(progress: IssueProgress | null | undefined, pageCount: number): string {
    if (!progress || pageCount <= 0) return '';
    if (!progress.isCompleted && progress.currentPage <= 0) return '';
    const page = progress.isCompleted ? pageCount : Math.min(progress.currentPage + 1, pageCount);
    const date = toIso(progress.updatedAt);
    return date ? ` pse:lastRead="${page}" pse:lastReadDate="${date}"` : '';
}

/**
 * An issue as an acquisition entry. `pageCount` is the caller's resolved count (the series feed
 * self-heals a stored 0 first) and `progress` adds the reading position, so a page-streaming client
 * resumes where the reader stopped.
 */
export function issueEntry(
    baseUrl: string,
    series: SeriesRef,
    issue: IssueFeedRow,
    options: { pageCount: number; progress?: IssueProgress | null },
): string {
    // An uncounted issue (`pageCount` 0; only the series feed heals one) advertises no page stream at
    // all: `pse:count="0"` is a stream a client cannot render. The acquisition link still stands.
    const pseLink = options.pageCount > 0
        ? `<link rel="http://vaemendis.net/opds-pse/stream" type="image/webp" href="${baseUrl}/api/opds/page/${issue.id}/{pageNumber}" pse:count="${options.pageCount}"${lastReadAttributes(options.progress, options.pageCount)}/>`
        : '';

    // Every publication entry carries its acquisition link, whatever the caller's permissions
    // (#221 point 4): §5.4 asks for one on every entry, the download route already answers 403 to a
    // user without download rights, and dropping the entry would also drop the page-stream for a
    // user who can only stream. The declared type is the file's real media type (§5.3).
    const downloadLink = issue.filePath
        ? `<link rel="http://opds-spec.org/acquisition" href="${baseUrl}/api/opds/download?issueId=${issue.id}" type="${mediaTypeForFile(issue.filePath)}"/>`
        : '';

    return `
  <entry>
    <title>${escapeXml(issueEntryTitle(series.name, issue))}</title>
    <id>urn:omnibus:issue:${issue.id}</id>
    <updated>${entryUpdated(issue.updatedAt)}</updated>
    ${authorElements(issueCreators(issue, series))}
    ${publisherElement(series.publisher)}
    <content type="text">${escapeXml(issue.description || 'No synopsis available.')}</content>
    ${opdsCoverLinks(baseUrl, 'issue', issue.id)}
    ${pseLink}
    ${downloadLink}
  </entry>`;
}

/** The `rel="search"` link a catalog root advertises, pointing at the OpenSearch description document. */
export function searchLink(baseUrl: string): string {
    return `<link rel="search" type="application/opensearchdescription+xml" href="${baseUrl}/api/opds/opensearch" title="Search Omnibus"/>`;
}

// ---------------------------------------------------------------------------------------------
// Feed envelope
// ---------------------------------------------------------------------------------------------

/**
 * The Atom envelope every feed shares. `namespaces` carries the extra declarations a feed needs —
 * `xmlns:dc` when it publishes a publisher, `xmlns:pse` when it streams pages.
 */
export function atomFeed(options: {
    id: string;
    title: string;
    updated: string;
    /** The `<link …/>` lines (self / start / up / next / previous / search), already indented. */
    links: string;
    entries: string;
    namespaces?: string;
}): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog"${options.namespaces ?? ''}>
  <id>${options.id}</id>
  <title>${escapeXml(options.title)}</title>
  <updated>${options.updated}</updated>
  <author><name>Omnibus</name></author>
${options.links}
  ${options.entries}
</feed>`;
}
