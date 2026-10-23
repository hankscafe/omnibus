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
    /** #239: the row belongs to a series a COLLECTED attachment keeps as its own ("Leave it as its
     *  own series") and has no attachment of its own — its books are that collection's volumes. */
    isRetainedCollected?: boolean;
    isManga?: boolean;
    filePattern: string;
    mangaFilePattern?: string | null;
    collectedFilePattern?: string | null;
}): string {
    const { isAnnual, isCollected, isRetainedCollected, isManga, filePattern, mangaFilePattern, collectedFilePattern } = opts;
    const collected = () => (collectedFilePattern && collectedFilePattern.trim() ? collectedFilePattern : COLLECTED_FILE_PATTERN);

    // Collected first: a collected edition of a manga series is still a collected edition, and an
    // attachment's kind is an explicit human decision that outranks the series-level template.
    if (isCollected) return collected();
    if (isAnnual) return ANNUAL_FILE_PATTERN;
    // After the annual check, so an annual inside a kept-as-its-own collection keeps its Mylar name.
    if (isRetainedCollected) return collected();
    if (isManga && mangaFilePattern && mangaFilePattern.trim()) return mangaFilePattern;
    return filePattern;
}

/** The attachment that names an issue's file: the row's own attachment, and only when it belongs
 *  to the row's own series (#239). A row that strayed into another series still carrying a foreign
 *  attachment id (the child's sync once adopted the parent's skeletons) must not take that lane's
 *  naming. Twin of the renamer's `LEFT JOIN ... AND av."seriesId" = i."seriesId"`. */
export function namingAttachment<A extends { seriesId: string }>(issue: { seriesId: string; attachedVolume?: A | null }): A | null {
    const own = issue.attachedVolume;
    return own && own.seriesId === issue.seriesId ? own : null;
}

/** What `{Series}` means in one issue's FILE name. EXACT TWIN of renamer.rs `series_token_for_issue`.
 *
 *  A LOCAL collected edition — a trade the provider has no volume for — is claimed by its files'
 *  NAMES alone (the name-anchored rule, attachment-name.ts): there is no issue id in a ComicInfo
 *  to fall back on. So its books are named after the EDITION ("Batman Compendium Vol. 001"), which
 *  the name rule still finds as the filename's prefix; naming them after the series ("Batman Vol.
 *  001") would orphan them at the next wipe, where they would parse as the run's #1. Every other
 *  row — a plain issue, an annual, a provider-backed trade — names after the series as before. */
export function seriesTokenForIssue(opts: {
    isCollected?: boolean;
    attachmentSource?: string | null;
    attachmentName?: string | null;
    seriesName: string;
}): string {
    const { isCollected, attachmentSource, attachmentName, seriesName } = opts;
    const edition = (attachmentName || '').trim();
    if (isCollected && attachmentSource === 'LOCAL' && edition) return edition;
    return seriesName;
}
