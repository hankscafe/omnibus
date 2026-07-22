import { isSameIssue } from '@/lib/utils/issue-parser';

// Issue #194: a metadata-sync race can leave an Issue row holding another issue's metadataId.
// Any path that fetches provider data BY that stored id (view-time enrichment, cover reset) must
// prove the fetched issue really is this row — same parent volume/series and same issue number —
// before writing, or the wrong id propagates into description/credits/covers and then gets locked
// in by DEEP_SYNCED. Returns a log-ready reason when the payload fails the check, null when it
// may be trusted.
//
// Checks are evidence-based: a dimension is only enforced when both sides are known, so e.g. a
// Metron payload without a resolvable series id (their fallback search failed) still gets the
// number check instead of being rejected outright.
export function issueIdentityMismatch(opts: {
    rowNumber: string;
    seriesMetadataId?: string | null;
    seriesMetadataSource?: string | null;
    /** Provider the stored metadataId belongs to ('COMICVINE' | 'METRON'). */
    expectedSource: string;
    /** CV volume id / Metron series id carried by the fetched payload. */
    fetchedParentId?: string | null;
    fetchedIssueNumber?: string | number | null;
}): string | null {
    // The series' own provider id is only comparable when the series is matched to the same provider.
    const seriesParentId = opts.seriesMetadataSource === opts.expectedSource ? (opts.seriesMetadataId || null) : null;

    if (opts.fetchedParentId && seriesParentId && opts.fetchedParentId !== seriesParentId) {
        const parentKind = opts.expectedSource === 'METRON' ? 'series' : 'volume';
        return `resolved to ${parentKind} ${opts.fetchedParentId} but the series is ${parentKind} ${seriesParentId}`;
    }

    const fetchedNum = opts.fetchedIssueNumber;
    if (fetchedNum !== null && fetchedNum !== undefined && String(fetchedNum).trim() !== ''
        && !isSameIssue(String(fetchedNum), opts.rowNumber)) {
        return `resolved to issue #${fetchedNum} but the row is issue #${opts.rowNumber}`;
    }

    return null;
}
