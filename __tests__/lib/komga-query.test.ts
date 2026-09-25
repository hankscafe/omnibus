// __tests__/lib/komga-query.test.ts
//
// #206 (Paperback): the query strings Paperback's Komga source sends, verbatim from its code —
// `?page=0&size=20&deleted=false`, `?unpaged=true&media_status=READY&deleted=false`,
// `?page=0&size=40&search=bat&tag=x&genre=y&collection_id=c&library_id=l&sort=titleSort` and
// `?sort=readProgress.readDate,desc&read_status=IN_PROGRESS&page=0&size=20&deleted=false`.
import { describe, it, expect } from 'vitest';
import { parsePaging, parseSeriesSort, parseSeriesFilters, parseReadStatus } from '@/lib/komga/query';

const sp = (qs: string) => new URL(`http://localhost/komga/api/v1/series${qs}`).searchParams;

describe('komga query: paging', () => {
    it('defaults to page 0 / size 20 and reads the explicit values', () => {
        expect(parsePaging(sp(''))).toEqual({ page: 0, size: 20, unpaged: false });
        expect(parsePaging(sp('?page=2&size=40&deleted=false'))).toEqual({ page: 2, size: 40, unpaged: false });
    });

    it('clamps nonsense: negative or non-numeric page → 0, size within 1..500', () => {
        expect(parsePaging(sp('?page=-3&size=0'))).toEqual({ page: 0, size: 1, unpaged: false });
        expect(parsePaging(sp('?page=abc&size=100000'))).toEqual({ page: 0, size: 500, unpaged: false });
    });

    it('honours unpaged=true (the books-of-a-series call)', () => {
        expect(parsePaging(sp('?unpaged=true&media_status=READY&deleted=false')).unpaged).toBe(true);
        expect(parsePaging(sp('?unpaged=false')).unpaged).toBe(false);
    });

    it('takes a caller default size', () => {
        expect(parsePaging(sp(''), 40).size).toBe(40);
    });
});

describe('komga query: series sort', () => {
    it('defaults to title order', () => {
        expect(parseSeriesSort(sp(''))).toEqual({ field: 'name', dir: 'asc' });
    });

    it('reads the two sorts the source emits, plus Komga\'s prefixed and created forms', () => {
        expect(parseSeriesSort(sp('?sort=titleSort'))).toEqual({ field: 'name', dir: 'asc' });
        // lastModified = when the series last gained a file (Issue.fileAddedAt, #206 follow-up) —
        // not Series.updatedAt, which the Series Monitor bumps on every run to rotate its window.
        expect(parseSeriesSort(sp('?sort=lastModified,desc'))).toEqual({ field: 'fileAddedAt', dir: 'desc' });
        expect(parseSeriesSort(sp('?sort=lastModifiedDate,asc'))).toEqual({ field: 'fileAddedAt', dir: 'asc' });
        expect(parseSeriesSort(sp('?sort=metadata.titleSort,desc'))).toEqual({ field: 'name', dir: 'desc' });
        expect(parseSeriesSort(sp('?sort=created,desc'))).toEqual({ field: 'createdAt', dir: 'desc' });
        expect(parseSeriesSort(sp('?sort=createdDate,asc'))).toEqual({ field: 'createdAt', dir: 'asc' });
    });

    it('falls back to the default for an unknown field', () => {
        expect(parseSeriesSort(sp('?sort=booksCount,desc'))).toEqual({ field: 'name', dir: 'asc' });
    });
});

describe('komga query: series filters', () => {
    it('reads search and the four tag-derived filters, repeated values included', () => {
        const f = parseSeriesFilters(sp('?search=bat%20man&tag=Event&tag=Crossover&genre=Superhero&collection_id=col_1&library_id=lib_1&library_id=lib_2'));
        expect(f).toEqual({
            search: 'bat man',
            tags: ['Event', 'Crossover'],
            genres: ['Superhero'],
            collectionIds: ['col_1'],
            libraryIds: ['lib_1', 'lib_2'],
        });
    });

    it('ignores blank values', () => {
        expect(parseSeriesFilters(sp('?search=%20%20&tag=&genre='))).toEqual({
            search: null, tags: [], genres: [], collectionIds: [], libraryIds: [],
        });
    });
});

describe('komga query: read status', () => {
    it('reads the IN_PROGRESS filter the Continue Reading section sends and null otherwise', () => {
        expect(parseReadStatus(sp('?sort=readProgress.readDate,desc&read_status=IN_PROGRESS'))).toBe('IN_PROGRESS');
        expect(parseReadStatus(sp('?read_status=READ'))).toBe('READ');
        expect(parseReadStatus(sp('?read_status=UNREAD'))).toBe('UNREAD');
        expect(parseReadStatus(sp('?read_status=bogus'))).toBeNull();
        expect(parseReadStatus(sp(''))).toBeNull();
    });
});
