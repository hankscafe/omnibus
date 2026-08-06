// __tests__/lib/utils/issue-parser.test.ts
// Removed X of Y testing since hasn't been implemented yet
import { describe, it, expect } from 'vitest';
import { extractIssueNumber, isSameIssue, parseIssueRange, normalizeFractionNumbers } from '@/lib/utils/issue-parser';

describe('Utility: Issue Number Parser', () => {
    describe('isSameIssue()', () => {
        it('should correctly evaluate standard numbers', () => {
            expect(isSameIssue('1', '001')).toBe(true);
            expect(isSameIssue('1.5', '001.50')).toBe(true);
        });

        it('should correctly evaluate negative numbers', () => {
            expect(isSameIssue('-1', '-001')).toBe(true);
            expect(isSameIssue('-2.5', '-2.50')).toBe(true);
            
            // Should not falsely equate a positive and negative
            expect(isSameIssue('-1', '1')).toBe(false);
        });

        it('should handle alpha-numeric suffixes', () => {
            expect(isSameIssue('1A', '001a')).toBe(true);
            expect(isSameIssue('-1A', '-001a')).toBe(true);
        });
    });

    // 2026-07-25 worklist item 9 (Kaiju No. 8): when the caller knows the series name, digits that
    // belong to the TITLE must not be read as issue numbers. The series name is consumed as a
    // punctuation/case-insensitive prefix before extraction; without the hint, behavior is unchanged.
    describe('extractIssueNumber() with a series-name hint', () => {
        it('stops title digits from swallowing the volume number (the Kaiju No. 8 case)', () => {
            expect(extractIssueNumber('Kaiju No.8 v01.cbz', 'Kaiju No. 8')).toBe('1');
            expect(extractIssueNumber('Kaiju No. 8 v02.cbz', 'Kaiju No. 8')).toBe('2');
        });

        it('keeps explicit markers and bare numbers working after the strip', () => {
            expect(extractIssueNumber('Kaiju No. 8 - Chapter 105.cbz', 'Kaiju No. 8')).toBe('105');
            expect(extractIssueNumber('Kaiju No.8 008.cbz', 'Kaiju No. 8')).toBe('8');
        });

        it('treats a file named exactly like the series as a one-shot, not as the title digit', () => {
            expect(extractIssueNumber('Kaiju No. 8.cbz', 'Kaiju No. 8')).toBe('1');
        });

        it('leaves parsing untouched when the hint is absent or not a prefix', () => {
            expect(extractIssueNumber('Kaiju No.8 v01.cbz')).toBe('8'); // status quo without the hint
            expect(extractIssueNumber('Batman 005.cbz', 'Superman')).toBe('5');
        });

        it('never half-consumes a longer word (glue guard) and ignores non-prefix titles', () => {
            expect(extractIssueNumber('Nova 003.cbz', 'No')).toBe('3');
            expect(extractIssueNumber('Batman 005 (2016).cbz', 'Batman')).toBe('5');
        });
    });

    describe('extractIssueNumber()', () => {
        it('should safely extract explicit negative numbers', () => {
            expect(extractIssueNumber('Spider-Man #-1.cbz')).toBe('-1');
            expect(extractIssueNumber('Deadpool Issue -005.cbz')).toBe('-5');
            expect(extractIssueNumber('X-Men Vol -2.cbz')).toBe('-2');
        });

        it('should NOT confuse title separators with negative numbers', () => {
            // Priority 5 standalone number check
            expect(extractIssueNumber('Spider-Man - 1.cbz')).toBe('1');
            expect(extractIssueNumber('Batman - 002.cbz')).toBe('2');
        });

        it('should safely ignore release years during extraction', () => {
            expect(extractIssueNumber('Batman 2016 #001.cbz')).toBe('1');
            expect(extractIssueNumber('Batman (2016) Issue -1.cbz')).toBe('-1');
        });

        it('should extract trailing issue numbers from volume-tagged filenames', () => {
            expect(extractIssueNumber('Uncanny X-Men-V1-001.cbz')).toBe('1');
            expect(extractIssueNumber('Uncanny X-Men-V1-023.cbz')).toBe('23');
            expect(extractIssueNumber('Uncanny X-Men-V1-066.cbz')).toBe('66');
        });

        it('should prefer explicit issue markers over volume tokens', () => {
            expect(extractIssueNumber('Spider-Man v2 #5.cbz')).toBe('5');
            expect(extractIssueNumber('Batman Vol 2 Issue 12.cbz')).toBe('12');
        });

        it('should fall back to the volume number only when no other number exists', () => {
            expect(extractIssueNumber('Batman Vol 4.cbz')).toBe('4');
        });
    });

    describe('parseIssueRange()', () => {
        it('detects issue/volume ranges in GetComics batch titles', () => {
            expect(parseIssueRange('Crossed Vol. 1 #0 – 9 (2008-2010)')).toEqual({ start: 0, end: 9 });
            expect(parseIssueRange('Saga #1-54')).toEqual({ start: 1, end: 54 });
            expect(parseIssueRange('Crossed Volume 1 – 4 + Extras (2008-2015)')).toEqual({ start: 1, end: 4 });
            expect(parseIssueRange('Crossed +100 #1 – 18 (2014-2016)')).toEqual({ start: 1, end: 18 });
        });

        it('picks the issue range and ignores the trailing year span when both are present', () => {
            expect(parseIssueRange('Crossed Vol. 4 – Badlands #1 – 25 (2012-2013)')).toEqual({ start: 1, end: 25 });
        });

        it('returns null for single issues, lone TPBs, and pure year spans', () => {
            expect(parseIssueRange('Batman #12 (2011)')).toBeNull();
            expect(parseIssueRange('Batman Vol 1 TPB')).toBeNull();
            expect(parseIssueRange('Crossed (2008-2010)')).toBeNull();
        });
    });
});
// Issue #200 (anacronismo): ComicVine numbers half-issues with Unicode vulgar fractions
// ("X-Men (1991) #½ - Thrall"). Every layer must treat "½" and "0.5" as the same number, and
// the extractor must parse "#½" instead of defaulting to "1" (which collided with the real #1).
// Parity: omnibus-engine metadata.rs normalize_fraction_numbers / is_same_issue + scanner tests.
describe('Vulgar fraction issue numbers (#200)', () => {
    it('normalizeFractionNumbers rewrites fractions as decimals, merging glued integers', () => {
        expect(normalizeFractionNumbers('½')).toBe('0.5');
        expect(normalizeFractionNumbers('1½')).toBe('1.5');   // Wizard #1½ is a real comic
        expect(normalizeFractionNumbers('¼')).toBe('0.25');
        expect(normalizeFractionNumbers('¾')).toBe('0.75');
        expect(normalizeFractionNumbers('X-Men #½ (1998)')).toBe('X-Men #0.5 (1998)');
        expect(normalizeFractionNumbers('no fractions 12.5')).toBe('no fractions 12.5');
    });

    it('isSameIssue equates the fraction with its decimal forms', () => {
        expect(isSameIssue('½', '0.5')).toBe(true);
        expect(isSameIssue('½', '.5')).toBe(true);
        expect(isSameIssue('½', '½')).toBe(true);
        expect(isSameIssue('1½', '1.5')).toBe(true);
        expect(isSameIssue('¼', '0.25')).toBe(true);
        expect(isSameIssue('½', '1')).toBe(false);
        expect(isSameIssue('½', '0.25')).toBe(false);
    });

    it('extractIssueNumber parses fraction filenames instead of defaulting to 1', () => {
        expect(extractIssueNumber('X-Men #½ (1998).cbz')).toBe('0.5');
        expect(extractIssueNumber('X-Men #½ (1998).cbz', 'X-Men')).toBe('0.5');
        expect(extractIssueNumber('Wizard #1½.cbz')).toBe('1.5');
        expect(extractIssueNumber('Gen13 #¾ (1994).cbz')).toBe('0.75'); // that one exists too
    });
});
