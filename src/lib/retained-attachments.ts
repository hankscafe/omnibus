// src/lib/retained-attachments.ts
//
// #239: "Leave it as its own series". An attached provider volume can ALSO be a Series of its own
// (the usual shape for trades: ComicVine publishes one volume per collection). When the admin keeps
// it that way, the attachment stores a flag — not a pointer — and the child is found exactly the way
// the attach POST finds it: a Series other than the parent whose metadataSource/metadataId equal the
// attachment's metadataSource/volumeId. The attachment counts as retained only while that child
// exists, so a rematch or delete of the child needs no bookkeeping anywhere: the lookup simply stops
// matching, and the engine's next attach sync clears the stale flag.
//
// Every caller asks here (the panel, the shelf, Standardize's preview and Node fallback); the engine
// twins are retained_children / retaining_kinds in omnibus-engine/src/attached_volumes.rs.
import { prisma } from '@/lib/db';

export interface AttachmentRef {
    seriesId: string;
    metadataSource: string;
    volumeId: string;
    retained?: boolean | null;
}

export interface RetainedChild {
    id: string;
    name: string;
    folderPath: string;
}

/** The Series a retained attachment keeps as its own — empty when it isn't retained (flag unset,
 *  a LOCAL edition, or no such child). More than one only if two Series share the volume. */
export async function retainedChildren(attachment: AttachmentRef): Promise<RetainedChild[]> {
    if (!attachment.retained || attachment.metadataSource === 'LOCAL' || !attachment.volumeId) return [];
    return prisma.series.findMany({
        where: { metadataSource: attachment.metadataSource, metadataId: attachment.volumeId, id: { not: attachment.seriesId } },
        select: { id: true, name: true, folderPath: true },
        orderBy: { id: 'asc' },
    });
}

/** The kinds of the retained attachments that keep THIS series as their volume. A series kept by a
 *  COLLECTED attachment names its books with the collected pattern (Standardize). */
export async function retainedKindsForSeries(series: { id: string; metadataSource?: string | null; metadataId?: string | null }): Promise<string[]> {
    if (!series.metadataId || series.metadataSource === 'LOCAL') return [];
    const rows = await prisma.attachedVolume.findMany({
        where: { retained: true, metadataSource: series.metadataSource || 'COMICVINE', volumeId: series.metadataId, seriesId: { not: series.id } },
        select: { kind: true },
    });
    return Array.from(new Set(rows.map(r => r.kind))).sort();
}
