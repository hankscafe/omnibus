// src/lib/utils/file-pattern.ts
//
// Which naming template a single issue gets. EXACT TWIN of the engine's
// renamer.rs `file_pattern_for_issue` — the Node standardize loop, the rename PREVIEW, and the
// engine renamer must all answer this the same way, or a preview promises a name the renamer
// doesn't produce (that exact bug shipped in beta.007 for annuals).

/** #203 Phase 1: fixed, because interoperating with what Mylar/Komga expect beside the main run
 *  IS the feature. An annual is a distinct comic with its own year. */
export const ANNUAL_FILE_PATTERN = "{Series} Annual #{Issue} ({IssueYear})";

/** #203 COLLECTED: the default for a trade/omnibus attached to a series. Unlike the annual
 *  pattern this one is configurable (collected_file_naming_pattern) — TPB conventions vary far
 *  more (v01 / Vol. 1 / the collection's own title), so a fixed pattern would rename against the
 *  grain of half the libraries using it. */
export const COLLECTED_FILE_PATTERN = "{Series} Vol. {Issue} ({IssueYear})";

export function filePatternForIssue(opts: {
    isAnnual?: boolean;
    isCollected?: boolean;
    isManga?: boolean;
    filePattern: string;
    mangaFilePattern?: string | null;
    collectedFilePattern?: string | null;
}): string {
    const { isAnnual, isCollected, isManga, filePattern, mangaFilePattern, collectedFilePattern } = opts;

    // Collected first: a collected edition of a manga series is still a collected edition, and an
    // attachment's kind is an explicit human decision that outranks the series-level template.
    if (isCollected) {
        return collectedFilePattern && collectedFilePattern.trim() ? collectedFilePattern : COLLECTED_FILE_PATTERN;
    }
    if (isAnnual) return ANNUAL_FILE_PATTERN;
    if (isManga && mangaFilePattern && mangaFilePattern.trim()) return mangaFilePattern;
    return filePattern;
}
