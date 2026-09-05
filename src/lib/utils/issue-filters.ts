// src/lib/utils/issue-filters.ts
//
// The library-wide issues view's filters, as URL state. Pulled out of the page so a deep link like
// /library/issues?status=WANTED — the "missing issues" entry point (field report by
// robotshavehearts2, who never found the Wanted filter) — lands on a pre-filtered view, and so the
// view a user builds by hand is shareable: the URL is the filter state, in both directions.
//
// Parsing is strict on the enumerated fields. A bogus `status=BOGUS` from a stale bookmark falls
// back to ALL and is never forwarded to the API, which would otherwise treat it as "no status
// filter" while the UI's select showed a value it doesn't have.

export const ISSUE_SORT_DEFAULT = "release_desc";

const STATUS_VALUES = ["ALL", "DOWNLOADED", "WANTED"] as const;
const LIBRARY_VALUES = ["ALL", "COMICS", "MANGA"] as const;
const SORT_VALUES = ["release_desc", "release_asc"] as const;
const ERA_VALUES = ["ALL", "2020s", "2010s", "2000s", "1990s", "1980s", "CLASSIC"] as const;

export type IssueStatusFilter = (typeof STATUS_VALUES)[number];

export interface IssueFilters {
    search: string;
    publisher: string;
    era: string;
    library: string;
    status: IssueStatusFilter;
    sort: string;
}

export const DEFAULT_ISSUE_FILTERS: IssueFilters = {
    search: "",
    publisher: "ALL",
    era: "ALL",
    library: "ALL",
    status: "ALL",
    sort: ISSUE_SORT_DEFAULT,
};

function pick<T extends readonly string[]>(raw: string | null, allowed: T, fallback: T[number]): T[number] {
    const v = (raw || "").trim();
    return (allowed as readonly string[]).includes(v) ? (v as T[number]) : fallback;
}

/** URL → filters. Anything missing or unrecognised is the default; publisher is free text
 *  (the list comes from the library itself) and search is whatever the user typed. */
export function filtersFromParams(params: URLSearchParams | null | undefined): IssueFilters {
    if (!params) return { ...DEFAULT_ISSUE_FILTERS };
    return {
        search: (params.get("q") || "").trim(),
        publisher: (params.get("publisher") || "").trim() || "ALL",
        era: pick(params.get("era"), ERA_VALUES, "ALL"),
        library: pick(params.get("library"), LIBRARY_VALUES, "ALL"),
        status: pick(params.get("status"), STATUS_VALUES, "ALL"),
        sort: pick(params.get("sort"), SORT_VALUES, ISSUE_SORT_DEFAULT),
    };
}

/** Filters → query string, carrying ONLY what differs from the defaults so the plain page keeps a
 *  plain URL. Key order is fixed, so equal filter states produce equal strings. */
export function paramsFromFilters(f: IssueFilters): string {
    const p = new URLSearchParams();
    if (f.status !== "ALL") p.set("status", f.status);
    if (f.library !== "ALL") p.set("library", f.library);
    if (f.publisher !== "ALL") p.set("publisher", f.publisher);
    if (f.era !== "ALL") p.set("era", f.era);
    if (f.sort !== ISSUE_SORT_DEFAULT) p.set("sort", f.sort);
    if (f.search.trim()) p.set("q", f.search.trim());
    return p.toString();
}
