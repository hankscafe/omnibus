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
import { comicInfoWritesEnabled } from '@/lib/comicinfo-writes';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { UNMATCHED_DIR, isPathWithinRoots } from '@/lib/utils/paths';
import { attachAsCollected } from '@/lib/match-collision';
import { retainedChildren } from '@/lib/retained-attachments';

// LOCAL: a collected edition (or annual run) the provider has no volume for — attached by name,
// no sync lane; its books are the files whose names carry it (field report by robotshavehearts2).
const VALID_SOURCES = ['COMICVINE', 'METRON', 'LOCAL'];
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

/**
 * Rewrite the ComicInfo of every file in an attachment's lane once its pass has run (#238). A
 * claimed file otherwise keeps the XML it had before the attach — the parent volume's id, the series'
 * year, no issue id — until the series' next refresh, and the attached volume's id in the file is
 * half of the zero-API restore. Same FIRE-AND-FORGET rule as the series.json export, and a failure
 * here never fails the attach: the next refresh rewrites these files anyway. An attach is no
 * write-to-file choice of its own, so "Write metadata to ComicInfo.xml" decides (#251).
 */
async function queueLaneEmbed(attachmentId: string) {
    try {
        if (!(await comicInfoWritesEnabled())) return;
        const rows = await prisma.issue.findMany({
            where: { attachedVolumeId: attachmentId, filePath: { not: null } },
            select: { id: true, filePath: true },
        });
        const issueIds = rows.filter(r => r.filePath).map(r => r.id);
        if (issueIds.length === 0) return;
        void omnibusQueue.add('EMBED_METADATA',
            { type: 'EMBED_METADATA', issueIds },
            { jobId: `EMBED_META_ATTACH_${attachmentId}_${Date.now()}` }
        ).catch(e => Logger.log(`[Attachments API] Couldn't queue the ComicInfo rewrite: ${getErrorMessage(e)}`, 'warn'));
    } catch (e) {
        Logger.log(`[Attachments API] Couldn't queue the ComicInfo rewrite: ${getErrorMessage(e)}`, 'warn');
    }
}

async function requireAdmin() {
    const session = await getServerSession(await getAuthOptions());
    if (session?.user?.role !== 'ADMIN') return null;
    return session;
}

/**
 * A LOCAL attachment: named by the admin, keyed by a generated local id, reused by name on the same
 * series. Without a sourcePath the engine claims the folder's files whose names carry it (the same
 * pass a provider lane runs, minus the fetch). With one — a folder or file dropped into /unmatched
 * — the collision helper moves it under the series and makes its rows the lane's books outright.
 */
async function attachLocal(session: any, series: any, kind: string, body: any) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ error: 'A local collected edition needs a name.' }, { status: 400 });
    const startYear = body?.startYear ? parseInt(body.startYear) || null : null;

    const existing = await prisma.attachedVolume.findFirst({ where: { seriesId: series.id, metadataSource: 'LOCAL', name } });
    const volumeId = existing?.volumeId || `local_${randomUUID()}`;

    const sourcePath = typeof body?.sourcePath === 'string' && body.sourcePath.trim() ? body.sourcePath.trim() : null;
    if (sourcePath) {
        const libraries = await prisma.library.findMany();
        const roots = [...libraries.map((l: any) => l.path), UNMATCHED_DIR];
        if (!isPathWithinRoots(sourcePath, roots)) return NextResponse.json({ error: 'Unauthorized path access' }, { status: 403 });
        if (!fs.existsSync(sourcePath)) return NextResponse.json({ error: 'File/Folder not found.' }, { status: 404 });
        const sourceSeries = await prisma.series.findFirst({ where: { folderPath: sourcePath }, select: { id: true } });

        const result = await attachAsCollected({
            owner: {
                id: series.id, name: series.name, year: series.year ?? null, publisher: series.publisher ?? null,
                metadataSource: series.metadataSource || 'COMICVINE', metadataId: series.metadataId ?? null,
                folderPath: series.folderPath, isManga: !!series.isManga, imprint: series.imprint ?? null,
            },
            source: sourcePath, sourceSeriesId: sourceSeries?.id ?? null,
            metadataSource: 'LOCAL', volumeId, volumeName: name, volumeYear: startYear || 0,
            config: {}, libraryRoots: roots,
        });
        if (result.error) return NextResponse.json({ success: false, attachmentId: result.attachmentId, error: result.error }, { status: 502 });

        queueSeriesJsonExport(series.id, `ATTACH_LOCAL_${result.attachmentId}`);
        await AuditLogger.log('ATTACH_VOLUME', {
            seriesId: series.id, seriesName: series.name, metadataSource: 'LOCAL', volumeId, kind, name, local: true, sourcePath,
            moved: result.moved, absorbed: result.absorbed, claimed: result.claimed, conflicts: result.conflicts,
        }, session.user.id);
        return NextResponse.json({
            success: true, local: true, attachmentId: result.attachmentId, name, summary: null,
            moved: result.moved, absorbed: result.absorbed, claimed: result.claimed, skeletonsReplaced: result.skeletonsReplaced, conflicts: result.conflicts,
        });
    }

    const attachment = await prisma.attachedVolume.upsert({
        where: { seriesId_metadataSource_volumeId: { seriesId: series.id, metadataSource: 'LOCAL', volumeId } },
        update: { kind, name, ...(startYear ? { startYear } : {}) },
        create: { seriesId: series.id, metadataSource: 'LOCAL', volumeId, kind, name, startYear },
    });

    let summary: any = null;
    try {
        const res = await engineFetchLong(ENGINE_URL + '/api/metadata/attach-sync', {
            method: 'POST',
            headers: engineHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ attachment_id: attachment.id, claim: true }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.ok) {
            const message = payload?.error || `engine returned ${res.status}`;
            Logger.log(`[Attachments API] Local claim pass failed for "${name}": ${message}`, 'warn');
            return NextResponse.json({ success: false, attachmentId: attachment.id, error: message }, { status: 502 });
        }
        summary = Array.isArray(payload.results) ? payload.results[0] : null;
    } catch (e) {
        Logger.log(`[Attachments API] Engine unreachable for the local claim pass: ${getErrorMessage(e)}`, 'error');
        return NextResponse.json({ success: false, attachmentId: attachment.id, error: 'The engine is unreachable.' }, { status: 502 });
    }

    queueSeriesJsonExport(series.id, `ATTACH_LOCAL_${attachment.id}`);
    await queueLaneEmbed(attachment.id);
    await AuditLogger.log('ATTACH_VOLUME', { seriesId: series.id, seriesName: series.name, metadataSource: 'LOCAL', volumeId, kind, name, local: true, summary }, session.user.id);
    return NextResponse.json({
        success: true, local: true, attachmentId: attachment.id, name,
        summary: summary ? { total: summary.total, claimed: summary.claimed, created: summary.created, updated: summary.updated, unclaimed: summary.unclaimed } : null,
    });
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
        // #239: an attachment kept as its own series shows as such, with the series it lives in.
        const kept = await Promise.all(attachments.map(async a => {
            const [child] = await retainedChildren(a);
            return child ? { ...child, issueCount: await prisma.issue.count({ where: { seriesId: child.id } }) } : null;
        }));

        return NextResponse.json({
            attachments: attachments.map((a, i) => ({
                id: a.id,
                metadataSource: a.metadataSource,
                volumeId: a.volumeId,
                kind: a.kind,
                name: a.name,
                startYear: a.startYear,
                issueCount: a.issueCount,
                ownedCount: ownedByAttachment.get(a.id) || 0,
                lastSyncedAt: a.lastSyncedAt,
                retained: kept[i] !== null,
                retainedSeries: kept[i],
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
        const metadataSource: string = (body?.metadataSource || 'COMICVINE').toUpperCase();
        const kind: string = (body?.kind || 'ANNUAL').toUpperCase();
        const isLocal = metadataSource === 'LOCAL';
        const volumeId: string = isLocal ? '' : (body?.volumeId != null ? String(body.volumeId).trim() : '');

        if (!seriesId || (!isLocal && !volumeId)) {
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

        if (isLocal) return await attachLocal(session, series, kind, body);

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
        // The files the pass claimed get the attached volume's ComicInfo now, not at the next refresh (#238).
        await queueLaneEmbed(attachment.id);

        await AuditLogger.log('ATTACH_VOLUME', {
            seriesId, seriesName: series.name, metadataSource, volumeId, kind, summary,
        }, (session.user as any).id);

        // #203 COLLECTED: this volume may ALREADY be in the library as its own series — the common
        // shape for trades, which ComicVine publishes as one volume per collection. We don't decide
        // for the admin: report it, and let them choose to pull its files under the parent (one
        // folder, the thing the field report asked for) or leave it standing.
        const standalone = await prisma.series.findFirst({
            where: { metadataSource, metadataId: volumeId, id: { not: seriesId } },
            select: { id: true, name: true, folderPath: true, _count: { select: { issues: true } } },
        });
        // #239: once the admin chose "Leave it as its own series", a Refresh doesn't ask again.
        const kept = await retainedChildren(attachment);

        return NextResponse.json({
            success: true,
            attachmentId: attachment.id,
            name: summary?.name ?? attachment.name,
            existingSeries: standalone && kept.length === 0
                ? { id: standalone.id, name: standalone.name, folderPath: standalone.folderPath, issueCount: standalone._count.issues }
                : null,
            retainedSeries: kept[0] ?? null,
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
 * ABSORB (#203 COLLECTED): pull a standalone series' books under the parent it was just attached to.
 *
 * The rule throughout is "keep the row that owns the file". Where the attach already created a
 * provider skeleton for the same issue, the skeleton is the disposable one — the source row holds
 * the file AND the reader's progress, bookmarks and any curation, so it is the row that survives
 * and moves. Files are not moved by hand here: re-parenting and then running the standardize job
 * puts them in the parent's folder through the same conflict-guarded path everything else uses
 * (the "Standardize names ate my comics" incident is why nothing invents its own file moving).
 */
export async function PUT(request: Request) {
    try {
        const session = await requireAdmin();
        if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

        const body = await request.json().catch(() => ({}));
        const attachmentId: string = body?.attachmentId;
        const sourceSeriesId: string = body?.sourceSeriesId;
        if (!attachmentId || !sourceSeriesId) {
            return NextResponse.json({ error: 'Missing attachmentId or sourceSeriesId' }, { status: 400 });
        }

        const attachment = await prisma.attachedVolume.findUnique({ where: { id: attachmentId } });
        if (!attachment) return NextResponse.json({ error: 'Attachment not found' }, { status: 404 });
        if (attachment.seriesId === sourceSeriesId) {
            return NextResponse.json({ error: "That series is the attachment's own parent." }, { status: 400 });
        }

        const source = await prisma.series.findUnique({ where: { id: sourceSeriesId } });
        if (!source) return NextResponse.json({ error: 'Series not found' }, { status: 404 });

        // One transaction (#239): a failure part-way used to leave the source's books re-parented,
        // its skeletons deleted and the source Series standing empty — with no audit entry, since
        // the throw came before it. Nothing outside the transaction is awaited inside it (#195:
        // SQLite's single pooled connection would deadlock on its own transaction).
        const { moved, skeletonsReplaced, removedSeries } = await prisma.$transaction(async (tx) => {
            const sourceIssues = await tx.issue.findMany({ where: { seriesId: sourceSeriesId } });
            const laneRows = await tx.issue.findMany({ where: { attachedVolumeId: attachmentId } });

            let moved = 0;
            let skeletonsReplaced = 0;
            for (const issue of sourceIssues) {
                // A file-less skeleton for the same provider issue is redundant once the real book
                // arrives — drop it and let the owning row take its place in the lane. Never the row
                // itself (#239): a skeleton the source's sync once adopted is in BOTH lists, and taking
                // it as its own twin deleted it before the update ("Record to update not found").
                const twin = issue.metadataId
                    ? laneRows.find(r => r.id !== issue.id && r.metadataId === issue.metadataId && !r.filePath)
                    : undefined;
                if (twin) {
                    // Its reading-list entries follow the book that replaces it (same provider issue);
                    // the delete would otherwise cascade them away.
                    await tx.readingListItem.updateMany({ where: { issueId: twin.id }, data: { issueId: issue.id } });
                    await tx.issue.delete({ where: { id: twin.id } });
                    skeletonsReplaced++;
                }
                await tx.issue.update({
                    where: { id: issue.id },
                    data: { seriesId: attachment.seriesId, attachedVolumeId: attachmentId },
                });
                moved++;
            }

            // Only remove the source series once nothing is left pointing at it — never a blind delete.
            const remaining = await tx.issue.count({ where: { seriesId: sourceSeriesId } });
            let removedSeries = false;
            if (remaining === 0) {
                await tx.series.delete({ where: { id: sourceSeriesId } });
                removedSeries = true;
            }
            // #239: the volume is the parent's lane now, not a series kept as its own.
            if (attachment.retained) {
                await tx.attachedVolume.update({ where: { id: attachmentId }, data: { retained: false } });
            }
            return { moved, skeletonsReplaced, removedSeries };
        }, { timeout: 30000, maxWait: 10000 });

        queueSeriesJsonExport(attachment.seriesId, `ABSORB_${attachmentId}`);

        await AuditLogger.log('ABSORB_SERIES_INTO_ATTACHMENT', {
            attachmentId, sourceSeriesId, sourceName: source.name, parentSeriesId: attachment.seriesId,
            moved, skeletonsReplaced, removedSeries,
        }, (session.user as any).id);

        Logger.log(`[Attachments API] Absorbed "${source.name}" into its parent series: ${moved} book(s) moved, ${skeletonsReplaced} skeleton(s) replaced.`, 'info');
        return NextResponse.json({ success: true, moved, skeletonsReplaced, removedSeries });
    } catch (error: unknown) {
        Logger.log(`[Attachments API] Absorb failed: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

/**
 * #239 "Leave it as its own series": the attached volume is also a Series of its own, and the admin
 * keeps it that way. The choice is STORED (it used to be a dialog close, so every Refresh asked again
 * and one misclick absorbed the series). The child keeps its folder, files and rows; the parent's
 * shelf lists the child's books instead of its own skeletons for them, so those skeletons go —
 * file-less ones only, after their reading-list entries are moved onto the child's row for the same
 * provider issue (ReadingListItem.issue cascades). A file-backed lane row stays where it is.
 */
export async function PATCH(request: Request) {
    try {
        const session = await requireAdmin();
        if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

        const body = await request.json().catch(() => ({}));
        const attachmentId: string = body?.attachmentId;
        if (!attachmentId || body?.retain !== true) {
            return NextResponse.json({ error: 'Missing attachmentId or retain' }, { status: 400 });
        }

        const attachment = await prisma.attachedVolume.findUnique({ where: { id: attachmentId } });
        if (!attachment) return NextResponse.json({ error: 'Attachment not found' }, { status: 404 });
        if (attachment.metadataSource === 'LOCAL') {
            return NextResponse.json({ error: 'A local edition has no series of its own to keep.' }, { status: 400 });
        }

        const children = await retainedChildren({ ...attachment, retained: true });
        if (children.length === 0) {
            return NextResponse.json({ error: "That volume isn't a series of its own in your library any more." }, { status: 409 });
        }

        const skeletons = await prisma.issue.findMany({
            where: { seriesId: attachment.seriesId, attachedVolumeId: attachmentId, OR: [{ filePath: null }, { filePath: '' }] },
            select: { id: true, metadataId: true },
        });
        const skeletonIds = skeletons.map(s => s.id);
        const providerIds = skeletons.map(s => s.metadataId).filter((m): m is string => !!m);
        const childRows = providerIds.length > 0
            ? await prisma.issue.findMany({
                where: { seriesId: { in: children.map(c => c.id) }, metadataId: { in: providerIds } },
                select: { id: true, metadataId: true },
            })
            : [];

        await prisma.$transaction(async (tx) => {
            await tx.attachedVolume.update({ where: { id: attachmentId }, data: { retained: true } });
            for (const skeleton of skeletons) {
                const replacement = childRows.find(r => r.metadataId === skeleton.metadataId);
                await tx.readingListItem.updateMany({
                    where: { issueId: skeleton.id },
                    data: { issueId: replacement?.id ?? null },
                });
            }
            if (skeletonIds.length > 0) {
                await tx.issue.deleteMany({ where: { id: { in: skeletonIds } } });
            }
        }, { timeout: 30000, maxWait: 10000 });

        queueSeriesJsonExport(attachment.seriesId, `RETAIN_${attachmentId}`);

        await AuditLogger.log('RETAIN_ATTACHED_SERIES', {
            attachmentId, parentSeriesId: attachment.seriesId, volumeId: attachment.volumeId,
            metadataSource: attachment.metadataSource, keptSeriesId: children[0].id, skeletonsRemoved: skeletonIds.length,
        }, (session.user as any).id);

        return NextResponse.json({ success: true, retainedSeries: children[0], skeletonsRemoved: skeletonIds.length });
    } catch (error: unknown) {
        Logger.log(`[Attachments API] Keeping a volume as its own series failed: ${getErrorMessage(error)}`, 'error');
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
