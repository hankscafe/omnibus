import { describe, it, expect } from 'vitest';
import { normalizeSeriesName, findLocalSeriesMatch } from '@/lib/utils/series-match';

describe('normalizeSeriesName', () => {
    it('collapses delimiters so ":" / "-" / spacing variants compare equal', () => {
        const canonical = normalizeSeriesName('X-Men Outback');
        expect(normalizeSeriesName('X-Men: Outback')).toBe(canonical);
        expect(normalizeSeriesName('X-Men - Outback')).toBe(canonical);
        expect(normalizeSeriesName('  x-men   outback  ')).toBe(canonical);
    });

    it('is null/undefined safe', () => {
        expect(normalizeSeriesName(null)).toBe('');
        expect(normalizeSeriesName(undefined)).toBe('');
    });
});

describe('findLocalSeriesMatch', () => {
    it('returns null when no local series shares the name', () => {
        const local = [{ id: 'a', name: 'Spawn', year: 1992 }];
        expect(findLocalSeriesMatch(local, 'X-Men', 2024)).toBeNull();
    });

    it('matches a single same-named volume regardless of year (recall preserved)', () => {
        const local = [{ id: 'a', name: 'X-Men', year: 2019 }];
        // No release year, and a non-matching release year, both still resolve the lone candidate.
        expect(findLocalSeriesMatch(local, 'X-Men', null)?.id).toBe('a');
        expect(findLocalSeriesMatch(local, 'X-Men', 2099)?.id).toBe('a');
    });

    it('bridges punctuation differences (Metron "X-Men: Outback" → stored "X-Men Outback")', () => {
        const local = [{ id: 'ob', name: 'X-Men Outback', year: 2026 }];
        expect(findLocalSeriesMatch(local, 'X-Men: Outback', 2026)?.id).toBe('ob');
    });

    it('disambiguates same-named volumes by exact start year', () => {
        const local = [
            { id: 'v2019', name: 'X-Men', year: 2019 },
            { id: 'v2024', name: 'X-Men', year: 2024 },
        ];
        expect(findLocalSeriesMatch(local, 'X-Men', 2024)?.id).toBe('v2024');
        expect(findLocalSeriesMatch(local, 'X-Men', 2019)?.id).toBe('v2019');
    });

    it('tolerates a ±1 cross-provider year disagreement', () => {
        const local = [
            { id: 'v2019', name: 'X-Men', year: 2019 },
            { id: 'v2024', name: 'X-Men', year: 2024 },
        ];
        expect(findLocalSeriesMatch(local, 'X-Men', 2025)?.id).toBe('v2024');
    });

    it('returns null when several same-named volumes exist but none match the release year (the false-positive fix)', () => {
        const local = [
            { id: 'v2019', name: 'X-Men', year: 2019 },
            { id: 'v2021', name: 'X-Men', year: 2021 },
        ];
        // A brand-new 2024 volume we do NOT own must not borrow an owned volume's badge.
        expect(findLocalSeriesMatch(local, 'X-Men', 2024)).toBeNull();
    });

    it('falls back to the first match only when there is no release year to disambiguate with', () => {
        const local = [
            { id: 'first', name: 'X-Men', year: 2019 },
            { id: 'second', name: 'X-Men', year: 2024 },
        ];
        expect(findLocalSeriesMatch(local, 'X-Men', null)?.id).toBe('first');
    });
});
