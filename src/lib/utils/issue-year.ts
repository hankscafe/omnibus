// src/lib/utils/issue-year.ts
//
// The year a file name's {IssueYear} token carries (#243). In order of trust:
//   1. the issue's release date in the library - the year Standardize writes, so a file named at
//      import is never renamed again by the next Standardize;
//   2. the file's own ComicInfo <Year> - the issue's cover year. Never <Volume>: that is the
//      series' start year, which made every new issue of a long-running series carry the year
//      the series began;
//   3. the series year.
// Engine twin: watched_sync.rs issue_year_for_name.

function plausibleYear(value: unknown): string | null {
    const m = String(value ?? '').trim().match(/^(\d{4})/);
    if (!m) return null;
    const year = Number(m[1]);
    return year >= 1900 && year <= 2100 ? m[1] : null;
}

export function resolveIssueYear(sources: {
    releaseDate?: string | null;
    comicInfoYear?: number | string | null;
    seriesYear?: number | string | null;
}): string {
    return plausibleYear(sources.releaseDate)
        ?? plausibleYear(sources.comicInfoYear)
        ?? (sources.seriesYear == null ? '' : String(sources.seriesYear));
}
