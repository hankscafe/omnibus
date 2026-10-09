// __tests__/lib/utils/issue-year.test.ts
import { describe, it, expect } from 'vitest';
import { resolveIssueYear } from '@/lib/utils/issue-year';

// #243: the year a file's {IssueYear} token carries. Engine twin: watched_sync.rs issue_year_for_name.
describe('resolveIssueYear', () => {
    it('prefers the issue\'s release date in the library', () => {
        expect(resolveIssueYear({ releaseDate: '2026-01-14', comicInfoYear: 2025, seriesYear: 2024 })).toBe('2026');
        expect(resolveIssueYear({ releaseDate: '2026-01-14T00:00:00.000Z', seriesYear: 2024 })).toBe('2026');
    });

    it('falls back to the file\'s own ComicInfo <Year>, then the series year', () => {
        expect(resolveIssueYear({ releaseDate: null, comicInfoYear: 2026, seriesYear: 2024 })).toBe('2026');
        expect(resolveIssueYear({ releaseDate: '', comicInfoYear: '2026', seriesYear: '2024' })).toBe('2026');
        expect(resolveIssueYear({ releaseDate: null, comicInfoYear: null, seriesYear: 2024 })).toBe('2024');
    });

    it('ignores values that are not plausible years', () => {
        expect(resolveIssueYear({ releaseDate: 'TBA', comicInfoYear: 106705, seriesYear: 2024 })).toBe('2024');
        expect(resolveIssueYear({ releaseDate: '0000-00-00', comicInfoYear: 0, seriesYear: 2024 })).toBe('2024');
    });

    it('returns an empty string when nothing is known, so "()" is cleaned out of the name', () => {
        expect(resolveIssueYear({})).toBe('');
        expect(resolveIssueYear({ seriesYear: '' })).toBe('');
    });
});
