// @vitest-environment jsdom
// #270 (niddelicious): reading from a Reading List - the reader's "next" follows the list, and the
// list page knows you are coming back to it.
import { describe, it, expect, beforeEach } from 'vitest';
import {
    readerHref, nextInList, markReturnToList, takeReturnToList, READING_LIST_RETURN_KEY,
} from '@/lib/reading-list-nav';

// A linked entry (its file, or null when the issue isn't in the library yet) and an unlinked one.
const entry = (id: string, filePath: string | null, series = 'Crisis') => ({
    id, issue: { filePath, number: id, series: { name: series, folderPath: `/comics/${series}` } },
});
const missing = (id: string) => ({ id, issue: null });

describe('readerHref', () => {
    it('opens the file in its series', () => {
        expect(readerHref('/comics/A & B/A #1.cbz', '/comics/A & B'))
            .toBe(`/reader?path=${encodeURIComponent('/comics/A & B/A #1.cbz')}&series=${encodeURIComponent('/comics/A & B')}`);
    });

    it('names the list and the entry when read from a list', () => {
        expect(readerHref('/c/x.cbz', null, { listId: 'l 1', itemId: 'it2' }))
            .toBe(`/reader?path=${encodeURIComponent('/c/x.cbz')}&series=&list=l%201&item=it2`);
    });
});

describe('nextInList', () => {
    const items = [
        entry('it1', '/comics/Crisis/1.cbz'),
        missing('it2'),
        entry('it3', null),
        entry('it4', '/comics/Flash/7.cbz', 'Flash'),
        entry('it5', '/comics/Crisis/1.cbz'),
        entry('it6', '/comics/Crisis/2.cbz'),
    ];

    it('is the next entry you have a file for, from any series, counting the ones it skipped', () => {
        const r = nextInList(items, { itemId: 'it1', filePath: '/comics/Crisis/1.cbz' });
        expect(r).toEqual({ found: true, next: items[3], skipped: 2 });
    });

    it('goes by the entry, so an issue that is in the list twice continues from the right place', () => {
        expect(nextInList(items, { itemId: 'it5', filePath: '/comics/Crisis/1.cbz' }).next).toBe(items[5]);
    });

    it("finds the file's first entry when the link names no entry or one that is gone", () => {
        expect(nextInList(items, { itemId: null, filePath: '/comics/Flash/7.cbz' }).next).toBe(items[4]);
        expect(nextInList(items, { itemId: 'gone', filePath: '/comics/Flash/7.cbz' }).next).toBe(items[4]);
    });

    it("doesn't trust an entry id whose file is a different one", () => {
        expect(nextInList(items, { itemId: 'it1', filePath: '/comics/Flash/7.cbz' }).next).toBe(items[4]);
    });

    it('has no next after the last entry you have a file for', () => {
        expect(nextInList(items, { itemId: 'it6', filePath: '/comics/Crisis/2.cbz' })).toEqual({ found: true, next: null, skipped: 0 });
        expect(nextInList([...items, missing('it7')], { itemId: 'it6', filePath: '/comics/Crisis/2.cbz' }))
            .toEqual({ found: true, next: null, skipped: 1 });
    });

    it("says so when the file isn't in the list at all", () => {
        expect(nextInList(items, { itemId: 'it1', filePath: '/comics/Other/1.cbz' })).toEqual({ found: false, next: null, skipped: 0 });
    });
});

describe('return marker', () => {
    beforeEach(() => window.sessionStorage.clear());

    it('is taken once, and only by the list it was left for', () => {
        markReturnToList('l1');
        expect(window.sessionStorage.getItem(READING_LIST_RETURN_KEY)).toBe('l1');
        expect(takeReturnToList('l2')).toBe(false);
        expect(takeReturnToList('l1')).toBe(true);
        expect(takeReturnToList('l1')).toBe(false);
    });
});
