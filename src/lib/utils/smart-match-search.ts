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

/** Builds the stored suggestion from an /api/issue-details volume payload. */
export function buildManualSuggestion(data: any, provider: string): ManualSuggestion {
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
    }
}
