// src/lib/utils/collected-edition.ts
//
// Collected editions dropped as loose files (#257): "Power Rangers Prime v01 (2025) (Digital)
// (dekabro-Empire).cbz" … "v04". What the filename says about the edition's name and each book's
// volume number, and whether a book's own name lets the name-anchored rule (attachment-name.ts)
// find it again after a wipe. Client-safe (the Attach dialog prefills from it) — no node imports.
import { attachmentForFilename } from '@/lib/utils/attachment-name';
import { describeIssueFromFilename, isSameIssue, normalizeFractionNumbers, stripSeriesPrefix } from '@/lib/utils/issue-parser';

const COMIC_EXTENSION = /\.(cbz|cbr|zip|rar|cb7|epub|pdf)$/i;
// The first volume token: "v01", "v 1", "Vol. 02", "Volume 3". Whole word, so "Venom" never counts.
const VOLUME_TOKEN = /(?<![a-zA-Z0-9])(?:vol(?:ume)?\.?\s*|v\s*)\d{1,3}(?![0-9])/i;

/** The edition's name as a book's filename suggests it: the title before the volume token, without
 *  the extension, the bracketed release tags or a trailing subtitle. "Ghost Rider Epic Collection
 *  v04 (2026) - To Slay The Demon" → "Ghost Rider Epic Collection". A name with no volume token
 *  keeps its whole title. */
export function editionNameFromFile(fileName: string): string {
    const stem = fileName.trim().replace(COMIC_EXTENSION, '');
    let s = stem.replace(/\([^()]*\)|\[[^[\]]*\]/g, ' ');
    const volume = VOLUME_TOKEN.exec(s);
    if (volume) s = s.slice(0, volume.index);
    s = s.replace(/\s+/g, ' ').replace(/[\s,\-–—:_.]+$/, '').trim();
    return s || stem.trim();
}

/** A book's number within its edition: the volume number parsed with the edition's name as the
 *  series hint, so title digits ("Kaiju No. 8 v03") stay out of it. */
export function bookNumberFromFile(fileName: string, editionName?: string): string {
    const hint = (editionName || editionNameFromFile(fileName)).trim();
    return normalizeFractionNumbers(describeIssueFromFilename(fileName, hint || undefined).number);
}

/** The year in a book's own filename, "(2025)" or "(2024, 3rd edition)" — its {IssueYear} when the
 *  book has no release date of its own. */
export function yearFromFileName(fileName: string): number | null {
    const m = /[([]\s*(19\d{2}|20\d{2})\s*(?=[)\],])/.exec(fileName);
    return m ? parseInt(m[1], 10) : null;
}

/** An edition named like its series — or a shorter prefix of it — can never claim a file by name
 *  (attachment-name.ts): after a wipe its books would come back as the run's issues. */
export function editionNameClashesWithSeries(editionName: string, seriesName: string): boolean {
    const edition = editionName.trim();
    if (!edition) return true;
    return stripSeriesPrefix(seriesName.trim(), edition) !== null;
}

/** A name the series may use for an edition when the filename's own title is the series' name. */
export function distinctEditionName(editionName: string, seriesName: string): string {
    const edition = editionName.trim() || seriesName.trim();
    return editionNameClashesWithSeries(edition, seriesName) ? `${edition} TPB` : edition;
}

export type CollectedFormat = 'Omnibus' | 'HC' | 'GN' | 'TPB';

/** A collected edition's kind as its name says it — what its books' ComicInfo <Format> becomes:
 *  "Omnibus", "HC" (hardcover, deluxe, absolute), "GN" (graphic novel), else "TPB". Only the part
 *  the edition adds to its series' name counts ("Absolute Batman TPB" is a TPB). Whole words, any
 *  case. EXACT twin of the engine's collected_format_from_name (metadata_writer.rs). */
export function collectedFormatFromName(editionName: string, seriesName = ''): CollectedFormat {
    const rest = seriesName.trim() ? stripSeriesPrefix(editionName, seriesName.trim()) : null;
    const name = rest ?? editionName;
    if (/\bomnibus\b/i.test(name)) return 'Omnibus';
    if (/\b(?:hc|hard\s?cover|deluxe|absolute)\b/i.test(name)) return 'HC';
    if (/\b(?:graphic novel|ogn|gn)\b/i.test(name)) return 'GN';
    return 'TPB';
}

/** The main-run issues book `bookNumber` covers when every book collects `perBook` consecutive
 *  issues — v01 → "1-4", v02 → "5-8" for four per book. A suggestion for the Covers field, never
 *  stored without the admin seeing it; null when the number isn't a whole volume number. */
export function evenCoverage(bookNumber: string, perBook: number): string | null {
    if (!/^\d+$/.test(bookNumber.trim()) || !Number.isInteger(perBook) || perBook < 1) return null;
    const book = parseInt(bookNumber, 10);
    if (book < 1) return null;
    const first = (book - 1) * perBook + 1;
    const last = book * perBook;
    return first === last ? String(first) : `${first}-${last}`;
}

/** Issues per book when the run splits evenly over its books: 16 issues and books up to v04 → 4.
 *  Null when it doesn't divide — an uneven split is the admin's call, not a guess. */
export function suggestIssuesPerBook(seriesIssueCount: number | null | undefined, highestBookNumber: number): number | null {
    const count = Number(seriesIssueCount) || 0;
    if (count < 1 || !Number.isInteger(highestBookNumber) || highestBookNumber < 1) return null;
    return count % highestBookNumber === 0 ? count / highestBookNumber : null;
}

/** Whether `fileName` would be claimed back by this edition, as this number, from its name alone. */
export function nameClaimsBook(fileName: string, seriesName: string, editionName: string, number: string): boolean {
    const match = attachmentForFilename(fileName, seriesName, [{ id: 'edition', name: editionName, kind: 'COLLECTED' }]);
    return !!match && isSameIssue(match.number, number);
}

const FORMAT_ORDER: CollectedFormat[] = ['TPB', 'HC', 'Omnibus', 'GN'];

/** The label a series name and edition name give the edition's own shelf: the edition name without
 *  the series' name ("Power Rangers Prime TPB" on Power Rangers Prime → "TPB", "Ghost Rider Epic
 *  Collection" → "Epic Collection"); a provider volume named exactly like its series reads as its type. */
export function editionShelfTitle(editionName: string, seriesName: string): string {
    const name = editionName.trim();
    const rest = stripSeriesPrefix(name, seriesName.trim());
    const title = (rest ?? name).replace(/^[\s:,\-–—_.]+/, '').trim();
    return title || collectedFormatFromName(name, seriesName);
}

export interface CollectedShelf<B> { key: string; name: string | null; title: string; format: CollectedFormat; books: B[] }

/** #257: a series' collected books split into one shelf per edition — the run's issues, then the
 *  TPBs, the hardcovers, the omnibuses, the graphic novels — instead of one mixed shelf where every
 *  edition's "Vol. 1" looked alike. Book order inside a shelf is kept as given. */
export function groupCollectedShelves<B extends { collectionId?: string | null; attachedVolumeId?: string | null; collectionName?: string | null }>(
    books: B[], seriesName: string,
): CollectedShelf<B>[] {
    const shelves = new Map<string, CollectedShelf<B>>();
    for (const book of books) {
        const name = book.collectionName?.trim() || null;
        // The edition's id (a kept edition's books carry it as collectionId: their rows live in the
        // child series and have no attachedVolumeId of the parent's), else its name.
        const key = book.collectionId || book.attachedVolumeId || (name ? `name:${name.toLowerCase()}` : 'collected');
        let shelf = shelves.get(key);
        if (!shelf) {
            const format = collectedFormatFromName(name || '', seriesName);
            shelf = { key, name, title: name ? editionShelfTitle(name, seriesName) : 'Collected Editions', format, books: [] };
            shelves.set(key, shelf);
        }
        shelf.books.push(book);
    }
    return [...shelves.values()].sort((a, b) =>
        FORMAT_ORDER.indexOf(a.format) - FORMAT_ORDER.indexOf(b.format) || a.title.localeCompare(b.title, undefined, { numeric: true }));
}
