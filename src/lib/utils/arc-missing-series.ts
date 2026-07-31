// src/lib/utils/arc-missing-series.ts
//
// Fork review #5 (Auto-Build add-missing-series): resolve each UNMATCHED arc issue to its parent
// series and return the series the library doesn't hold AT ALL — no Series row for that catalog id.
// Partially-owned series (any existing row, even a fileless monitor stub) are excluded on purpose:
// they stay on the reading list's "Missing (N)" bulk-download path. The caller offers the returned
// series to the CLIENT, which adds them through the normal /api/request monitorOnly pipeline so
// permissions, the manga gate, and auditing all apply unchanged.
//
// Lives outside the route file because Next route files may only export handlers, and this logic
// wants direct unit tests (same reason lib/library-roots.ts exists).
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { cachedCvGet } from '@/lib/metadata/metadata-cache';
import { MetronProvider } from '@/lib/metadata/providers/metron';

export interface MissingArcSeries { id: string; name: string; source: string }

export async function collectMissingArcSeries(
    issuesList: any[],
    unmatchedIssueIds: (number | string)[],
    eventSource: string,
    cvApiKey: string | null,
): Promise<MissingArcSeries[]> {
    if (unmatchedIssueIds.length === 0) return [];
    const volumesById = new Map<string, string>();

    if (eventSource === 'METRON') {
        // Metron's arc issue_list serializer carries the series NAME but not its id — resolve each
        // unique name through one provider search (rate-limit backoff lives inside the provider).
        const byId = new Map(issuesList.map((o: any) => [String(o.id), o]));
        const names = new Set<string>();
        for (const id of unmatchedIssueIds) {
            const name = byId.get(String(id))?.series?.name;
            if (name) names.add(name);
        }
        const metron = new MetronProvider();
        for (const name of Array.from(names)) {
            try {
                const results = await metron.searchSeries(name);
                const exact = results.find((r: any) => String(r.name).toLowerCase() === name.toLowerCase()) || results[0];
                if (exact?.sourceId) volumesById.set(String(exact.sourceId), exact.name || name);
            } catch (e) {
                Logger.log(`[Auto-Build] Metron series lookup failed for "${name}": ${getErrorMessage(e)}`, 'warn');
            }
        }
    } else {
        // ComicVine arc payloads list issues as stubs (no volume field), so batch-resolve the
        // parents: /issues/ filtered by an id list, 100 per call — one API round-trip per 100
        // unmatched issues, and it flows through the shared metadata cache.
        if (!cvApiKey) return [];
        const ids = unmatchedIssueIds.map(String);
        for (let i = 0; i < ids.length; i += 100) {
            const chunk = ids.slice(i, i + 100);
            try {
                const res = await cachedCvGet('https://comicvine.gamespot.com/api/issues/', {
                    params: { api_key: cvApiKey, format: 'json', filter: `id:${chunk.join('|')}`, field_list: 'id,volume', limit: 100 },
                    headers: { 'User-Agent': 'Omnibus/1.0' },
                    timeout: 15000,
                });
                for (const issue of res.data?.results || []) {
                    if (issue?.volume?.id) volumesById.set(String(issue.volume.id), issue.volume.name || 'Unknown Series');
                }
            } catch (e) {
                Logger.log(`[Auto-Build] ComicVine volume batch lookup failed: ${getErrorMessage(e)}`, 'warn');
            }
        }
    }

    if (volumesById.size === 0) return [];

    const owned = await prisma.series.findMany({
        where: { metadataSource: eventSource, metadataId: { in: Array.from(volumesById.keys()) } },
        select: { metadataId: true },
    });
    const ownedIds = new Set(owned.map(s => s.metadataId));
    return Array.from(volumesById.entries())
        .filter(([id]) => !ownedIds.has(id))
        .map(([id, name]) => ({ id, name, source: eventSource }));
}
