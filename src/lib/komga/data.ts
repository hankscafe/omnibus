// src/lib/komga/data.ts
//
// #206: the DB side of the Komga facade. Everything here is scoped by the caller's library grants
// (the same chokepoint the OPDS feed uses) and, where progress is involved, by the key's user.
// Only issues WITH a file are books — a wanted-but-missing row is not something Paperback can open.
import fs from 'fs';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ciContains } from '@/lib/utils/db-search';
import { seriesAccessWhere, nestedSeriesAccessWhere, canAccessLibraryId, type AccessibleLibraries } from '@/lib/library-access';
import { countArchivePages, countArchivePagesViaEngine, isPageCountable, isEngineCountable } from '@/lib/utils/archive-pages';
import {
    komgaPage,
    orderBooks,
    seriesAuthors,
    authorsFromRows,
    toSeriesDto,
    toBookDto,
    type KomgaIssueRow,
    type KomgaSeriesRow,
    type SeriesCounts,
    type ProgressRow,
} from './dto';
import type { Paging, SeriesFilters, SeriesSort } from './query';
import { bookWhereFor, pinnedSeriesId, seriesWhereFor, type SearchBody } from './search';

export const HAS_FILE = { filePath: { not: null } } as const;
const ZERO_COUNTS: SeriesCounts = { booksCount: 0, booksReadCount: 0, booksInProgressCount: 0 };

type SeriesRef = { id: string; name: string; libraryId?: string | null };
type IssueWithLane = Prisma.IssueGetPayload<{ include: { attachedVolume: { select: { name: true } } } }>;

// ---------------------------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------------------------

/**
 * The list filter: grants AND has-files AND each requested constraint — nothing overwrites another,
 * and the grants are always the first clause, outside anything a client sends. `extra` is a search
 * body's condition (POST /series/list), already translated by search.ts.
 */
export function seriesListWhere(libs: AccessibleLibraries, filters: SeriesFilters, userId?: string, extra?: Prisma.SeriesWhereInput): Prisma.SeriesWhereInput {
    const and: Prisma.SeriesWhereInput[] = [
        seriesAccessWhere(libs) as Prisma.SeriesWhereInput,
        { issues: { some: HAS_FILE } },
    ];
    if (filters.search) and.push({ name: ciContains(filters.search) });
    if (filters.libraryIds.length) and.push({ libraryId: { in: filters.libraryIds } });
    // Genres/tags are JSON-array strings; a quoted needle matches whole values only.
    for (const g of filters.genres) and.push({ genres: { contains: `"${g}"` } });
    for (const t of filters.tags) and.push({ tags: { contains: `"${t}"` } });
    // Collections belong to a user — a collection filter only reaches the caller's own.
    if (filters.collectionIds.length) {
        and.push({ collectionItems: { some: { collectionId: { in: filters.collectionIds }, ...(userId ? { collection: { userId } } : {}) } } });
    }
    if (extra && Object.keys(extra).length > 0) and.push(extra);
    return { AND: and };
}

export function seriesOrderBy(sort: SeriesSort): Prisma.SeriesOrderByWithRelationInput[] {
    // `id` tiebreaker: OFFSET pagination needs a total order (same rule as the OPDS catalog).
    // (fileAddedAt and readDate are aggregates over a series' issues — listSeries orders those itself.)
    switch (sort.field) {
        case 'createdAt': return [{ createdAt: sort.dir }, { id: 'asc' }];
        default: return [{ name: sort.dir }, { year: 'asc' }, { id: 'asc' }];
    }
}

/** Per-series book / read / in-progress counts for one user, in two queries for the whole page. */
export async function seriesCounts(seriesIds: string[], userId: string): Promise<Map<string, SeriesCounts>> {
    const out = new Map<string, SeriesCounts>();
    if (seriesIds.length === 0) return out;
    const [groups, progress] = await Promise.all([
        prisma.issue.groupBy({
            by: ['seriesId'],
            where: { seriesId: { in: seriesIds }, ...HAS_FILE },
            _count: { _all: true },
            _max: { fileAddedAt: true }, // the series' lastModified (#206 follow-up)
        }),
        prisma.readProgress.findMany({
            where: { userId, issue: { seriesId: { in: seriesIds }, ...HAS_FILE } },
            select: { isCompleted: true, currentPage: true, issue: { select: { seriesId: true } } },
        }),
    ]);
    for (const g of groups) out.set(g.seriesId, { ...ZERO_COUNTS, booksCount: g._count._all, lastFileAddedAt: g._max?.fileAddedAt ?? null });
    for (const p of progress) {
        const c = out.get(p.issue.seriesId) ?? { ...ZERO_COUNTS };
        if (p.isCompleted) c.booksReadCount++;
        else if (p.currentPage > 0) c.booksInProgressCount++;
        out.set(p.issue.seriesId, c);
    }
    return out;
}

export interface ListSeriesArgs {
    libs: AccessibleLibraries;
    userId: string;
    filters: SeriesFilters;
    sort: SeriesSort;
    page: number;
    size: number;
    /** A search body's translated condition — ANDed inside the grants. */
    extra?: Prisma.SeriesWhereInput;
}

/** A file row with an arrival stamp — the rows the arrival order ranks. */
const STAMPED_FILE = { ...HAS_FILE, fileAddedAt: { not: null } } as const;

/**
 * Arrival order (#206 follow-up): the series that most recently gained a file, by the newest
 * Issue.fileAddedAt under the same filters. Only stamped rows rank — Postgres sorts a NULL max
 * FIRST under DESC, which would put an unstamped series at the top of Paperback's update walk and
 * stop it dead (the startup backfill leaves none, but a gap must never reorder the list). `seriesId`
 * breaks ties so OFFSET paging stays a total order; the count covers exactly the ranked set.
 */
async function listByArrival(where: Prisma.SeriesWhereInput, dir: 'asc' | 'desc', page: number, size: number) {
    const [groups, total] = await Promise.all([
        prisma.issue.groupBy({
            by: ['seriesId'],
            where: { ...STAMPED_FILE, series: where },
            _max: { fileAddedAt: true },
            orderBy: [{ _max: { fileAddedAt: dir } }, { seriesId: 'asc' }],
            skip: page * size,
            take: size,
        }),
        prisma.series.count({ where: { AND: [where, { issues: { some: STAMPED_FILE } }] } }),
    ]);
    const ids = groups.map(g => g.seriesId);
    const found = ids.length ? await prisma.series.findMany({ where: { id: { in: ids } } }) : [];
    const byId = new Map(found.map(s => [s.id, s]));
    return { rows: ids.map(id => byId.get(id)).filter((s): s is NonNullable<typeof s> => Boolean(s)), total };
}

/** How far back "last read" ordering looks (the caller's most recent progress rows). */
const READ_DATE_CAP = 500;

/**
 * `sort=readProgress.readDate,desc` (the 0.9 source's Continue Reading): series by when the caller
 * last read in them, newest first. Series never read don't rank. Hydrated in that order and paged
 * by slicing, so the count is exactly the ranked set.
 */
async function listByReadDate(where: Prisma.SeriesWhereInput, userId: string, libs: AccessibleLibraries, page: number, size: number) {
    const recent = await prisma.readProgress.findMany({
        where: { userId, issue: { ...HAS_FILE, ...(nestedSeriesAccessWhere(libs) as Prisma.IssueWhereInput) } },
        orderBy: { updatedAt: 'desc' },
        take: READ_DATE_CAP,
        select: { issue: { select: { seriesId: true } } },
    });
    const ordered = distinct(recent.map(r => r.issue.seriesId));
    const matching = ordered.length
        ? await prisma.series.findMany({ where: { AND: [where, { id: { in: ordered } }] }, select: { id: true } })
        : [];
    const keep = new Set(matching.map(m => m.id));
    const ids = ordered.filter(id => keep.has(id));
    const slice = ids.slice(page * size, page * size + size);
    const found = slice.length ? await prisma.series.findMany({ where: { id: { in: slice } } }) : [];
    const byId = new Map(found.map(s => [s.id, s]));
    return { rows: slice.map(id => byId.get(id)).filter((s): s is NonNullable<typeof s> => Boolean(s)), total: ids.length };
}

export async function listSeries({ libs, userId, filters, sort, page, size, extra }: ListSeriesArgs) {
    const where = seriesListWhere(libs, filters, userId, extra);
    const { rows, total } = sort.field === 'fileAddedAt'
        ? await listByArrival(where, sort.dir, page, size)
        : sort.field === 'readDate'
            ? await listByReadDate(where, userId, libs, page, size)
            : await Promise.all([
                prisma.series.findMany({ where, orderBy: seriesOrderBy(sort), skip: page * size, take: size }),
                prisma.series.count({ where }),
            ]).then(([rows, total]) => ({ rows, total }));
    const counts = await seriesCounts(rows.map(r => r.id), userId);
    const content = rows.map(r => toSeriesDto(r, counts.get(r.id) ?? ZERO_COUNTS, seriesAuthors(r)));
    return komgaPage(content, page, size, total);
}

export type SeriesLookup<T> = { ok: true; series: T } | { ok: false; status: 404 | 403 };

/** A series the caller may see: 404 unknown, 403 outside their grants (the OPDS convention). */
export async function findAccessibleSeries(id: string, libs: AccessibleLibraries): Promise<SeriesLookup<KomgaSeriesRow & SeriesRef>> {
    const series = await prisma.series.findUnique({ where: { id } });
    if (!series) return { ok: false, status: 404 };
    if (!canAccessLibraryId(libs, series.libraryId)) return { ok: false, status: 403 };
    return { ok: true, series };
}

/** The detail DTO: counts for this user; credits from the series columns, else from its issues. */
export async function seriesDetail(series: KomgaSeriesRow, userId: string) {
    const counts = await seriesCounts([series.id], userId);
    let authors = seriesAuthors(series);
    if (authors.length === 0) {
        const rows = await prisma.issue.findMany({
            where: { seriesId: series.id, ...HAS_FILE },
            select: { writers: true, artists: true },
        });
        authors = authorsFromRows(rows);
    }
    return toSeriesDto(series, counts.get(series.id) ?? ZERO_COUNTS, authors);
}

// ---------------------------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------------------------

export interface LaneIssue extends KomgaIssueRow {
    filePath: string;
}

function withLane(row: IssueWithLane): LaneIssue {
    return { ...row, filePath: row.filePath ?? '', attachmentName: row.attachedVolumeId ? (row.attachedVolume?.name ?? null) : null };
}

/** A series' books in reading order (run, then annuals), with their 1-based positions. */
export async function loadOrderedBooks(seriesId: string) {
    const rows = await prisma.issue.findMany({
        where: { seriesId, ...HAS_FILE },
        include: { attachedVolume: { select: { name: true } } },
    });
    return orderBooks(rows.map(withLane));
}

export async function progressByIssue(userId: string, issueIds: string[]): Promise<Map<string, ProgressRow>> {
    const map = new Map<string, ProgressRow>();
    if (issueIds.length === 0) return map;
    const rows = await prisma.readProgress.findMany({ where: { userId, issueId: { in: issueIds } } });
    for (const r of rows) map.set(r.issueId, r);
    return map;
}

async function statSafe(filePath: string): Promise<{ size: number; mtime: Date } | null> {
    try {
        const s = await fs.promises.stat(filePath);
        return { size: s.size, mtime: s.mtime };
    } catch {
        return null;
    }
}

/** BookDtos for ordered issues: file size/mtime from disk (best effort), the user's progress. */
export async function bookDtos(ordered: ReturnType<typeof orderBooks<LaneIssue>>, series: SeriesRef, userId: string) {
    const [stats, progress] = await Promise.all([
        Promise.all(ordered.map(o => statSafe(o.issue.filePath))),
        progressByIssue(userId, ordered.map(o => o.issue.id)),
    ]);
    return ordered.map((o, i) => toBookDto(o.issue, series, {
        position: o.position,
        sizeBytes: stats[i]?.size ?? 0,
        mtime: stats[i]?.mtime ?? o.issue.updatedAt,
        progress: progress.get(o.issue.id) ?? null,
    }));
}

type IssueWithSeries = Prisma.IssueGetPayload<{ include: { series: { select: { id: true; name: true; libraryId: true } } } }>;

export type IssueLookup = { ok: true; issue: IssueWithSeries } | { ok: false; status: 404 | 403 };

/** An issue with a file the caller may see (by its series' library). */
export async function findAccessibleIssue(id: string, libs: AccessibleLibraries): Promise<IssueLookup> {
    const issue = await prisma.issue.findUnique({
        where: { id },
        include: { series: { select: { id: true, name: true, libraryId: true } } },
    });
    if (!issue) return { ok: false, status: 404 };
    if (!canAccessLibraryId(libs, issue.series?.libraryId)) return { ok: false, status: 403 };
    return { ok: true, issue };
}

/**
 * Issue.pageCount, self-healed from the archive when a scan persisted 0 (same rule as the OPDS
 * feed: zips are counted locally, RAR/7z through the engine, and the result is written back).
 */
export async function healedPageCount(issue: { id: string; filePath: string | null; pageCount: number }): Promise<number> {
    let pageCount = issue.pageCount || 0;
    if (!pageCount && isPageCountable(issue.filePath)) {
        pageCount = await countArchivePages(issue.filePath);
    } else if (!pageCount && isEngineCountable(issue.filePath)) {
        pageCount = await countArchivePagesViaEngine(issue.filePath);
    }
    if (!(issue.pageCount || 0) && pageCount > 0) {
        await prisma.issue.update({ where: { id: issue.id }, data: { pageCount } }).catch(() => {});
    }
    return pageCount;
}

// ---------------------------------------------------------------------------------------------
// Homepage sections: Continue Reading + On Deck
// ---------------------------------------------------------------------------------------------

type ProgressWithIssue = Prisma.ReadProgressGetPayload<{
    include: { issue: { include: { series: { select: { id: true; name: true; libraryId: true } }; attachedVolume: { select: { name: true } } } } };
}>;

async function tileFor(row: ProgressWithIssue['issue'], progress: ProgressRow | null) {
    const lane = withLane(row);
    const stat = await statSafe(lane.filePath);
    return toBookDto(lane, row.series, {
        position: parseFloat(lane.number) || 0,
        sizeBytes: stat?.size ?? 0,
        mtime: stat?.mtime ?? row.updatedAt,
        progress,
    });
}

/** The user's started-but-unfinished books with files, inside their library grants. */
function inProgressWhere(userId: string, libs: AccessibleLibraries): Prisma.ReadProgressWhereInput {
    return {
        userId,
        isCompleted: false,
        currentPage: { gt: 0 },
        issue: { ...HAS_FILE, ...(nestedSeriesAccessWhere(libs) as Prisma.IssueWhereInput) },
    };
}

/** `/books?read_status=IN_PROGRESS&sort=readProgress.readDate,desc`: unfinished books, newest read first. */
export async function inProgressBooks(userId: string, libs: AccessibleLibraries, page: number, size: number) {
    const where = inProgressWhere(userId, libs);
    const [rows, total] = await Promise.all([
        prisma.readProgress.findMany({
            where,
            include: { issue: { include: { series: { select: { id: true, name: true, libraryId: true } }, attachedVolume: { select: { name: true } } } } },
            orderBy: { updatedAt: 'desc' },
            skip: page * size,
            take: size,
        }),
        prisma.readProgress.count({ where }),
    ]);
    const content = await Promise.all(rows.map(r => tileFor(r.issue, r)));
    return komgaPage(content, page, size, total);
}

/**
 * `/books/ondeck`: for each series the user recently finished a book in, the next book after the
 * last one they completed — skipped when the series is read through, and skipped when that next
 * book is already started (Komga's rule: a started book belongs to Continue Reading, not On Deck,
 * so the two homepage sections never show the same tile).
 */
export async function onDeckBooks(userId: string, libs: AccessibleLibraries, size: number) {
    const recent = await prisma.readProgress.findMany({
        where: { userId, isCompleted: true, issue: { ...HAS_FILE, ...(nestedSeriesAccessWhere(libs) as Prisma.IssueWhereInput) } },
        orderBy: { updatedAt: 'desc' },
        take: 50,
        select: { updatedAt: true, issue: { select: { id: true, seriesId: true } } },
    });
    const seriesIds: string[] = [];
    for (const r of recent) if (!seriesIds.includes(r.issue.seriesId)) seriesIds.push(r.issue.seriesId);

    const out: ReturnType<typeof toBookDto>[] = [];
    for (const seriesId of seriesIds) {
        if (out.length >= size) break;
        const series = await prisma.series.findUnique({ where: { id: seriesId }, select: { id: true, name: true, libraryId: true } });
        if (!series) continue;
        const ordered = await loadOrderedBooks(seriesId);
        const progress = await progressByIssue(userId, ordered.map(o => o.issue.id));
        let lastDone = -1;
        ordered.forEach((o, i) => { if (progress.get(o.issue.id)?.isCompleted) lastDone = i; });
        const next = ordered.slice(lastDone + 1).find(o => !progress.get(o.issue.id)?.isCompleted);
        if (!next) continue;
        const started = progress.get(next.issue.id);
        if (started && started.currentPage > 0) continue;
        const stat = await statSafe(next.issue.filePath);
        out.push(toBookDto(next.issue, series, {
            position: next.position,
            sizeBytes: stat?.size ?? 0,
            mtime: stat?.mtime ?? next.issue.updatedAt,
            progress: null,
        }));
    }
    return komgaPage(out, 0, size, out.length);
}

// ---------------------------------------------------------------------------------------------
// View More for On Deck / Continue Reading (#206 round 4)
// ---------------------------------------------------------------------------------------------
// The source's getViewMoreItems asks for `/series/<section id>` for every homepage section and
// reads SeriesDtos (it opens `/series/{id}/thumbnail` and the series itself), so On Deck and
// Continue Reading are answered here as the series behind their books, in the section's order.

/** How far back View More looks — the homepage sections themselves show 20. */
const VIEW_MORE_CAP = 50;

async function seriesPageFor(seriesIds: string[], userId: string, page: number, size: number) {
    const slice = seriesIds.slice(page * size, page * size + size);
    const found = slice.length ? await prisma.series.findMany({ where: { id: { in: slice } } }) : [];
    const byId = new Map(found.map(s => [s.id, s]));
    const rows = slice.map(id => byId.get(id)).filter((s): s is NonNullable<typeof s> => Boolean(s));
    const counts = await seriesCounts(rows.map(r => r.id), userId);
    const content = rows.map(r => toSeriesDto(r, counts.get(r.id) ?? ZERO_COUNTS, seriesAuthors(r)));
    return komgaPage(content, page, size, seriesIds.length);
}

const distinct = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) === i);

/** `/series/continue`: each series with an unfinished book, most recently read first. */
export async function inProgressSeries(userId: string, libs: AccessibleLibraries, page: number, size: number) {
    const rows = await prisma.readProgress.findMany({
        where: inProgressWhere(userId, libs),
        orderBy: { updatedAt: 'desc' },
        take: VIEW_MORE_CAP,
        select: { issue: { select: { seriesId: true } } },
    });
    return seriesPageFor(distinct(rows.map(r => r.issue.seriesId)), userId, page, size);
}

/** `/series/ondeck`: the series of the On Deck books, in On Deck order. */
export async function onDeckSeries(userId: string, libs: AccessibleLibraries, page: number, size: number) {
    const deck = await onDeckBooks(userId, libs, VIEW_MORE_CAP);
    return seriesPageFor(distinct(deck.content.map(b => b.seriesId)), userId, page, size);
}

// ---------------------------------------------------------------------------------------------
// Paperback 0.9's search API (#206 prep): POST /series/list, POST /books/list, v2 read progress
// ---------------------------------------------------------------------------------------------

/** Every series the caller has an unfinished book in (search.ts asks for it lazily). */
async function inProgressSeriesIdList(userId: string, libs: AccessibleLibraries): Promise<string[]> {
    const rows = await prisma.readProgress.findMany({
        where: inProgressWhere(userId, libs),
        orderBy: { updatedAt: 'desc' },
        take: READ_DATE_CAP,
        select: { issue: { select: { seriesId: true } } },
    });
    return distinct(rows.map(r => r.issue.seriesId));
}

const NO_FILTERS: SeriesFilters = { search: null, tags: [], genres: [], collectionIds: [], libraryIds: [] };

/** POST /series/list: the body's condition + full text, inside the grants, in the requested order. */
export async function searchSeries(args: { libs: AccessibleLibraries; userId: string; body: SearchBody; sort: SeriesSort; page: number; size: number }) {
    const { libs, userId, body, sort, page, size } = args;
    const extra = await seriesWhereFor(body.condition, { userId, inProgressSeriesIds: () => inProgressSeriesIdList(userId, libs) });
    return listSeries({ libs, userId, filters: { ...NO_FILTERS, search: body.fullTextSearch }, sort, page, size, extra });
}

/**
 * POST /books/list. Pinned to one series (how the 0.9 source lists chapters): that series' books in
 * reading order with their 1-based numberSort, honouring unpaged — and nothing at all for a series
 * outside the grants (a search answers empty, it doesn't confirm the series exists). Anything else
 * is paged like every other list; a library-wide unpaged request would stat every file on disk.
 */
export async function searchBooks(args: { libs: AccessibleLibraries; userId: string; body: SearchBody; paging: Paging }) {
    const { libs, userId, body, paging } = args;
    const { page, size } = paging;
    const where: Prisma.IssueWhereInput = {
        AND: [
            HAS_FILE,
            nestedSeriesAccessWhere(libs) as Prisma.IssueWhereInput,
            bookWhereFor(body.condition, userId),
            ...(body.fullTextSearch ? [{ name: ciContains(body.fullTextSearch) }] : []),
        ],
    };

    const pinned = pinnedSeriesId(body.condition);
    if (pinned) {
        const series = await prisma.series.findUnique({ where: { id: pinned }, select: { id: true, name: true, libraryId: true } });
        if (!series || !canAccessLibraryId(libs, series.libraryId)) return komgaPage([], page, size, 0);
        const matched = new Set((await prisma.issue.findMany({ where, select: { id: true } })).map(r => r.id));
        const ordered = (await loadOrderedBooks(pinned)).filter(o => matched.has(o.issue.id));
        const slice = paging.unpaged ? ordered : ordered.slice(page * size, page * size + size);
        const content = await bookDtos(slice, series, userId);
        return paging.unpaged
            ? komgaPage(content, 0, Math.max(1, content.length), ordered.length)
            : komgaPage(content, page, size, ordered.length);
    }

    const [rows, total] = await Promise.all([
        prisma.issue.findMany({
            where,
            include: { series: { select: { id: true, name: true, libraryId: true } }, attachedVolume: { select: { name: true } } },
            orderBy: [{ seriesId: 'asc' }, { number: 'asc' }, { id: 'asc' }],
            skip: page * size,
            take: size,
        }),
        prisma.issue.count({ where }),
    ]);
    const progress = await progressByIssue(userId, rows.map(r => r.id));
    const content = await Promise.all(rows.map(r => tileFor(r, progress.get(r.id) ?? null)));
    return komgaPage(content, page, size, total);
}

/**
 * GET /api/v2/series/{id}/read-progress/tachiyomi — Komga's TachiyomiReadProgressV2Dto, which the
 * 0.9 source reads to know where the reader is up to: the book counts, and the numberSort of the
 * last book read WITHOUT A GAP from the start (0 when the first book is unread).
 */
export async function tachiyomiProgress(seriesId: string, userId: string) {
    const ordered = await loadOrderedBooks(seriesId);
    const progress = await progressByIssue(userId, ordered.map(o => o.issue.id));
    let read = 0, inProgress = 0, lastReadContinuousNumberSort = 0, continuous = true;
    for (const o of ordered) {
        const p = progress.get(o.issue.id);
        if (p?.isCompleted) read++;
        else if (p && p.currentPage > 0) inProgress++;
        if (continuous && p?.isCompleted) lastReadContinuousNumberSort = o.position;
        else continuous = false;
    }
    return {
        booksCount: ordered.length,
        booksReadCount: read,
        booksUnreadCount: ordered.length - read - inProgress,
        booksInProgressCount: inProgress,
        lastReadContinuousNumberSort,
        maxNumberSort: ordered.length ? ordered[ordered.length - 1].position : 0,
    };
}
