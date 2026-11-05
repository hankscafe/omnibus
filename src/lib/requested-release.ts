// The issue an UNRELEASED request waits for: its row in the series' issue list, which holds the release
// date. The Series Monitor's upgrade sweep (queue.ts, Phase 3) moves a request on by that date, and
// Request Management shows it, so both find the row here.
import { prisma } from '@/lib/db';
import { extractIssueNumber } from '@/lib/utils/issue-parser';
import { requestedIssueRow } from '@/lib/utils/attachment-name';

type WaitingRequest = { id: string; volumeId: string | null; activeDownloadName: string | null };

export async function requestedIssueRows(requests: WaitingRequest[]) {
    // Only the series these requests name, each issue projected to what the lookup needs - never the
    // whole library nested under every series.
    const volumeIds = [...new Set(requests.map(r => r.volumeId).filter(Boolean))] as string[];
    const seriesList = volumeIds.length
        ? await prisma.series.findMany({
            where: { OR: [{ metadataId: { in: volumeIds } }, { id: { in: volumeIds } }] },
            select: {
                id: true, metadataId: true, name: true, publisher: true, isManga: true,
                issues: { select: { number: true, releaseDate: true, attachedVolumeId: true, attachedVolume: { select: { name: true, kind: true } } } }
            }
        })
        : [];

    type Series = (typeof seriesList)[number];
    const found = new Map<string, { series: Series; row: Series['issues'][number] }>();
    for (const req of requests) {
        // Unified utility (negative-number aware).
        const number = extractIssueNumber(req.activeDownloadName || '');
        if (isNaN(parseFloat(number))) continue;
        const series = seriesList.find(s => s.metadataId === req.volumeId || s.id === req.volumeId);
        if (!series) continue;
        // #255: the Special's own row when the request names one (search worker twin).
        const row = requestedIssueRow(series.issues, number, req.activeDownloadName || '', series.name || '');
        if (row) found.set(req.id, { series, row });
    }
    return found;
}
