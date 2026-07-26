// __tests__/lib/utils/alpha-buckets.test.ts
//
// Beta E (2026-07-25 worklist item 6): the alphabet jump bar's bucket math. Buckets are computed
// from the names index IN SERVER ORDER — offsets are first-occurrence indexes, so a jump always
// lands on a row the server will actually return at that offset, regardless of collation quirks
// (SQLite's binary collation can scatter lowercase names after Z; the bar stays truthful anyway).
import { describe, it, expect } from 'vitest';
import { letterForName, computeLetterBuckets } from '@/lib/utils/alpha-buckets';

describe('letterForName', () => {
    it('maps names to their bar letter', () => {
        expect(letterForName('Batman')).toBe('B');
        expect(letterForName('apple pie')).toBe('A');
        expect(letterForName('9 Lives')).toBe('#');
        expect(letterForName('#1 Comic')).toBe('#');
        expect(letterForName('')).toBe('#');
    });

    it('folds simple diacritics instead of dumping them in #', () => {
        expect(letterForName('Éclair')).toBe('E');
    });
});

describe('computeLetterBuckets', () => {
    it('produces first-occurrence offsets and counts in server order', () => {
        const names = ['#1 Comic', '9 Lives', 'Alpha Flight', 'apple pie', 'Batman', 'Zorro'];
        expect(computeLetterBuckets(names)).toEqual([
            { letter: '#', offset: 0, count: 2 },
            { letter: 'A', offset: 2, count: 2 },
            { letter: 'B', offset: 4, count: 1 },
            { letter: 'Z', offset: 5, count: 1 },
        ]);
    });

    it('keeps first-occurrence semantics when a collation scatters a letter', () => {
        // SQLite binary order can produce: Alpha, Batman, Zorro, apple (lowercase after Z).
        const names = ['Alpha', 'Batman', 'Zorro', 'apple'];
        const buckets = computeLetterBuckets(names);
        // 'A' anchors at its FIRST occurrence; the straggler still counts toward 'A'.
        expect(buckets.find(b => b.letter === 'A')).toEqual({ letter: 'A', offset: 0, count: 2 });
        expect(buckets.find(b => b.letter === 'Z')).toEqual({ letter: 'Z', offset: 2, count: 1 });
    });

    it('returns an empty list for an empty index', () => {
        expect(computeLetterBuckets([])).toEqual([]);
    });
});
