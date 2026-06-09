// __tests__/lib/utils/issue-parser.test.ts
// Removed X of Y testing since hasn't been implemented yet
import { describe, it, expect } from 'vitest';
import { extractIssueNumber, isSameIssue } from '@/lib/utils/issue-parser';

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
    });
});