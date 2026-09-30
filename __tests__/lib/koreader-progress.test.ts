// __tests__/lib/koreader-progress.test.ts
//
// #217 (realAbitbol): KOReader reports 1-based pages - `progress` is the top page shown ("9", sent as a
// string), `percentage` is page / page count (9/258 = 0.0348) - while ReadProgress.currentPage is the web
// reader's 0-based page index (it resumes at pages[currentPage]; "finished" is currentPage = page count).
// Storing KOReader's page number as the index made the web reader resume one page late.
import { describe, it, expect } from 'vitest';
import { koreaderPosition, pagesReadSince } from '@/lib/koreader-progress';

describe('lib: KOReader position → ReadProgress', () => {
    it('stores KOReader\'s page 9 as index 8 (the report: 258 pages, progress "9", 0.0348)', () => {
        expect(koreaderPosition('9', 0.0348, 258)).toEqual({ currentPage: 8, totalPages: 258, isCompleted: false });
    });

    it('uses the percentage when progress isn\'t a page number', () => {
        // round(0.0348 × 258) = 9 → index 8
        expect(koreaderPosition('/body/DocFragment[3]', 0.0348, 258)).toEqual({ currentPage: 8, totalPages: 258, isCompleted: false });
        expect(koreaderPosition(undefined, 0.75, 40)).toEqual({ currentPage: 29, totalPages: 40, isCompleted: false });
    });

    it('first page is index 0, and a page past the end is the last page', () => {
        expect(koreaderPosition('1', 1 / 258, 258).currentPage).toBe(0);
        expect(koreaderPosition('300', 0.5, 258).currentPage).toBe(257);
        expect(koreaderPosition('0', 0, 258).currentPage).toBe(0);
    });

    it('a finished book gets the web reader\'s own "finished" value (the page count)', () => {
        expect(koreaderPosition('256', 0.992, 258)).toEqual({ currentPage: 258, totalPages: 258, isCompleted: true });
    });

    it('with no known page count, works in percentage points out of 100', () => {
        expect(koreaderPosition('30', 0.75, 0)).toEqual({ currentPage: 74, totalPages: 100, isCompleted: false });
    });

    it('never trusts a percentage outside 0-1', () => {
        expect(koreaderPosition(undefined, 7, 40).isCompleted).toBe(true);
        expect(koreaderPosition(undefined, -2, 40).currentPage).toBe(0);
        expect(koreaderPosition(undefined, 'nonsense', 40).currentPage).toBe(0);
    });
});

describe('lib: pages read since the last position (the reading heatmap)', () => {
    const at = (currentPage: number, totalPages: number, isCompleted = false) => ({ currentPage, totalPages, isCompleted });

    it('first sync: every page up to the current one', () => {
        expect(pagesReadSince(null, at(8, 258))).toBe(9);
    });

    it('from a web-reader position to KOReader\'s: the pages between, not one extra', () => {
        // Web reader left off at index 5 (page 6); KOReader is now on page 9 (index 8) → 3 pages.
        expect(pagesReadSince(at(5, 258), at(8, 258))).toBe(3);
    });

    it('an old row on another page scale (the v1.4.5 percentage rows) is read as a fraction', () => {
        // 26 of 100 seen → 10 of 40; now on page 30 → 20 pages
        expect(pagesReadSince(at(25, 100), at(29, 40))).toBe(20);
    });

    it('moving backwards, or after finishing, adds nothing', () => {
        expect(pagesReadSince(at(31, 40), at(19, 40))).toBe(0);
        expect(pagesReadSince(at(40, 40, true), at(12, 40))).toBe(0);
    });

    it('finishing counts the rest of the book', () => {
        expect(pagesReadSince(at(29, 40), at(40, 40, true))).toBe(10);
    });
});
