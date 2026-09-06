// Shared logic for the Smart Matcher's Search Match dialog (#199 round 2, concept by
// CapitanoNemo78): searching by name is the primary way to hand-match an item, with the
// classic exact-provider-ID lookup kept as the advanced fallback. Both paths funnel into
// the same volume-details resolution, so the shapes here are the single source of truth
// for what the page holds as a "manual match result".

/** The suggestion shape the matcher stores for a manually-resolved volume/series. */
export interface ManualSuggestion {
    id: any
    name: string
    year: any
    publisher: string
    image: string | null
    count: number | string
    description: string
    metadataSource: string
    /** The volume's per-issue stubs ({id, issue_number, name}) for Issue Mapping cross-reference. */
    rawIssues: any[]
    /** #199 round 4: the volume's aggregated credits as dialog-key CSV strings — the metadata
     *  editor's "fill empty fields from provider" source. Absent when the payload carried none
     *  (e.g. auto-scan's lightweight suggestions). */
    credits?: Record<string, string>
}

/** Strips the ComicVine 4050- prefix and anything that can't be part of a provider id/slug. */
export function cleanProviderId(raw: string): string {
    return (raw || '').replace('4050-', '').replace(/[^0-9a-zA-Z-]/g, '')
}

/** "049" and "49" are the same issue; leading zeros are presentation, not identity. */
export function normalizeIssueNumber(n: unknown): string {
    return (n ?? '').toString().trim().replace(/^0+(?=\d)/, '')
}

/**
 * Cross-references an extracted issue number against a volume's issue stubs and returns the
 * provider's exact issue id ("" when nothing matches). Accepts both the ComicVine stub field
 * (issue_number) and the generic `number` fallback.
 */
export function findIssueIdByNumber(rawIssues: any[] | undefined, issueNumber: string): string {
    const target = normalizeIssueNumber(issueNumber)
    if (!target) return ''
    const hit = (rawIssues || []).find(i => normalizeIssueNumber(i?.issue_number ?? i?.number) === target)
    return hit?.id != null ? hit.id.toString() : ''
}

/**
 * Resolves a provider's exact issue id from an admin-corrected issue number (#199 round 2:
 * the auto cross-reference can bind the wrong issue inside a correctly-matched series, e.g.
 * "4" extracted from "Nuova Serie 04" when the comic is #154). A non-empty rawIssues list is
 * treated as authoritative (it came from the same volume-details call a fetch would repeat);
 * only when no list is at hand — e.g. the match came from the auto-scan's lightweight
 * suggestion — is the volume fetched for the real one. Returns '' when the number simply
 * isn't in the volume; throws only when the fallback fetch itself fails.
 */
export async function resolveIssueIdByNumber(opts: {
    issueNumber: string
    rawIssues?: any[]
    seriesMetadataId?: string | number
    provider?: string
}): Promise<string> {
    if (opts.rawIssues && opts.rawIssues.length > 0) {
        return findIssueIdByNumber(opts.rawIssues, opts.issueNumber)
    }
    if (!opts.seriesMetadataId) return ''
    const provider = opts.provider || 'COMICVINE'
    const res = await fetch(`/api/issue-details?id=${opts.seriesMetadataId}&type=volume&provider=${provider}`)
    const data = await res.json()
    if (!res.ok || data.error) throw new Error(data.error || "Couldn't load the series' issue list")
    return findIssueIdByNumber(data.issues, opts.issueNumber)
}

// #199 round 4 Beta B: the CONTENT fields keep-mode carries from the files when the admin never
// opened the editor — description + the ComicInfo defaults + universe/seriesGroup. The identity
// trio (name/year/publisher) deliberately stays with the admin's chosen match: matching IS the
// identity decision; the files own the curation.
const KEEP_CARRY_KEYS = [
    'universe', 'seriesGroup', 'description',
    'imprint', 'format', 'languageISO', 'ageRating', 'writer', 'penciller', 'inker', 'colorist',
    'letterer', 'coverArtist', 'editor', 'translator', 'genre', 'tags', 'characters', 'teams',
    'locations', 'mainCharacterOrTeam', 'storyArc', 'storyArcNumber', 'alternateSeries',
    'alternateNumber', 'alternateCount', 'communityRating', 'gtin', 'notes', 'scanInformation', 'review',
] as const

/** #199 round 4 Beta B (keep mode): with NO saved override, Accept still carries the files' own
 *  CONTENT into the match payload and locks the series — viewing the dialog was never required
 *  for curation to survive. Returns null when the files supplied nothing carryable (payload and
 *  lock behavior then stay exactly pre-Beta-B). Exported for tests. */
export function buildKeepCarry(prefill: {
    fields?: Record<string, { value: string; source: string }>
    blackAndWhite?: { value: boolean; source: string }
} | null | undefined): Record<string, any> | null {
    if (!prefill?.fields) return null
    const carry: Record<string, any> = {}
    for (const k of KEEP_CARRY_KEYS) {
        const v = prefill.fields[k]?.value
        if (v && v.trim()) carry[k] = v
    }
    if (prefill.blackAndWhite?.value === true) carry.blackAndWhite = true
    if (Object.keys(carry).length === 0) return null
    carry.lockMetadata = true
    return carry
}

/** Builds the stored suggestion from an /api/issue-details volume payload. */
export function buildManualSuggestion(data: any, provider: string): ManualSuggestion {
    // Volume-level credit arrays → dialog-key CSVs (#199 round 4). Only non-empty groups are
    // kept, and a payload with none at all yields no credits field (the fill button hides).
    const joined: Record<string, string> = {}
    const addCredit = (dialogKey: string, arr: any) => {
        if (Array.isArray(arr) && arr.length) joined[dialogKey] = arr.filter(Boolean).join(', ')
    }
    addCredit('writer', data.writers); addCredit('penciller', data.artists); addCredit('inker', data.inkers)
    addCredit('colorist', data.colorists); addCredit('letterer', data.letterers); addCredit('coverArtist', data.coverArtists)
    addCredit('editor', data.editors); addCredit('translator', data.translators); addCredit('genre', data.genres)
    addCredit('characters', data.characters); addCredit('teams', data.teams); addCredit('locations', data.locations)
    addCredit('storyArc', data.storyArcs)

    return {
        id: data.id || data.volumeId,
        name: data.name,
        year: data.year,
        publisher: data.publisher,
        image: data.image,
        // Accurately parse the issue count from either API
        count: data.count || data.count_of_issues || data.issue_count || data.issues?.length || '?',
        description: data.description,
        metadataSource: provider,
        rawIssues: data.issues || [], // Hold onto raw issues for cross-referencing IDs
        ...(Object.keys(joined).length ? { credits: joined } : {}),
    }
}

/**
 * The rows "Accept All" is allowed to act on: ones with a real provider suggestion, never a
 * NOT_FOUND/ERROR placeholder, and never an IGNORED series.
 *
 * The ignore guard is the load-bearing part. Ignored rows are hidden by default but visible while
 * the "Show ignored" toggle is on, and a bulk accept that swept them up would silently undo a
 * decision the admin made deliberately (field report from robotshavehearts2: series ComicVine has
 * no record of, marked ignored so they stop being offered).
 */
export function acceptableForBulk<T extends { id: string; isIgnored?: boolean }>(
    items: T[],
    suggestions: Record<string, unknown>,
): T[] {
    return items.filter(item => {
        if (item.isIgnored) return false;
        const s = suggestions[item.id];
        return !!s && s !== 'NOT_FOUND' && s !== 'ERROR';
    });
}

// ---------------------------------------------------------------------------------------------
// Suggestion ranking (field report by robotshavehearts2: "some odd ones were way off, but if I
// manually searched the keywords it found it at the top").
//
// The auto-scan used to take results[0] from /api/search, whose only ranking signal is a boolean
// sort on exact start-year — so a folder "X-Men (2024)" pulled EVERY 2024 volume to the front
// ("X-Men: From the Ashes Infinity Comic", "X-Men Annual"…) and [0] was whichever ComicVine listed
// first. Name relevance was never scored at all. These helpers score it, with the year as a
// tiebreaker-plus rather than a sort key, so the name dominates unless names tie.
//
// nameSimilarity is an EXACT twin of the engine's renamer-side scorer (matcher.rs name_similarity)
// and the year term twins matcher.rs year_term — the background sweep and the Smart Matcher must
// rank the same candidates the same way, or the sweep would auto-match what the UI would reject.
// ---------------------------------------------------------------------------------------------

/** Case-insensitive token Dice coefficient over alphanumeric words. Symbols fold to spaces, so
 *  "Hack/Slash" == "Hack Slash" == "hack slash". Token-based, order-insensitive. Twin of Rust. */
export function nameSimilarity(a: string, b: string): number {
    const tokens = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
    const ta = tokens(a);
    const tb = tokens(b);
    if (ta.length === 0 || tb.length === 0) return 0;
    const common = ta.filter(t => tb.includes(t)).length;
    return (2 * common) / (ta.length + tb.length);
}

/** The year's contribution to a candidate's score. A tiebreaker-plus, deliberately small next to a
 *  full-name match: exact year +0.10, off by one +0.05 (ComicVine's start_year and a folder's year
 *  disagree by one all the time), further off −0.05, either side unknown 0. Twin of Rust.
 *
 *  The magnitudes are chosen so the year's whole reach (+0.10 to −0.05 = 0.15) stays UNDER a
 *  one-token name difference on a two-token name (1.0 vs 0.8 = 0.2): a folder whose year is wrong
 *  by three still resolves to the exact name, not to a same-year near-miss like its own annual. The
 *  year only decides between names within 0.15 of each other — which is what "tiebreaker" means. */
export function yearTerm(candidateYear: number | null | undefined, wantedYear: number | null | undefined): number {
    if (!candidateYear || !wantedYear) return 0;
    const diff = Math.abs(candidateYear - wantedYear);
    if (diff === 0) return 0.10;
    if (diff <= 1) return 0.05;
    return -0.05;
}

/** What the auto-scan should search for, from an unmatched item's display name. A raw file arrives
 *  as its filename minus extension ("X-Men 001 (2024)"), so the issue number and year must come
 *  off or they pollute the provider query; a folder arrives as "Batman Omnibus Vol. 2". The year is
 *  returned separately so the ranker can use it — it never goes into the query itself. */
export function seriesQueryFromName(name: string): { query: string; year: number | null } {
    let s = name.trim();
    const yearMatch = s.match(/[(\[]?\b(19\d{2}|20\d{2})\b[)\]]?/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
    if (yearMatch) s = s.replace(yearMatch[0], ' ');
    // Edition / volume words, anywhere, whole words only (the old regex matched once, unbounded).
    s = s.replace(/\b(omnibus|tpb|compendium|hardcover|hc|vol\.?|volume)\b\.?\s*\d*/gi, ' ');
    // A trailing issue token: "#12", "001", "12.5", "v01". Trailing only — "Kaiju No. 8" keeps its 8.
    s = s.replace(/\s+(?:#\s*)?(?:v\d+|\d{1,4}(?:\.\d+)?)\s*$/i, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    // Never search for nothing: a name that was ALL edition words falls back to itself.
    return { query: s.length >= 2 ? s : name.trim(), year };
}

export interface RankedCandidate<T> {
    result: T;
    sim: number;
    yearTerm: number;
    score: number;
}

/** Every candidate scored and sorted, best first. Exported so the reasoning is inspectable. */
export function rankSearchResults<T extends { name?: string; year?: string | number | null }>(
    seriesName: string,
    year: number | null | undefined,
    results: T[],
): RankedCandidate<T>[] {
    return results
        .map(result => {
            const sim = nameSimilarity(seriesName, result.name || '');
            const candYear = result.year != null && result.year !== '' ? parseInt(String(result.year), 10) : null;
            const yt = yearTerm(Number.isFinite(candYear as number) ? candYear : null, year);
            return { result, sim, yearTerm: yt, score: sim + yt };
        })
        .sort((a, b) => b.score - a.score || b.sim - a.sim);
}

/** The floor below which a "suggestion" is a wild guess. Half the tokens must overlap: this is what
 *  keeps Accept All — which takes every row that has ANY suggestion — from sweeping up nonsense. */
export const SUGGESTION_MIN_SIMILARITY = 0.4;

/** The auto-scan's pick: the best-scored candidate, or null when even the best barely resembles the
 *  name — a NOT_FOUND is more honest than a confident-looking wrong answer. */
export function pickSuggestion<T extends { name?: string; year?: string | number | null }>(
    seriesName: string,
    year: number | null | undefined,
    results: T[],
    minSimilarity: number = SUGGESTION_MIN_SIMILARITY,
): T | null {
    const ranked = rankSearchResults(seriesName, year, results);
    const best = ranked[0];
    if (!best || best.sim < minSimilarity) return null;
    return best.result;
}
