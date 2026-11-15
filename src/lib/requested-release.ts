// The issue an UNRELEASED request waits for: its row in the series' issue list, which holds the release
// date. The Series Monitor's upgrade sweep (queue.ts, Phase 3) moves a request on by that date, its
// fresh-release pass (Phase 3c) re-searches a just-released NOT_FOUND one by it, and Request Management
// shows it, so all three find the row here.
import { prisma } from '@/lib/db';
import { extractIssueNumber } from '@/lib/utils/issue-parser';
import { requestedIssueRow } from '@/lib/utils/attachment-name';

type WaitingRequest = { id: string; volumeId: string | null; activeDownloadName: string | null };

/** Calendar fix A (beta.040): for this long after its release, a request for an issue no source had yet
 *  (NOT_FOUND) is searched again on every Series Monitor run (queue.ts, Phase 3c). GetComics and the
 *  indexers usually post a new issue within a day or two, and the parked sweep's awaiting_retry_days
 *  (default 7) is far too slow for that. The engine's monitor window looks the same 14 days back
 *  (monitor.rs WINDOW_PAST_DAYS). */
export const FRESH_RELEASE_DAYS = 14;
/** ...at most this often per request, however often the monitor is scheduled. */
export const FRESH_RETRY_HOURS = 12;

/** Out already, and released on one of the last `days` days. A release date is a day, not an instant, so
 *  the window's first day counts whole; a month-only date ("2026-11") reads as the 1st. */
export function releasedWithinDays(releaseDate: string | null | undefined, days: number, now: Date = new Date()): boolean {
    if (!releaseDate) return false;
    const released = new Date(releaseDate);
    if (isNaN(released.getTime()) || released > now) return false;
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    since.setUTCHours(0, 0, 0, 0);
    return released >= since;
}

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
