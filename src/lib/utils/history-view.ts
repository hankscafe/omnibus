// src/lib/utils/history-view.ts
//
// Pure client-side helpers for the /library/history controls (fork review #3): the API already
// returns the full data set ordered newest-first, so search/sort stay in the browser. Extracted
// from the page for direct unit tests.

export type HistorySort = 'recent' | 'oldest' | 'title-asc' | 'title-desc' | 'progress';
export type HistoryView = 'grid' | 'compact' | 'list';

export const HISTORY_SORTS: { value: HistorySort; label: string }[] = [
    { value: 'recent', label: 'Recently Read' },
    { value: 'oldest', label: 'Oldest First' },
    { value: 'title-asc', label: 'Title A-Z' },
    { value: 'title-desc', label: 'Title Z-A' },
    { value: 'progress', label: 'Progress High-Low' },
];

export interface HistoryItemLike {
    seriesName: string;
    issueNumber: string | number;
    percentage: number;
    updatedAt: string | Date;
}

export function filterHistory<T extends HistoryItemLike>(items: T[], query: string): T[] {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i => `${i.seriesName} #${i.issueNumber}`.toLowerCase().includes(q));
}

// Title sorts break number ties numerically ("2" before "10"); progress ties fall back to recency
// so equal-percentage rows keep a stable, meaningful order.
export function sortHistory<T extends HistoryItemLike>(items: T[], sort: HistorySort): T[] {
    const ts = (i: HistoryItemLike) => new Date(i.updatedAt).getTime() || 0;
    const num = (i: HistoryItemLike) => {
        const n = parseFloat(String(i.issueNumber));
        return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
    };
    const byTitle = (a: HistoryItemLike, b: HistoryItemLike) =>
        a.seriesName.localeCompare(b.seriesName, undefined, { sensitivity: 'base' }) || num(a) - num(b);

    const sorted = [...items];
    switch (sort) {
        case 'oldest': sorted.sort((a, b) => ts(a) - ts(b)); break;
        case 'title-asc': sorted.sort(byTitle); break;
        case 'title-desc': sorted.sort((a, b) => byTitle(b, a)); break;
        case 'progress': sorted.sort((a, b) => (b.percentage - a.percentage) || (ts(b) - ts(a))); break;
        case 'recent':
        default: sorted.sort((a, b) => ts(b) - ts(a)); break;
    }
    return sorted;
}
