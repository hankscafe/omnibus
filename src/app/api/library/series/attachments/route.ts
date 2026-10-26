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
import path from 'path';
import { randomUUID } from 'crypto';
import { UNMATCHED_DIR, isPathWithinRoots } from '@/lib/utils/paths';
import { attachAsCollected, type CollectedBookFile } from '@/lib/match-collision';
import { retainedChildren } from '@/lib/retained-attachments';
import { findOrCreateProviderSeries } from '@/lib/provider-series';
import { normalizeCoverage } from '@/lib/utils/coverage';
import { COMIC_EXT_REGEX } from '@/lib/utils/formats';
import { isSameIssue, normalizeFractionNumbers } from '@/lib/utils/issue-parser';
import { bookNumberFromFile, distinctEditionName, editionNameClashesWithSeries } from '@/lib/utils/collected-edition';
import { archiveCoverJpeg, saveCustomSeriesCover } from '@/lib/series-cover';

// LOCAL: a collected edition (or annual run) the provider has no volume for — attached by name,
// no sync lane; its books are the files whose names carry it (field report by robotshavehearts2).
const VALID_SOURCES = ['COMICVINE', 'METRON', 'LOCAL'];
const VALID_KINDS = ['ANNUAL', 'COLLECTED'];
/** #257: how many loose books one attach may pick — a drop folder, not a whole library. */
const MAX_PICKED_FILES = 200;
// A book's volume number: positive ("1", "2.5", "3a"). A negative one names back as a different
// number after a wipe ("Vol. -001" parses as 1).
const BOOK_NUMBER = /^\d+(?:\.\d+)?[a-zA-Z]?$/;

/**
 * #257: the loose books an admin picked in the Attach dialog — each a plain comic FILE directly in
 * the drop folder (never a library file, never one inside a dropped folder — both already belong to
 * a series row — and never a symlink, which could reach outside the drop folder), with the number
 * and coverage the admin confirmed; a blank number is read from the filename, so duplicates are
 * caught either way. Refused whole on the first bad entry: a half-applied pick would leave the
 * admin guessing which books moved.
 */
function parsePickedFiles(raw: unknown): { files: CollectedBookFile[] } | { error: string; status: number } {
    if (!Array.isArray(raw) || raw.length === 0) return { error: 'Pick at least one file.', status: 400 };
    if (raw.length > MAX_PICKED_FILES) return { error: `Pick at most ${MAX_PICKED_FILES} files at once.`, status: 400 };
    const files: CollectedBookFile[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
        const p = typeof entry?.path === 'string' ? entry.path.trim() : '';
        if (!p) return { error: 'A picked file has no path.', status: 400 };
        if (!isPathWithinRoots(p, [UNMATCHED_DIR]) || path.dirname(path.resolve(p)) !== path.resolve(UNMATCHED_DIR)) {
            return { error: 'Unauthorized path access', status: 403 };
        }
        if (!COMIC_EXT_REGEX.test(p)) return { error: `"${path.basename(p)}" is not a comic file.`, status: 400 };
        let isFile = false;
        try { isFile = fs.lstatSync(p).isFile(); } catch { isFile = false; }
        if (!isFile) return { error: `"${path.basename(p)}" is no longer a file in the drop folder.`, status: 404 };
        const key = p.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        // Stored the way the filename parser stores it: "02" is Vol. 2. Blank = the filename's.
        const given = entry?.number == null ? '' : String(entry.number).trim();
        const number = normalizeFractionNumbers(given || bookNumberFromFile(path.basename(p))).replace(/^0+(?=\d)/, '');
        if (!BOOK_NUMBER.test(number)) return { error: `"${number}" is not a volume number.`, status: 400 };
        const rawCovers = entry?.coversIssues == null ? '' : String(entry.coversIssues).trim();
        const coversIssues = rawCovers ? normalizeCoverage(rawCovers) : null;
        if (rawCovers && !coversIssues) return { error: `"${rawCovers}" is not a list of issues (e.g. "1-4, 6").`, status: 400 };
        files.push({ path: p, number, coversIssues });
    }
    // Two books can't share a number in one edition — the second would shadow the first's row.
    for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
            if (isSameIssue(files[i].number as string, files[j].number as string)) {
                return { error: `Two picked files are both Vol. ${files[i].number}.`, status: 400 };
            }
        }
    }
    return { files };
}

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
 * #257: several loose books picked at once go under the series as ONE local collected edition —
 * each with the number and coverage the admin confirmed, moved by the collision helper (never
 * overwriting; a book that fails is put back and counted), and named so the name rule can claim
 * them back after a wipe. The edition must not be named like its series, or that rule could never
 * tell its books from the run's issues; a book the edition's shelf already has is refused.
 * `coverFromBook`: the first book's own first page becomes the series' locked cover — here, before
 * the caller queues a new series' provider sync, so that sync never replaces it.
 */
async function attachLocalFiles(
    session: any, series: any, kind: string, name: string, volumeId: string, startYear: number | null,
    rawFiles: unknown, seriesCreated: boolean, existingAttachmentId: string | null, coverFromBook: boolean,
) {
    if (kind !== 'COLLECTED') return NextResponse.json({ error: 'Only a collected edition takes picked files.' }, { status: 400 });
    const picked = parsePickedFiles(rawFiles);
    if ('error' in picked) return NextResponse.json({ error: picked.error }, { status: picked.status });
    if (editionNameClashesWithSeries(name, series.name)) {
        const suggestedName = distinctEditionName(name, series.name);
        return NextResponse.json({
            error: `"${name}" is the series' own name — give the edition a name of its own, e.g. "${suggestedName}".`,
            suggestedName,
        }, { status: 400 });
    }
    if (existingAttachmentId) {
        const onShelf = await prisma.issue.findMany({ where: { attachedVolumeId: existingAttachmentId }, select: { number: true } });
        const taken = picked.files.find(f => onShelf.some(b => isSameIssue(b.number, f.number as string)));
        if (taken) return NextResponse.json({ error: `Vol. ${taken.number} is already on the "${name}" shelf.` }, { status: 400 });
    }

    const libraries = await prisma.library.findMany();
    const roots = [...libraries.map((l: any) => l.path), UNMATCHED_DIR];
    // The books are named here, so the naming settings apply (collected pattern, issue padding).
    const settings = await prisma.systemSetting.findMany();
    const config: Record<string, string> = Object.fromEntries(settings.map((s: any) => [s.key, s.value]));

    const result = await attachAsCollected({
        owner: {
            id: series.id, name: series.name, year: series.year ?? null, publisher: series.publisher ?? null,
            metadataSource: series.metadataSource || 'COMICVINE', metadataId: series.metadataId ?? null,
            folderPath: series.folderPath, isManga: !!series.isManga, imprint: series.imprint ?? null,
            universe: series.universe ?? null, seriesGroup: series.seriesGroup ?? null,
        },
        source: picked.files[0].path, files: picked.files, sourceSeriesId: null,
        metadataSource: 'LOCAL', volumeId, volumeName: name, volumeYear: startYear || 0,
        config, libraryRoots: roots,
    });
    if (result.error) return NextResponse.json({ success: false, attachmentId: result.attachmentId, error: result.error }, { status: 502 });
    // Where each book landed (the lowest-numbered one can give the series its cover).
    const books = await prisma.issue.findMany({
        where: { attachedVolumeId: result.attachmentId, filePath: { not: null } },
        select: { number: true, filePath: true },
    });

    let seriesCover: 'book' | 'failed' | null = null;
    const firstBook = [...books].sort((a, b) => (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0))[0];
    if (coverFromBook && firstBook?.filePath) {
        try {
            const cover = await archiveCoverJpeg(firstBook.filePath);
            if (!cover.ok) throw new Error(`no readable first page (${cover.status})`);
            await saveCustomSeriesCover(series.id, series.folderPath, cover.body);
            seriesCover = 'book';
        } catch (e) {
            Logger.log(`[Attachments API] Couldn't use ${firstBook.filePath} as the cover of ${series.name}: ${getErrorMessage(e)}`, 'warn');
            seriesCover = 'failed';
        }
    }

    queueSeriesJsonExport(series.id, `ATTACH_LOCAL_${result.attachmentId}`);
    // A library series gets the books' ComicInfo now ("Write metadata to ComicInfo.xml" decides);
    // a new one gets it with the provider sync its caller queues.
    if (!seriesCreated && result.attachmentId) await queueLaneEmbed(result.attachmentId);
    await AuditLogger.log('ATTACH_VOLUME', {
        seriesId: series.id, seriesName: series.name, seriesCreated, metadataSource: 'LOCAL', volumeId, kind, name, local: true,
        files: picked.files.map(f => f.path), moved: result.moved, claimed: result.claimed, conflicts: result.conflicts, failed: result.failed ?? 0, seriesCover,
    }, session.user.id);
    return NextResponse.json({
        success: true, local: true, attachmentId: result.attachmentId, name, summary: null,
        series: { id: series.id, name: series.name, folderPath: series.folderPath, created: seriesCreated },
        books: books.map(b => ({ number: b.number, filePath: b.filePath })),
        moved: result.moved, absorbed: result.absorbed, claimed: result.claimed, skeletonsReplaced: result.skeletonsReplaced,
        conflicts: result.conflicts, failed: result.failed ?? 0, seriesCover,
    });
}

/**
 * A LOCAL attachment: named by the admin, keyed by a generated local id, reused by name on the same
 * series. Without a sourcePath the engine claims the folder's files whose names carry it (the same
 * pass a provider lane runs, minus the fetch). With one — a folder or file dropped into /unmatched
 * — the collision helper moves it under the series and makes its rows the lane's books outright.
 * With `files` (#257), several picked loose books go under it at once (attachLocalFiles).
 */
async function attachLocal(session: any, series: any, kind: string, body: any, seriesCreated = false) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ error: 'A local collected edition needs a name.' }, { status: 400 });
    const startYear = body?.startYear ? parseInt(body.startYear) || null : null;

    const existing = await prisma.attachedVolume.findFirst({ where: { seriesId: series.id, metadataSource: 'LOCAL', name } });
    const volumeId = existing?.volumeId || `local_${randomUUID()}`;

    if (body?.files !== undefined) {
        return await attachLocalFiles(session, series, kind, name, volumeId, startYear, body.files, seriesCreated, existing?.id ?? null, body?.coverFromBook === true);
    }

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
        // #257: picked loose books may name their series by its provider key instead of a library id.
        const parent = !seriesId && body?.parent && typeof body.parent === 'object' ? body.parent : null;

        if (parent) {
            if (!isLocal || kind !== 'COLLECTED' || body?.files === undefined) {
                return NextResponse.json({ error: 'A series picked from the provider takes picked files as a local collected edition.' }, { status: 400 });
            }
            // Everything that can be refused is refused BEFORE the series is created, so a bad pick
            // never leaves an empty series behind.
            const name = typeof body?.name === 'string' ? body.name.trim() : '';
            if (!name) return NextResponse.json({ error: 'A local collected edition needs a name.' }, { status: 400 });
            const picked = parsePickedFiles(body.files);
            if ('error' in picked) return NextResponse.json({ error: picked.error }, { status: picked.status });
            const parentName = typeof parent.name === 'string' ? parent.name.trim() : '';
            if (parentName && editionNameClashesWithSeries(name, parentName)) {
                const suggestedName = distinctEditionName(name, parentName);
                return NextResponse.json({
                    error: `"${name}" is the series' own name — give the edition a name of its own, e.g. "${suggestedName}".`,
                    suggestedName,
                }, { status: 400 });
            }
            const resolved = await findOrCreateProviderSeries(parent);
            if (resolved.error !== undefined) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
            try {
                return await attachLocal(session, resolved.series, kind, body, resolved.created);
            } finally {
                // A series created just now has only its key: the sync brings its description,
                // credits, cover and issue list — queued however the attach went, so a failed one
                // never leaves a bare series behind. After the attach, so it sees a book-cover lock.
                if (resolved.created) {
                    void omnibusQueue.add('METADATA_SYNC',
                        { type: 'METADATA_SYNC', seriesIds: [resolved.series.id] },
                        { jobId: `METADATA_SYNC_ATTACH_${resolved.series.id}_${Date.now()}` }
                    ).catch(e => Logger.log(`[Attachments API] Couldn't queue the metadata sync: ${getErrorMessage(e)}`, 'warn'));
                }
            }
        }

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
