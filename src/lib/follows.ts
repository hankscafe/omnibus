// src/lib/follows.ts
//
// Per-user series follows (the subscription signal behind the Updates feed). Three rules pinned
// here: following is read-side only (never touches Series.monitored, never downloads anything);
// auto-follow helpers are BEST-EFFORT (a follow insert must never fail the request that triggered
// it); and the one-time backfill derives follows from each user's existing request history — the
// exact rows the auto-follow-on-request rule would have produced had it always existed.
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export const FOLLOW_BACKFILL_SENTINEL = 'follow_request_backfilled';

/** Idempotent follow. Never throws — callers treat it as fire-and-forget bookkeeping. */
export async function followSeries(userId: string, seriesId: string): Promise<void> {
    if (!userId || !seriesId) return;
    try {
        await prisma.seriesFollow.upsert({
            where: { userId_seriesId: { userId, seriesId } },
            update: {},
            create: { userId, seriesId },
        });
    } catch (e) {
        Logger.log(`[Follows] Auto-follow failed for user ${userId} / series ${seriesId}: ${getErrorMessage(e)}`, 'warn');
    }
}

/**
 * Follow by catalog identity (metadataSource + metadataId) — for request paths that only hold a
 * volume id. A series not (yet) in the library is a silent no-op: the volume-request path creates
 * the row first and follows directly, so this covers the single-issue path where the series may
 * or may not exist.
 */
export async function followSeriesByCatalogId(userId: string, metadataSource: string, metadataId: string | null | undefined): Promise<void> {
    if (!userId || !metadataId || metadataId === '0') return;
    try {
        const series = await prisma.series.findUnique({
            where: { metadataSource_metadataId: { metadataSource, metadataId } },
            select: { id: true },
        });
        if (series) await followSeries(userId, series.id);
    } catch (e) {
        Logger.log(`[Follows] Catalog-id follow lookup failed (${metadataSource}/${metadataId}): ${getErrorMessage(e)}`, 'warn');
    }
}

/**
 * One-time, sentinel-guarded backfill (db-init pattern): every distinct (user, volume, source)
 * from request history becomes a follow where the series exists in the library. No skipDuplicates
 * (unsupported on SQLite) — filter-first against existing rows, same as the library-access
 * backfill. Requests for series never imported are skipped silently.
 */
export async function backfillFollowsFromRequests(): Promise<void> {
    const done = await prisma.systemSetting.findUnique({ where: { key: FOLLOW_BACKFILL_SENTINEL } });
    if (done) return;

    const requests = await prisma.request.findMany({
        select: { userId: true, volumeId: true, metadataSource: true },
    });

    const wanted = new Map<string, { userId: string; metadataSource: string; metadataId: string }>();
    for (const r of requests) {
        if (!r.userId || !r.volumeId || r.volumeId === '0') continue;
        wanted.set(`${r.userId}|${r.metadataSource}|${r.volumeId}`, {
            userId: r.userId, metadataSource: r.metadataSource, metadataId: r.volumeId,
        });
    }

    let created = 0;
    if (wanted.size > 0) {
        const catalogPairs = Array.from(new Set(Array.from(wanted.values()).map(w => `${w.metadataSource}|${w.metadataId}`)));
        const seriesRows = await prisma.series.findMany({
            where: { OR: catalogPairs.map(p => { const [metadataSource, metadataId] = p.split('|'); return { metadataSource, metadataId }; }) },
            select: { id: true, metadataSource: true, metadataId: true },
        });
        const seriesByCatalog = new Map(seriesRows.map(s => [`${s.metadataSource}|${s.metadataId}`, s.id]));

        const rows: { userId: string; seriesId: string }[] = [];
        const seen = new Set<string>();
        for (const w of Array.from(wanted.values())) {
            const seriesId = seriesByCatalog.get(`${w.metadataSource}|${w.metadataId}`);
            if (!seriesId) continue;
            const key = `${w.userId}:${seriesId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push({ userId: w.userId, seriesId });
        }

        if (rows.length > 0) {
            const existing = await prisma.seriesFollow.findMany({ select: { userId: true, seriesId: true } });
            const have = new Set(existing.map(f => `${f.userId}:${f.seriesId}`));
            const fresh = rows.filter(r => !have.has(`${r.userId}:${r.seriesId}`));
            if (fresh.length > 0) {
                await prisma.seriesFollow.createMany({ data: fresh });
                created = fresh.length;
            }
        }
    }

    await prisma.systemSetting.create({ data: { key: FOLLOW_BACKFILL_SENTINEL, value: new Date().toISOString() } });
    Logger.log(`[Follows] Backfilled ${created} follow(s) from request history.`, 'success');
}
