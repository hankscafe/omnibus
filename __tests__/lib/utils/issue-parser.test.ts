// __tests__/lib/utils/issue-parser.test.ts
// Removed X of Y testing since hasn't been implemented yet
import { describe, it, expect } from 'vitest';
import { extractIssueNumber, isSameIssue, parseIssueRange } from '@/lib/utils/issue-parser';

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