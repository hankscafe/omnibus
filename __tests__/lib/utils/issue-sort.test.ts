// #203 round 3 (anacronismo): the series page listed the run by number and then every attached
// volume's annuals by number after it, so seven "Annual #1"s sat in a row with nothing saying
// which volume each was from. These pin the shared sort + label the page now uses: a lane names
// its volume, and a sort by release date lets annuals fall into place between the issues.
import { describe, it, expect } from 'vitest';
import { ISSUE_SORT_MODES, parseIssueSortMode, sortIssuesForDisplay, laneLabel } from '@/lib/utils/issue-sort';

const row = (id: string, parsedNum: number, opts: { isAnnual?: boolean; releaseDate?: string | null; attachmentName?: string | null } = {}) =>
    ({ id, parsedNum, isAnnual: !!opts.isAnnual, releaseDate: opts.releaseDate ?? null, attachmentName: opts.attachmentName ?? null });

// The Amazing Spider-Man shape: the run, an annual from the 1964 volume between #14 and #15, a
// '96 one-off, and a skeleton with no date yet.
const run = [
    row('i15', 15, { releaseDate: '1964-08-01' }),
    row('a96', 1, { isAnnual: true, releaseDate: '1996-11-01', attachmentName: "The Amazing Spider-Man '96" }),
    row('i1', 1, { releaseDate: '1963-03-01' }),
    row('a64', 1, { isAnnual: true, releaseDate: '1964-06-01', attachmentName: 'The Amazing Spider-Man Annual' }),
    row('i14', 14, { releaseDate: '1964-07-01' }),
    row('undated', 2, { isAnnual: true, releaseDate: null, attachmentName: 'The Amazing Spider-Man Annual' }),
];
const ids = (rows: { id: string }[]) => rows.map(r => r.id);

describe('parseIssueSortMode', () => {
    it('accepts exactly the four modes and nothing else', () => {
        expect(ISSUE_SORT_MODES.map(m => m.value)).toEqual(['number_asc', 'number_desc', 'date_asc', 'date_desc']);
        for (const m of ISSUE_SORT_MODES) expect(parseIssueSortMode(m.value)).toBe(m.value);
        expect(parseIssueSortMode('name_asc')).toBeNull();
        expect(parseIssueSortMode('')).toBeNull();
        expect(parseIssueSortMode(null)).toBeNull();
        expect(parseIssueSortMode(undefined)).toBeNull();
    });
});

describe('sortIssuesForDisplay', () => {
    it('by number keeps the run first and the annuals after it, low to high — what the page always did', () => {
        expect(ids(sortIssuesForDisplay(run, 'number_asc'))).toEqual(['i1', 'i14', 'i15', 'a96', 'a64', 'undated']);
    });

    it('by number, high to low, still keeps the run ahead of the annuals', () => {
        expect(ids(sortIssuesForDisplay(run, 'number_desc'))).toEqual(['i15', 'i14', 'i1', 'undated', 'a96', 'a64']);
    });

    it('by release date, oldest first, lets an annual fall between the issues it was published among', () => {
        // The 1964 annual (June) lands ahead of #14 (July) and #15 (August) — chronological,
        // whatever the numbers say; the undated skeleton closes the list.
        expect(ids(sortIssuesForDisplay(run, 'date_asc'))).toEqual(['i1', 'a64', 'i14', 'i15', 'a96', 'undated']);
    });

    it('by release date, newest first, reverses the dated rows and still leaves the undated ones last', () => {
        expect(ids(sortIssuesForDisplay(run, 'date_desc'))).toEqual(['a96', 'i15', 'i14', 'a64', 'i1', 'undated']);
    });

    it('breaks a shared date by domain then number, in the chosen direction', () => {
        const sameDay = [
            row('a1', 1, { isAnnual: true, releaseDate: '2012-05-01' }),
            row('i2', 2, { releaseDate: '2012-05-01' }),
            row('i1', 1, { releaseDate: '2012-05-01' }),
        ];
        expect(ids(sortIssuesForDisplay(sameDay, 'date_asc'))).toEqual(['i1', 'i2', 'a1']);
        expect(ids(sortIssuesForDisplay(sameDay, 'date_desc'))).toEqual(['a1', 'i2', 'i1']);
    });

    it('returns a new array and leaves the input untouched', () => {
        const before = ids(run);
        const out = sortIssuesForDisplay(run, 'date_desc');
        expect(out).not.toBe(run);
        expect(ids(run)).toEqual(before);
    });

    it('treats a missing or NaN number as zero rather than throwing', () => {
        const odd = [row('x', NaN), row('y', 3), { id: 'z', parsedNum: null as unknown as number, isAnnual: false, releaseDate: null, attachmentName: null }];
        expect(ids(sortIssuesForDisplay(odd, 'number_asc'))).toEqual(['x', 'z', 'y']);
    });
});

describe('laneLabel', () => {
    it('names the attached volume ahead of the domain, and just the domain otherwise', () => {
        expect(laneLabel({ isAnnual: true, attachmentName: "The Amazing Spider-Man '96" })).toBe("The Amazing Spider-Man '96 · Annual");
        expect(laneLabel({ isAnnual: true, attachmentName: null })).toBe('Annual');
        expect(laneLabel({ isAnnual: false, attachmentName: null })).toBe('Issue');
        // A blank name is no name.
        expect(laneLabel({ isAnnual: true, attachmentName: '   ' })).toBe('Annual');
    });
});

// #255: a Special is its own domain — after the run and the annuals by number, and never read as
// the run's "#1". Every surface that orders issues (the page, Komga, OPDS, the reader) shares this.
describe('a Special', () => {
    const withSpecial = [
        { id: 'sp1', parsedNum: 1, isAnnual: false, isSpecial: true, releaseDate: '2026-01-14' },
        { id: 'i2', parsedNum: 2, isAnnual: false, releaseDate: '2024-11-13' },
        { id: 'a1', parsedNum: 1, isAnnual: true, releaseDate: '2025-10-22' },
        { id: 'i1', parsedNum: 1, isAnnual: false, releaseDate: '2024-10-09' },
    ];

    it('sorts after the run and the annuals by number, in both directions', () => {
        expect(ids(sortIssuesForDisplay(withSpecial, 'number_asc'))).toEqual(['i1', 'i2', 'a1', 'sp1']);
        expect(ids(sortIssuesForDisplay(withSpecial, 'number_desc'))).toEqual(['i2', 'i1', 'a1', 'sp1']);
    });

    it('falls into place by release date like an annual', () => {
        expect(ids(sortIssuesForDisplay(withSpecial, 'date_asc'))).toEqual(['i1', 'i2', 'a1', 'sp1']);
    });

    it('is labelled a Special, after its own volume', () => {
        expect(laneLabel({ isSpecial: true, attachmentName: 'Absolute Batman: Ark-M' })).toBe('Absolute Batman: Ark-M · Special');
        expect(laneLabel({ isSpecial: true, attachmentName: null })).toBe('Special');
    });
});
