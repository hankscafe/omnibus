// KOReader's reading position in ReadProgress terms (#217).
//
// KOReader reports 1-based pages for comics and PDFs: `progress` is the top page shown, sent as a string
// ("9" - kosync's tostring(getTopPage())), and `percentage` is page / page count (9/258). The web reader
// keeps ReadProgress.currentPage as a 0-based page index - it resumes at pages[currentPage] and writes a
// finished book as currentPage = page count. Storing KOReader's page number as the index made the web
// reader resume one page late.

export type KoreaderPosition = { currentPage: number; totalPages: number; isCompleted: boolean };
type ProgressRow = { currentPage: number; totalPages: number; isCompleted?: boolean | null };

/** KOReader counts a book this far through as finished (the web reader marks the last two pages). */
const COMPLETED_AT = 0.99;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * The ReadProgress position for a KOReader push. `pageCount` is the issue's own page count (0 when
 * unknown - then the position is kept in percentage points out of 100, as before).
 */
export function koreaderPosition(progress: unknown, percentage: unknown, pageCount: number): KoreaderPosition {
    const pct = clamp(Number(percentage) || 0, 0, 1);
    const known = pageCount > 0;
    const totalPages = known ? pageCount : 100;
    if (pct >= COMPLETED_AT) return { currentPage: totalPages, totalPages, isCompleted: true };

    // A paging document's progress is its 1-based top page; anything else (an EPUB xpointer, a
    // missing value) falls back to the percentage. The page number wins because in KOReader's scroll
    // mode it follows the top page shown, where the percentage follows the bottom one.
    const text = typeof progress === 'number' ? String(progress) : typeof progress === 'string' ? progress.trim() : '';
    const pageNumber = known && /^\d+$/.test(text) && Number(text) >= 1 ? Number(text) : Math.round(pct * totalPages);
    return { currentPage: clamp(pageNumber - 1, 0, totalPages - 1), totalPages, isCompleted: false };
}

/** How many pages a row says were seen - through its index, or all of them once finished. */
function pagesSeen(row: ProgressRow): number {
    return row.isCompleted || row.currentPage >= row.totalPages ? row.totalPages : row.currentPage + 1;
}

/**
 * Pages read between the previous ReadProgress row and a new position, for the reading heatmap. The old
 * row is read as a fraction of its own page count - a v1.4.5 KOReader row is in percentage points out
 * of 100 - and counts nothing when the new position is behind it.
 */
export function pagesReadSince(previous: ProgressRow | null | undefined, next: KoreaderPosition): number {
    const before = previous && previous.totalPages > 0
        ? Math.round(Math.min(1, pagesSeen(previous) / previous.totalPages) * next.totalPages)
        : 0;
    return Math.max(0, pagesSeen(next) - before);
}
