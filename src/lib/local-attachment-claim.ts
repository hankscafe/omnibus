// src/lib/local-attachment-claim.ts
//
// #257: the name claim of a series' LOCAL editions, run before a provider sync pairs the run's rows.
// A book of a local edition can sit unbound on the series (scanned before its edition existed, or
// put back by hand); its "Vol. 1" parses as #1, so the pairing would take it for the run's #1 and
// give it that issue's id, title and cover. Claimed first, it is the edition's and the pairing
// (which leaves this series' lane rows out) never sees it.
//
// Twin of the engine's claim (omnibus-engine/src/attached_volumes.rs claim_local_attachments →
// sync_local_attachment step 1) — keep them identical: an unbound, file-backed row whose filename
// names a LOCAL edition of this series (attachmentForFilename, every attachment of the series
// competing, so a provider lane's name still wins its own files) joins that edition with the
// number parsed under the edition's name, a lane-and-number identity that survives a wipe, and a
// "Vol. N" title unless it already has a real one. Coverage from series.json is the engine pass's.
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { attachmentForFilename } from '@/lib/utils/attachment-name';

/** Claims a series' unbound books for its LOCAL editions by name. Returns how many it claimed. */
export async function claimLocalAttachments(seriesId: string, seriesName: string): Promise<number> {
    const attachments = await prisma.attachedVolume.findMany({
        where: { seriesId },
        select: { id: true, name: true, kind: true, metadataSource: true },
        orderBy: { createdAt: 'asc' },
    });
    const local = new Set(attachments.filter(a => a.metadataSource === 'LOCAL').map(a => a.id));
    if (local.size === 0) return 0;

    const rows = await prisma.issue.findMany({
        where: { seriesId, attachedVolumeId: null, filePath: { not: null }, NOT: { filePath: '' } },
        select: { id: true, filePath: true, name: true },
    });
    let claimed = 0;
    for (const row of rows) {
        const fileName = (row.filePath || '').split(/[\\/]/).pop() || '';
        const match = attachmentForFilename(fileName, seriesName, attachments);
        if (!match || !local.has(match.id)) continue;
        const untitled = !row.name || row.name.startsWith('Issue ');
        try {
            await prisma.issue.update({
                where: { id: row.id },
                data: {
                    attachedVolumeId: match.id, isAnnual: match.kind === 'ANNUAL', matchState: 'MATCHED',
                    metadataId: `local_${match.id}_${match.number}`, metadataSource: 'LOCAL', number: match.number,
                    ...(untitled ? { name: `Vol. ${match.number}` } : {}),
                },
            });
            claimed++;
        } catch (e) {
            Logger.log(`[Local Claim] Couldn't claim ${fileName} for its local edition: ${getErrorMessage(e)}`, 'warn');
        }
    }
    return claimed;
}
