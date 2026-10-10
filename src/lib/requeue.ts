// src/lib/requeue.ts
//
// "Try the next release": a download that can't be used - the client reported it failed (cron), or
// the archive that arrived can't be read (#240, importer) - blocks BOTH the link it came from and its
// release title, puts the request back to PENDING and searches again. After three tries the request
// is parked STALLED instead (the monitor's dead-request sweep takes it from there).
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';

const MAX_RETRIES = 3;

type RequeueableRequest = {
    id: string;
    retryCount: number | null;
    failedLinks?: string | null;
    downloadLink: string | null;
    volumeId: string | null;
    activeDownloadName: string | null;
    name?: string | null;
};

export async function requeueWithNextRelease(
    req: RequeueableRequest,
    blocked: { title?: string | null },
): Promise<'requeued' | 'stalled'> {
    const label = req.activeDownloadName || req.id;
    if ((req.retryCount || 0) >= MAX_RETRIES) {
        Logger.log(`[Requeue] Request "${label}" failed ${MAX_RETRIES} times. Marking as STALLED.`, 'error');
        await prisma.request.update({ where: { id: req.id }, data: { status: 'STALLED' } });
        return 'stalled';
    }

    let failed: string[] = [];
    try { failed = JSON.parse(req.failedLinks || '[]'); } catch { /* start a fresh list */ }
    // Block BOTH the specific hash/url and the exact release title.
    for (const entry of [req.downloadLink, blocked.title]) {
        if (entry && !failed.includes(entry)) failed.push(entry);
    }

    await prisma.request.update({
        where: { id: req.id },
        data: {
            status: 'PENDING',
            downloadLink: null,
            retryCount: (req.retryCount || 0) + 1,
            failedLinks: JSON.stringify(failed),
        } as any,
    });
    Logger.log(`[Requeue] Re-queuing "${label}" (Attempt ${(req.retryCount || 0) + 1}/${MAX_RETRIES})`, 'info');

    // Reconstruct the search context: the series' own name + issue number when the series is known,
    // so a dirty release title never becomes the query.
    const { searchAndDownload } = await import('@/lib/automation');
    const series = req.volumeId && req.volumeId !== '0'
        ? await prisma.series.findFirst({ where: { metadataId: req.volumeId } })
        : null;

    let searchYear = series?.year?.toString() || '';
    if (!searchYear && req.activeDownloadName) {
        const yearMatch = req.activeDownloadName.match(/\b(19\d{2}|20\d{2})\b/);
        if (yearMatch) searchYear = yearMatch[1];
    }

    let searchName = req.name || req.activeDownloadName || 'Unknown';
    if (series) {
        const cleanTitle = (req.activeDownloadName || '').replace(/\.\w+$/, '');
        const issueMatch = cleanTitle.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?[a-zA-Z]?)/i);
        searchName = `${series.name} #${issueMatch ? issueMatch[1] : '1'}`;
    }

    await searchAndDownload(req.id, searchName, searchYear, series?.publisher || 'Unknown', series?.isManga || false, false);
    return 'requeued';
}
