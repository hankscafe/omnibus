// src/lib/utils/synced-name.ts
// #199 round 3: which name survives a provider sync.
//
// The Issue.name column holds the STORY TITLE ("Lifedeath"), not a display composite.
// ComicVine's issue list supplies exactly that — but Metron's issue_list carries no story
// titles at all, so its list-derived names are composites like "X-Men (1991) #154" (built by
// MetronProvider.getSeriesIssues). Real Metron titles arrive later, from the per-issue detail
// pass. Without a guard, the next list sync would clobber a detail-fetched title straight
// back to the composite, every single run.
//
// EXACT twin: omnibus-engine/src/metadata.rs (synced_name_is_generic / resolve_synced_name /
// detail_name_write). Change one side only with a mirrored change + test on the other.
import { isSameIssue } from '@/lib/utils/issue-parser';

/** True for names that carry no story information for this row: empty, an "Issue 154" /
 *  "Issue #154" placeholder (any number — a stale placeholder is junk whatever its digits),
 *  or a name that merely ENDS with this row's own "#154" (bare or list-composite). A name
 *  with a story suffix ("X-Men (1991) #154: Lifedeath") is NOT generic. */
export function syncedNameIsGeneric(name: string | null | undefined, number: string): boolean {
    const n = (name || '').trim();
    if (!n) return true;
    // The number class includes the vulgar fractions the pipeline understands (issue #200).
    if (/^Issue\s*#?\s*[\d.½¼¾]+$/i.test(n)) return true;
    const tail = n.match(/#\s*([\d.½¼¾]+)$/);
    if (tail && isSameIssue(tail[1], number)) return true;
    return false;
}

/** What a LIST sync should write into Issue.name.
 *  - a locked (hasCustomMetadata) row keeps its curated name;
 *  - fillOnly (file_metadata_priority) keeps any existing non-empty name;
 *  - an empty provider name never blanks an existing one (never-wipe, issue #179);
 *  - a generic/composite provider name (Metron's issue_list shape) may fill blanks or
 *    replace another generic, but never replaces a real story title;
 *  - otherwise the provider's title wins, like every other synced field. */
export function resolveSyncedName(
    existing: string | null | undefined,
    incoming: string | null | undefined,
    number: string,
    locked: boolean,
    fillOnly: boolean,
): string | null {
    const ex = existing ?? null;
    if (locked) return ex;
    const exHas = !!ex && ex.trim() !== '';
    if (fillOnly && exHas) return ex;
    const inc = (incoming || '').trim();
    if (!inc) return ex;
    if (exHas && syncedNameIsGeneric(inc, number) && !syncedNameIsGeneric(ex, number)) return ex;
    return inc;
}

/** What the Metron DETAIL pass should write into Issue.name, or null for "leave the column
 *  alone". The detail payload is the issue's own id-verified record, so its story title beats
 *  a list composite or placeholder — only file_metadata_priority protecting a REAL existing
 *  title (not a placeholder it should be rescuing) stops the write. Locked rows never reach
 *  the detail pass, so they are not re-checked here. */
export function detailNameWrite(
    existing: string | null | undefined,
    storyTitle: string | null | undefined,
    number: string,
    fillOnly: boolean,
): string | null {
    const story = (storyTitle || '').trim();
    if (!story) return null;
    const exHas = !!existing && existing.trim() !== '';
    if (fillOnly && exHas && !syncedNameIsGeneric(existing, number)) return null;
    return story;
}
