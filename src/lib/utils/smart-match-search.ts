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
