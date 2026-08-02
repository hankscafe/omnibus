// Updates-feed grouping helpers (Beta B): local-day bucketing, Today/Yesterday labels with an
// injectable clock, same-day series clustering that preserves feed order, and the unread filter.
import { describe, it, expect } from 'vitest';
import { dayKeyOf, dayLabel, groupUpdates, filterUnread } from '@/lib/utils/updates-view';

const item = (id: string, seriesId: string, seriesName: string, createdAt: string, isRead = false) =>
    ({ id, seriesId, seriesName, createdAt, isRead });

describe('dayKeyOf / dayLabel', () => {
    it('keys by the local calendar day', () => {
        expect(dayKeyOf(new Date(2026, 6, 31, 23, 59))).toBe('2026-07-31');
        expect(dayKeyOf(new Date(2026, 6, 1, 0, 0))).toBe('2026-07-01');
    });

    it('labels Today and Yesterday against the injected clock, dates otherwise', () => {
        const now = new Date(2026, 6, 31, 12, 0);
        expect(dayLabel('2026-07-31', now)).toBe('Today');
        expect(dayLabel('2026-07-30', now)).toBe('Yesterday');
        expect(dayLabel('2026-07-28', now)).toMatch(/July 28/);
    });

    it('handles Yesterday across a month boundary', () => {
        const firstOfMonth = new Date(2026, 7, 1, 8, 0); // Aug 1
        expect(dayLabel('2026-07-31', firstOfMonth)).toBe('Yesterday');
    });
});

describe('groupUpdates', () => {
    it('buckets by day and clusters same-series items within a day, preserving feed order', () => {
        const groups = groupUpdates([
            item('a', 's1', 'Kagurabachi', '2026-07-31T10:00:00'),
            item('b', 's2', 'Saga', '2026-07-31T09:00:00'),
            item('c', 's1', 'Kagurabachi', '2026-07-31T08:00:00'), // same series+day → joins the s1 cluster
            item('d', 's1', 'Kagurabachi', '2026-07-30T10:00:00'), // previous day → NEW cluster
        ]);

        expect(groups).toHaveLength(2);
        expect(groups[0].clusters.map(c => c.seriesId)).toEqual(['s1', 's2']);
        expect(groups[0].clusters[0].items.map(i => i.id)).toEqual(['a', 'c']);
        expect(groups[1].clusters).toHaveLength(1);
        expect(groups[1].clusters[0].items.map(i => i.id)).toEqual(['d']);
    });

    it('returns an empty list for no items', () => {
        expect(groupUpdates([])).toEqual([]);
    });
});

describe('filterUnread', () => {
    const items = [item('a', 's1', 'X', '2026-07-31T10:00:00', true), item('b', 's1', 'X', '2026-07-31T09:00:00', false)];

    it('drops read items only when the toggle is on', () => {
        expect(filterUnread(items, true).map(i => i.id)).toEqual(['b']);
        expect(filterUnread(items, false)).toHaveLength(2);
    });
});
