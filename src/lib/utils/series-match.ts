// src/lib/utils/series-match.ts
//
// Cross-provider series matching for the global calendar. The Metron pull list and a ComicVine-keyed
// library don't share IDs, so the only viable bridge between an upcoming release and the library is the
// series NAME. A bare name match, though, is blind to *which volume* it hit: owning "X-Men (2019)" must
// not flag a brand-new "X-Men (2024)" pull-list release as already-in-library, and it must not let the
// monitored auto-create write a WANTED row onto the wrong volume. These helpers keep the name bridge but
// disambiguate same-named volumes by start year.

/**
 * Canonical form for comparing series names across providers: lowercased, every run of
 * non-alphanumeric characters (":", "-", "/", ".", "'", whitespace, …) collapsed to a single space,
 * then trimmed. So "X-Men: Outback", "X-Men - Outback" and "X-Men Outback" all compare equal — the same
 * delimiter-agnostic rule the automation relevance guard uses, which also undoes the punctuation a
 * library name loses to sanitizeFilename (e.g. a stored "X-Men Outback" still matches Metron's
 * "X-Men: Outback").
 */
export function normalizeSeriesName(name: string | null | undefined): string {
    return (name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

export interface MatchableSeries {
    name: string | null;
    year?: number | null;
}

/**
 * Resolve which local series a pull-list release belongs to.
 *
 * - 0 name matches  → null (not in library).
 * - 1 name match    → that series. The common case is unchanged, so recall doesn't regress.
 * - >1 name matches → the franchise has multiple same-named volumes, so disambiguate by start year
 *   (exact first, then ±1 for the occasional cross-provider off-by-one). If the release's year matches
 *   NONE of the same-named volumes we own, it's a different volume we don't have → null (the
 *   false-positive fix). With no release year to judge by, fall back to the first match — no worse than
 *   the old first-wins behavior for the genuinely un-disambiguatable case.
 *
 * Returns the matched element verbatim (id / metadataId / monitored / … all preserved).
 */
export function findLocalSeriesMatch<T extends MatchableSeries>(
    localSeries: T[],
    releaseName: string | null | undefined,
    releaseYear?: number | null,
): T | null {
    const target = normalizeSeriesName(releaseName);
    if (!target) return null;

    const candidates = localSeries.filter(s => normalizeSeriesName(s.name) === target);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    if (releaseYear) {
        const exact = candidates.find(s => s.year === releaseYear);
        if (exact) return exact;
        const near = candidates.find(s => typeof s.year === 'number' && s.year > 0 && Math.abs(s.year - releaseYear) <= 1);
        if (near) return near;
        // Multiple same-named volumes, none in the release's year window → we don't own this one.
        return null;
    }

    return candidates[0];
}
