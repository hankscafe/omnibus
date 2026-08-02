// Fork review #3: /library/history client-side search + sort. Pure helpers, pinned directly.
import { describe, it, expect } from 'vitest';
import { filterHistory, sortHistory } from '@/lib/utils/history-view';

const item = (seriesName: string, issueNumber: string, percentage: number, updatedAt: string) =>
    ({ seriesName, issueNumber, percentage, updatedAt });

const ITEMS = [
    item('Saga', '10', 50, '2026-07-28T10:00:00Z'),
    item('Saga', '2', 100, '2026-07-30T10:00:00Z'),
    item('Absolute Batman', '1', 25, '2026-07-29T10:00:00Z'),
    item('X-Men', '5', 50, '2026-07-27T10:00:00Z'),
];

describe('filterHistory', () => {
    it('matches series name case-insensitively and returns everything for a blank query', () => {
        expect(filterHistory(ITEMS, 'saga')).toHaveLength(2);
        expect(filterHistory(ITEMS, '  ')).toHaveLength(4);
    });

    it('matches against the issue number too', () => {
        const hits = filterHistory(ITEMS, '#5');
        expect(hits).toHaveLength(1);
        expect(hits[0].seriesName).toBe('X-Men');
    });
});

describe('sortHistory', () => {
    it('recent = newest updatedAt first (the server default order)', () => {
        expect(sortHistory(ITEMS, 'recent').map(i => i.seriesName)).toEqual(['Saga', 'Absolute Batman', 'Saga', 'X-Men']);
    });

    it('oldest = reverse of recent', () => {
        expect(sortHistory(ITEMS, 'oldest').map(i => i.seriesName)).toEqual(['X-Men', 'Saga', 'Absolute Batman', 'Saga']);
    });

    it('title A-Z breaks number ties numerically (2 before 10)', () => {
        const sorted = sortHistory(ITEMS, 'title-asc');
        expect(sorted.map(i => `${i.seriesName} #${i.issueNumber}`)).toEqual([
            'Absolute Batman #1', 'Saga #2', 'Saga #10', 'X-Men #5',
        ]);
    });

    it('title Z-A is the exact reverse', () => {
        expect(sortHistory(ITEMS, 'title-desc').map(i => `${i.seriesName} #${i.issueNumber}`)).toEqual([
            'X-Men #5', 'Saga #10', 'Saga #2', 'Absolute Batman #1',
        ]);
    });

    it('progress sorts high-to-low with recency as the tiebreak', () => {
        const sorted = sortHistory(ITEMS, 'progress');
        expect(sorted.map(i => i.percentage)).toEqual([100, 50, 50, 25]);
        // Both 50% rows: Saga #10 (07-28) is more recent than X-Men (07-27).
        expect(sorted[1].seriesName).toBe('Saga');
        expect(sorted[2].seriesName).toBe('X-Men');
    });

    it('does not mutate the input array', () => {
        const copy = [...ITEMS];
        sortHistory(ITEMS, 'title-asc');
        expect(ITEMS).toEqual(copy);
    });
});
