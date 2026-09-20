// src/lib/komga/query.ts
//
// #206: the query strings Paperback's Komga source sends, parsed into what the data layer needs.
// Pure; the exact strings are pinned in __tests__/lib/komga-query.test.ts.

const MAX_PAGE_SIZE = 500;

export interface Paging {
    page: number;
    size: number;
    unpaged: boolean;
}

export function parsePaging(sp: URLSearchParams, defaultSize = 20): Paging {
    const rawPage = parseInt(sp.get('page') ?? '', 10);
    const rawSize = parseInt(sp.get('size') ?? '', 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 0;
    const size = Number.isFinite(rawSize) ? Math.min(MAX_PAGE_SIZE, Math.max(1, rawSize)) : defaultSize;
    return { page, size, unpaged: sp.get('unpaged') === 'true' };
}

export type SeriesSortField = 'name' | 'updatedAt' | 'createdAt';

export interface SeriesSort {
    field: SeriesSortField;
    dir: 'asc' | 'desc';
}

export const DEFAULT_SERIES_SORT: SeriesSort = { field: 'name', dir: 'asc' };

const SORT_FIELDS: Record<string, SeriesSortField> = {
    titlesort: 'name',
    title: 'name',
    name: 'name',
    lastmodified: 'updatedAt',
    lastmodifieddate: 'updatedAt',
    created: 'createdAt',
    createddate: 'createdAt',
};

/** `sort=titleSort`, `sort=lastModified,desc`, `sort=metadata.titleSort,asc` … unknown → default. */
export function parseSeriesSort(sp: URLSearchParams): SeriesSort {
    const raw = (sp.get('sort') ?? '').trim();
    if (!raw) return DEFAULT_SERIES_SORT;
    const [fieldRaw, dirRaw] = raw.split(',');
    const field = SORT_FIELDS[fieldRaw.trim().replace(/^metadata\./i, '').toLowerCase()];
    if (!field) return DEFAULT_SERIES_SORT;
    return { field, dir: (dirRaw ?? '').trim().toLowerCase() === 'desc' ? 'desc' : 'asc' };
}

export interface SeriesFilters {
    search: string | null;
    tags: string[];
    genres: string[];
    collectionIds: string[];
    libraryIds: string[];
}

const all = (sp: URLSearchParams, key: string) => sp.getAll(key).map(v => v.trim()).filter(v => v.length > 0);

export function parseSeriesFilters(sp: URLSearchParams): SeriesFilters {
    const search = (sp.get('search') ?? '').trim();
    return {
        search: search || null,
        tags: all(sp, 'tag'),
        genres: all(sp, 'genre'),
        collectionIds: all(sp, 'collection_id'),
        libraryIds: all(sp, 'library_id'),
    };
}

export type ReadStatus = 'IN_PROGRESS' | 'READ' | 'UNREAD';

export function parseReadStatus(sp: URLSearchParams): ReadStatus | null {
    const v = sp.get('read_status');
    return v === 'IN_PROGRESS' || v === 'READ' || v === 'UNREAD' ? v : null;
}
