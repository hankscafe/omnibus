// src/app/api/library/series/attachments/route.ts
//
// #203 Phase 1 (concept by anacronismo): attach a provider volume to a series whose own volume
// doesn't contain it — an annual run today, collected editions on the same rails later. ComicVine
// publishes no machine link between a series and its annuals, so the attachment is manual, exactly
// as Mylar does it. The engine owns the import/sync lane (id-anchored, never number-anchored);
// this route owns the attachment's lifecycle and reports what a pass actually did.

export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { ENGINE_URL, engineHeaders, engineFetchLong } from '@/lib/engine';
import { omnibusQueue } from '@/lib/queue';

const VALID_SOURCES = ['COMICVINE', 'METRON'];
const VALID_KINDS = ['ANNUAL', 'COLLECTED'];

/**
 * Queue the series.json regeneration WITHOUT awaiting it. A `await queue.add(...)` never settles
 * when Redis is down or wedged, which would hang this response long after the work it reports on
 * finished (beta.027's settings-save dot, same shape). The export is a durability convenience —
 * the next scheduled sweep writes the file anyway — so it must never gate the answer.
 */
function queueSeriesJsonExport(seriesId: string, tag: string) {
    void omnibusQueue.add('EXPORT_SERIES_JSON',
        { type: 'EXPORT_SERIES_JSON', seriesId },
        { jobId: `EXPORT_SJ_${tag}_${Date.now()}` }
    ).catch(e => Logger.log(`[Attachments API] Couldn't queue the series.json export: ${getErrorMessage(e)}`, 'warn'));
}

async function requireAdmin() {
    const session = await getServerSession(await getAuthOptions());
    if (session?.user?.role !== 'ADMIN') return null;
    return session;
}

/** The attachments on a series, with the size of each lane. */
export async function GET(request: Request) {
    try {
        const seriesId = new URL(request.url).searchParams.get('seriesId');
        if (!seriesId) return NextResponse.json({ error: 'Missing seriesId' }, { status: 400 });

        const attachments = await prisma.attachedVolume.findMany({
            where: { seriesId },
            orderBy: { createdAt: 'asc' },
        });
        // The stored issueCount is what the last sync saw; the live count is what the user owns now.
        const owned = await prisma.issue.groupBy({
            by: ['attachedVolumeId'],
            where: { seriesId, attachedVolumeId: { not: null }, filePath: { not: null } },
            _count: { _all: true },
        });
        const ownedByAttachment = new Map(owned.map(o => [o.attachedVolumeId, o._count._all]));

        return NextResponse.json({
            attachments: attachments.map(a => ({
                id: a.id,
                metadataSource: a.metadataSource,
                volumeId: a.volumeId,
                kind: a.kind,
                name: a.name,
                startYear: a.startYear,
                issueCount: a.issueCount,
                ownedCount: ownedByAttachment.get(a.id) || 0,
                lastSyncedAt: a.lastSyncedAt,
            })),
        });
    } catch (error: unknown) {
        Logger.log(`[Attachments API] List failed: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

/**
 * Attach a volume (or re-sync one that's already attached). The engine's pass is SYNCHRONOUS so the
 * caller can report the truth of what happened — claimed / created / left unclaimed — rather than a
 * hopeful "started". Claiming a local annual file is silent by design (2026-08-26 call): the summary
 * is the honesty, and detach or the issue editor's exact-id field is the undo.
 */
export async function POST(request: Request) {
    try {
        const session = await requireAdmin();
        if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

        const body = await request.json();
        const seriesId: string = body?.seriesId;
        const volumeId: string = body?.volumeId != null ? String(body.volumeId).trim() : '';
        const metadataSource: string = (body?.metadataSource || 'COMICVINE').toUpperCase();
        const kind: string = (body?.kind || 'ANNUAL').toUpperCase();

        if (!seriesId || !volumeId) {
            return NextResponse.json({ error: 'Missing seriesId or volumeId' }, { status: 400 });
        }
        if (!VALID_SOURCES.includes(metadataSource)) {
            return NextResponse.json({ error: `Unknown metadata source "${metadataSource}"` }, { status: 400 });
        }
        if (!VALID_KINDS.includes(kind)) {
            return NextResponse.json({ error: `Unknown attachment kind "${kind}"` }, { status: 400 });
        }

        const series = await prisma.series.findUnique({ where: { id: seriesId } });
        if (!series) return NextResponse.json({ error: 'Series not found' }, { status: 404 });

        // Attaching a series' OWN volume to itself would put two lanes on the same provider issues.
        if (series.metadataSource === metadataSource && series.metadataId === volumeId) {
            return NextResponse.json({ error: "That's this series' own volume — attach the annual's volume instead." }, { status: 400 });
        }

        // Idempotent: re-attaching the same volume re-syncs it instead of erroring.
        const attachment = await prisma.attachedVolume.upsert({
            where: { seriesId_metadataSource_volumeId: { seriesId, metadataSource, volumeId } },
            update: { kind, ...(body?.name ? { name: String(body.name) } : {}), ...(body?.startYear ? { startYear: parseInt(body.startYear) || null } : {}) },
            create: {
                seriesId,
                metadataSource,
                volumeId,
                kind,
                name: body?.name ? String(body.name) : null,
                startYear: body?.startYear ? parseInt(body.startYear) || null : null,
            },
        });

        let summary: any = null;
        try {
            // Long-lived on purpose: a volume with several pages of issues pays ComicVine's pacing.
            const res = await engineFetchLong(ENGINE_URL + '/api/metadata/attach-sync', {
                method: 'POST',
                headers: engineHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ attachment_id: attachment.id, claim: true }),
            });
            const payload = await res.json().catch(() => null);
            if (!res.ok || !payload?.ok) {
                const message = payload?.error || `engine returned ${res.status}`;
                // The attachment row stays: the link is the user's decision, and a provider outage
                // shouldn't undo it — the next series refresh syncs the lane.
                Logger.log(`[Attachments API] Import failed for volume ${volumeId}: ${message}`, 'warn');
                return NextResponse.json({ success: false, attachmentId: attachment.id, error: message }, { status: 502 });
            }
            summary = Array.isArray(payload.results) ? payload.results[0] : null;
        } catch (e) {
            Logger.log(`[Attachments API] Engine unreachable for the attach import: ${getErrorMessage(e)}`, 'error');
            return NextResponse.json({ success: false, attachmentId: attachment.id, error: 'The engine is unreachable.' }, { status: 502 });
        }

        // Record the attachment in series.json right away — that file is half of the zero-API
        // restore, so it must not wait for the next scheduled export. FIRE-AND-FORGET: a queue add
        // against a dead/wedged Redis never settles, and awaiting it would hang the whole response
        // long after the import itself succeeded (the beta.027 settings-save incident, exactly).
        queueSeriesJsonExport(seriesId, `ATTACH_${attachment.id}`);

        await AuditLogger.log('ATTACH_VOLUME', {
            seriesId, seriesName: series.name, metadataSource, volumeId, kind, summary,
        }, (session.user as any).id);

        return NextResponse.json({
            success: true,
            attachmentId: attachment.id,
            name: summary?.name ?? attachment.name,
            summary: summary
                ? {
                    total: summary.total,
                    claimed: summary.claimed,
                    created: summary.created,
                    updated: summary.updated,
                    unclaimed: summary.unclaimed,
                }
                : null,
        });
    } catch (error: unknown) {
        Logger.log(`[Attachments API] Attach failed: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

/**
 * Detach. Non-destructive by default: files and everything the user curated stay, the rows simply
 * stop belonging to a provider volume (Prisma's SetNull does the unlinking). Only the file-less
 * skeletons this attachment created are worth offering to remove, and only when asked.
 */
export async function DELETE(request: Request) {
    try {
        const session = await requireAdmin();
        if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

        const body = await request.json().catch(() => ({}));
        const attachmentId: string = body?.attachmentId;
        const deleteSkeletons: boolean = body?.deleteSkeletons === true;
        if (!attachmentId) return NextResponse.json({ error: 'Missing attachmentId' }, { status: 400 });

        const attachment = await prisma.attachedVolume.findUnique({ where: { id: attachmentId } });
        if (!attachment) return NextResponse.json({ error: 'Attachment not found' }, { status: 404 });

        let skeletonsDeleted = 0;
        if (deleteSkeletons) {
            const res = await prisma.issue.deleteMany({
                where: { attachedVolumeId: attachmentId, OR: [{ filePath: null }, { filePath: '' }] },
            });
            skeletonsDeleted = res.count;
        }
        // The remaining rows keep their files, numbers, and metadata — they're just unattached
        // annuals again, exactly what they were before the attach.
        const unlinked = await prisma.issue.updateMany({
            where: { attachedVolumeId: attachmentId },
            data: { attachedVolumeId: null },
        });
        await prisma.attachedVolume.delete({ where: { id: attachmentId } });

        queueSeriesJsonExport(attachment.seriesId, `DETACH_${attachmentId}`);

        await AuditLogger.log('DETACH_VOLUME', {
            seriesId: attachment.seriesId, volumeId: attachment.volumeId,
            metadataSource: attachment.metadataSource, skeletonsDeleted, keptIssues: unlinked.count,
        }, (session.user as any).id);

        return NextResponse.json({ success: true, keptIssues: unlinked.count, skeletonsDeleted });
    } catch (error: unknown) {
        Logger.log(`[Attachments API] Detach failed: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
