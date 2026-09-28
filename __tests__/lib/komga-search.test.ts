// __tests__/lib/komga-search.test.ts
//
// #206 prep for Paperback's 0.9 "Komga" source (extensions-default branch 0.9, v3.0): it lists a
// series' chapters with POST /api/v1/books/list and searches (and fills Continue Reading) with
// POST /api/v1/series/list, sending Komga's search-condition JSON. The body is untrusted input, so
// it is parsed into a small whitelisted tree — bounded in size, depth and clause count, unknown
// fields and operators dropped — and only that tree is turned into Prisma filters. The exact
// bodies the source sends are pinned here.
import { describe, it, expect, vi } from 'vitest';
import { parseSearchBody, readSearchBody, seriesWhereFor, bookWhereFor, pinnedSeriesId, SearchError, SEARCH_LIMITS, NEVER } from '@/lib/komga/search';

// What the 0.9 source sends (komga.ts getSearchResults / getChapters / getDiscoverSectionItems).
const SEARCH_BODY = {
    fullTextSearch: '  bat ',
    condition: {
        allOf: [
            { tag: { operator: 'is', value: 'Event%20Book' } }, // values are encodeURIComponent'd by the source
            { genre: { operator: 'isNot', value: 'Horror' } },
            { collectionId: { operator: 'is', value: 'col_1' } },
            { libraryId: { operator: 'is', value: 'lib_1' } },
        ],
    },
};
const CHAPTERS_BODY = {
    condition: {
        seriesId: { operator: 'is', value: 'ser_1' },
        deleted: { operator: 'isFalse' },
        mediaStatus: { operator: 'is', value: 'READY' },
    },
};
const CONTINUE_BODY = { condition: { deleted: { operator: 'isFalse' }, readStatus: { operator: 'is', value: 'IN_PROGRESS' } } };

describe('parseSearchBody', () => {
    it('reads the source\'s search body: full text trimmed, filters decoded, allOf kept', () => {
        const b = parseSearchBody(SEARCH_BODY);
        expect(b.fullTextSearch).toBe('bat');
        expect(b.condition).toEqual({
            kind: 'all',
            nodes: [
                { kind: 'field', field: 'tag', op: 'is', value: 'Event Book' },
                { kind: 'field', field: 'genre', op: 'isNot', value: 'Horror' },
                { kind: 'field', field: 'collectionId', op: 'is', value: 'col_1' },
                { kind: 'field', field: 'libraryId', op: 'is', value: 'lib_1' },
            ],
        });
        expect(b.ignored).toEqual([]);
    });

    it('treats several keys in one condition object as allOf — how the source writes its chapter and Continue Reading bodies', () => {
        expect(parseSearchBody(CHAPTERS_BODY).condition).toEqual({
            kind: 'all',
            nodes: [
                { kind: 'field', field: 'seriesId', op: 'is', value: 'ser_1' },
                { kind: 'flag', field: 'deleted', value: false },
                { kind: 'field', field: 'mediaStatus', op: 'is', value: 'READY' },
            ],
        });
        expect(parseSearchBody(CONTINUE_BODY).condition).toEqual({
            kind: 'all',
            nodes: [
                { kind: 'flag', field: 'deleted', value: false },
                { kind: 'field', field: 'readStatus', op: 'is', value: 'IN_PROGRESS' },
            ],
        });
    });

    it('supports anyOf, and collapses a group of one to its member', () => {
        const b = parseSearchBody({ condition: { anyOf: [{ libraryId: { operator: 'is', value: 'a' } }, { allOf: [{ tag: { operator: 'is', value: 'x' } }] }] } });
        expect(b.condition).toEqual({
            kind: 'any',
            nodes: [{ kind: 'field', field: 'libraryId', op: 'is', value: 'a' }, { kind: 'field', field: 'tag', op: 'is', value: 'x' }],
        });
    });

    it('drops fields and operators it does not know — and says which', () => {
        const b = parseSearchBody({ condition: { allOf: [
            { author: { operator: 'is', value: 'x' } },
            { seriesId: { operator: 'contains', value: 'x' } },
            { tag: { operator: 'is', value: 'A' } },
        ] } });
        expect(b.condition).toEqual({ kind: 'field', field: 'tag', op: 'is', value: 'A' });
        expect(b.ignored).toEqual(['author', 'seriesId:contains']);
    });

    it('reads an empty or missing body as "everything", and keeps a malformed escape as typed', () => {
        expect(parseSearchBody(null)).toEqual({ condition: null, fullTextSearch: null, ignored: [] });
        expect(parseSearchBody({})).toEqual({ condition: null, fullTextSearch: null, ignored: [] });
        expect(parseSearchBody({ condition: { tag: { operator: 'is', value: 'bad%zz' } } }).condition)
            .toEqual({ kind: 'field', field: 'tag', op: 'is', value: 'bad%zz' });
    });

    it('refuses what no client sends: a non-object body or condition, too deep, too many clauses', () => {
        const bad = (v: unknown) => { try { parseSearchBody(v); return null; } catch (e) { return e; } };
        for (const v of [[], 'x', { condition: 'x' }, { condition: [] }, { condition: { allOf: 'x' } }]) {
            expect(bad(v)).toBeInstanceOf(SearchError);
            expect((bad(v) as SearchError).status).toBe(400);
        }
        let deep: any = { tag: { operator: 'is', value: 'x' } };
        for (let i = 0; i < SEARCH_LIMITS.maxDepth + 1; i++) deep = { allOf: [deep] };
        expect(bad({ condition: deep })).toBeInstanceOf(SearchError);
        const wide = { allOf: Array.from({ length: SEARCH_LIMITS.maxNodes + 1 }, (_, i) => ({ tag: { operator: 'is', value: `t${i}` } })) };
        expect(bad({ condition: wide })).toBeInstanceOf(SearchError);
    });
});

describe('readSearchBody', () => {
    const post = (body: string, headers: Record<string, string> = {}) =>
        new Request('http://localhost/komga/api/v1/series/list', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

    it('parses a JSON request', async () => {
        expect((await readSearchBody(post(JSON.stringify(CONTINUE_BODY)))).condition).not.toBeNull();
        expect((await readSearchBody(post(''))).condition).toBeNull();
    });

    it('refuses an oversized body (413) — by header, and by what actually arrived', async () => {
        const e1 = await readSearchBody(post('{}', { 'content-length': String(SEARCH_LIMITS.maxBytes + 1) })).catch(e => e);
        expect(e1).toBeInstanceOf(SearchError);
        expect(e1.status).toBe(413);
        const big = JSON.stringify({ fullTextSearch: 'x'.repeat(SEARCH_LIMITS.maxBytes) });
        const e2 = await readSearchBody(post(big)).catch(e => e);
        expect(e2.status).toBe(413);
    });

    it('refuses malformed JSON (400)', async () => {
        const e = await readSearchBody(post('{nope')).catch(e => e);
        expect(e).toBeInstanceOf(SearchError);
        expect(e.status).toBe(400);
    });
});

describe('seriesWhereFor — the tree as Prisma filters (grants are added by the caller, outside)', () => {
    const ctx = (ids: string[] = ['s2', 's1']) => ({ userId: 'u1', inProgressSeriesIds: vi.fn(async () => ids) });

    it('maps the source\'s search: tags/genres by whole value, collections only the caller\'s own', async () => {
        const c = ctx();
        const where = await seriesWhereFor(parseSearchBody(SEARCH_BODY).condition, c);
        expect(where).toEqual({
            AND: [
                { tags: { contains: '"Event Book"' } },
                // isNot on a column that may be empty keeps the empty rows: SQL's NOT (NULL LIKE …)
                // is NULL, which dropped every series with no genres (caught on the live walk).
                { OR: [{ genres: null }, { NOT: { genres: { contains: '"Horror"' } } }] },
                { collectionItems: { some: { collectionId: 'col_1', collection: { userId: 'u1' } } } },
                { libraryId: 'lib_1' },
            ],
        });
        expect(c.inProgressSeriesIds).not.toHaveBeenCalled(); // only asked for when the tree needs it
    });

    it('Continue Reading: deleted=false matches everything, IN_PROGRESS is the caller\'s started series', async () => {
        expect(await seriesWhereFor(parseSearchBody(CONTINUE_BODY).condition, ctx())).toEqual({ id: { in: ['s2', 's1'] } });
    });

    it('answers nothing rather than something wrong for what a series cannot be asked', async () => {
        const one = (c: unknown) => seriesWhereFor(parseSearchBody({ condition: c }).condition, ctx());
        expect(await one({ readStatus: { operator: 'is', value: 'READ' } })).toEqual(NEVER);
        expect(await one({ deleted: { operator: 'isTrue' } })).toEqual(NEVER);
        expect(await one({ allOf: [{ libraryId: { operator: 'is', value: 'a' } }, { deleted: { operator: 'isTrue' } }] })).toEqual(NEVER);
        expect(await seriesWhereFor(null, ctx())).toEqual({});
    });

    it('anyOf becomes OR; isNot becomes NOT', async () => {
        const where = await seriesWhereFor(parseSearchBody({ condition: { anyOf: [
            { seriesId: { operator: 'is', value: 'a' } }, { seriesId: { operator: 'isNot', value: 'b' } },
        ] } }).condition, ctx());
        expect(where).toEqual({ OR: [{ id: 'a' }, { NOT: { id: 'b' } }] });
    });

    it('isNot on a column that may be empty (genres, tags, library) also matches the empty rows', async () => {
        const one = (c: unknown) => seriesWhereFor(parseSearchBody({ condition: c }).condition, ctx());
        expect(await one({ tag: { operator: 'isNot', value: 'x' } })).toEqual({ OR: [{ tags: null }, { NOT: { tags: { contains: '"x"' } } }] });
        expect(await one({ libraryId: { operator: 'isNot', value: 'l' } })).toEqual({ OR: [{ libraryId: null }, { NOT: { libraryId: 'l' } }] });
        expect(bookWhereFor(parseSearchBody({ condition: { genre: { operator: 'isNot', value: 'g' } } }).condition, 'u1'))
            .toEqual({ series: { OR: [{ genres: null }, { NOT: { genres: { contains: '"g"' } } }] } });
    });
});

describe('bookWhereFor + pinnedSeriesId — chapters', () => {
    it('the source\'s chapter body is just "this series" (deleted=false and READY hold for every file-backed book)', () => {
        const node = parseSearchBody(CHAPTERS_BODY).condition;
        expect(bookWhereFor(node, 'u1')).toEqual({ seriesId: 'ser_1' });
        expect(pinnedSeriesId(node)).toBe('ser_1');
    });

    it('read status is the caller\'s own progress', () => {
        const one = (value: string, operator = 'is') => bookWhereFor(parseSearchBody({ condition: { readStatus: { operator, value } } }).condition, 'u1');
        expect(one('IN_PROGRESS')).toEqual({ readProgresses: { some: { userId: 'u1', isCompleted: false, currentPage: { gt: 0 } } } });
        expect(one('READ')).toEqual({ readProgresses: { some: { userId: 'u1', isCompleted: true } } });
        expect(one('UNREAD')).toEqual({ NOT: { readProgresses: { some: { userId: 'u1', OR: [{ isCompleted: true }, { currentPage: { gt: 0 } }] } } } });
        expect(one('READ', 'isNot')).toEqual({ NOT: { readProgresses: { some: { userId: 'u1', isCompleted: true } } } });
    });

    it('a media status other than READY, or a deleted book, matches nothing; a search is pinned to no series', () => {
        const one = (c: unknown) => bookWhereFor(parseSearchBody({ condition: c }).condition, 'u1');
        expect(one({ mediaStatus: { operator: 'is', value: 'ERROR' } })).toEqual(NEVER);
        expect(one({ mediaStatus: { operator: 'isNot', value: 'READY' } })).toEqual(NEVER);
        expect(one({ deleted: { operator: 'isTrue' } })).toEqual(NEVER);
        expect(one({ libraryId: { operator: 'is', value: 'lib_1' } })).toEqual({ series: { libraryId: 'lib_1' } });
        expect(pinnedSeriesId(parseSearchBody({ condition: { seriesId: { operator: 'isNot', value: 'x' } } }).condition)).toBeNull();
        expect(pinnedSeriesId(parseSearchBody(SEARCH_BODY).condition)).toBeNull();
    });
});
