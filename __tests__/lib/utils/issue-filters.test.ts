// The issues view's filters as URL state — both directions. A deep link must land pre-filtered
// (the "missing issues" entry point is /library/issues?status=WANTED), a stale or hand-typed
// value must never reach the API, and the plain page must keep a plain URL.
import { describe, it, expect } from 'vitest';
import { filtersFromParams, paramsFromFilters, DEFAULT_ISSUE_FILTERS } from '@/lib/utils/issue-filters';

const parse = (qs: string) => filtersFromParams(new URLSearchParams(qs));

describe('filtersFromParams', () => {
    it('lands a deep link on the filtered view', () => {
        expect(parse('status=WANTED')).toEqual({ ...DEFAULT_ISSUE_FILTERS, status: 'WANTED' });
        expect(parse('status=WANTED&library=MANGA&era=2010s&sort=release_asc&publisher=DC%20Comics&q=%20Batman%20'))
            .toEqual({ search: 'Batman', publisher: 'DC Comics', era: '2010s', library: 'MANGA', status: 'WANTED', sort: 'release_asc' });
    });

    it('falls back to the default for anything it does not recognise', () => {
        // A stale bookmark or a typo must not become a value the select cannot show — and must not
        // be forwarded to the API, which would read an unknown status as "no filter".
        expect(parse('status=BOGUS&sort=nope&library=BOOKS&era=1800s')).toEqual(DEFAULT_ISSUE_FILTERS);
        expect(parse('status=wanted')).toEqual(DEFAULT_ISSUE_FILTERS); // exact-case enum
    });

    it('treats an absent or empty query as the defaults', () => {
        expect(filtersFromParams(null)).toEqual(DEFAULT_ISSUE_FILTERS);
        expect(filtersFromParams(undefined)).toEqual(DEFAULT_ISSUE_FILTERS);
        expect(parse('')).toEqual(DEFAULT_ISSUE_FILTERS);
        expect(parse('publisher=%20%20&q=%20')).toEqual(DEFAULT_ISSUE_FILTERS);
    });
});

describe('paramsFromFilters', () => {
    it('writes only what differs from the defaults, so the plain page keeps a plain URL', () => {
        expect(paramsFromFilters(DEFAULT_ISSUE_FILTERS)).toBe('');
        expect(paramsFromFilters({ ...DEFAULT_ISSUE_FILTERS, status: 'WANTED' })).toBe('status=WANTED');
    });

    it('round-trips every field in a fixed key order', () => {
        const full = { search: 'Batman', publisher: 'DC Comics', era: '2010s', library: 'COMICS', status: 'DOWNLOADED' as const, sort: 'release_asc' };
        const qs = paramsFromFilters(full);
        expect(qs).toBe('status=DOWNLOADED&library=COMICS&publisher=DC+Comics&era=2010s&sort=release_asc&q=Batman');
        expect(filtersFromParams(new URLSearchParams(qs))).toEqual(full);
    });

    it('trims the search and drops it when blank', () => {
        expect(paramsFromFilters({ ...DEFAULT_ISSUE_FILTERS, search: '   ' })).toBe('');
        expect(paramsFromFilters({ ...DEFAULT_ISSUE_FILTERS, search: '  Hellboy ' })).toBe('q=Hellboy');
    });
});
